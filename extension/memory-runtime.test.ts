import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { updateConfig } from "./config.ts";
import { ProcessLockOccupiedError } from "./lock.ts";
import {
  MemoryStore,
  projectMemoryRoot,
  type MemoryMessage,
} from "./memory.ts";
import type {
  MemoryCompactor,
  MemoryCompactorOptions,
  MemoryCompactorFactory,
} from "./memory-compactor.ts";
import {
  TURN_SETTLE_GRACE_MS,
  ordinaryLeadSession,
  registerMemoryRuntime,
} from "./memory-runtime.ts";
import { fakeContext, fakePi } from "./support.ts";

// --- fixtures ---------------------------------------------------------------

const projects: string[] = [];
let entryCounter = 0;

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-herdsman-memory-runtime-"));
  projects.push(dir);
  return dir;
}

test.after(() => {
  for (const project of projects)
    rmSync(project, { recursive: true, force: true });
  updateConfig("memoryProjects", undefined);
});

function withProjects(paths: string[]): void {
  updateConfig("memoryProjects", paths);
}

function entryBase(parentId: string | null) {
  entryCounter += 1;
  return {
    id: `entry-${entryCounter}-${randomUUID().slice(0, 8)}`,
    parentId,
    timestamp: new Date(Date.now() + entryCounter).toISOString(),
  };
}

function userEntry(text: string, parentId: string | null = null) {
  return {
    ...entryBase(parentId),
    type: "message",
    message: { role: "user", content: text, timestamp: 0 },
  } as unknown as SessionEntry;
}

