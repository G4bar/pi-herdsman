/**
 * Project memory session wiring for the ordinary Lead: activation and project
 * ownership, live logging, backfill, the per-turn view freeze, view injection
 * and the native compaction policy.
 *
 * The store owns the log and the view math, the compactor owns the model calls;
 * this module owns the Pi events.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type FileEntry,
  type ProjectedSessionEntry,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { readConfig } from "./config.ts";
import { resolveCompactorDefinition } from "./agent-definitions.ts";
import { ProcessLockOccupiedError, readProcessLockStatus } from "./lock.ts";
import {
  MemoryStore,
  UNBUILT_LINE,
  VIEW_BLOCK_LINES,
  VIEW_CLOSE,
  VIEW_OPEN,
  clipEcho,
  clipHead,
  deriveMessages,
  extractIdentifiers,
  lineLabel,
  markViewCache,
  nodeAt,
  nodeStart,
  projectMemoryRoot,
  renderLine,
  viewParts,
  type DerivedMessage,
  type MemorySource,
  type ViewLine,
} from "./memory.ts";
import {
  matchProject,
  reason,
  type MemoryActivationOutcome,
  type MemoryRuntimeSnapshot,
  type MemoryTurnRecord,
} from "./memory-status.ts";
import {
  SHUTDOWN_DRAIN_MS,
  extensionRegisteredProvider,
  start as startMemoryCompactor,
  type MemoryCompactor,
  type MemoryCompactorFailure,
  type MemoryCompactorOptions,
} from "./memory-compactor.ts";

/** The per-turn settle grace: after this the view freezes with placeholders. */
export const TURN_SETTLE_GRACE_MS = 3_000;
/** How long the wait runs before the widget appears, and how often it refreshes. */
const WAIT_WIDGET_DELAY_MS = 500;
const WAIT_WIDGET_REFRESH_MS = 1_000;
/** The wait widget and the placeholder footer status share this key. */
const MEMORY_UI_KEY = "pi-herdsman-memory";
/** How much of the previous exchange the view carries, head and tail together. */
const LAST_EXCHANGE_CHARS = 16 * 1024;
/** At most this many images, and this many bytes in all, come back per zoom. */
const ZOOM_IMAGE_LIMIT = 4;
const ZOOM_IMAGE_BYTES = 5 * 1024 * 1024;
/** The tools the zoom gate examines; every other call passes through. */
const GATED_TOOLS: ReadonlySet<string> = new Set([
  "delegate_agent",
  "continue_agent",
  "reply_agent",
  "steer_agent",
  "interrupt_agent",
  "edit",
  "write",
]);
/** A full UUID: `continue_agent.session` is a UUID or a session path. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many blocked identifiers one reason names. */
const GATE_REASON_LIMIT = 5;
/** How often one identifier must be blocked before the reason suggests asking. */
const GATE_ASK_AFTER = 3;
/** The durable audit entry the gate appends; it is never corpus text. */
const GATE_ENTRY_TYPE = "pi-herdsman-memory-gate";
/** The durable usage entry each compaction call appends, for the harness. */
const USAGE_ENTRY_TYPE = "pi-herdsman-memory-usage";
/** The durable turn entry each `freezeTurn` appends, for the status report. */
const TURN_ENTRY_TYPE = "pi-herdsman-memory-turn";
/** The one warning a session without a compactor model gets at start. */
const NO_COMPACTOR_MODEL_NOTICE =
  "Project memory is off: choose the compactor model in /herdsman definitions -> compactor -> Model";
/**
 * The one notice a session whose Lead provider is extension-registered gets
 * once memory is active. Hedged on purpose: no generic signal says that a
 * provider keeps per-session state, only that an extension registered it.
 */
const PROVIDER_STATE_NOTICE =
  "Project memory replaces the conversation with the project view each turn, so a provider that keeps its own per-session conversation state (for example pi-claude-bridge with Claude Code session reuse) cannot reuse it and may re-send the full view every turn.";

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
  /** Called whenever ownership starts or ends, so tools and prompts follow. */
  onActiveChange?: () => void;
};

type ContextMessage = ContextEvent["messages"][number];

/** The wait widget's lifecycle: shown after a delay, cleared as one unit. */
type WaitWidget = { stop(): void };

/** The previous exchange the view carries after `<chat>`, verbatim. */
type LastExchange = {
  /**
   * The user's words as injected: clipped with the block, so an omitted middle
   * is never counted as seen by the gate.
   */
  user: string;
  /** The clipped block body; `viewMessage` supplies the tag. */
  text: string;
};

/** One turn's frozen view: what the request injects until the next prompt. */
type FrozenTurn = {
  /** The rendered 4-line blocks, in order. */
  blocks: string[];
  /** The view line ranges the blocks cover. An empty list means T is 0. */
  lines: ViewLine[];
  /** The last context-producing entry before the prompt, or none when fresh. */
  anchor: string | null;
  /** The previous exchange, or none on the first turn. */
  exchange: LastExchange | undefined;
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
  /** True while a turn freeze waits for summaries; new entries wait with it. */
  freezing: boolean;
  frozen: FrozenTurn | undefined;
  /** True once a compaction failure was reported, so an outage notifies once. */
  reported: boolean;
  /** The latest failure error per compactor node, so a built node clears it. */
  failures: Map<string, string>;
  /** This turn's verbatim corpus, cached until the branch grows. */
  corpus: TurnCorpus | undefined;
  /** True once a gated call blocked this turn, so `zoomBefore` stops counting. */
  gateBlocked: boolean;
  /** How often each identifier was blocked this turn. */
  blockCounts: Map<string, number>;
};

/** The text this turn already showed verbatim: prompt, tool results, user text. */
type TurnCorpus = {
  /** Identifies the branch state the corpus was built from. */
  key: string;
  /** The text as seen, for case-sensitive membership. */
  text: string;
  /** The lowercased text, so UUIDs compare case-insensitively. */
  lower: string;
  /** True when a `zoom` result is already earlier in this turn. */
  zoomed: boolean;
  /**
   * The part of the turn a value can have come from, in gate order. Together
   * they cover `text`, so a value is in the corpus exactly when some part
   * holds it.
   */
  system: string;
  zoom: string;
  user: string;
  tool: string;
};

