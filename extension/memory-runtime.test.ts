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
  UNBUILT_LINE,
  lineLabel,
  markViewCache,
  projectMemoryRoot,
  viewParts,
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
  /** Runs at the start of `whenSettled`, so a test can build during the wait. */
  duringSettle: (() => void) | undefined;

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
    this.duringSettle?.();
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
  /** The final system prompt the gate may count as seen. */
  systemPrompt = "";
  /** How often the gate read the prompt, so a corpus cache hit is visible. */
  systemPromptCalls = 0;

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
    (extended as { getSystemPrompt?: () => string }).getSystemPrompt = () => {
      this.systemPromptCalls += 1;
      return this.systemPrompt;
    };
    return extended;
  }
}

type HarnessOptions = {
  isOrdinaryLead?: () => boolean;
  settleGraceMs?: number;
  thinkingLevel?: string;
  hang?: boolean;
  startCompactor?: MemoryCompactorFactory;
  onActiveChange?: () => void;
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
      ...(options.onActiveChange === undefined
        ? {}
        : { onActiveChange: options.onActiveChange }),
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

  async beforeProviderRequest(
    session: TestSession,
    payload: unknown,
    api = "anthropic-messages",
  ): Promise<unknown> {
    const ctx = session.context();
    (ctx as { model?: unknown }).model = { api };
    const [result] = await this.emit(
      "before_provider_request",
      { type: "before_provider_request", payload },
      ctx,
    );
    return result;
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

  async toolCall(
    session: TestSession,
    toolName: string,
    input: Record<string, unknown>,
    toolCallId = "call-1",
  ): Promise<any> {
    const [result] = await this.emit(
      "tool_call",
      { type: "tool_call", toolName, toolCallId, input },
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
  assert.equal(view.content[0].text, "<chat>\n");
  assert.equal(view.content[view.content.length - 1].text, "</chat>\n");
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

test("a node built during the grace is in the frozen view", async () => {
  const project = projectDir();
  withProjects([project]);
  // Over 512 bytes, so the line needs a call and starts as a placeholder.
  const long = userEntry("x".repeat(600));
  const session = new TestSession({
    cwd: project,
    file: "/sessions/built.jsonl",
    entries: [long],
  });
  session.branch = session.entries;
  const harness = new Harness({ hang: true, settleGraceMs: 20 });
  await harness.sessionStart(session);
  const compactor = harness.compactors[0];
  compactor.duringSettle = () =>
    compactor.store.appendNode([0, 0], "built summary");

  await harness.beforeAgentStart(session);

  const injected = await harness.context(session, []);
  assert.ok(injected);
  const view = injected.messages[0].content
    .map((block: any) => block.text)
    .join("\n");
  assert.match(view, /built summary/);
  assert.doesNotMatch(view, /not summarized yet/);
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

// --- zoom and date ----------------------------------------------------------

const IMAGE_BLOCK = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

/**
 * A user entry whose content carries one image, so its record flags `src`. The
 * optional `id` lets a test rewrite one entry's file with a different image.
 */
function imageUserEntry(
  text: string,
  parentId: string | null = null,
  image: Record<string, unknown> = IMAGE_BLOCK,
  id?: string,
) {
  const entry = {
    ...entryBase(parentId),
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text }, { ...image }],
      timestamp: 0,
    },
  };
  if (id !== undefined) entry.id = id;
  return entry as unknown as SessionEntry;
}

/** A user entry whose content carries `count` images of `bytes` data each. */
function multiImageEntry(text: string, count: number, bytes = 4) {
  const images = Array.from({ length: count }, () => ({
    type: "image",
    data: "a".repeat(bytes),
    mimeType: "image/png",
  }));
  return {
    ...entryBase(null),
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text }, ...images],
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function writeSessionFile(
  dir: string,
  id: string,
  entry: SessionEntry,
): string {
  const file = join(dir, `${id}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id,
    timestamp: new Date().toISOString(),
    cwd: dir,
  };
  writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
  return file;
}

function memoryTool(harness: Harness, name: string): any {
  const found = harness.pi.tools.find((candidate) => candidate.name === name);
  assert.ok(found, `the ${name} tool is registered`);
  return found;
}

function callMemoryTool(
  harness: Harness,
  session: TestSession,
  name: string,
  params: Record<string, unknown>,
): Promise<any> {
  return memoryTool(harness, name).execute(
    "call",
    params,
    undefined,
    undefined,
    session.context(),
  );
}

function resultText(result: any): string {
  return result.content.map((block: any) => block.text).join("\n");
}

/** A session with four small entries, so T = 4 and every leaf is call-free. */
function fourEntrySession(project: string, file: string): TestSession {
  const entries = [
    userEntry("first"),
    assistantEntry("second"),
    userEntry("third"),
    assistantEntry("fourth"),
  ];
  entries[1].parentId = entries[0].id;
  entries[2].parentId = entries[1].id;
  entries[3].parentId = entries[2].id;
  const session = new TestSession({ cwd: project, file, entries });
  session.branch = entries;
  return session;
}

test("zoom n > 1 returns the two child lines", async () => {
  const project = projectDir();
  withProjects([project]);
  const session = fourEntrySession(project, "/sessions/zoom.jsonl");
  const harness = new Harness();
  await harness.sessionStart(session);

  const result = await callMemoryTool(harness, session, "zoom", {
    id: 0,
    n: 2,
  });
  assert.equal(
    resultText(result),
    "0+1|note: user: first\n1+1|note: lead: second",
  );
  assert.deepEqual(result.details, {
    id: 0,
    n: 2,
    ranges: [
      [0, 0],
      [0, 1],
    ],
  });
  await harness.shutdown(session, "quit");
});

test("zoom shows a placeholder for an unbuilt child and omits one past T", async () => {
  const project = projectDir();
  withProjects([project]);
  const long = userEntry("x".repeat(600));
  const short = assistantEntry("short", long.id);
  const session = new TestSession({
    cwd: project,
    file: "/sessions/placeholder.jsonl",
    entries: [long, short],
  });
  session.branch = [long, short];
  const harness = new Harness();
  await harness.sessionStart(session);

  const opened = await callMemoryTool(harness, session, "zoom", {
    id: 0,
    n: 2,
  });
  assert.equal(
    resultText(opened),
    "0+1|(not summarized yet: zoom it)\n1+1|note: lead: short",
  );

  // A child whose start is at T is omitted: T is 2, so 2+1 is not a line.
  const past = await callMemoryTool(harness, session, "zoom", { id: 0, n: 4 });
  assert.equal(resultText(past), "0+2|(not summarized yet: zoom it)");
  assert.deepEqual(past.details.ranges, [[1, 0]]);
  await harness.shutdown(session, "quit");
});

test("zoom rejects a bad n, a misaligned id and an out-of-range id", async () => {
  const project = projectDir();
  withProjects([project]);
  const session = fourEntrySession(project, "/sessions/zoom-errors.jsonl");
  const harness = new Harness();
  await harness.sessionStart(session);

  await assert.rejects(
    callMemoryTool(harness, session, "zoom", { id: 0, n: 3 }),
    /n must be a power of two/,
  );
  await assert.rejects(
    callMemoryTool(harness, session, "zoom", { id: 1, n: 2 }),
    /id must be a multiple of n/,
  );
  await assert.rejects(
    callMemoryTool(harness, session, "zoom", { id: 4, n: 1 }),
    /below the project log count 4/,
  );
  await assert.rejects(
    callMemoryTool(harness, session, "zoom", { id: -1, n: 1 }),
    /non-negative integer/,
  );
  await harness.shutdown(session, "quit");
});

test("zoom n = 1 returns the message whole with its images", async () => {
  const project = projectDir();
  withProjects([project]);
  // A real sessions directory: an old session file is read only from here.
  const dir = projectDir();
  const session = new TestSession({
    cwd: project,
    file: join(dir, "current-images.jsonl"),
  });
  const harness = new Harness();
  await harness.sessionStart(session);
  const store = harness.compactors[0].store;

  // The current session: the image lives in its in-memory entries.
  const current = imageUserEntry("look here");
  session.entries = [current];
  store.appendMessage({
    kind: "user",
    text: "look here",
    size: 9,
    date: current.timestamp,
    src: { session: session.file!, entry: current.id, part: 0, images: true },
    hash: "image-current",
  });
  const fromCurrent = await callMemoryTool(harness, session, "zoom", {
    id: 0,
    n: 1,
  });
  assert.equal(fromCurrent.content[0].text, "user: look here");
  assert.deepEqual(fromCurrent.content[1], IMAGE_BLOCK);
  assert.equal(fromCurrent.details.session, session.file);

  // An older session file in the same directory: its images come back.
  const older = imageUserEntry("from before");
  const olderFile = writeSessionFile(dir, "older-session", older);
  store.appendMessage({
    kind: "user",
    text: "from before",
    size: 11,
    date: older.timestamp,
    src: { session: olderFile, entry: older.id, part: 0, images: true },
    hash: "image-older",
  });
  const fromFile = await callMemoryTool(harness, session, "zoom", {
    id: 1,
    n: 1,
  });
  assert.equal(fromFile.content[0].text, "user: from before");
  assert.deepEqual(fromFile.content[1], IMAGE_BLOCK);

  // A session file that is gone is reported, not hidden.
  store.appendMessage({
    kind: "user",
    text: "gone image",
    size: 10,
    date: older.timestamp,
    src: {
      session: `/nonexistent/${randomUUID()}.jsonl`,
      entry: "gone",
      part: 0,
      images: true,
    },
    hash: "image-gone",
  });
  const fromGone = await callMemoryTool(harness, session, "zoom", {
    id: 2,
    n: 1,
  });
  assert.equal(fromGone.content[0].text, "user: gone image");
  assert.equal(
    fromGone.content[1].text,
    "[image unavailable: session file missing]",
  );
  await harness.shutdown(session, "quit");
});

test("an id from an earlier session resolves from a new session", async () => {
  const project = projectDir();
  withProjects([project]);
  const first = new TestSession({
    cwd: project,
    file: "/sessions/earlier.jsonl",
    entries: [userEntry("kept across sessions")],
  });
  first.branch = first.entries;
  const harness = new Harness();
  await harness.sessionStart(first);
  await harness.shutdown(first, "quit");

  const second = new TestSession({
    cwd: project,
    file: "/sessions/later.jsonl",
  });
  await harness.sessionStart(second, "new");
  const result = await callMemoryTool(harness, second, "zoom", {
    id: 0,
    n: 1,
  });
  assert.equal(result.content[0].text, "note: user: kept across sessions");
  await harness.shutdown(second, "quit");
});

test("date formats the record in local time with its UTC offset and rejects a range", async () => {
  const project = projectDir();
  withProjects([project]);
  const entry = userEntry("dated");
  entry.timestamp = "2026-01-02T03:04:05.000Z";
  const session = new TestSession({
    cwd: project,
    file: "/sessions/date.jsonl",
    entries: [entry],
  });
  session.branch = [entry];
  const harness = new Harness();
  await harness.sessionStart(session);

  const result = await callMemoryTool(harness, session, "date", { id: 0 });
  const text = result.content[0].text as string;
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/);
  const [day, clock, offset] = text.split(" ");
  assert.equal(
    Date.parse(`${day}T${clock}${offset}`),
    Date.parse(entry.timestamp),
  );
  assert.equal(result.details.date, text);

  await assert.rejects(
    callMemoryTool(harness, session, "date", { id: 1 }),
    /below the project log count 1/,
  );
  await harness.shutdown(session, "quit");
});

test("the memory tools are registered but inactive without memory", async () => {
  const harness = new Harness();
  assert.equal(memoryTool(harness, "zoom").defaultActive, false);
  assert.equal(memoryTool(harness, "date").defaultActive, false);
  assert.ok(!harness.pi.pi.getActiveTools().includes("zoom"));
  assert.ok(!harness.pi.pi.getActiveTools().includes("date"));

  const session = new TestSession({
    cwd: projectDir(),
    file: "/sessions/inactive.jsonl",
  });
  await assert.rejects(
    callMemoryTool(harness, session, "zoom", { id: 0, n: 1 }),
    /Project memory is not active/,
  );
  await assert.rejects(
    callMemoryTool(harness, session, "date", { id: 0 }),
    /Project memory is not active/,
  );
});

test("an empty project reports the empty log to zoom and date", async () => {
  const project = projectDir();
  withProjects([project]);
  const session = new TestSession({
    cwd: project,
    file: "/sessions/empty-log.jsonl",
  });
  const harness = new Harness();
  await harness.sessionStart(session);

  await assert.rejects(
    callMemoryTool(harness, session, "zoom", { id: 0, n: 1 }),
    /the log is empty/,
  );
  await assert.rejects(
    callMemoryTool(harness, session, "date", { id: 0 }),
    /the log is empty/,
  );
  await harness.shutdown(session, "quit");
});

// --- review fixes -----------------------------------------------------------

test("a mid-turn role change ends ownership without re-projecting tools", async () => {
  const project = projectDir();
  withProjects([project]);
  const session = new TestSession({
    cwd: project,
    file: "/sessions/role-midturn.jsonl",
    entries: [userEntry("hello")],
  });
  session.branch = session.entries;
  let ordinary = true;
  const changes: number[] = [];
  const harness = new Harness({
    isOrdinaryLead: () => ordinary,
    onActiveChange: () => changes.push(1),
  });
  await harness.sessionStart(session);
  assert.equal(harness.compactors.length, 1);
  assert.equal(changes.length, 1); // activation notifies once

  // A mid-turn role change deactivates silently: no tool re-projection.
  ordinary = false;
  await harness.messageEnd(session);
  assert.equal(changes.length, 1);
  assert.equal(harness.compactors[0].stopped, true);

  await harness.shutdown(session, "quit");
  assert.equal(changes.length, 1);
});

test("deactivation at a session boundary re-projects the Lead tools", async () => {
  const project = projectDir();
  withProjects([project]);
  const session = new TestSession({
    cwd: project,
    file: "/sessions/role-boundary.jsonl",
  });
  const changes: number[] = [];
  const harness = new Harness({ onActiveChange: () => changes.push(1) });
  await harness.sessionStart(session);
  assert.equal(changes.length, 1);

  await harness.shutdown(session, "quit");
  assert.equal(changes.length, 2);
});

test("zoom refuses an image source outside the sessions directory", async () => {
  const project = projectDir();
  withProjects([project]);
  const sessions = projectDir();
  const session = new TestSession({
    cwd: project,
    file: join(sessions, "current.jsonl"),
  });
  const harness = new Harness();
  await harness.sessionStart(session);
  const store = harness.compactors[0].store;

  // A real .jsonl file with an image, but outside the sessions directory.
  const outside = imageUserEntry("outside");
  const outsideFile = writeSessionFile(
    projectDir(),
    "outside-session",
    outside,
  );
  store.appendMessage({
    kind: "user",
    text: "outside",
    size: 7,
    date: outside.timestamp,
    src: { session: outsideFile, entry: outside.id, part: 0, images: true },
    hash: "image-outside",
  });
  const result = await callMemoryTool(harness, session, "zoom", {
    id: 0,
    n: 1,
  });
  assert.equal(result.content[0].text, "user: outside");
  assert.equal(result.content.length, 2);
  assert.equal(
    result.content[1].text,
    "[image unavailable: session file missing]",
  );

  // A path with no .jsonl extension is refused before it is read.
  store.appendMessage({
    kind: "user",
    text: "passwd",
    size: 6,
    date: outside.timestamp,
    src: { session: "/etc/passwd", entry: "x", part: 0, images: true },
    hash: "image-passwd",
  });
  const passwd = await callMemoryTool(harness, session, "zoom", {
    id: 1,
    n: 1,
  });
  assert.equal(passwd.content.length, 2);
  assert.equal(
    passwd.content[1].text,
    "[image unavailable: session file missing]",
  );
  await harness.shutdown(session, "quit");
});

test("zoom re-parses an old session file rather than caching it", async () => {
  const project = projectDir();
  withProjects([project]);
  const sessions = projectDir();
  const session = new TestSession({
    cwd: project,
    file: join(sessions, "current.jsonl"),
  });
  const harness = new Harness();
  await harness.sessionStart(session);
  const store = harness.compactors[0].store;

  const older = imageUserEntry("first image");
  const olderFile = writeSessionFile(sessions, "older-session", older);
  store.appendMessage({
    kind: "user",
    text: "first image",
    size: 11,
    date: older.timestamp,
    src: { session: olderFile, entry: older.id, part: 0, images: true },
    hash: "image-cached",
  });
  const first = await callMemoryTool(harness, session, "zoom", { id: 0, n: 1 });
  assert.deepEqual(first.content[1], IMAGE_BLOCK);

  // The same entry id now carries a different image. A cache would keep the
  // old one; re-parsing returns the file as it is now.
  const changed = { type: "image", data: "d29ybGQ=", mimeType: "image/png" };
  const updated = imageUserEntry("first image", null, changed, older.id);
  writeSessionFile(sessions, "older-session", updated);
  const second = await callMemoryTool(harness, session, "zoom", {
    id: 0,
    n: 1,
  });
  assert.deepEqual(second.content[1], changed);
  await harness.shutdown(session, "quit");
});

test("zoom caps the number and size of images it returns", async () => {
  const project = projectDir();
  withProjects([project]);
  const session = new TestSession({
    cwd: project,
    file: "/sessions/capped.jsonl",
  });
  const harness = new Harness();
  await harness.sessionStart(session);
  const store = harness.compactors[0].store;

  // Five small images: four come back and the fifth is noted.
  const many = multiImageEntry("five images", 5);
  session.entries = [many];
  store.appendMessage({
    kind: "user",
    text: "five images",
    size: 11,
    date: many.timestamp,
    src: { session: session.file!, entry: many.id, part: 0, images: true },
    hash: "image-many",
  });
  const countCapped = await callMemoryTool(harness, session, "zoom", {
    id: 0,
    n: 1,
  });
  assert.equal(
    countCapped.content.filter((block: any) => block.type === "image").length,
    4,
  );
  assert.equal(
    (countCapped.content.at(-1) as any).text,
    "[1 image(s) omitted]",
  );

  // One image past the byte cap: none come back, and the note says so.
  const big = multiImageEntry("big image", 1, 5 * 1024 * 1024 + 1);
  session.entries = [big];
  store.appendMessage({
    kind: "user",
    text: "big image",
    size: 9,
    date: big.timestamp,
    src: { session: session.file!, entry: big.id, part: 0, images: true },
    hash: "image-big",
  });
  const bytesCapped = await callMemoryTool(harness, session, "zoom", {
    id: 1,
    n: 1,
  });
  assert.equal(
    bytesCapped.content.filter((block: any) => block.type === "image").length,
    0,
  );
  assert.equal(
    (bytesCapped.content.at(-1) as any).text,
    "[1 image(s) omitted]",
  );
  await harness.shutdown(session, "quit");
});

// --- the zoom gate ----------------------------------------------------------

const GATE_UUID = "11111111-1111-4111-8111-111111111111";
/** A UUID with hex letters, so its case is observable. */
const LETTER_UUID = "abcdefab-1234-4abc-8def-abcdefabcdef";
const OTHER_UUID = "22222222-2222-4222-8222-222222222222";

function chained(texts: string[]): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let parent: string | null = null;
  for (const text of texts) {
    const entry = userEntry(text, parent);
    entries.push(entry);
    parent = entry.id;
  }
  return entries;
}

function gateToolResult(
  text: string,
  toolName: string,
  parentId: string | null,
): SessionEntry {
  return {
    ...entryBase(parentId),
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: `gate-${entryCounter}`,
      toolName,
      content: [{ type: "text", text }],
      isError: false,
      timestamp: Date.now(),
    },
  } as unknown as SessionEntry;
}

/** An assistant message whose only block is a bash tool call. */
function assistantBashCall(
  command: string,
  parentId: string | null,
): SessionEntry {
  return {
    ...entryBase(parentId),
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: { command } }],
    },
  } as unknown as SessionEntry;
}

/** The user's own `!cmd`: Pi records it as a `bashExecution` message. */
function bashExecutionEntry(
  command: string,
  parentId: string | null,
): SessionEntry {
  return {
    ...entryBase(parentId),
    type: "message",
    message: {
      role: "bashExecution",
      command,
      output: "",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function pushEntry(session: TestSession, entry: SessionEntry): void {
  session.entries = [...session.entries, entry];
  session.branch = session.entries;
}

function lastId(session: TestSession): string | null {
  return session.branch[session.branch.length - 1]?.id ?? null;
}

function gateEntries(harness: Harness): any[] {
  return harness.pi.entries
    .filter((entry: any) => entry.customType === "pi-herdsman-memory-gate")
    .map((entry: any) => entry.data);
}

/** A frozen turn whose view is the given texts, with an empty corpus. */
async function gateSession(
  view: string[],
  systemPrompt = "",
): Promise<{ project: string; session: TestSession; harness: Harness }> {
  const project = projectDir();
  withProjects([project]);
  const entries = chained(view);
  const session = new TestSession({
    cwd: project,
    file: "/sessions/gate.jsonl",
    entries,
  });
  session.branch = entries;
  session.systemPrompt = systemPrompt;
  const harness = new Harness();
  await harness.sessionStart(session);
  await harness.beforeAgentStart(session);
  return { project, session, harness };
}

/** The `id+n` label the frozen view holds for a value. */
function viewLabel(harness: Harness, value: string): string {
  const line = harness.compactors[0].store.latestLineContaining(value);
  assert.ok(line, `the view holds ${value}`);
  return lineLabel(line);
}

test("the gate blocks a strict UUID that only the view holds", async () => {
  const { session, harness } = await gateSession([`session ${GATE_UUID}`]);
  const result = await harness.toolCall(session, "continue_agent", {
    session: GATE_UUID,
    task: "continue",
  });
  assert.equal(result.block, true);
  assert.ok(result.reason.includes(`zoom ${viewLabel(harness, GATE_UUID)}`));
  assert.match(result.reason, /not seen verbatim this turn/);
  assert.doesNotMatch(result.reason, /not in the view/);
  assert.match(result.reason, /Retry the call after the zoom result arrives/);
  await harness.shutdown(session, "quit");
});

test("the same UUID from this turn's zoom result is allowed", async () => {
  const { session, harness } = await gateSession(["opening"]);
  pushEntry(
    session,
    gateToolResult(`session ${GATE_UUID}`, "zoom", lastId(session)),
  );
  const result = await harness.toolCall(session, "continue_agent", {
    session: GATE_UUID,
    task: "continue",
  });
  assert.equal(result, undefined);
  await harness.shutdown(session, "quit");
});

test("a UUID the user typed this turn passes, whatever its case", async () => {
  const { session, harness } = await gateSession(["opening"]);
  pushEntry(
    session,
    userEntry(`session ${GATE_UUID.toUpperCase()}`, lastId(session)),
  );
  const result = await harness.toolCall(session, "continue_agent", {
    session: GATE_UUID,
    task: "continue",
  });
  assert.equal(result, undefined);
  await harness.shutdown(session, "quit");
});

test("a ref the user typed this turn is allowed", async () => {
  const { session, harness } = await gateSession(["opening"]);
  pushEntry(session, userEntry("use result:researcher#1", lastId(session)));
  const result = await harness.toolCall(session, "delegate_agent", {
    definition: "researcher",
    task: "do it",
    files: ["result:researcher#1"],
  });
  assert.equal(result, undefined);
  await harness.shutdown(session, "quit");
});

test("a ref that appears nowhere is blocked as not in the view", async () => {
  const { session, harness } = await gateSession(["opening"]);
  const result = await harness.toolCall(session, "delegate_agent", {
    definition: "researcher",
    task: "copy result:nowhere#1",
  });
  assert.equal(result.block, true);
  assert.match(
    result.reason,
    /blocked: "result:nowhere#1" not seen verbatim this turn and not in the view/,
  );
  await harness.shutdown(session, "quit");
});

test("an edit path only the view holds is blocked until a read shows it", async () => {
  const { project, session, harness } = await gateSession([
    "see docs/notes.md",
  ]);
  const relativePath = "docs/notes.md";
  const absolutePath = join(project, relativePath);

  const blocked = await harness.toolCall(session, "edit", {
    path: relativePath,
    edits: [{ oldText: "a", newText: "b" }],
  });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /not seen verbatim this turn/);

  pushEntry(
    session,
    gateToolResult(`read ${absolutePath}`, "read", lastId(session)),
  );
  assert.equal(
    await harness.toolCall(session, "edit", { path: relativePath, edits: [] }),
    undefined,
  );
  assert.equal(
    await harness.toolCall(session, "edit", { path: absolutePath, edits: [] }),
    undefined,
  );
  await harness.shutdown(session, "quit");
});

test("write creates a new file but is blocked on an existing one held by the view", async () => {
  const { project, session, harness } = await gateSession([
    "overwrite existing.md",
  ]);
  assert.equal(
    await harness.toolCall(session, "write", { path: "new.md", content: "x" }),
    undefined,
  );
  writeFileSync(join(project, "existing.md"), "old");
  const blocked = await harness.toolCall(session, "write", {
    path: "existing.md",
    content: "new",
  });
  assert.equal(blocked.block, true);
  await harness.shutdown(session, "quit");
});

test("a path that appears nowhere is allowed", async () => {
  const { session, harness } = await gateSession(["opening"]);
  assert.equal(
    await harness.toolCall(session, "edit", {
      path: "missing/gone.md",
      edits: [],
    }),
    undefined,
  );
  await harness.shutdown(session, "quit");
});

test("the agent, label and definition fields are never checked", async () => {
  const { session, harness } = await gateSession(["opening"]);
  pushEntry(session, userEntry("use result:researcher#1", lastId(session)));
  // The agent is a UUID that appears nowhere; only the ref inside the message
  // is checked, so the call passes.
  assert.equal(
    await harness.toolCall(session, "reply_agent", {
      agent: OTHER_UUID,
      message: "use result:researcher#1",
    }),
    undefined,
  );
  assert.equal(
    await harness.toolCall(session, "delegate_agent", {
      definition: "researcher",
      task: "do it",
      label: "fresh-label",
      files: ["result:researcher#1"],
    }),
    undefined,
  );
  await harness.shutdown(session, "quit");
});

test("the gate is inert without memory, a freeze or with the fallback", async () => {
  // No session_start: memory owns nothing.
  const off = projectDir();
  withProjects([off]);
  const offSession = new TestSession({ cwd: off, file: "/sessions/off.jsonl" });
  const offHarness = new Harness();
  assert.equal(
    await offHarness.toolCall(offSession, "continue_agent", {
      session: GATE_UUID,
      task: "go",
    }),
    undefined,
  );

  // Started, but no turn has frozen a view.
  const cold = projectDir();
  withProjects([cold]);
  const coldSession = new TestSession({
    cwd: cold,
    file: "/sessions/cold.jsonl",
    entries: chained(["opening"]),
  });
  coldSession.branch = coldSession.entries;
  const coldHarness = new Harness();
  await coldHarness.sessionStart(coldSession);
  assert.equal(
    await coldHarness.toolCall(coldSession, "continue_agent", {
      session: GATE_UUID,
      task: "go",
    }),
    undefined,
  );
  await coldHarness.shutdown(coldSession, "quit");

  // A fallback turn: the tail no longer maps onto the view.
  const { session, harness } = await gateSession(["opening"]);
  pushEntry(session, compactionEntry(lastId(session)));
  await harness.context(session, []);
  assert.equal(
    await harness.toolCall(session, "continue_agent", {
      session: GATE_UUID,
      task: "go",
    }),
    undefined,
  );
  await harness.shutdown(session, "quit");
});

test("a gate entry records each identifier and the zoomBefore state", async () => {
  const { session, harness } = await gateSession(["opening"]);
  pushEntry(session, gateToolResult(GATE_UUID, "zoom", lastId(session)));
  await harness.toolCall(session, "continue_agent", {
    session: GATE_UUID,
    task: "go",
  });
  // Still unprompted: no block has happened yet.
  await harness.toolCall(session, "continue_agent", {
    session: GATE_UUID,
    task: "go again",
  });
  const blocked = await harness.toolCall(session, "delegate_agent", {
    definition: "researcher",
    task: "use result:nowhere#1",
  });
  assert.equal(blocked.block, true);
  // The block ends the unprompted streak.
  await harness.toolCall(session, "continue_agent", {
    session: GATE_UUID,
    task: "after",
  });

  const entries = gateEntries(harness);
  assert.equal(entries.length, 4);
  assert.deepEqual(
    entries.map((entry) => entry.zoomBefore),
    [true, true, true, false],
  );
  assert.deepEqual(
    entries.map((entry) => entry.blocked),
    [false, false, true, false],
  );
  assert.equal(entries[0].tool, "continue_agent");
  assert.equal(entries[0].toolCallId, "call-1");
  assert.deepEqual(entries[0].identifiers, [
    {
      value: GATE_UUID,
      class: "uuid",
      inView: false,
      inCorpus: true,
      source: "zoom",
    },
  ]);
  await harness.shutdown(session, "quit");
});

test("a gate entry names the part of the turn that showed each identifier", async () => {
  const { session, harness } = await gateSession(["opening"]);
  pushEntry(
    session,
    gateToolResult(`zoomed ${GATE_UUID}`, "zoom", lastId(session)),
  );
  await harness.toolCall(session, "continue_agent", {
    session: GATE_UUID,
    task: "go",
  });
  pushEntry(
    session,
    gateToolResult(`read ${LETTER_UUID}`, "read", lastId(session)),
  );
  await harness.toolCall(session, "continue_agent", {
    session: LETTER_UUID,
    task: "go",
  });
  pushEntry(session, userEntry(`typed ${OTHER_UUID}`, lastId(session)));
  await harness.toolCall(session, "continue_agent", {
    session: OTHER_UUID,
    task: "go",
  });
  const blocked = await harness.toolCall(session, "delegate_agent", {
    definition: "researcher",
    task: "use result:nowhere#1",
  });
  assert.equal(blocked.block, true);
  assert.deepEqual(
    gateEntries(harness).map((entry) =>
      entry.identifiers.map((identifier: any) => identifier.source),
    ),
    [["zoom"], ["tool"], ["user"], ["none"]],
  );
  await harness.shutdown(session, "quit");
});

test("the third block of one identifier adds the ask-the-user line", async () => {
  const { session, harness } = await gateSession(["opening"]);
  const input = { definition: "researcher", task: "use result:nowhere#1" };
  const first = await harness.toolCall(session, "delegate_agent", input);
  const second = await harness.toolCall(session, "delegate_agent", input);
  const third = await harness.toolCall(session, "delegate_agent", input);
  assert.doesNotMatch(first.reason, /ask the user/);
  assert.doesNotMatch(second.reason, /ask the user/);
  assert.match(third.reason, /ask the user for it/);
  await harness.shutdown(session, "quit");
});

test("a value past the echo clip is still in the corpus", async () => {
  const { session, harness } = await gateSession(["opening"]);
  // `clipEcho` keeps the 30 KB head and tail; this value sits in the middle.
  const body = `${"x".repeat(20_000)}${GATE_UUID}${"y".repeat(20_000)}`;
  pushEntry(session, gateToolResult(body, "read", lastId(session)));
  const result = await harness.toolCall(session, "continue_agent", {
    session: GATE_UUID,
    task: "continue",
  });
  assert.equal(result, undefined);
  await harness.shutdown(session, "quit");
});

test("the view lookup for a UUID ignores case", async () => {
  const upper = LETTER_UUID.toUpperCase();
  const { session, harness } = await gateSession([`session ${upper}`]);
  const result = await harness.toolCall(session, "continue_agent", {
    session: LETTER_UUID,
    task: "continue",
  });
  assert.equal(result.block, true);
  assert.ok(result.reason.includes(`zoom ${viewLabel(harness, upper)}`));
  assert.doesNotMatch(result.reason, /not in the view/);
  await harness.shutdown(session, "quit");
});

test("the corpus cache survives the gate's own audit entries", async () => {
  const { session, harness } = await gateSession(["opening"]);
  await harness.toolCall(session, "continue_agent", {
    session: GATE_UUID,
    task: "go",
  });
  const first = session.systemPromptCalls;
  assert.equal(first, 1);
  // Pi appends the gate entry to the session; the next call must reuse the corpus.
  pushEntry(session, {
    ...entryBase(lastId(session)),
    type: "custom",
    customType: "pi-herdsman-memory-gate",
    data: {},
  } as unknown as SessionEntry);
  await harness.toolCall(session, "continue_agent", {
    session: GATE_UUID,
    task: "go",
  });
  assert.equal(session.systemPromptCalls, first);
  await harness.shutdown(session, "quit");
});

test("an assistant bash call is not corpus text but the user's own command is", async () => {
  // The assistant's tool arguments never count.
  const assistant = await gateSession(["opening"]);
  pushEntry(
    assistant.session,
    assistantBashCall(`echo ${GATE_UUID}`, lastId(assistant.session)),
  );
  const refused = await assistant.harness.toolCall(
    assistant.session,
    "continue_agent",
    { session: GATE_UUID, task: "continue" },
  );
  assert.equal(refused.block, true);
  await assistant.harness.shutdown(assistant.session, "quit");

  // The user's `!cmd` is their own words.
  const user = await gateSession(["opening"]);
  pushEntry(
    user.session,
    bashExecutionEntry(`echo ${GATE_UUID}`, lastId(user.session)),
  );
  assert.equal(
    await user.harness.toolCall(user.session, "continue_agent", {
      session: GATE_UUID,
      task: "continue",
    }),
    undefined,
  );
  await user.harness.shutdown(user.session, "quit");
});

// --- the view cache mark ----------------------------------------------------

const CACHE_MARK = { type: "ephemeral" };

/** One fully built 4-line view block, as `renderBlocks` would emit it. */
function builtBlock(index: number): string {
  return [0, 1, 2, 3]
    .map((row) => `${index * 4 + row}|summary ${index * 4 + row}`)
    .join("\n");
}

/** An Anthropic Messages payload whose first message is the injected view. */
function markedPayload(blocks: string[], extraMarks = 0): any {
  const payload: any = {
    model: "claude-haiku-4-5",
    system: [{ type: "text", text: "system", cache_control: CACHE_MARK }],
    tools: [{ name: "zoom", cache_control: CACHE_MARK }],
    messages: [
      {
        role: "user",
        content: viewParts(blocks),
      },
      {
        role: "user",
        content: [{ type: "text", text: "next", cache_control: CACHE_MARK }],
      },
    ],
  };
  for (let index = 0; index < extraMarks; index += 1)
    payload.tools.push({ name: `tool-${index}`, cache_control: CACHE_MARK });
  return payload;
}

function countMarks(payload: unknown): number {
  return JSON.stringify(payload).split("cache_control").length - 1;
}

test("the view mark lands on the last fully built block", () => {
  const payload = markedPayload([builtBlock(0), builtBlock(1)]);
  const result = markViewCache(payload) as any;
  assert.ok(result);
  // content: 0 <chat>, 1 block0, 2 block1, 3 </chat>.
  assert.deepEqual(result.messages[0].content[2].cache_control, CACHE_MARK);
  assert.equal(result.messages[0].content[1].cache_control, undefined);
  assert.equal(countMarks(result), countMarks(payload) + 1);

  // Everything but the added mark is deep-equal to the input.
  const stripped = JSON.parse(JSON.stringify(result));
  delete stripped.messages[0].content[2].cache_control;
  assert.deepEqual(stripped, JSON.parse(JSON.stringify(payload)));
});

test("a placeholder in the last block moves the mark to the previous block", () => {
  const last = [
    "4|summary 4",
    "5|summary 5",
    `6|${UNBUILT_LINE}`,
    "7|summary 7",
  ].join("\n");
  const result = markViewCache(markedPayload([builtBlock(0), last])) as any;
  assert.ok(result);
  assert.deepEqual(result.messages[0].content[1].cache_control, CACHE_MARK);
  assert.equal(result.messages[0].content[2].cache_control, undefined);
});

test("the view mark is a no-op on unexpected shapes", () => {
  for (const payload of [
    undefined,
    null,
    "text",
    { messages: "not an array" },
    { messages: [] },
    { messages: [{ role: "user", content: "plain" }] },
    {
      messages: [{ role: "user", content: [{ type: "text", text: "<chat>" }] }],
    },
  ])
    assert.equal(markViewCache(payload), undefined);
});

test("the view mark is a no-op when four marks already exist", () => {
  const payload = markedPayload([builtBlock(0)], 1);
  assert.equal(countMarks(payload), 4);
  assert.equal(markViewCache(payload), undefined);
});

test("the view mark is a no-op when no block is fully built", () => {
  const partial = "0|summary 0\n1|summary 1";
  const unbuilt = `0|${UNBUILT_LINE}\n1|summary 1\n2|summary 2\n3|summary 3`;
  assert.equal(markViewCache(markedPayload([partial, unbuilt])), undefined);
});

test("the handler marks only an active memory's Anthropic view", async () => {
  const project = projectDir();
  withProjects([project]);
  const prompt = userEntry("first message");
  const session = new TestSession({
    cwd: project,
    file: "/sessions/mark.jsonl",
    entries: [prompt],
  });
  session.branch = [prompt];
  const harness = new Harness();
  await harness.sessionStart(session);

  const payload = () => markedPayload([builtBlock(0)]);

  // No frozen view yet: the turn has not started.
  assert.equal(
    await harness.beforeProviderRequest(session, payload()),
    undefined,
  );

  await harness.beforeAgentStart(session);
  const marked = (await harness.beforeProviderRequest(
    session,
    payload(),
  )) as any;
  assert.ok(marked);
  assert.deepEqual(marked.messages[0].content[1].cache_control, CACHE_MARK);

  // A non-Anthropic model is left alone.
  assert.equal(
    await harness.beforeProviderRequest(
      session,
      payload(),
      "openai-completions",
    ),
    undefined,
  );
  await harness.shutdown(session, "quit");

  // Memory inactive: the project is no longer listed.
  withProjects([]);
  const inactive = new TestSession({
    cwd: project,
    file: "/sessions/inactive-mark.jsonl",
    entries: [prompt],
  });
  inactive.branch = [prompt];
  const other = new Harness();
  await other.sessionStart(inactive);
  await other.beforeAgentStart(inactive);
  assert.equal(
    await other.beforeProviderRequest(inactive, payload()),
    undefined,
  );
  await other.shutdown(inactive, "quit");
  withProjects([project]);
});

test("usage entries are appended per compaction", async () => {
  const project = projectDir();
  withProjects([project]);
  const prompt = userEntry("first message");
  const session = new TestSession({
    cwd: project,
    file: "/sessions/usage.jsonl",
    entries: [prompt],
  });
  session.branch = [prompt];
  const harness = new Harness();
  await harness.sessionStart(session);
  harness.compactors[0].options.onUsage?.({
    line: [0, 0],
    kind: "leaf",
    input: 1,
    output: 2,
    reasoning: 1,
    cacheRead: 3,
    cacheWrite: 4,
    attempts: 2,
    retries: 1,
  });
  assert.deepEqual(
    harness.pi.entries.filter(
      (entry: any) => entry.customType === "pi-herdsman-memory-usage",
    ),
    [
      {
        type: "custom",
        customType: "pi-herdsman-memory-usage",
        data: {
          node: [0, 0],
          kind: "leaf",
          input: 1,
          output: 2,
          reasoning: 1,
          cacheRead: 3,
          cacheWrite: 4,
          attempts: 2,
          retries: 1,
        },
      },
    ],
  );
  await harness.shutdown(session, "quit");
});