function assistantEntry(text: string, parentId: string | null = null) {
  return {
    ...entryBase(parentId),
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as unknown as SessionEntry;
}

function compactionEntry(parentId: string | null = null) {
  return {
    ...entryBase(parentId),
    type: "compaction",
    summary: "summary",
    firstKeptEntryId: "none",
    tokensBefore: 1,
  } as unknown as SessionEntry;
}

/** Pi omits a failed attempt's messages this way on retry and overflow recovery. */
function omitEntry(targetId: string, parentId: string | null) {
  return {
    ...entryBase(parentId),
    type: "context_edit",
    targetId,
    replacement: null,
  } as unknown as SessionEntry;
}

/** A fake compactor: it builds nothing, and records what the runtime asked. */
class FakeCompactor implements MemoryCompactor {
  readonly store: MemoryStore;
  readonly options: MemoryCompactorOptions;
  readonly settled: number[] = [];
  signals: (AbortSignal | undefined)[] = [];
  messages = 0;
  stopped = false;
  /** When true, `whenSettled` only ends with the signal. */
  hang = false;

  constructor(store: MemoryStore, options: MemoryCompactorOptions) {
    this.store = store;
    this.options = options;
  }

  onMessage(): void {
    this.messages += 1;
  }

  async whenSettled(upToIndex: number, signal?: AbortSignal): Promise<void> {
    this.settled.push(upToIndex);
    this.signals.push(signal);
    if (!this.hang) return;
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  stop(): void {
    this.stopped = true;
  }
}

/** One fake Lead session: its file, its entries, its notices. */
class TestSession {
  readonly cwd: string;
  readonly file: string | undefined;
  readonly notices: { message: string; type: string | undefined }[] = [];
  entries: SessionEntry[];
  branch: SessionEntry[];
  signal: AbortSignal | undefined;

  constructor(options: {
    cwd: string;
    file?: string;
    entries?: SessionEntry[];
  }) {
    this.cwd = options.cwd;
    this.file = options.file;
    this.entries = options.entries ?? [];
    this.branch = this.entries;
  }

  /** A ctx for the session as it is now, so the runtime sees every change. */
  context(): ExtensionContext {
    const context = fakeContext(this.entries, this.branch);
    context.cwd = this.cwd;
    context.ui = {
      ...context.ui,
      notify: (...args: unknown[]) => {
        this.notices.push({
          message: String(args[0]),
          type: args[1] as string | undefined,
        });
      },
    };
    context.sessionManager = {
      getSessionId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      getSessionName: () => undefined,
      getSessionFile: () => this.file,
      getEntries: () => this.entries,
      getBranch: () => this.branch,
      // Pi's own projection, so context edits and compactions are real here.
      buildSessionProjection: () =>
        buildSessionProjection(
          this.entries,
          this.branch[this.branch.length - 1]?.id ?? null,
        ),
    } as unknown as typeof context.sessionManager;
    const extended = context as unknown as ExtensionContext;
    (extended as { signal?: AbortSignal }).signal = this.signal;
    return extended;
  }
}

type HarnessOptions = {
  isOrdinaryLead?: () => boolean;
  settleGraceMs?: number;
  thinkingLevel?: string;
  hang?: boolean;
  startCompactor?: MemoryCompactorFactory;
};

class Harness {
  readonly pi: ReturnType<typeof fakePi>;
  readonly compactors: FakeCompactor[] = [];

  constructor(options: HarnessOptions = {}) {
    this.pi = fakePi({ thinkingLevel: options.thinkingLevel });
    const compactors = this.compactors;
    const factory: MemoryCompactorFactory =
      options.startCompactor ??
      ((store, _ctx, compactorOptions) => {
        const compactor = new FakeCompactor(store, compactorOptions);
        compactor.hang = options.hang ?? false;
        compactors.push(compactor);
        return compactor;
      });
    registerMemoryRuntime(this.pi.pi as unknown as ExtensionAPI, {
      isOrdinaryLead: options.isOrdinaryLead ?? (() => true),
      ...(options.settleGraceMs === undefined
        ? {}
        : { settleGraceMs: options.settleGraceMs }),
      startCompactor: factory,
    });
  }

  async emit(
    name: string,
    event: unknown,
    ctx: ExtensionContext,
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.pi.events.get(name) ?? [])
      results.push(await handler(event, ctx));
    return results;
  }

  sessionStart(session: TestSession, reason = "startup"): Promise<unknown[]> {
    return this.emit(
      "session_start",
      { type: "session_start", reason },
      session.context(),
    );
  }

  shutdown(session: TestSession, reason: string): Promise<unknown[]> {
    return this.emit(
      "session_shutdown",
      { type: "session_shutdown", reason },
      session.context(),
    );
  }

  messageEnd(session: TestSession): Promise<unknown[]> {
    return this.emit(
      "message_end",
      { type: "message_end", message: { role: "assistant" } },
      session.context(),
    );
  }

  turnEnd(session: TestSession): Promise<unknown[]> {
    return this.emit(
      "turn_end",
      { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] },
      session.context(),
    );
  }

  beforeAgentStart(session: TestSession): Promise<unknown[]> {
    return this.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "next",
        systemPrompt: "",
        systemPromptOptions: {},
      },
      session.context(),
    );
  }

  async context(
    session: TestSession,
    messages: unknown[],
  ): Promise<{ messages: any[] } | undefined> {
    const [result] = await this.emit(
      "context",
      { type: "context", messages },
      session.context(),
    );
    return result as { messages: any[] } | undefined;
  }

  async beforeCompact(session: TestSession, reason: string): Promise<unknown> {
    const [result] = await this.emit(
      "session_before_compact",
      {
        type: "session_before_compact",
        preparation: {},
        branchEntries: session.branch,
        reason,
        willRetry: false,
        signal: new AbortController().signal,
      },
      session.context(),
    );
    return result;
  }
}

function mainLog(project: string): MemoryMessage[] {
  const directory = join(projectMemoryRoot(project), "main");
  const messages: MemoryMessage[] = [];
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch {
    return messages;
  }
  for (const name of names)
    for (const line of readFileSync(join(directory, name), "utf8").split("\n"))
      if (line !== "") messages.push(JSON.parse(line));
  return messages;
}

function savedView(project: string): {
  T: number;
  chat: [number, number][];
} {
  return JSON.parse(
    readFileSync(join(projectMemoryRoot(project), "view.json"), "utf8"),
  );
}

/** A live owner of the project lock, as another process would leave it. */
function occupyLock(project: string): void {
  const lock = join(projectMemoryRoot(project), "lock");
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  writeFileSync(
    join(lock, `${process.pid}-${id}`),
    JSON.stringify({ pid: process.pid, id }),
  );
}

// --- tests ------------------------------------------------------------------

test("the settle grace is 30 seconds", () => {
  assert.equal(TURN_SETTLE_GRACE_MS, 30_000);
});

