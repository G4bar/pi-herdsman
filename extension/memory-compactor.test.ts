import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCompactorDefinition } from "./agent-definitions.ts";
import { MemoryStore } from "./memory.ts";
import {
  FAILURES_BEFORE_REPORT,
  MAX_CONCURRENT_COMPACTIONS,
  MAX_LENGTH_RETRIES,
  type MemoryCompactorCallbacks,
  start,
} from "./memory-compactor.ts";
import {
  LOSSY_MARKER,
  MEMORY_VIEW_DESCRIPTION,
  RULER,
  compressTask,
  mergeTask,
  tooLongTask,
} from "./memory-prompts.ts";

// --- fakes ------------------------------------------------------------------

function assistant(
  text: string,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  } as AssistantMessage;
}

/** A stream the test drives: `start` arrives at once, the end later. */
class FakeCall {
  readonly context: Context;
  readonly signal: AbortSignal | undefined;
  aborted = false;
  readonly stream: AsyncIterable<AssistantMessageEvent>;
  private readonly queue: AssistantMessageEvent[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  constructor(context: Context, signal: AbortSignal | undefined) {
    this.context = context;
    this.signal = signal;
    this.queue.push({
      type: "start",
      partial: assistant(""),
    } as AssistantMessageEvent);
    this.stream = { [Symbol.asyncIterator]: () => this.iterate() };
    signal?.addEventListener(
      "abort",
      () => {
        this.aborted = true;
        this.ended = true;
        this.wake?.();
        this.wake = undefined;
      },
      { once: true },
    );
  }

  private async *iterate(): AsyncGenerator<AssistantMessageEvent> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private push(event: AssistantMessageEvent): void {
    this.queue.push(event);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  respond(text: string): void {
    this.push({
      type: "done",
      message: assistant(text),
    } as AssistantMessageEvent);
    this.ended = true;
  }

  fail(message: string): void {
    this.push({
      type: "error",
      error: assistant("", { stopReason: "error", errorMessage: message }),
    } as AssistantMessageEvent);
    this.ended = true;
  }
}

class FakeRegistry {
  readonly calls: FakeCall[] = [];
  readonly requested: Model<Api>[] = [];
  responder: (call: FakeCall, index: number) => void = (call) =>
    call.respond("summary line");
  private readonly models: Model<Api>[];

  constructor(models: Model<Api>[]) {
    this.models = models;
  }

  getAll(): Model<Api>[] {
    return this.models;
  }

  hasConfiguredAuth(): boolean {
    return true;
  }

  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: { signal?: AbortSignal },
  ): unknown {
    this.requested.push(model);
    const call = new FakeCall(context, options?.signal);
    const index = this.calls.length;
    this.calls.push(call);
    this.responder(call, index);
    return call.stream;
  }
}

function makeModel(provider: string, id: string): Model<Api> {
  return {
    provider,
    id,
    api: "anthropic-messages",
    reasoning: true,
    thinkingLevelMap: {},
  } as unknown as Model<Api>;
}

function fakeContext(
  registry: FakeRegistry,
  model: Model<Api> | undefined,
  project: string,
): ExtensionContext {
  return {
    cwd: project,
    isProjectTrusted: () => true,
    model: model ?? registry.getAll()[0],
    thinkingLevel: "high",
    modelRegistry: registry,
  } as unknown as ExtensionContext;
}

// --- fixtures ---------------------------------------------------------------

let sequence = 0;

function addMessage(store: MemoryStore, text: string): number {
  sequence += 1;
  const message = store.appendMessage({
    kind: "user",
    text,
    size: Buffer.byteLength(text, "utf8"),
    date: "2026-01-02T03:04:05.000Z",
    src: { session: "/sessions/s.jsonl", entry: `e${sequence}`, part: 0 },
    hash: `h${sequence}`,
  });
  return message.i;
}

function longText(prefix = ""): string {
  return `${prefix}${"x".repeat(600)}`;
}

async function withProject<T>(
  run: (project: string, store: MemoryStore) => Promise<T>,
): Promise<T> {
  const project = mkdtempSync(join(tmpdir(), "pi-herdsman-compactor-"));
  const store = new MemoryStore(project);
  try {
    return await run(project, store);
  } finally {
    store.close();
    rmSync(project, { recursive: true, force: true });
  }
}

async function withAgentDir<T>(
  run: (project: string, agentDir: string) => Promise<T>,
): Promise<T> {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-herdsman-compactor-agent-"));
  const project = mkdtempSync(join(tmpdir(), "pi-herdsman-compactor-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await run(project, agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("condition was not reached");
}

function taskText(call: FakeCall): string {
  const content = call.context.messages[1]?.content;
  return typeof content === "string" ? content : "";
}

// --- prompts ----------------------------------------------------------------

test("the system prompt is the view description plus the compactor body", () =>
  withProject(async (project, store) => {
    addMessage(store, longText());
    const registry = new FakeRegistry([makeModel("test", "lead")]);
    const ctx = fakeContext(registry, makeModel("test", "lead"), project);
    const compactor = start(store, ctx);
    await compactor.whenSettled(0);
    compactor.stop();

    const call = registry.calls[0];
    assert.equal(
      call.context.systemPrompt,
      `${MEMORY_VIEW_DESCRIPTION}\n\n${resolveCompactorDefinition(ctx).body}`,
    );
    assert.equal(call.context.tools, undefined);
  }));

test("the task templates are byte-exact from the gist", () => {
  assert.equal(RULER, "-".repeat(512));
  assert.equal(RULER.length, 512);
  assert.match(MEMORY_VIEW_DESCRIPTION, /^# The view\n/);
  assert.match(MEMORY_VIEW_DESCRIPTION, /- note: memories imported/);
  assert.match(MEMORY_VIEW_DESCRIPTION, /…\[ids\]/);
  assert.doesNotMatch(MEMORY_VIEW_DESCRIPTION, /Unii|zoom\("Name"\)/);

  assert.equal(
    compressTask({ id: 42, kind: "user", text: "hello" }),
    [
      "Compaction: compress message 42 into one line of at most 512 bytes",
      "(about 70 words), the length of this ruler:",
      "-".repeat(512),
      "<input>",
      "user: hello",
      "</input>",
    ].join("\n"),
  );

  assert.equal(
    mergeTask({ line: [1, 0], first: "first line", second: "second line" }),
    [
      "Compaction: merge lines 0+1 and 1+1, adjacent, into one line of at most",
      "512 bytes (about 70 words), the length of this ruler:",
      "-".repeat(512),
      "<chat> may hold their messages, 0 to 1, in more detail: take details",
      "of them from there too.",
      "<input>",
      "0+1|first line",
      "1+1|second line",
      "</input>",
    ].join("\n"),
  );

  assert.equal(
    tooLongTask({ bytes: 700, cut: "abc" }),
    [
      "Too long: your line is 700 bytes, over the 512-byte limit. Write",
      "the whole line again for the same <input>, cutting just enough of the",
      "least valuable items to fit before this cut:",
      "abc| ← LIMIT",
    ].join("\n"),
  );
});

// --- retries ----------------------------------------------------------------

test("an over-length line is retried and the shortest is kept", () =>
  withProject(async (project, store) => {
    addMessage(store, longText());
    const replies = ["a".repeat(700), "b".repeat(600), "c".repeat(530), "ok"];
    let index = 0;
    const registry = new FakeRegistry([makeModel("test", "lead")]);
    registry.responder = (call) => call.respond(replies[index++]!);
    const compactor = start(store, fakeContext(registry, undefined, project));
    await compactor.whenSettled(0);
    compactor.stop();

    assert.equal(registry.calls.length, 4);
    assert.equal(store.nodeText([0, 0]), "ok");
    const retry = registry.calls[1]!.context.messages.at(-1)!;
    assert.equal(typeof retry.content, "string");
    const cut = "a".repeat(512);
    assert.equal(retry.content, tooLongTask({ bytes: 700, cut }));
  }));

test("the over-length retry is capped at five", () =>
  withProject(async (project, store) => {
    addMessage(store, longText());
    let index = 0;
    const registry = new FakeRegistry([makeModel("test", "lead")]);
    registry.responder = (call) => call.respond("z".repeat(600 - index++ * 10));
    const compactor = start(store, fakeContext(registry, undefined, project));
    await compactor.whenSettled(0);
    compactor.stop();

    assert.equal(registry.calls.length, MAX_LENGTH_RETRIES + 1);
    assert.equal(Buffer.byteLength(store.nodeText([0, 0])!, "utf8"), 550);
  }));

test("a multi-byte retry cut never splits a code point", () =>
  withProject(async (project, store) => {
    addMessage(store, longText());
    const wider = `${"a".repeat(511)}é`;
    const registry = new FakeRegistry([makeModel("test", "lead")]);
    let index = 0;
    registry.responder = (call) => call.respond(index++ === 0 ? wider : "ok");
    const compactor = start(store, fakeContext(registry, undefined, project));
    await compactor.whenSettled(0);
    compactor.stop();

    const retry = registry.calls[1]!.context.messages.at(-1)!;
    const cut = (retry.content as string).split("\n").at(-1)!;
    assert.equal(cut, `${"a".repeat(511)}| ← LIMIT`);
    assert.ok(Buffer.byteLength("a".repeat(511), "utf8") <= 512);
  }));

// --- lossy marker -----------------------------------------------------------

test("a dropped leaf identifier is marked", () =>
  withProject(async (project, store) => {
    addMessage(store, longText("/home/gabar/project/src/file.ts "));
    const registry = new FakeRegistry([makeModel("test", "lead")]);
    registry.responder = (call) => call.respond("no exact value here");
    const compactor = start(store, fakeContext(registry, undefined, project));
    await compactor.whenSettled(0);
    compactor.stop();
    assert.ok(store.nodeText([0, 0])!.endsWith(` ${LOSSY_MARKER}`));
  }));

test("a leaf that drops nothing gets no marker", () =>
  withProject(async (project, store) => {
    addMessage(store, longText("/home/gabar/project/src/file.ts "));
    const registry = new FakeRegistry([makeModel("test", "lead")]);
    registry.responder = (call) =>
      call.respond("kept /home/gabar/project/src/file.ts");
    const compactor = start(store, fakeContext(registry, undefined, project));
    await compactor.whenSettled(0);
    compactor.stop();
    assert.equal(
      store.nodeText([0, 0]),
      "kept /home/gabar/project/src/file.ts",
    );
  }));

test("a marker the model already wrote is not duplicated", () =>
  withProject(async (project, store) => {
    addMessage(store, longText("/home/gabar/project/src/file.ts "));
    const registry = new FakeRegistry([makeModel("test", "lead")]);
    registry.responder = (call) =>
      call.respond(`summary without the path ${LOSSY_MARKER}`);
    const compactor = start(store, fakeContext(registry, undefined, project));
    await compactor.whenSettled(0);
    compactor.stop();
    const text = store.nodeText([0, 0])!;
    assert.equal(text, `summary without the path ${LOSSY_MARKER}`);
    assert.equal(text.split(LOSSY_MARKER).length, 2);
  }));

test("a child marker propagates to its merge", () =>
  withProject(async (project, store) => {
    addMessage(store, "a".repeat(600));
    addMessage(store, "b".repeat(600));
    while (store.nextJob()) {
      // The leaves are built directly below.
    }
    store.appendNode([0, 0], `${"a".repeat(300)} ${LOSSY_MARKER}`);
    store.appendNode([0, 1], "b".repeat(300));

    const registry = new FakeRegistry([makeModel("test", "lead")]);
    registry.responder = (call) => call.respond("merged");
    const compactor = start(store, fakeContext(registry, undefined, project));
    await waitFor(() => store.nodeText([1, 0]) !== undefined);
    compactor.stop();

    assert.equal(registry.calls.length, 1);
    assert.match(taskText(registry.calls[0]!), /^Compaction: merge lines /);
    assert.equal(store.nodeText([1, 0]), `merged ${LOSSY_MARKER}`);
  }));

// --- concurrency ------------------------------------------------------------

test("at most eight calls run at once and leaves start in order", () =>
  withProject(async (project, store) => {
    for (let index = 0; index < 20; index += 1) addMessage(store, longText());
    const registry = new FakeRegistry([makeModel("test", "lead")]);
    registry.responder = () => {};
    const compactor = start(store, fakeContext(registry, undefined, project));
    await waitFor(() => registry.calls.length === MAX_CONCURRENT_COMPACTIONS);
    await tick();

    assert.equal(registry.calls.length, MAX_CONCURRENT_COMPACTIONS);
    assert.deepEqual(
      registry.calls.map(
        (call) => /compress message (\d+)/.exec(taskText(call))?.[1],
      ),
      ["0", "1", "2", "3", "4", "5", "6", "7"],
    );

    registry.responder = (call) => call.respond("short");
    for (const call of registry.calls.slice()) call.respond("short");
    await compactor.whenSettled(19);
    compactor.stop();
    assert.equal(registry.calls.length, 20);
  }));

test("a merge starts only once both halves are built", () =>
  withProject(async (project, store) => {
    addMessage(store, "a".repeat(600));
    addMessage(store, "b".repeat(600));
    const registry = new FakeRegistry([makeModel("test", "lead")]);
    registry.responder = () => {};
    const compactor = start(store, fakeContext(registry, undefined, project));
    await waitFor(() => registry.calls.length === 2);

    assert.deepEqual(
      registry.calls.map(
        (call) => /^Compaction: (compress|merge) /.exec(taskText(call))?.[1],
      ),
      ["compress", "compress"],
    );

    registry.calls[0]!.respond("a".repeat(300));
    await tick();
    await tick();
    assert.equal(registry.calls.length, 2);

    registry.calls[1]!.respond("b".repeat(300));
    await waitFor(() => registry.calls.length === 3);
    assert.match(taskText(registry.calls[2]!), /^Compaction: merge lines /);
    registry.calls[2]!.respond("merged");
    await compactor.whenSettled(1);
    compactor.stop();
  }));

// --- failure ----------------------------------------------------------------

test("a failed node is requeued and retried on the next message", () =>
  withProject(async (project, store) => {
    addMessage(store, longText());
    const failures: string[] = [];
    const callbacks: MemoryCompactorCallbacks = {
      onFailure: (failure) => failures.push(failure.error),
    };
    let attempts = 0;
    const registry = new FakeRegistry([makeModel("test", "lead")]);
    registry.responder = (call) => {
      attempts += 1;
      if (attempts <= FAILURES_BEFORE_REPORT) call.fail("provider down");
      else call.respond("recovered");
    };
    const compactor = start(
      store,
      fakeContext(registry, undefined, project),
      callbacks,
    );

    for (
      let index = 0;
      index < 10 && store.nodeText([0, 0]) === undefined;
      index += 1
    ) {
      compactor.onMessage();
      await tick();
    }
    compactor.stop();

    assert.equal(store.nodeText([0, 0]), "recovered");
    assert.equal(registry.calls.length, FAILURES_BEFORE_REPORT + 1);
    assert.deepEqual(failures, ["provider down"]);
  }));

// --- model resolution -------------------------------------------------------

test("the definition model overrides the inherited model", () =>
  withAgentDir(async (project, agentDir) => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "compactor.md"),
      "---\nname: compactor\nmodel: test/compactor\nbodyMode: append\n---\n",
    );
    const store = new MemoryStore(project);
    try {
      addMessage(store, longText());
      const inherited = makeModel("test", "lead");
      const configured = makeModel("test", "compactor");
      const registry = new FakeRegistry([inherited, configured]);
      const compactor = start(store, fakeContext(registry, inherited, project));
      await compactor.whenSettled(0);
      compactor.stop();
      assert.equal(registry.requested[0], configured);
    } finally {
      store.close();
    }
  }));

test("the compactor inherits the Lead model when the definition sets none", () =>
  withProject(async (project, store) => {
    addMessage(store, longText());
    const inherited = makeModel("test", "lead");
    const registry = new FakeRegistry([inherited]);
    const compactor = start(store, fakeContext(registry, inherited, project));
    await compactor.whenSettled(0);
    compactor.stop();
    assert.equal(registry.requested[0], inherited);
  }));

test("an unresolvable definition model makes start throw", () =>
  withAgentDir(async (project, agentDir) => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "compactor.md"),
      "---\nname: compactor\nmodel: nope/missing\n---\n",
    );
    const store = new MemoryStore(project);
    try {
      const registry = new FakeRegistry([makeModel("test", "lead")]);
      assert.throws(
        () =>
          start(
            store,
            fakeContext(registry, makeModel("test", "lead"), project),
          ),
        /nope\/missing" is not available/,
      );
    } finally {
      store.close();
    }
  }));