/** The identifier classes the gate distinguishes. */
type GateClass = "uuid" | "ref" | "path";

/** Where the gate found a value verbatim, or that it did not. */
type GateSource = "system" | "zoom" | "user" | "tool" | "none";

/** One identifier an action relies on. */
type GateCheck = { value: string; class: GateClass };

/**
 * Memory belongs to an ordinary Lead session only: a Lead process that is
 * neither Manager nor Chief and does not run the `managed-lead` profile of an
 * assigned managed Lead (ADR 0020).
 */
export function ordinaryLeadSession(session: {
  isLeadProcess: boolean;
  leadRoleActive: boolean;
  managedExecution: boolean;
}): boolean {
  return (
    session.isLeadProcess && session.leadRoleActive && !session.managedExecution
  );
}

export function registerMemoryRuntime(
  pi: ExtensionAPI,
  options: MemoryRuntimeOptions,
): { isActive(): boolean; snapshot(): MemoryRuntimeSnapshot } {
  const settleGraceMs = options.settleGraceMs ?? TURN_SETTLE_GRACE_MS;
  const startCompactor = options.startCompactor ?? startMemoryCompactor;
  let active: ActiveMemory | undefined;
  /** The latest `activate()` outcome, cleared when the next one starts. */
  let activationOutcome: MemoryActivationOutcome | undefined;
  /**
   * True once this session was told about an extension-registered Lead
   * provider. It lives outside `ActiveMemory` so a project switch, which
   * rebuilds that record, cannot repeat the notice.
   */
  let providerNoticeSent = false;
  /** The latest frozen turn, for the status report. */
  let lastTurn: MemoryTurnRecord | undefined;

  function notify(
    ctx: ExtensionContext,
    message: string,
    type: "info" | "warning" | "error" = "warning",
  ): void {
    // A non-interactive run has no UI, so a warning also goes to stderr.
    if (type !== "info") console.error(`Project memory: ${message}`);
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
    lastTurn = undefined;
    // A role change or project switch can deactivate outside shutdown, so a
    // widget or footer owned by this session must not outlive ownership. A
    // stale ctx must never block the lock release below.
    try {
      clearMemoryUi(memory.ctx);
    } catch {
      // Teardown is best-effort; stopping and closing still must run.
    }
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

  /** The live lock owner's pid, or undefined when the lock cannot be read. */
  function lockPid(project: string): number | undefined {
    try {
      const { claim } = readProcessLockStatus(
        join(projectMemoryRoot(project), "lock"),
        "project memory",
      );
      return claim.pid;
    } catch {
      return undefined;
    }
  }

  /** Names the live owner, so a second concurrent session is not a mystery. */
  function lockMessage(project: string): string {
    const pid = lockPid(project);
    return pid === undefined
      ? "Project memory is already open in another process"
      : `Project memory is already open in process ${pid}`;
  }

  function reportCompactionFailure(failure: MemoryCompactorFailure): void {
    const memory = active;
    if (!memory) return;
    // Recorded before the once-per-outage notice, so a still-failing node is
    // visible to the status even while the notice stays single. Re-setting an
    // existing node moves it to the end, so the snapshot's last value is the
    // latest failure.
    const key = lineLabel(failure.line);
    memory.failures.delete(key);
    memory.failures.set(key, failure.error);
    if (memory.reported) return;
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
    activationOutcome = undefined;
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
    // The compactor model is the user's choice, never the Lead's: without one
    // this session runs native, with no lock, view, or tools (ADR 0020).
    // `session_start` runs once, so this notice is the session's only one.
    if (resolveCompactorDefinition(ctx).model === undefined) {
      deactivate();
      notify(ctx, NO_COMPACTOR_MODEL_NOTICE);
      return;
    }
    if (!active) {
      let store: MemoryStore;
      try {
        store = new MemoryStore(project);
      } catch (error) {
        if (!(error instanceof ProcessLockOccupiedError)) throw error;
        // A second concurrent session is not an error; it simply has no memory.
        activationOutcome = { kind: "locked", pid: lockPid(project) };
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
          // The harness reads these entries to measure cache use; they are never
          // sent to the model.
          onUsage: (usage) => {
            // A node that built is no longer failing, whatever failed before.
            active?.failures.delete(lineLabel(usage.line));
            pi.appendEntry(USAGE_ENTRY_TYPE, {
              node: usage.line,
              kind: usage.kind,
              input: usage.input,
              output: usage.output,
              reasoning: usage.reasoning,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              attempts: usage.attempts,
              retries: usage.retries,
              ms: usage.ms,
            });
          },
        });
      } catch (error) {
        closeQuietly(store);
        activationOutcome = { kind: "failed", reason: reason(error) };
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
        freezing: false,
        frozen: undefined,
        reported: false,
        failures: new Map(),
        corpus: undefined,
        gateBlocked: false,
        blockCounts: new Map(),
      };
      options.onActiveChange?.();
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
    memory.corpus = undefined;
    memory.gateBlocked = false;
    memory.blockCounts.clear();
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
    // While a freeze is waiting, a new entry belongs to the turn's tail: it is
    // logged by the next flush, and `scanned` stays put so nothing is skipped.
    if (memory.freezing) return;
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

  /** Logs every entry that is not in the log yet, without failing the turn. */
  function flush(memory: ActiveMemory): void {
    try {
      logNewEntries(memory);
    } catch {
      // A log failure must not fail the turn; the next resume backfills it.
    }
  }

  /** Waits for the previous turn's nodes, then freezes this turn's view. */
  async function freezeTurn(ctx: ExtensionContext): Promise<void> {
    const memory = owning();
    if (!memory) return;
    memory.ctx = ctx;
    memory.frozen = undefined;
    memory.corpus = undefined;
    memory.gateBlocked = false;
    memory.blockCounts.clear();
    try {
      // The anchor is read before the wait: whatever lands while waiting is
      // part of the turn's tail, never only of the view.
      const anchor = anchorOf(ctx);
      // The exchange is read with the anchor, so a late message cannot change it.
      const exchange = lastExchange(ctx, anchor);
      // The store appends each logged leaf and completes the batches the built
      // nodes unblock, so the 128 KB bound and `view.json` are already current;
      // the freeze below is the turn boundary the request depends on.
      logNewEntries(memory);
      // While the wait runs, a message that lands is left unscanned: it belongs
      // to the turn's tail, and the view must not also carry it.
      memory.freezing = true;
      // A ref'd timer: the process must not leave this turn while the previous
      // one is still being summarized.
      const grace = new AbortController();
      const timer = setTimeout(() => grace.abort(), settleGraceMs);
      // The pending count is read before the wait; `ms` brackets the wait only.
      const pending = memory.compactor.unbuilt(memory.store.view.T - 1);
      const started = Date.now();
      let skipped = false;
      let widget: WaitWidget | undefined;
      try {
        if (ctx.mode === "tui" && ctx.hasUI)
          widget = startWaitWidget(
            ctx,
            started,
            () => memory.compactor.unbuilt(memory.store.view.T - 1),
            () => {
              skipped = true;
              grace.abort();
            },
          );
        // Keep the `AbortSignal.any`: a real turn signal would abort the wait,
        // even though `before_agent_start` has no run for Esc to abort today.
        const signal = ctx.signal
          ? AbortSignal.any([ctx.signal, grace.signal])
          : grace.signal;
        await memory.compactor.whenSettled(memory.store.view.T - 1, signal);
      } finally {
        clearTimeout(timer);
        // Unblock the turn even if widget teardown throws.
        memory.freezing = false;
        widget?.stop();
      }
      // Every line the wait built is in the view; a line the grace gave up on
      // renders as a placeholder.
      const blocks = memory.store.renderChatBlocks();
      const placeholders = countPlaceholders(blocks);
      memory.frozen = {
        blocks,
        lines: memory.store.view.chat,
        anchor,
        exchange,
        timestamp: Date.now(),
        fallback: false,
      };
      // The footer keeps the placeholder count for the turn; the next freeze
      // that has none clears it. A session torn down mid-wait stops here.
      if (owning() === memory) setPlaceholderStatus(ctx, placeholders);
      // `settled` also covers `whenSettled` giving up because every pending
      // node failed: `placeholders` is the cross-check for that case. A skip is
      // the user's Esc; an expiry is the grace giving up.
      recordTurn(memory, {
        ms: Date.now() - started,
        outcome: skipped
          ? "aborted"
          : ctx.signal?.aborted
            ? "aborted"
            : grace.signal.aborted
              ? "expired"
              : "settled",
        pending,
        placeholders,
        viewBytes: frozenViewBytes(blocks),
      });
    } catch {
      // A store or compactor failure must not fail the turn.
      memory.frozen = undefined;
    }
  }

  /**
   * Records one frozen turn: the in-memory copy feeds the status report, and
   * the session custom entry is the durable ledger the report script reads. It
   * carries no prompt or view text.
   */
  function recordTurn(memory: ActiveMemory, record: MemoryTurnRecord): void {
    if (owning() !== memory) return;
    lastTurn = record;
    try {
      pi.appendEntry(TURN_ENTRY_TYPE, record);
    } catch {
      // A session being torn down does not get a ledger entry.
    }
  }

  // The tools are always registered for the Lead role and activated only while
  // memory is active, so an inactive project's tool list stays unchanged.
  function toolStore(): MemoryStore {
    const memory = owning();
    if (!memory)
      throw new Error("Project memory is not active in this session.");
    return memory.store;
  }

  pi.registerTool({
    name: "zoom",
    label: "zoom",
    description:
      "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
    promptSnippet: undefined,
    exposure: "model-only",
    executionMode: "sequential",
    defaultActive: false,
    parameters: Type.Object(
      { id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) },
      { additionalProperties: false },
    ),
    execute: async (
      _toolCallId: string,
      params: { id: number; n: number },
      _signal: AbortSignal | undefined,
      _update: unknown,
      ctx: ExtensionContext,
    ) => zoomResult(toolStore(), ctx, params.id, params.n),
  });
  pi.registerTool({
    name: "date",
    label: "date",
    description: "The date and time of message id.",
    promptSnippet: undefined,
    exposure: "model-only",
    executionMode: "sequential",
    defaultActive: false,
    parameters: Type.Object(
      { id: Type.Integer({ minimum: 0 }) },
      { additionalProperties: false },
    ),
    execute: async (
      _toolCallId: string,
      params: { id: number },
      _signal: AbortSignal | undefined,
      _update: unknown,
      _ctx: ExtensionContext,
    ) => dateResult(toolStore(), params.id),
  });

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    const wasActive = active !== undefined;
    try {
      activate(ctx);
    } catch (error) {
      deactivate();
      // A store that cannot open is the session's answer, not `next session`.
      activationOutcome = { kind: "failed", reason: reason(error) };
      notify(ctx, `Project memory is inactive: ${reason(error)}`);
    }
    // A session that no longer owns memory re-projects, so a stale tool set
    // from the previous session does not carry over.
    if (wasActive && !active) options.onActiveChange?.();
  });
  pi.on("message_end", (_event, ctx: ExtensionContext) => {
    const memory = owning();
    if (!memory) return;
    memory.ctx = ctx;
    flush(memory);
  });
  // Pi persists a message after its `message_end` handlers, so the last message
  // of a turn is only an entry once the turn ends.
  pi.on("turn_end", (_event, ctx: ExtensionContext) => {
    const memory = owning();
    if (!memory) return;
    memory.ctx = ctx;
    flush(memory);
  });
  // The zoom gate: an action may only use identifiers this turn already showed
  // verbatim. It reads the frozen view, so it never blocks a line the model was
  // told to zoom, and a `zoom` result earlier in the turn makes a value pass.
  pi.on("tool_call", (event: any, ctx: ExtensionContext) => {
    const memory = owning();
    if (!memory) return;
    const frozen = memory.frozen;
    if (!frozen || frozen.fallback) return;
    if (!GATED_TOOLS.has(event.toolName)) return;
    try {
      return gateCall(pi, memory, ctx, event, frozen);
    } catch {
      // A gate failure must not fail the turn; the tool runs unchecked.
      return undefined;
    }
  });
  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    await freezeTurn(ctx);
  });
  pi.on("context", (event, ctx: ExtensionContext) => {
    const memory = owning();
    if (!memory) return;
    // A provider that keeps its own per-session conversation state cannot
    // reuse the view; say so once per session, on the first prepared turn.
    if (!providerNoticeSent) {
      const provider = ctx.model?.provider;
      if (provider && extensionRegisteredProvider(ctx, provider)) {
        providerNoticeSent = true;
        notify(ctx, PROVIDER_STATE_NOTICE, "info");
      }
    }
    const frozen = memory.frozen;
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
  // One cache mark at the view, so its prefix survives across turns. Pi marks
  // the system prompt, the tools and the last user block; without this mark
  // each turn ends differently and rewrites the whole view (ADR 0009).
  pi.on("before_provider_request", (event, ctx: ExtensionContext) => {
    const frozen = owning()?.frozen;
    if (!frozen || frozen.fallback) return;
    if (ctx.model?.api !== "anthropic-messages") return;
    // test-only: smoke A/B disables the mark to measure its effect.
    if (process.env.PI_HERDSMAN_MEMORY_DISABLE_VIEW_MARK === "1") return;
    try {
      return markViewCache(event.payload);
    } catch {
      // Caching is efficiency, not correctness: a shape mismatch is a no-op.
      return undefined;
    }
  });
  pi.on("session_before_compact", (event: SessionBeforeCompactEvent) => {
    if (!owning()) return;
    // The view replaces the history Pi would summarize. Overflow recovery and
    // a manual /compact stay native (ADR 0020).
    if (event.reason === "threshold") return { cancel: true };
    return;
  });
  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    // A session replacement tears this runtime down and re-runs the extension
    // factory, and quit or reload starts over from nothing: in every case the
    // next `session_start` is a new registration that claims the project lock
    // for itself. Holding it here would leave that session native, with a
    // spurious "already open" notice, and the compactor running on a disposed
    // session's ctx. Flush first, because the outgoing session is still on disk.
    const memory = active;
    if (memory && ctx) {
      memory.ctx = ctx;
      flush(memory);
    }
    if (memory) {
      // Pi awaits this handler, so a build that is still running finishes and
      // is appended before the store closes: quitting right after a turn is
      // the normal way to end a session, and its last builds are exactly the
      // ones a bare `stop()` would throw away and redo on the next start.
      try {
        await memory.compactor.drain(SHUTDOWN_DRAIN_MS, () => {
          if (!ctx?.hasUI) return;
          let inFlight = 0;
          try {
            inFlight = memory.compactor.stats().inFlight;
          } catch {
            // A compactor whose counters cannot be read still drained.
          }
          notify(
            ctx,
            `Project memory: finishing ${inFlight} in-flight summar${inFlight === 1 ? "y" : "ies"} (up to ${SHUTDOWN_DRAIN_MS / 1000} s)`,
            "info",
          );
        });
      } catch {
        // A drain that fails still has to release the lock below.
      }
    }
    deactivate();
    if (memory) options.onActiveChange?.();
  });

  /** The state the status menu reports from; dropped with `active`. */
  function snapshot(): MemoryRuntimeSnapshot {
    const memory = owning();
    const failures = memory ? [...memory.failures.values()] : [];
    return {
      active: memory !== undefined,
      failing: failures.at(-1),
      outcome: activationOutcome,
      turn: memory ? lastTurn : undefined,
      stats: memory?.compactor.stats(),
      viewBytes: memory
        ? Buffer.byteLength(memory.store.renderChat(), "utf8")
        : undefined,
    };
  }

  // Keys off `owning()` rather than the raw active state: a role change ends
  // ownership at the next read, and the Lead's tool projection and prompt
  // section both evaluate this before the turn starts.
  return { isActive: () => owning() !== undefined, snapshot };
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
  const match = matchProject(cwd, projects);
  return match.listed ? match.project : undefined;
}

