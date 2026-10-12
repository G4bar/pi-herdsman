/**
 * Project memory session wiring for the ordinary Lead: activation and project
 * ownership, live logging, backfill, the per-turn view freeze, view injection
 * and the native compaction policy.
 *
 * The store owns the log and the view math, the compactor owns the model calls;
 * this module owns the Pi events.
 */
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  sessionEntryToContextMessages,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import { readConfig } from "./config.ts";
import { ProcessLockOccupiedError, readProcessLockStatus } from "./lock.ts";
import {
  MemoryStore,
  deriveMessages,
  projectMemoryRoot,
  type DerivedMessage,
  type ViewLine,
} from "./memory.ts";
import {
  start as startMemoryCompactor,
  type MemoryCompactor,
  type MemoryCompactorFailure,
  type MemoryCompactorOptions,
} from "./memory-compactor.ts";

/** The per-turn settle grace: after this the view freezes with placeholders. */
export const TURN_SETTLE_GRACE_MS = 30_000;
const VIEW_OPEN = "<chat>";
const VIEW_CLOSE = "</chat>";

export type MemoryCompactorFactory = (
  store: MemoryStore,
  ctx: ExtensionContext,
  options: MemoryCompactorOptions,
) => MemoryCompactor;

export type MemoryRuntimeOptions = {
  /**
   * True when the current session is an ordinary Lead session: never Manager,
   * Chief, `managed-lead`, or a managed Agent.
   */
  isOrdinaryLead(): boolean;
  /** The per-turn settle grace. Tests shorten it. */
  settleGraceMs?: number;
  /** The compactor factory. Tests inject a fake. */
  startCompactor?: MemoryCompactorFactory;
};

type ContextMessage = ContextEvent["messages"][number];

/** One turn's frozen view: what the request injects until the next prompt. */
type FrozenTurn = {
  /** The rendered 4-line blocks, in order. */
  blocks: string[];
  /** The view line ranges the blocks cover. An empty list means T is 0. */
  lines: ViewLine[];
  /** The last context-producing entry before the prompt, or none when fresh. */
  anchor: string | null;
  /** Fixed with the freeze, so every call in the turn injects the same message. */
  timestamp: number;
  /** Set when the tail cannot be mapped: the rest of the turn stays native. */
  fallback: boolean;
};

type ActiveMemory = {
  store: MemoryStore;
  compactor: MemoryCompactor;
  /** The owning session's ctx, rebound on every `session_start`. */
  ctx: ExtensionContext;
  /** The realpath of the owned project. */
  project: string;
  /** The owning session file. */
  session: string;
  /** Entries already examined in `getEntries()`. */
  scanned: number;
  /** Entry ids already in the log, so a rescan never logs one twice. */
  logged: Set<string>;
  frozen: FrozenTurn | undefined;
  /** True once a compaction failure was reported, so an outage notifies once. */
  reported: boolean;
};