test("a session with no model makes start throw", () =>
  withProject(async (project, store) => {
    const registry = new FakeRegistry([]);
    assert.throws(
      () => start(store, fakeContext(registry, undefined, project)),
      /has no model/,
    );
  }));

// --- stop and settle --------------------------------------------------------

test("stop aborts calls and appends nothing", () =>
  withProject(async (project, store) => {
    addMessage(store, longText());
    const registry = new FakeRegistry([makeModel("test", "lead")]);
    registry.responder = () => {};
    const compactor = start(store, fakeContext(registry, undefined, project));
    await waitFor(() => registry.calls.length === 1);
    compactor.stop();
    await tick();
    assert.equal(registry.calls[0]!.aborted, true);
    assert.equal(store.nodeText([0, 0]), undefined);
  }));

test("whenSettled resolves on abort without building the node", () =>
  withProject(async (project, store) => {
    addMessage(store, longText());
    const registry = new FakeRegistry([makeModel("test", "lead")]);
    registry.responder = () => {};
    const compactor = start(store, fakeContext(registry, undefined, project));
    const controller = new AbortController();
    const settled = compactor.whenSettled(0, controller.signal);
    await waitFor(() => registry.calls.length === 1);
    controller.abort();
    await settled;
    assert.equal(store.nodeText([0, 0]), undefined);
    compactor.stop();
  }));

test("whenSettled returns early when every remaining node has failed", () =>
  withProject(async (project, store) => {
    addMessage(store, longText());
    const registry = new FakeRegistry([makeModel("test", "lead")]);
    registry.responder = (call) => call.fail("down");
    const compactor = start(store, fakeContext(registry, undefined, project));
    await waitFor(() => registry.calls.length === 1);
    await tick();
    await compactor.whenSettled(0);
    assert.equal(store.nodeText([0, 0]), undefined);
    compactor.stop();
  }));