/** The frozen chat view's rendered byte length, wrappers included. */
function frozenViewBytes(blocks: readonly string[]): number {
  return Buffer.byteLength(
    [VIEW_OPEN, ...blocks, VIEW_CLOSE].join("\n"),
    "utf8",
  );
}

/** Placeholder lines in the frozen view, one per line that is still unbuilt. */
function countPlaceholders(blocks: readonly string[]): number {
  let count = 0;
  for (const block of blocks)
    for (const line of block.split("\n"))
      if (line.includes(UNBUILT_LINE)) count += 1;
  return count;
}

/**
 * The wait widget: nothing for the first 500 ms, then one line refreshed every
 * second, with a bare Esc consumed to skip the wait. `stop()` clears the
 * widget, its timers and its key listener together, so Esc is native again the
 * moment the wait ends and a throwing freeze still removes the listener.
 */
function startWaitWidget(
  ctx: ExtensionContext,
  started: number,
  pending: () => number,
  onSkip: () => void,
): WaitWidget {
  let shown = false;
  let refresh: ReturnType<typeof setInterval> | undefined;
  let stopInput: (() => void) | undefined;
  // shortcut: a plain string[] gets no terminal width, so DESIGN §7's
  // responsive shortening is left to Pi's own wrap; upgrade to a component
  // factory if the extension UI ever exposes the width.
  let count = 0;
  const render = () => {
    try {
      count = pending();
    } catch {
      // A store that cannot be read keeps the last count on screen.
    }
    const seconds = Math.floor((Date.now() - started) / 1000);
    const line = `Memory: waiting for ${count} summar${count === 1 ? "y" : "ies"} from the last turn · ${seconds} s · Esc to skip`;
    try {
      ctx.ui.setWidget(MEMORY_UI_KEY, [line]);
      shown = true;
    } catch {
      // A UI that cannot take a widget must not fail the turn.
    }
  };
  const delay = setTimeout(() => {
    render();
    refresh = setInterval(render, WAIT_WIDGET_REFRESH_MS);
    try {
      stopInput = ctx.ui.onTerminalInput((data) => {
        // Kitty and modifyOtherKeys send Esc as `\x1b[27u` / `\x1b[27;1u`;
        // `matchesKey` accepts those and a bare `\x1b`, and nothing else.
        if (!matchesKey(data, "escape")) return undefined;
        onSkip();
        return { consume: true };
      });
    } catch {
      stopInput = undefined;
    }
  }, WAIT_WIDGET_DELAY_MS);
  return {
    stop() {
      clearTimeout(delay);
      if (refresh !== undefined) clearInterval(refresh);
      if (shown) {
        try {
          ctx.ui.setWidget(MEMORY_UI_KEY, undefined);
        } catch {
          // Widget teardown is best-effort during UI failure or shutdown.
        }
      }
      try {
        stopInput?.();
      } catch {
        // A listener that cannot be removed must not fail the turn.
      }
    },
  };
}