export function registerMemoryRuntime(
  pi: ExtensionAPI,
  options: MemoryRuntimeOptions,
): void {
  const settleGraceMs = options.settleGraceMs ?? TURN_SETTLE_GRACE_MS;
  const startCompactor = options.startCompactor ?? startMemoryCompactor;
  let active: ActiveMemory | undefined;

  function notify(
    ctx: ExtensionContext,
    message: string,
    type: "info" | "warning" | "error" = "warning",
  ): void {
    try {
      ctx.ui.notify(message, type);
    } catch {
      // A UI that cannot take a notice must not fail the session.
    }
  }

  /** Stops the compactor and releases the project lock. */
  function deactivate(): void {
    const memory = active;
    if (!memory) return;
    active = undefined;
    try {
      memory.compactor.stop();
    } catch {
      // Nothing partial is appended either way.
    }
    try {
      memory.store.close();
    } catch {
      // A lock that changed owner is not this session's to release.
    }
  }

  /** Names the live owner, so a second concurrent session is not a mystery. */
  function lockMessage(project: string): string {
    try {
      const { claim } = readProcessLockStatus(
        join(projectMemoryRoot(project), "lock"),
        "project memory",
      );
      return `Project memory is already open in process ${claim.pid}`;
    } catch {
      return "Project memory is already open in another process";
    }
  }

  function reportCompactionFailure(failure: MemoryCompactorFailure): void {
    const memory = active;
    if (!memory || memory.reported) return;
    memory.reported = true;
    notify(
      memory.ctx,
      `Project memory compaction is failing: ${failure.error}`,
    );
  }

  /**
   * The active memory while this session is still an ordinary Lead. A role
   * transition ends ownership at the next memory event (ADR 0020).
   */
  function owning(): ActiveMemory | undefined {
    if (!active) return undefined;
    if (options.isOrdinaryLead()) return active;
    deactivate();
    return undefined;
  }

  function activate(ctx: ExtensionContext): void {
    const project = listedProject(ctx.cwd);
    // A session outside an opted-in project, or outside the ordinary Lead
    // role, ends ownership: the lock is held across the sessions of one project.
    if (project === undefined || !options.isOrdinaryLead()) {
      deactivate();
      return;
    }
    if (active && active.project !== project) deactivate();
    // Pi's read-only session manager omits `isPersisted()`; a persisted session
    // always carries its file and an in-memory one never does.
    const session = ctx.sessionManager.getSessionFile();
    if (session === undefined) {
      deactivate();
      return;
    }
    if (!active) {
      let store: MemoryStore;
      try {
        store = new MemoryStore(project);
      } catch (error) {
        if (!(error instanceof ProcessLockOccupiedError)) throw error;
        // A second concurrent session is not an error; it simply has no memory.
        notify(
          ctx,
          `${lockMessage(project)}; this session runs without it.`,
          "info",
        );
        return;
      }
      if (store.loadWarnings.length > 0)
        notify(
          ctx,
          `Project memory log damage: ${store.loadWarnings.length} warning(s); first: ${store.loadWarnings[0]}`,
        );
      let compactor: MemoryCompactor;
      try {
        compactor = startCompactor(store, ctx, {
          thinkingLevel: pi.getThinkingLevel(),
          onFailure: (failure) => reportCompactionFailure(failure),
        });
      } catch (error) {
        closeQuietly(store);
        notify(ctx, `Project memory is inactive: ${reason(error)}`);
        return;
      }
      active = {
        store,
        compactor,
        ctx,
        project,
        session,
        scanned: 0,
        logged: new Set(),
        frozen: undefined,
        reported: false,
      };
    }
    bind(ctx);
  }

  /** Points the owning memory at the current session and imports its branch. */
  function bind(ctx: ExtensionContext): void {
    const memory = active;
    if (!memory) return;
    const session = ctx.sessionManager.getSessionFile();
    if (session === undefined) return;
    memory.ctx = ctx;
    memory.session = session;
    memory.frozen = undefined;
    memory.scanned = 0;
    memory.logged.clear();
    backfill(memory);
  }

  /** Imports the active branch's unlogged messages once, as `note` (D8). */
  function backfill(memory: ActiveMemory): void {
    const hashes = loggedHashes(memory.store.root);
    let appended = false;
    for (const entry of memory.ctx.sessionManager.getBranch()) {
      memory.logged.add(entry.id);
      for (const message of deriveMessages(entry, memory.session)) {
        if (hashes.has(message.hash)) continue;
        hashes.add(message.hash);
        memory.store.appendMessage(note(message));
        appended = true;
      }
    }
    memory.scanned = memory.ctx.sessionManager.getEntries().length;
    if (appended) memory.compactor.onMessage();
  }

  /**
   * Appends every session entry that is not logged yet, whatever branch it sits
   * on: memory never rewinds, and abandoned branches stay in it (ADR 0020).
   */
  function logNewEntries(memory: ActiveMemory): void {
    const session = memory.ctx.sessionManager.getSessionFile();
    if (session === undefined) return;
    const entries = memory.ctx.sessionManager.getEntries();
    // Entries only ever append, so the scan starts where the last one ended.
    if (entries.length < memory.scanned) memory.scanned = 0;
    if (entries.length === memory.scanned) return;
    let appended = false;
    for (let index = memory.scanned; index < entries.length; index += 1) {
      const entry = entries[index];
      if (memory.logged.has(entry.id)) continue;
      memory.logged.add(entry.id);
      for (const message of deriveMessages(entry, session)) {
        memory.store.appendMessage(message);
        appended = true;
      }
    }
    memory.scanned = entries.length;
    if (appended) memory.compactor.onMessage();
  }

  /** Waits for the previous turn's nodes, then freezes this turn's view. */
  async function freezeTurn(ctx: ExtensionContext): Promise<void> {
    const memory = owning();
    if (!memory) return;
    memory.ctx = ctx;
    memory.frozen = undefined;
    try {
      // The anchor is read before the wait: whatever lands while waiting is
      // part of the turn's tail, never only of the view.
      const anchor = anchorOf(ctx);
      // The store appends each logged leaf and completes the batches the built
      // nodes unblock, so the 128 KB bound and `view.json` are already current;
      // the freeze below is the turn boundary the request depends on.
      logNewEntries(memory);
      // A ref'd timer: the process must not leave this turn while the previous
      // one is still being summarized.
      const grace = new AbortController();
      const timer = setTimeout(() => grace.abort(), settleGraceMs);
      try {
        const signal = ctx.signal
          ? AbortSignal.any([ctx.signal, grace.signal])
          : grace.signal;
        await memory.compactor.whenSettled(memory.store.view.T - 1, signal);
      } finally {
        clearTimeout(timer);
      }
      memory.frozen = {
        blocks: memory.store.renderChatBlocks(),
        lines: memory.store.view.chat,
        anchor,
        timestamp: Date.now(),
        fallback: false,
      };
    } catch {
      // A store or compactor failure must not fail the turn.
      memory.frozen = undefined;
    }
  }

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    try {
      activate(ctx);
    } catch (error) {
      deactivate();
      notify(ctx, `Project memory is inactive: ${reason(error)}`);
    }
  });
  pi.on("message_end", (_event, ctx: ExtensionContext) => {
    const memory = owning();
    if (!memory) return;
    memory.ctx = ctx;
    try {
      logNewEntries(memory);
    } catch {
      // A log failure must not fail the turn: the next resume backfills it.
    }
  });
  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    await freezeTurn(ctx);
  });
  pi.on("context", (event, ctx: ExtensionContext) => {
    const frozen = owning()?.frozen;
    if (!frozen || frozen.fallback) return;
    // An empty view is an empty memory: the first turn stays native.
    if (frozen.lines.length === 0) return;
    const count = tailCount(ctx, frozen.anchor);
    if (count === undefined || count > event.messages.length) {
      // The tail no longer maps onto the view; the rest of the turn is native.
      frozen.fallback = true;
      return;
    }
    const tail = count === 0 ? [] : event.messages.slice(-count);
    return { messages: [viewMessage(frozen), ...tail] };
  });
  pi.on("session_before_compact", (event: SessionBeforeCompactEvent) => {
    if (!owning()) return;
    // The view replaces the history Pi would summarize. Overflow recovery and
    // a manual /compact stay native (ADR 0020).
    if (event.reason === "threshold") return { cancel: true };
    return;
  });
  pi.on("session_shutdown", (event: SessionShutdownEvent) => {
    // Quit and reload tear the extension runtime down. Every other reason is a
    // session replacement, which keeps the project lock for this process. An
    // unclassified shutdown cannot hold ownership, so it releases.
    if (event && event.reason !== "quit" && event.reason !== "reload") return;
    deactivate();
  });
}