test("memory applies to an ordinary Lead only", () => {
  const cases: [string, Parameters<typeof ordinaryLeadSession>[0], boolean][] =
    [
      [
        "ordinary Lead",
        { isLeadProcess: true, leadRoleActive: true, managedExecution: false },
        true,
      ],
      [
        "assigned managed Lead using managed-lead",
        { isLeadProcess: true, leadRoleActive: true, managedExecution: true },
        false,
      ],
      [
        "Manager or Chief",
        { isLeadProcess: true, leadRoleActive: false, managedExecution: false },
        false,
      ],
      [
        "Manager with a managed assignment",
        { isLeadProcess: true, leadRoleActive: false, managedExecution: true },
        false,
      ],
      [
        "managed Agent or unmanaged process",
        { isLeadProcess: false, leadRoleActive: true, managedExecution: false },
        false,
      ],
    ];
  for (const [name, session, expected] of cases)
    assert.equal(ordinaryLeadSession(session), expected, name);
});

type ActivationCase = {
  name: string;
  role: "lead" | "manager" | "chief" | "managed" | "managed-lead";
  listed?: boolean;
  symlink?: boolean;
  persisted?: boolean;
  occupied?: boolean;
  startError?: string;
  active: boolean;
  notice?: RegExp;
  noticeType?: string;
};

test("activation follows the listed project, the role, persistence and the lock", async () => {
  const cases: ActivationCase[] = [
    { name: "cwd not listed", role: "lead", listed: false, active: false },
    { name: "listed", role: "lead", active: true },
    {
      name: "listed through a symlink",
      role: "lead",
      symlink: true,
      active: true,
    },
    { name: "Manager", role: "manager", active: false },
    { name: "Chief", role: "chief", active: false },
    { name: "managed-lead", role: "managed-lead", active: false },
    { name: "managed Agent", role: "managed", active: false },
    {
      name: "in-memory session",
      role: "lead",
      persisted: false,
      active: false,
    },
    {
      name: "lock held by a live pid",
      role: "lead",
      occupied: true,
      active: false,
      notice: new RegExp(`open in process ${process.pid}`),
      noticeType: "info",
    },
    {
      name: "unresolvable compactor model",
      role: "lead",
      startError: "project memory compactor has no model",
      active: false,
      notice:
        /Project memory is inactive: project memory compactor has no model/,
      noticeType: "warning",
    },
  ];

  for (const activation of cases) {
    const project = projectDir();
    const unlisted = projectDir();
    const link = join(projectDir(), "link");
    symlinkSync(project, link);
    withProjects([activation.listed === false ? unlisted : project]);
    if (activation.occupied) occupyLock(project);

    const session = new TestSession({
      cwd: activation.symlink ? link : project,
      file: activation.persisted === false ? undefined : "/sessions/a.jsonl",
    });
    const harness = new Harness({
      isOrdinaryLead: () => activation.role === "lead",
      startCompactor: activation.startError
        ? () => {
            throw new Error(activation.startError);
          }
        : undefined,
    });

    await harness.sessionStart(session);

    assert.equal(
      harness.compactors.length === 1,
      activation.active,
      activation.name,
    );
    if (activation.notice) {
      assert.equal(session.notices.length, 1, activation.name);
      assert.match(
        session.notices[0].message,
        activation.notice,
        activation.name,
      );
      assert.equal(
        session.notices[0].type,
        activation.noticeType,
        activation.name,
      );
    } else {
      assert.deepEqual(session.notices, [], activation.name);
    }
    if (!activation.active) {
      // Never half active: nothing is injected and nothing is logged.
      assert.equal(
        await harness.context(session, []),
        undefined,
        activation.name,
      );
      assert.equal(mainLog(project).length, 0, activation.name);
    }
    await harness.shutdown(session, "quit");
  }
});