/** The footer's placeholder line, or its removal when the turn has none. */
function setPlaceholderStatus(
  ctx: ExtensionContext,
  placeholders: number,
): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  try {
    ctx.ui.setStatus(
      MEMORY_UI_KEY,
      placeholders === 0
        ? undefined
        : `memory: ${placeholders} placeholder${placeholders === 1 ? "" : "s"}`,
    );
  } catch {
    // A UI that cannot take a status must not fail the turn.
  }
}

/** Removes both memory surfaces; safe when neither was ever shown. */
function clearMemoryUi(ctx: ExtensionContext): void {
  try {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    try {
      ctx.ui.setWidget(MEMORY_UI_KEY, undefined);
    } catch {
      // Best-effort teardown.
    }
    try {
      ctx.ui.setStatus(MEMORY_UI_KEY, undefined);
    } catch {
      // Best-effort teardown.
    }
  } catch {
    // A stale or disposed context cannot accept teardown; nothing to clear.
  }
}

/**
 * The previous user message and the Lead's reply, read from the branch up to
 * the anchor. The reply is the text parts of the last assistant message only:
 * never thinking, never a tool call. The block is clipped head and tail like a
 * tool result, so a huge exchange cannot grow the request without bound.
 */
function lastExchange(
  ctx: ExtensionContext,
  anchor: string | null,
): LastExchange | undefined {
  if (anchor === null) return undefined;
  const branch = ctx.sessionManager.getBranch();
  const end = branch.findIndex((entry) => entry.id === anchor);
  if (end === -1) return undefined;
  let userAt = -1;
  for (let index = end; index >= 0; index -= 1)
    if (messageRole(branch[index]) === "user") {
      userAt = index;
      break;
    }
  if (userAt === -1) return undefined;
  const user = messageText(branch[userAt]);
  if (user === "") return undefined;
  let lead: string | undefined;
  for (let index = end; index > userAt; index -= 1) {
    if (messageRole(branch[index]) !== "assistant") continue;
    const text = messageText(branch[index]);
    lead = text === "" ? undefined : text;
    break;
  }
  const body =
    lead === undefined ? `user: ${user}` : `user: ${user}\nlead: ${lead}`;
  const text = clipEcho(body, LAST_EXCHANGE_CHARS);
  return { user: exchangeUserPortion(text, lead !== undefined), text };
}

