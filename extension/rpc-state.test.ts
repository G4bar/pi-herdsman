import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fakeContext,
  fakePi,
  registerExtension,
  setLeadEnvironment,
} from "./support.ts";
import {
  HERDSMAN_STATUS_KEY,
  createHerdsmanStatusFeed,
  herdsmanAgentState,
  herdsmanRpcAgent,
  parseHerdsmanCommand,
  registerHerdsmanCommand,
  serializeHerdsmanRpcSnapshot,
  type HerdsmanFeedTimers,
  type HerdsmanRpcAgent,
  type HerdsmanRpcSnapshot,
} from "./rpc-state.ts";

function snapshotOf(agents: HerdsmanRpcAgent[]): HerdsmanRpcSnapshot {
  return { v: 1, capabilities: ["steer"], agents };
}

function fakeClock() {
  let now = 0;
  const queue: {
    at: number;
    callback: () => void;
    handle: object;
  }[] = [];
  const timers: HerdsmanFeedTimers = {
    now: () => now,
    schedule(callback, delayMs) {
      const handle = { id: queue.length + 1 };
      queue.push({ at: now + delayMs, callback, handle });
      return handle;
    },
    cancel(handle) {
      const index = queue.findIndex((timer) => timer.handle === handle);
      if (index >= 0) queue.splice(index, 1);
    },
  };
  const flush = async () => {
    for (let pass = 0; pass < 8; pass++)
      await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    timers,
    async advance(ms: number) {
      const target = now + ms;
      await flush();
      while (true) {
        const due = queue
          .filter((timer) => timer.at <= target)
          .sort((left, right) => left.at - right.at)[0];
        if (!due) break;
        queue.splice(queue.indexOf(due), 1);
        now = Math.max(now, due.at);
        due.callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

test("agent state follows ask, result, then liveness evidence", () => {
  assert.equal(herdsmanAgentState({ projection: "starting" }), "starting");
  assert.equal(herdsmanAgentState({ projection: "working" }), "running");
  assert.equal(herdsmanAgentState({ projection: "blocked" }), "running");
  assert.equal(
    herdsmanAgentState({ projection: "working", stale: true }),
    "stale",
  );
  assert.equal(herdsmanAgentState({ projection: "unknown" }), "stale");
  assert.equal(herdsmanAgentState({ projection: "lost" }), "closed");
  assert.equal(
    herdsmanAgentState({
      projection: "working",
      pendingAsk: { question: "Which branch?" },
    }),
    "asks",
  );
  assert.equal(
    herdsmanAgentState({
      projection: "settling",
      result: { status: "completed", completedAt: 5 },
    }),
    "finished",
  );
  assert.equal(
    herdsmanAgentState({
      projection: "settling",
      result: { status: "failed", completedAt: 5 },
    }),
    "failed",
  );
});

test("agent snapshot bounds task, activity, question and answer", () => {
  const running = herdsmanRpcAgent({
    label: "impl_one",
    definition: "implementer",
    projection: "working",
    task: "t".repeat(600),
    startedAt: 100,
    activity: Array.from({ length: 25 }, (_, index) => `row ${index}\nnext`),
  });
  assert.equal(running.state, "running");
  assert.equal(running.parent, null);
  assert.equal(running.task!.length, 500);
  assert.equal(running.activity!.length, 20);
  assert.equal(running.activity![19], "row 24 next");
  assert.equal(running.startedAt, 100);
  assert.equal(running.question, undefined);
  assert.equal(running.answer, undefined);
  assert.equal(running.endedAt, undefined);

  const asking = herdsmanRpcAgent({
    label: "impl_two",
    projection: "working",
    parentLabel: "impl_one",
    pendingAsk: { question: "q".repeat(9000), files: ["result:abc"] },
    activity: ["ignored"],
  });
  assert.equal(asking.state, "asks");
  assert.equal(asking.parent, "impl_one");
  assert.equal(asking.activity, undefined);
  assert.equal(asking.question!.text.length, 8192);
  assert.deepEqual(asking.question!.files, ["result:abc"]);

  const finished = herdsmanRpcAgent({
    label: "impl_three",
    projection: "settling",
    result: {
      status: "completed",
      text: "a".repeat(9000),
      completedAt: 42,
      resultRef: "result:xyz",
    },
    resumable: true,
  });
  assert.equal(finished.state, "finished");
  assert.equal(finished.answer!.length, 8192);
  assert.equal(finished.endedAt, 42);
  assert.equal(finished.resultRef, "result:xyz");
  assert.equal(finished.resumable, true);
});

test("serializing trims activity and then text to stay inside the limit", () => {
  const activitySnapshot = snapshotOf(
    Array.from({ length: 4 }, (_, index) =>
      herdsmanRpcAgent({
        label: `impl_${index}`,
        projection: "working",
        task: "task",
        activity: Array.from({ length: 20 }, () => "x".repeat(200)),
      }),
    ),
  );
  const activityLimit = 4 * 1024;
  const trimmed = serializeHerdsmanRpcSnapshot(activitySnapshot, activityLimit);
  assert.ok(Buffer.byteLength(trimmed) <= activityLimit);
  const parsed = JSON.parse(trimmed) as HerdsmanRpcSnapshot;
  assert.equal(parsed.agents.length, 4);
  assert.deepEqual(
    parsed.agents.map((agent) => agent.activity),
    [undefined, undefined, undefined, undefined],
  );
  assert.equal(parsed.agents[0]!.task, "task");

  const textSnapshot = snapshotOf([
    herdsmanRpcAgent({
      label: "impl_one",
      projection: "settling",
      result: {
        status: "completed",
        text: "a".repeat(8000),
        completedAt: 1,
        resultRef: "result:abc",
      },
    }),
  ]);
  const textLimit = 2 * 1024;
  const bounded = JSON.parse(
    serializeHerdsmanRpcSnapshot(textSnapshot, textLimit),
  ) as HerdsmanRpcSnapshot;
  assert.equal(bounded.agents[0]!.answer, undefined);
  assert.equal(bounded.agents[0]!.resultRef, "result:abc");
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= textLimit);
});

test("the status feed publishes once per throttle window and coalesces", async () => {
  const clock = fakeClock();
  const published: HerdsmanRpcSnapshot[] = [];
  let loads = 0;
  const feed = createHerdsmanStatusFeed({
    load: async () => {
      loads += 1;
      return snapshotOf([
        herdsmanRpcAgent({ label: `impl_${loads}`, projection: "working" }),
      ]);
    },
    publish: (text) => {
      published.push(JSON.parse(text) as HerdsmanRpcSnapshot);
    },
    throttleMs: 1000,
    timers: clock.timers,
  });
  feed.request();
  await clock.advance(0);
  assert.equal(published.length, 1);
  assert.equal(loads, 1);

  feed.request();
  feed.request();
  await clock.advance(999);
  assert.equal(published.length, 1);

  await clock.advance(1);
  assert.equal(published.length, 2);
  assert.equal(published[1]!.agents[0]!.label, "impl_2");

  feed.dispose();
  feed.request();
  await clock.advance(5000);
  assert.equal(published.length, 2);
});

test("a failing load drops the publish without throwing", async () => {
  const clock = fakeClock();
  const published: string[] = [];
  const feed = createHerdsmanStatusFeed({
    load: async () => {
      throw new Error("herdr unavailable");
    },
    publish: (text) => published.push(text),
    throttleMs: 0,
    timers: clock.timers,
  });
  feed.request();
  await clock.advance(0);
  assert.deepEqual(published, []);
  feed.dispose();
});

test("parsing /hm keeps the message verbatim and rejects bad input", () => {
  assert.deepEqual(parseHerdsmanCommand("steer impl_one fix the\n  parser"), {
    action: "steer",
    label: "impl_one",
    text: "fix the\n  parser",
  });
  assert.deepEqual(parseHerdsmanCommand("reply impl_two  yes, use B"), {
    action: "reply",
    label: "impl_two",
    text: "yes, use B",
  });
  assert.deepEqual(parseHerdsmanCommand("close impl_one"), {
    action: "close",
    label: "impl_one",
  });
  assert.deepEqual(parseHerdsmanCommand("continue impl_one go on"), {
    action: "continue",
    label: "impl_one",
    text: "go on",
  });
  assert.equal("error" in parseHerdsmanCommand(""), true);
  assert.equal("error" in parseHerdsmanCommand("bogus impl_one"), true);
  assert.equal("error" in parseHerdsmanCommand("steer"), true);
  assert.equal("error" in parseHerdsmanCommand("steer Impl_One text"), true);
  assert.equal("error" in parseHerdsmanCommand("steer impl_one"), true);
  assert.equal("error" in parseHerdsmanCommand("close impl_one now"), true);
});

test("/hm reaches the controller and reports refusals", async () => {
  const registered = new Map<string, any>();
  const runs: [string, Record<string, unknown>][] = [];
  const notifications: [string, string][] = [];
  const ctx = fakeContext([]) as any;
  ctx.ui.notify = (message: string, type?: string) => {
    notifications.push([message, type ?? "info"]);
  };
  registerHerdsmanCommand({
    registerCommand: (name, command) => registered.set(name, command),
    capabilities: () => ["steer", "reply", "close"],
    notify: (target, message, type) => target.ui.notify(message, type),
    run: async (action, params) => {
      runs.push([action, params]);
      if (params.agent === "missing")
        throw new Error("Agent missing is not a known agent");
    },
  });
  const command = registered.get("hm");
  assert.ok(command);

  await command.handler("steer impl_one tighten the test", ctx);
  assert.deepEqual(runs.at(-1), [
    "steer",
    { agent: "impl_one", message: "tighten the test" },
  ]);
  assert.equal(notifications.at(-1)![1], "info");

  await command.handler("close impl_one", ctx);
  assert.deepEqual(runs.at(-1), ["close", { agent: "impl_one" }]);

  await command.handler("interrupt impl_one stop", ctx);
  assert.equal(runs.length, 2);
  assert.match(notifications.at(-1)![0], /does not support \/hm interrupt/u);

  await command.handler("steer missing text", ctx);
  assert.equal(notifications.at(-1)![1], "error");
  assert.equal(notifications.at(-1)![0], "Agent missing is not a known agent");

  await command.handler("nope impl_one", ctx);
  assert.equal(notifications.at(-1)![1], "error");
  assert.match(notifications.at(-1)![0], /Unknown \/hm sub-command/u);
});

function rpcContext(entries: unknown[]) {
  const statuses: { key: string; text: string | undefined }[] = [];
  const notifications: [string, string][] = [];
  const ctx = fakeContext(entries) as any;
  ctx.mode = "rpc";
  ctx.hasUI = true;
  ctx.ui.setStatus = (key: string, text: string | undefined) => {
    statuses.push({ key, text });
  };
  ctx.ui.notify = (message: string, type?: string) => {
    notifications.push([message, type ?? "info"]);
  };
  return { ctx, statuses, notifications };
}

async function settle(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assertion();
}

test("RPC mode publishes the Herdsman snapshot and TUI mode stays silent", async () => {
  setLeadEnvironment();
  const entries: any[] = [];
  const fixture = fakePi({ entries });
  const { ctx, statuses } = rpcContext(entries);
  registerExtension!(fixture.pi as never);
  try {
    for (const handler of fixture.events.get("session_start") ?? [])
      await handler(undefined, ctx);
    assert.ok(fixture.commands.includes("hm"));
    await settle(() => assert.equal(statuses.length, 1));
    const status = statuses[0]!;
    assert.equal(status.key, HERDSMAN_STATUS_KEY);
    const snapshot = JSON.parse(status.text!) as HerdsmanRpcSnapshot;
    assert.equal(snapshot.v, 1);
    assert.deepEqual(snapshot.capabilities, [
      "steer",
      "interrupt",
      "reply",
      "close",
      "continue",
    ]);
    assert.deepEqual(snapshot.agents, []);
  } finally {
    for (const handler of fixture.events.get("session_shutdown") ?? [])
      await handler(undefined, ctx);
  }
});

test("RPC mode reports an unknown agent as an error", async () => {
  setLeadEnvironment();
  const entries: any[] = [];
  const fixture = fakePi({ entries });
  const { ctx, notifications } = rpcContext(entries);
  registerExtension!(fixture.pi as never);
  try {
    for (const handler of fixture.events.get("session_start") ?? [])
      await handler(undefined, ctx);
    await fixture.commandOptions.get("hm").handler("close ghost", ctx);
    const errors = notifications.filter(([, type]) => type === "error");
    assert.equal(errors.length, 1);
    // The refusal comes from the controller's own target resolution.
    assert.match(errors[0]![0], /agent identity|not found/iu);
  } finally {
    for (const handler of fixture.events.get("session_shutdown") ?? [])
      await handler(undefined, ctx);
  }
});

test("TUI mode never publishes a snapshot", async () => {
  setLeadEnvironment();
  const entries: any[] = [];
  const fixture = fakePi({ entries });
  const statuses: unknown[] = [];
  const ctx = fakeContext(entries) as any;
  ctx.hasUI = true;
  ctx.ui.setStatus = (...args: unknown[]) => statuses.push(args);
  registerExtension!(fixture.pi as never);
  for (const handler of fixture.events.get("session_start") ?? [])
    await handler(undefined, ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(statuses, []);
});