test("a damaged log is reported once with its first warning", async () => {
  const project = projectDir();
  withProjects([project]);
  const day = join(projectMemoryRoot(project), "main", "2026-01-02.jsonl");
  mkdirSync(join(projectMemoryRoot(project), "main"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(day, "not json\n{}\n");

  const session = new TestSession({ cwd: project, file: "/sessions/a.jsonl" });
  const harness = new Harness();
  await harness.sessionStart(session);

  assert.equal(harness.compactors.length, 1);
  assert.equal(session.notices.length, 1);
  assert.match(
    session.notices[0].message,
    /log damage: 1 warning\(s\); first: 2026-01-02\.jsonl: unreadable line at 0/,
  );
  await harness.shutdown(session, "quit");
});

test("the compactor is started with the Lead's thinking level", async () => {
  const project = projectDir();
  withProjects([project]);
  const session = new TestSession({ cwd: project, file: "/sessions/a.jsonl" });
  const harness = new Harness({ thinkingLevel: "high" });
  await harness.sessionStart(session);
  assert.equal(harness.compactors[0].options.thinkingLevel, "high");
  await harness.shutdown(session, "quit");
});

test("ownership follows the project and is released on shutdown", async () => {
  const project = projectDir();
  const other = projectDir();
  withProjects([project]);
  const harness = new Harness();
  const first = new TestSession({ cwd: project, file: "/sessions/a.jsonl" });
  await harness.sessionStart(first);
  assert.equal(harness.compactors.length, 1);
  assert.throws(() => new MemoryStore(project), ProcessLockOccupiedError);

  // A session outside the project ends ownership.
  const outside = new TestSession({ cwd: other, file: "/sessions/c.jsonl" });
  await harness.sessionStart(outside, "new");
  assert.equal(harness.compactors[0].stopped, true);
  const freed = new MemoryStore(project);
  freed.close();

  // A listed session claims the lock again.
  const second = new TestSession({
    cwd: project,
    file: "/sessions/b.jsonl",
    entries: [userEntry("hello")],
  });
  second.branch = second.entries;
  await harness.sessionStart(second, "resume");
  assert.equal(harness.compactors.length, 2);
  assert.equal(mainLog(project).length, 1);

  // Every shutdown releases, so the next owner is never blocked by this one.
  await harness.shutdown(second, "new");
  assert.equal(harness.compactors[1].stopped, true);
  const reopened = new MemoryStore(project);
  reopened.close();
});

test("a replacement runtime re-acquires the released lock", async () => {
  const project = projectDir();
  withProjects([project]);
  const session = new TestSession({
    cwd: project,
    file: "/sessions/a.jsonl",
    entries: [userEntry("hello")],
  });
  session.branch = session.entries;
  const first = new Harness();
  await first.sessionStart(session);
  assert.equal(first.compactors.length, 1);

  // Pi tears the runtime down and re-runs the extension factory on /new, so the
  // replacement is a second registration with its own state.
  const next = new TestSession({ cwd: project, file: "/sessions/b.jsonl" });
  await first.shutdown(session, "new");
  assert.equal(first.compactors[0].stopped, true);

  const second = new Harness();
  await second.sessionStart(next, "new");
  assert.equal(second.compactors.length, 1);
  assert.deepEqual(next.notices, []);
  await second.shutdown(next, "quit");
});

test("backfill imports the branch once, as notes, and dedupes a fork by hash", async () => {
  const project = projectDir();
  withProjects([project]);
  const entries = [userEntry("hello"), assistantEntry("hi there")];
  entries[1].parentId = entries[0].id;
  const session = new TestSession({
    cwd: project,
    file: "/sessions/resumed.jsonl",
    entries,
  });
  session.branch = entries;
  const harness = new Harness();
  await harness.sessionStart(session, "resume");

  const log = mainLog(project);
  assert.deepEqual(
    log.map((message) => message.kind),
    ["note", "note"],
  );
  assert.equal(log[0].text, "user: hello");
  assert.equal(log[1].text, "lead: hi there");
  assert.equal(harness.compactors[0].messages, 1);

  // The same session resumed again imports nothing.
  await harness.sessionStart(session, "resume");
  assert.equal(mainLog(project).length, 2);

  // A fork copies the entries verbatim into a new file: the hash dedupes them.
  const fork = new TestSession({
    cwd: project,
    file: "/sessions/fork.jsonl",
    entries: entries.map((entry) => structuredClone(entry)),
  });
  fork.branch = fork.entries;
  await harness.sessionStart(fork, "fork");
  assert.equal(mainLog(project).length, 2);

  // A fresh session imports nothing.
  const fresh = new TestSession({
    cwd: project,
    file: "/sessions/fresh.jsonl",
  });
  await harness.sessionStart(fresh, "new");
  assert.equal(mainLog(project).length, 2);
  await harness.shutdown(fresh, "quit");
});

test("every entry is logged once, whatever the branch", async () => {
  const project = projectDir();
  withProjects([project]);
  const first = userEntry("one");
  const second = assistantEntry("two", first.id);
  const session = new TestSession({
    cwd: project,
    file: "/sessions/tree.jsonl",
    entries: [first, second],
  });
  session.branch = [first, second];
  const harness = new Harness();
  await harness.sessionStart(session);
  assert.equal(mainLog(project).length, 2);
  assert.equal(harness.compactors[0].messages, 1);

  // /tree back to the first entry, then a new message on that branch.
  const third = assistantEntry("three", first.id);
  session.entries = [first, second, third];
  session.branch = [first, third];
  await harness.messageEnd(session);
  assert.deepEqual(
    mainLog(project).map((message) => [message.kind, message.text]),
    [
      ["note", "user: one"],
      ["note", "lead: two"],
      ["lead", "three"],
    ],
  );

  // A message_end with no new entries logs nothing.
  assert.equal(harness.compactors[0].messages, 2);
  await harness.messageEnd(session);
  assert.equal(harness.compactors[0].messages, 2);
  await harness.shutdown(session, "quit");
});

test("the view is frozen per turn with the grace, the abort and view.json", async () => {
  const project = projectDir();
  withProjects([project]);
  const prompt = userEntry("first message");
  const session = new TestSession({
    cwd: project,
    file: "/sessions/freeze.jsonl",
    entries: [prompt],
  });
  session.branch = [prompt];
  const harness = new Harness({ hang: true, settleGraceMs: 20 });
  await harness.sessionStart(session);

  // The turn's abort signal ends the wait early.
  const controller = new AbortController();
  session.signal = controller.signal;
  const aborted = harness.beforeAgentStart(session);
  controller.abort();
  await aborted;
  assert.equal(harness.compactors[0].settled.length, 1);
  assert.equal(harness.compactors[0].settled[0], 0);
  assert.equal(harness.compactors[0].signals[0]?.aborted, true);

  // The grace ends the wait on its own.
  session.signal = undefined;
  const started = Date.now();
  await harness.beforeAgentStart(session);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 20, `the grace ended after ${elapsed}ms`);
  assert.ok(elapsed < 5_000, `the grace ended after ${elapsed}ms`);
  assert.equal(harness.compactors[0].settled.length, 2);
  // The grace is the abort that ends the wait.
  assert.equal(harness.compactors[0].signals[1]?.aborted, true);

  // The frozen view is saved.
  const saved = savedView(project);
  assert.equal(saved.T, 1);
  assert.deepEqual(saved.chat, [[0, 0]]);
  await harness.shutdown(session, "quit");
});

test("the view replaces history and the tail follows the anchor", async () => {
  const project = projectDir();
  withProjects([project]);
  const first = userEntry("first message");
  const session = new TestSession({
    cwd: project,
    file: "/sessions/tail.jsonl",
    entries: [first],
  });
  session.branch = [first];
  const harness = new Harness();
  await harness.sessionStart(session);

  // The first turn has no memory yet: it is passed through unchanged.
  const before = harness.context(session, [{ role: "user", content: "first" }]);
  assert.equal(await before, undefined);

  await harness.beforeAgentStart(session);
  const prompt = userEntry("second message", first.id);
  session.entries = [first, prompt];
  session.branch = [first, prompt];
  await harness.messageEnd(session);

  const messages = [
    { role: "assistant", content: "first reply" },
    { role: "user", content: "second message" },
  ];
  const injected = await harness.context(session, messages);
  assert.ok(injected);
  assert.deepEqual(injected.messages.slice(1), [messages[1]]);
  const view = injected.messages[0];
  assert.equal(view.role, "user");
  assert.equal(view.content[0].text, "<chat>");
  assert.equal(view.content[view.content.length - 1].text, "</chat>");
  assert.ok(
    view.content
      .slice(1, -1)
      .some((block: any) => block.text.includes("first message")),
  );
  assert.ok(
    !view.content.some((block: any) => block.text.includes("second message")),
  );

  // The same view bytes, later in the turn, with a longer tail.
  const reply = assistantEntry("second reply", prompt.id);
  session.entries = [first, prompt, reply];
  session.branch = [first, prompt, reply];
  await harness.messageEnd(session);
  const extended = [
    ...messages,
    { role: "assistant", content: "second reply" },
  ];
  const later = await harness.context(session, extended);
  assert.ok(later);
  assert.equal(JSON.stringify(later.messages[0]), JSON.stringify(view));
  assert.deepEqual(later.messages.slice(1), extended.slice(1));

  // A compaction entry after the anchor passes the rest of the turn through.
  const compacted = compactionEntry(reply.id);
  session.entries = [first, prompt, reply, compacted];
  session.branch = [first, prompt, reply, compacted];
  assert.equal(await harness.context(session, extended), undefined);
  assert.equal(await harness.context(session, extended), undefined);
  await harness.shutdown(session, "quit");
});

test("a context edit narrows the tail to the projected messages", async () => {
  const project = projectDir();
  withProjects([project]);
  const opening = userEntry("opening");
  const anchored = assistantEntry("anchored reply", opening.id);
  const session = new TestSession({
    cwd: project,
    file: "/sessions/edited.jsonl",
    entries: [opening, anchored],
  });
  session.branch = [opening, anchored];
  const harness = new Harness();
  await harness.sessionStart(session);
  await harness.beforeAgentStart(session);

  // The turn retries: Pi omits the failed attempt's messages, then answers.
  const prompt = userEntry("second message", anchored.id);
  const failed = assistantEntry("failed attempt", prompt.id);
  const toolResult = {
    ...entryBase(failed.id),
    type: "message",
    message: {
      role: "toolResult",
      content: [{ type: "text", text: "tool output" }],
    },
  } as unknown as SessionEntry;
  const omittedFailed = omitEntry(failed.id, toolResult.id);
  const omittedTool = omitEntry(toolResult.id, omittedFailed.id);
  const retry = assistantEntry("retry reply", omittedTool.id);
  session.entries = [
    opening,
    anchored,
    prompt,
    failed,
    toolResult,
    omittedFailed,
    omittedTool,
    retry,
  ];
  session.branch = session.entries;

  // Pi's request holds the retried turn and drops the omitted attempt.
  const openingMessage = { role: "user", content: "opening" };
  const anchoredMessage = {
    role: "assistant",
    content: [{ type: "text", text: "anchored reply" }],
  };
  const promptMessage = { role: "user", content: "second message" };
  const retryMessage = {
    role: "assistant",
    content: [{ type: "text", text: "retry reply" }],
  };
  const injected = await harness.context(session, [
    openingMessage,
    anchoredMessage,
    promptMessage,
    retryMessage,
  ]);
  assert.ok(injected);
  assert.deepEqual(injected.messages.slice(1), [promptMessage, retryMessage]);
  await harness.shutdown(session, "quit");
});

test("a message that lands during the grace is in the tail, not the view", async () => {
  const project = projectDir();
  withProjects([project]);
  const opening = userEntry("opening");
  const session = new TestSession({
    cwd: project,
    file: "/sessions/grace.jsonl",
    entries: [opening],
  });
  session.branch = [opening];
  const harness = new Harness({ hang: true, settleGraceMs: 30 });
  await harness.sessionStart(session);

  // A message lands while the turn waits for the previous turn's summaries.
  const late = assistantEntry("late reply", opening.id);
  const waiting = harness.beforeAgentStart(session);
  session.entries = [opening, late];
  session.branch = [opening, late];
  await harness.messageEnd(session);
  await waiting;

  const openingMessage = { role: "user", content: "opening" };
  const lateMessage = {
    role: "assistant",
    content: [{ type: "text", text: "late reply" }],
  };
  const injected = await harness.context(session, [
    openingMessage,
    lateMessage,
  ]);
  assert.ok(injected);
  assert.ok(
    injected.messages[0].content
      .slice(1, -1)
      .every((block: any) => !block.text.includes("late reply")),
  );
  assert.deepEqual(injected.messages.slice(1), [lateMessage]);
  await harness.shutdown(session, "quit");
});

test("the last message of a turn is logged at turn_end and at shutdown", async () => {
  const project = projectDir();
  withProjects([project]);
  const prompt = userEntry("hello");
  const session = new TestSession({
    cwd: project,
    file: "/sessions/turn.jsonl",
    entries: [prompt],
  });
  session.branch = [prompt];
  const harness = new Harness();
  await harness.sessionStart(session);
  assert.deepEqual(
    mainLog(project).map((message) => message.text),
    ["user: hello"],
  );

  // Pi persists a message after its `message_end` handlers have run.
  const reply = assistantEntry("first reply", prompt.id);
  await harness.messageEnd(session);
  assert.equal(mainLog(project).length, 1);
  session.entries = [prompt, reply];
  session.branch = [prompt, reply];
  await harness.turnEnd(session);
  assert.deepEqual(
    mainLog(project).map((message) => message.text),
    ["user: hello", "first reply"],
  );

  // A shutdown flushes what no turn boundary saw.
  const last = assistantEntry("last reply", reply.id);
  session.entries = [prompt, reply, last];
  session.branch = [prompt, reply, last];
  await harness.shutdown(session, "quit");
  assert.deepEqual(
    mainLog(project).map((message) => message.text),
    ["user: hello", "first reply", "last reply"],
  );
});

test("an empty memory and an inactive session pass everything through", async () => {
  const project = projectDir();
  withProjects([project]);
  const session = new TestSession({
    cwd: project,
    file: "/sessions/empty.jsonl",
  });

  // Inactive: no session_start.
  const inactive = new Harness();
  assert.equal(await inactive.context(session, [{ role: "user" }]), undefined);

  // Active, but T is 0: a fresh project has nothing to replace.
  const harness = new Harness();
  await harness.sessionStart(session);
  await harness.beforeAgentStart(session);
  assert.equal(
    await harness.context(session, [{ role: "user", content: "hi" }]),
    undefined,
  );
  await harness.shutdown(session, "quit");
});

test("native compaction is cancelled only for the threshold reason", async () => {
  const project = projectDir();
  withProjects([project]);
  const session = new TestSession({ cwd: project, file: "/sessions/a.jsonl" });

  const inactive = new Harness();
  assert.equal(await inactive.beforeCompact(session, "threshold"), undefined);

  const harness = new Harness();
  await harness.sessionStart(session);
  assert.deepEqual(await harness.beforeCompact(session, "threshold"), {
    cancel: true,
  });
  assert.equal(await harness.beforeCompact(session, "overflow"), undefined);
  assert.equal(await harness.beforeCompact(session, "manual"), undefined);
  await harness.shutdown(session, "quit");
});

test("a role transition ends ownership at the next turn boundary", async () => {
  const project = projectDir();
  withProjects([project]);
  const prompt = userEntry("first message");
  const session = new TestSession({
    cwd: project,
    file: "/sessions/role.jsonl",
    entries: [prompt],
  });
  session.branch = [prompt];
  let ordinary = true;
  const harness = new Harness({ isOrdinaryLead: () => ordinary });
  await harness.sessionStart(session);
  assert.equal(harness.compactors.length, 1);

  ordinary = false;
  await harness.beforeAgentStart(session);
  assert.equal(harness.compactors[0].stopped, true);
  await harness.shutdown(session, "quit");
  const freed = new MemoryStore(project);
  freed.close();
});

test("a compaction failure notifies once and a shutdown stops the compactor", async () => {
  const project = projectDir();
  withProjects([project]);
  const session = new TestSession({ cwd: project, file: "/sessions/a.jsonl" });
  const harness = new Harness();
  await harness.sessionStart(session);
  const compactor = harness.compactors[0];

  compactor.options.onFailure?.({
    line: [0, 0],
    failures: 3,
    error: "provider unavailable",
  });
  compactor.options.onFailure?.({
    line: [0, 1],
    failures: 3,
    error: "provider unavailable",
  });
  assert.deepEqual(
    session.notices.map((notice) => notice.message),
    ["Project memory compaction is failing: provider unavailable"],
  );
  assert.equal(session.notices[0].type, "warning");

  await harness.shutdown(session, "quit");
  assert.equal(compactor.stopped, true);
});