/**
 * The user's words as they appear in the injected block. A reply adds its own
 * clipped text to the block, and the corpus must not carry that; when the
 * combined clip dropped the separator, only the head the clip kept is the
 * user's.
 */
function exchangeUserPortion(text: string, hasLead: boolean): string {
  const body = text.startsWith("user: ") ? text.slice("user: ".length) : text;
  if (!hasLead) return body;
  const leadAt = body.indexOf("\nlead: ");
  return leadAt >= 0 ? body.slice(0, leadAt) : clipHead(body);
}

/** The role of a message entry, or undefined for any other entry. */
function messageRole(entry: SessionEntry): string | undefined {
  if (entry.type !== "message") return undefined;
  return (entry.message as { role?: string }).role;
}

/** The concatenated text blocks of a message entry; thinking and calls out. */
function messageText(entry: SessionEntry): string {
  if (entry.type !== "message") return "";
  return contentBlocksText((entry.message as { content?: unknown }).content);
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

/**
 * What the request holds for one entry, as Pi projects it: a `context_edit`
 * that omits an entry contributes nothing, so the tail never counts it.
 */
function projectedMessages(
  entry: ProjectedSessionEntry,
): ContextEvent["messages"] {
  return entry.messages.filter((message) => message.role !== "system");
}

/** The last context-producing entry on the branch, or none when it is fresh. */
function anchorOf(ctx: ExtensionContext): string | null {
  let anchor: string | null = null;
  for (const entry of ctx.sessionManager.buildSessionProjection().entries)
    if (projectedMessages(entry).length > 0) anchor = entry.sourceEntry.id;
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
  for (const entry of ctx.sessionManager.buildSessionProjection().entries) {
    if (!after) {
      if (entry.sourceEntry.id === anchor) after = true;
      continue;
    }
    // A compaction entry summarizes the history before it, so the tail is no
    // longer the last messages of the request; `buildContextEntries` drops the
    // summarized entries and the fallback handles that turn instead.
    if (entry.sourceEntry.type === "compaction") return undefined;
    count += projectedMessages(entry).length;
  }
  return after ? count : undefined;
}

/**
 * The view as one synthetic user message: the wrappers, the blocks and the
 * previous exchange. The exchange sits after `</chat>`, so `markViewCache`
 * keeps its mark on a built view block and never on text that changes each
 * turn.
 */
function viewMessage(frozen: FrozenTurn): ContextMessage {
  const content = viewParts(frozen.blocks);
  if (frozen.exchange !== undefined)
    content.push({
      type: "text",
      text: `<last_exchange>\n${frozen.exchange.text}\n</last_exchange>\n`,
    });
  return { role: "user", content, timestamp: frozen.timestamp };
}

function closeQuietly(store: MemoryStore): void {
  try {
    store.close();
  } catch {
    // A lock that changed owner is not this session's to release.
  }
}

// --- zoom gate --------------------------------------------------------------

/**
 * Blocks a gated call whose identifiers this turn has not shown verbatim, and
 * records one gate entry per checked call. Strict values (`uuid`, `ref`) must be
 * in the corpus; a path only when the frozen view holds it and the corpus does
 * not, because the Lead may build a path from a listing.
 */
function gateCall(
  pi: ExtensionAPI,
  memory: ActiveMemory,
  ctx: ExtensionContext,
  event: {
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
  },
  frozen: FrozenTurn,
): { block: true; reason: string } | undefined {
  const checks = gateChecks(event.toolName, event.input, ctx.cwd);
  if (checks.length === 0) return undefined;
  const corpus = turnCorpus(memory, ctx, frozen);
  const decisions = checks.map((check) => {
    const line = frozenLineFor(frozen, check.value, check.class, ctx.cwd);
    return {
      check,
      line,
      inView: line !== undefined,
      inCorpus:
        check.class === "path"
          ? pathInText(check.value, ctx.cwd, corpus.text)
          : check.class === "uuid"
            ? corpus.lower.includes(check.value)
            : corpus.text.includes(check.value),
      source: corpusSource(corpus, check, ctx.cwd),
    };
  });
  const blocked = decisions.filter(({ check, inView, inCorpus }) =>
    check.class === "path" ? inView && !inCorpus : !inCorpus,
  );
  // Zooming before acting is the point: an earlier zoom counts only until a
  // block, after which the turn is no longer unprompted.
  pi.appendEntry(GATE_ENTRY_TYPE, {
    tool: event.toolName,
    toolCallId: event.toolCallId,
    identifiers: decisions.map(({ check, inView, inCorpus, source }) => ({
      value: check.value,
      class: check.class,
      inView,
      inCorpus,
      source,
    })),
    blocked: blocked.length > 0,
    zoomBefore: corpus.zoomed && !memory.gateBlocked,
  });
  if (blocked.length === 0) return undefined;
  const reasonLines: string[] = [];
  for (const { check, line } of blocked.slice(0, GATE_REASON_LIMIT)) {
    const count = (memory.blockCounts.get(check.value) ?? 0) + 1;
    memory.blockCounts.set(check.value, count);
    const ask = count >= GATE_ASK_AFTER ? "; ask the user for it" : "";
    if (line)
      reasonLines.push(
        `blocked: "${check.value}" not seen verbatim this turn; zoom ${lineLabel(line)}${ask}`,
      );
    else
      reasonLines.push(
        `blocked: "${check.value}" not seen verbatim this turn and not in the view; get it from a tool result or the user first${ask}`,
      );
  }
  reasonLines.push(
    "Retry the call after the zoom result arrives; a zoom and the action can be sent in the same batch.",
  );
  memory.gateBlocked = true;
  return { block: true, reason: reasonLines.join("\n") };
}

/** Every identifier the given call must have seen verbatim this turn. */
function gateChecks(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): GateCheck[] {
  switch (toolName) {
    case "delegate_agent":
      return [...freeTextChecks(input.task), ...fileChecks(input.files)];
    case "continue_agent":
      return [
        ...freeTextChecks(input.task),
        ...sessionChecks(input.session),
        ...fileChecks(input.files),
      ];
    case "reply_agent":
    case "steer_agent":
    case "interrupt_agent":
      return [...freeTextChecks(input.message), ...fileChecks(input.files)];
    case "edit":
      return pathChecks(input.path);
    case "write":
      return writePathChecks(input.path, cwd);
    default:
      return [];
  }
}

/** `uuid` and `ref` in free text; paths are never taken from prose. */
function freeTextChecks(value: unknown): GateCheck[] {
  if (typeof value !== "string") return [];
  return extractIdentifiers(value).flatMap((identifier) =>
    identifier.kind === "uuid" || identifier.kind === "ref"
      ? [{ value: identifier.value, class: identifier.kind }]
      : [],
  );
}

/** A `result:` file entry is a ref; every other entry is a path. */
function fileChecks(files: unknown): GateCheck[] {
  if (!Array.isArray(files)) return [];
  const checks: GateCheck[] = [];
  for (const entry of files) {
    if (typeof entry !== "string" || entry === "") continue;
    checks.push(
      entry.startsWith("result:")
        ? { value: entry, class: "ref" }
        : { value: entry, class: "path" },
    );
  }
  return checks;
}

/** `continue_agent.session` is a UUID, or a session path when it is not. */
function sessionChecks(value: unknown): GateCheck[] {
  if (typeof value !== "string" || value === "") return [];
  return [
    UUID.test(value)
      ? { value: value.toLowerCase(), class: "uuid" }
      : { value, class: "path" },
  ];
}

/** A field known to hold a path is taken whole, never through the extractor. */
function pathChecks(value: unknown): GateCheck[] {
  return typeof value === "string" && value !== ""
    ? [{ value, class: "path" }]
    : [];
}

/** A new file cannot have been seen yet, so `write` to one is not gated. */
function writePathChecks(value: unknown, cwd: string): GateCheck[] {
  if (typeof value !== "string" || value === "") return [];
  if (!existsSync(resolve(cwd, value))) return [];
  return [{ value, class: "path" }];
}

/** This turn's verbatim corpus, cached until the branch state changes. */
function turnCorpus(
  memory: ActiveMemory,
  ctx: ExtensionContext,
  frozen: FrozenTurn,
): TurnCorpus {
  const branch = ctx.sessionManager.getBranch();
  const key = corpusKey(branch, frozen);
  if (memory.corpus && memory.corpus.key === key) return memory.corpus;
  // A branch that no longer holds the anchor keeps every entry, so a value the
  // model saw natively is never blocked.
  const start =
    frozen.anchor === null
      ? 0
      : branch.findIndex((entry) => entry.id === frozen.anchor) + 1;
  const zoomEntries: string[] = [];
  const userEntries: string[] = [];
  const toolEntries: string[] = [];
  let zoomed = false;
  for (let index = Math.max(start, 0); index < branch.length; index += 1) {
    const entry = branch[index];
    // The derivation decides which entries count; the text stays raw and
    // unclipped, so a value the model saw past the echo clip still counts.
    const derived = deriveMessages(entry, memory.session);
    const counts = derived.some(
      (message) =>
        message.kind === "user" ||
        message.kind === "echo" ||
        message.kind === "work",
    );
    const isZoom = isZoomResult(entry);
    if (isZoom) zoomed = true;
    if (!counts) continue;
    // One entry can hold several kinds; the first that can hold an identifier
    // decides where the value came from.
    const raw = rawEntryText(entry);
    if (isZoom) zoomEntries.push(raw);
    else if (derived.some((message) => message.kind === "user"))
      userEntries.push(raw);
    else toolEntries.push(raw);
  }
  const zoom = zoomEntries.join("\n");
  // The previous exchange rides in the view message verbatim, so values the
  // user typed last turn count as seen; the Lead's own reply stays out.
  const previous = frozen.exchange?.user ?? "";
  const user =
    previous === ""
      ? userEntries.join("\n")
      : [previous, ...userEntries].join("\n");
  const tool = toolEntries.join("\n");
  const system = systemPromptOf(ctx);
  const text = `${system}\n${zoom}\n${user}\n${tool}`;
  const corpus: TurnCorpus = {
    key,
    text,
    lower: text.toLowerCase(),
    zoomed,
    system,
    zoom,
    user,
    tool,
  };
  memory.corpus = corpus;
  return corpus;
}

/** The first part of this turn's corpus that holds the value verbatim. */
function corpusSource(
  corpus: TurnCorpus,
  check: GateCheck,
  cwd: string,
): GateSource {
  const holds = (text: string) =>
    check.class === "path"
      ? pathInText(check.value, cwd, text)
      : check.class === "uuid"
        ? text.toLowerCase().includes(check.value)
        : text.includes(check.value);
  if (holds(corpus.zoom)) return "zoom";
  if (holds(corpus.user)) return "user";
  if (holds(corpus.tool)) return "tool";
  // The system prompt is part of `corpus.text`, so `none` has to mean "no part
  // holds it" for `source === "none"` to match `!inCorpus`.
  if (holds(corpus.system)) return "system";
  return "none";
}

/**
 * The turn's cache key, keyed on the last entry that is not the gate's own
 * audit entry, so a checked call does not invalidate the corpus it just used.
 */
function corpusKey(branch: SessionEntry[], frozen: FrozenTurn): string {
  let count = 0;
  let last = "";
  for (const entry of branch) {
    if (isGateEntry(entry) || isUsageEntry(entry)) continue;
    count += 1;
    last = entry.id;
  }
  return `${frozen.timestamp}|${frozen.anchor ?? ""}|${count}|${last}`;
}

function isGateEntry(entry: SessionEntry): boolean {
  return entry.type === "custom" && entry.customType === GATE_ENTRY_TYPE;
}

function isUsageEntry(entry: SessionEntry): boolean {
  return entry.type === "custom" && entry.customType === USAGE_ENTRY_TYPE;
}

/** The raw, unclipped text of an entry whose derivation counts in the corpus. */
function rawEntryText(entry: SessionEntry): string {
  if (entry.type === "custom_message") return contentBlocksText(entry.content);
  if (entry.type !== "message") return "";
  const message = entry.message as { role?: string; content?: unknown };
  if (message.role === "bashExecution") {
    const [converted] = convertToLlm([entry.message]);
    return converted ? contentBlocksText(converted.content) : "";
  }
  return contentBlocksText(message.content);
}

function contentBlocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string")
      parts.push(record.text);
  }
  return parts.join("\n");
}