/** The listed project path the cwd resolves to, or undefined when it is not listed. */
function listedProject(cwd: string): string | undefined {
  let projects: string[];
  try {
    projects = readConfig().memoryProjects;
  } catch {
    // A config that cannot be read is reported by its owner, not by memory.
    return undefined;
  }
  if (projects.length === 0) return undefined;
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return undefined;
  }
  for (const project of projects) {
    try {
      if (realpathSync(project) === real) return real;
    } catch {
      // A listed project that is gone cannot match.
    }
  }
  return undefined;
}

/** A backfilled message keeps its original kind as a text prefix. */
function note(message: DerivedMessage): DerivedMessage {
  const text = `${message.kind}: ${message.text}`;
  // The hash stays the entry's, so importing the same entry again dedupes.
  return {
    ...message,
    kind: "note",
    text,
    size: Buffer.byteLength(text, "utf8"),
  };
}

/**
 * The hashes the project log already holds.
 *
 * The store keeps message hashes only in the log, and the backfill dedupes
 * resumed and forked sessions by hash, so they are read back on activation.
 */
function loggedHashes(root: string): Set<string> {
  const hashes = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(join(root, "main"));
  } catch {
    return hashes;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    let content: string;
    try {
      content = readFileSync(join(root, "main", name), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (line === "") continue;
      try {
        const hash = (JSON.parse(line) as { hash?: unknown }).hash;
        if (typeof hash === "string") hashes.add(hash);
      } catch {
        // A torn line carries no hash.
      }
    }
  }
  return hashes;
}

/** What one entry contributes to the request, as Pi projects it. */
function visibleMessages(entry: SessionEntry): ContextMessage[] {
  return sessionEntryToContextMessages(entry).filter(
    (message) => message.role !== "system",
  );
}

/** The last context-producing entry on the branch, or none when it is fresh. */
function anchorOf(ctx: ExtensionContext): string | null {
  let anchor: string | null = null;
  for (const entry of ctx.sessionManager.getBranch())
    if (visibleMessages(entry).length > 0) anchor = entry.id;
  return anchor;
}

/**
 * How many messages the branch holds after the anchor, counted the way Pi
 * projects the branch, or undefined when they no longer map onto the view.
 */
function tailCount(
  ctx: ExtensionContext,
  anchor: string | null,
): number | undefined {
  let after = anchor === null;
  let count = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (!after) {
      if (entry.id === anchor) after = true;
      continue;
    }
    // A compaction entry summarizes the history before it, so the tail is no
    // longer the last messages of the request; `buildContextEntries` drops the
    // summarized entries and the fallback handles that turn instead.
    if (entry.type === "compaction") return undefined;
    count += visibleMessages(entry).length;
  }
  return after ? count : undefined;
}

/** The view as one synthetic user message: the wrappers and the blocks. */
function viewMessage(frozen: FrozenTurn): ContextMessage {
  const content: TextContent[] = [
    { type: "text", text: VIEW_OPEN },
    ...frozen.blocks.map((text) => ({ type: "text" as const, text })),
    { type: "text", text: VIEW_CLOSE },
  ];
  return { role: "user", content, timestamp: frozen.timestamp };
}

function closeQuietly(store: MemoryStore): void {
  try {
    store.close();
  } catch {
    // A lock that changed owner is not this session's to release.
  }
}

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error: /, "");
}