/** The final system prompt of this turn, or empty when Pi cannot render it. */
function systemPromptOf(ctx: ExtensionContext): string {
  try {
    const prompt = ctx.getSystemPrompt();
    return typeof prompt === "string" ? prompt : "";
  } catch {
    return "";
  }
}

function isZoomResult(entry: SessionEntry): boolean {
  if (entry.type !== "message") return false;
  const message = entry.message as { role?: string; toolName?: string };
  return message.role === "toolResult" && message.toolName === "zoom";
}

/** The latest frozen view line holding the value, or undefined. */
function frozenLineFor(
  frozen: FrozenTurn,
  value: string,
  kind: GateClass,
  cwd: string,
): ViewLine | undefined {
  const matches =
    kind === "path"
      ? (text: string) => pathInText(value, cwd, text)
      : kind === "uuid"
        ? (text: string) => text.toLowerCase().includes(value)
        : (text: string) => text.includes(value);
  for (let block = frozen.blocks.length - 1; block >= 0; block -= 1) {
    const rows = frozen.blocks[block].split("\n");
    for (let row = rows.length - 1; row >= 0; row -= 1) {
      const line = frozen.lines[block * VIEW_BLOCK_LINES + row];
      if (line && matches(rows[row])) return line;
    }
  }
  return undefined;
}

/** The forms a path is matched by: as given, absolute, and cwd-relative. */
function pathForms(value: string, cwd: string): string[] {
  const absolute = resolve(cwd, value);
  const relativePath = relative(cwd, absolute);
  return [...new Set([value, absolute, relativePath].filter(Boolean))];
}

function pathInText(value: string, cwd: string, text: string): boolean {
  return pathForms(value, cwd).some((form) => text.includes(form));
}

// --- zoom and date ----------------------------------------------------------

/**
 * Opens a view line: the two child lines for n > 1, the message itself for
 * n = 1. The text is the stored original, never a re-summary.
 */
function zoomResult(
  store: MemoryStore,
  ctx: ExtensionContext,
  id: number,
  n: number,
): {
  content: (TextContent | ImageContent)[];
  details: Record<string, unknown>;
} {
  const T = store.messageCount;
  throwIfZoomInvalid(id, n, T);
  if (n === 1) {
    const kind = store.messageKind(id) ?? "user";
    const source = store.messageSource(id);
    const content: (TextContent | ImageContent)[] = [
      { type: "text", text: `${kind}: ${store.messageText(id) ?? ""}` },
    ];
    if (source?.images) {
      const images = sourceImages(source, ctx);
      if (images === undefined)
        content.push({
          type: "text",
          text: "[image unavailable: session file missing]",
        });
      else {
        const bounded = boundedImages(images);
        content.push(...bounded.images);
        if (bounded.dropped > 0)
          content.push({
            type: "text",
            text: `[${bounded.dropped} image(s) omitted]`,
          });
      }
    }
    return {
      content,
      details: {
        id,
        n,
        ranges: [[0, id]],
        ...(source ? { session: source.session, entry: source.entry } : {}),
      },
    };
  }
  const ranges: ViewLine[] = [];
  const lines: string[] = [];
  for (const child of [nodeAt(id, n / 2), nodeAt(id + n / 2, n / 2)]) {
    if (!child || nodeStart(child) >= T) continue;
    lines.push(renderLine(child, store.nodeText(child)));
    ranges.push(child);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { id, n, ranges },
  };
}

/** One sentence naming the broken rule and a form that would work. */
function throwIfZoomInvalid(id: number, n: number, T: number): void {
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(Math.log2(n)))
    throw new Error(
      "n must be a power of two: use zoom(id, 1), zoom(id, 2), zoom(id, 4), …",
    );
  throwIfIdOutOfRange(id, T, "zoom");
  if (id % n !== 0)
    throw new Error(
      `id must be a multiple of n: use zoom(${Math.floor(id / n) * n}, ${n})`,
    );
}

function dateResult(
  store: MemoryStore,
  id: number,
): { content: TextContent[]; details: { id: number; date: string } } {
  const T = store.messageCount;
  throwIfIdOutOfRange(id, T, "date");
  const date = formatLocalDate(store.messageDate(id) ?? "");
  return { content: [{ type: "text", text: date }], details: { id, date } };
}

function throwIfIdOutOfRange(id: number, T: number, label: string): void {
  if (!Number.isInteger(id) || id < 0)
    throw new Error(`id must be a non-negative integer: use ${label}(0)`);
  if (id >= T)
    throw new Error(
      T === 0
        ? "id must be below the project log count: the log is empty"
        : `id must be below the project log count ${T}: use ${label}(${T - 1})`,
    );
}

/** `YYYY-MM-DD HH:MM:SS` in local time, followed by the UTC offset. */
function formatLocalDate(value: string): string {
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, "0");
  const local = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  const offset = -at.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const size = Math.abs(offset);
  return `${local} ${sign}${pad(Math.floor(size / 60))}:${pad(size % 60)}`;
}

/**
 * The images a record pointed at, or undefined when its source cannot be read.
 * The current session is read in memory; an old session file is parsed again on
 * each call, because zooming into an image is rare and a cache would hold every
 * image of every session for the life of the process.
 */
function sourceImages(
  source: MemorySource,
  ctx: ExtensionContext,
): ImageContent[] | undefined {
  if (source.session === ctx.sessionManager.getSessionFile()) {
    const entry = ctx.sessionManager
      .getEntries()
      .find((candidate) => candidate.id === source.entry);
    return entry ? imageBlocks(entry) : [];
  }
  const file = allowedSessionFile(source.session, ctx);
  if (file === undefined) return undefined;
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  for (const entry of parseSessionEntries(content)) {
    if (entry.id === source.entry) return imageBlocks(entry);
  }
  return [];
}

/**
 * An image source is read only when it is a `.jsonl` file inside the sessions
 * directory of the current session. The project log is append-only and could
 * hold any path, so this keeps a crafted record from reading another file.
 */
function allowedSessionFile(
  session: string,
  ctx: ExtensionContext,
): string | undefined {
  if (!session.endsWith(".jsonl")) return undefined;
  const current = ctx.sessionManager.getSessionFile();
  if (current === undefined) return undefined;
  let root: string;
  let resolved: string;
  try {
    root = realpathSync(dirname(current));
    resolved = realpathSync(session);
  } catch {
    return undefined;
  }
  return resolved.startsWith(`${root}${sep}`) ? resolved : undefined;
}

/** Caps one zoom's images by count and by payload bytes. */
function boundedImages(images: readonly ImageContent[]): {
  images: ImageContent[];
  dropped: number;
} {
  const kept: ImageContent[] = [];
  let bytes = 0;
  for (const image of images) {
    if (kept.length >= ZOOM_IMAGE_LIMIT) break;
    const size = Buffer.byteLength(image.data, "utf8");
    if (bytes + size > ZOOM_IMAGE_BYTES) break;
    bytes += size;
    kept.push(image);
  }
  return { images: kept, dropped: images.length - kept.length };
}

function imageBlocks(entry: SessionEntry | FileEntry): ImageContent[] {
  if (entry.type === "message")
    return imageContent((entry.message as { content?: unknown }).content);
  if (entry.type === "custom_message") return imageContent(entry.content);
  return [];
}

function imageContent(content: unknown): ImageContent[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isImageContent);
}

function isImageContent(block: unknown): block is ImageContent {
  if (!block || typeof block !== "object") return false;
  // SAFETY: every content block carries a `type`; the fields checked here are
  // the ones the image block contract requires.
  const candidate = block as {
    type?: unknown;
    data?: unknown;
    mimeType?: unknown;
  };
  return (
    candidate.type === "image" &&
    typeof candidate.data === "string" &&
    typeof candidate.mimeType === "string"
  );
}
