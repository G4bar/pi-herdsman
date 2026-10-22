/**
 * RPC-mode state feed and `/hm` controls.
 *
 * A Pi session started with `--mode rpc` publishes its Herdsman delegation tree
 * through `ctx.ui.setStatus("herdsman", <json>)`, which Pi forwards to the client
 * as an `extension_ui_request`. TUI mode publishes nothing: there the footer
 * would show the raw JSON.
 *
 * Three fields of the design are omitted because Herdsman keeps no source for
 * them: `toolCalls` and `tokens` (no per-agent usage counters in mailbox state,
 * and reading every agent transcript on each publish would cost far more than
 * the feed is worth) and `activity` (only the current request is kept; recent
 * work rows only exist inside the agent pane, which would cost one herdr
 * inspect call per agent per publish).
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const HERDSMAN_STATUS_KEY = "herdsman";
export const HERDSMAN_SNAPSHOT_VERSION = 1;
export const HERDSMAN_SNAPSHOT_LIMIT_BYTES = 64 * 1024;
export const HERDSMAN_FEED_THROTTLE_MS = 1_000;
export const HERDSMAN_COMMAND_NAME = "hm";

const ACTIVITY_ROWS = 20;
const TASK_LIMIT_CHARS = 500;
const TEXT_LIMIT_BYTES = 8 * 1024;
const AGENT_LIMIT = 100;

export type HerdsmanAgentState =
  "starting" | "running" | "asks" | "finished" | "failed" | "stale" | "closed";

export type HerdsmanCommandAction =
  "steer" | "interrupt" | "reply" | "close" | "continue";

export const HERDSMAN_COMMAND_ACTIONS: readonly HerdsmanCommandAction[] = [
  "steer",
  "interrupt",
  "reply",
  "close",
  "continue",
];

export type HerdsmanRpcAgent = {
  label: string;
  definition: string;
  parent: string | null;
  state: HerdsmanAgentState;
  task?: string;
  activity?: string[];
  startedAt?: number;
  endedAt?: number;
  question?: { text: string; files: string[] };
  answer?: string;
  resultRef?: string;
  resumable?: boolean;
};

export type HerdsmanRpcSnapshot = {
  v: typeof HERDSMAN_SNAPSHOT_VERSION;
  capabilities: HerdsmanCommandAction[];
  agents: HerdsmanRpcAgent[];
};

export type HerdsmanRpcAgentSource = {
  label: string;
  definition?: string;
  parentLabel?: string;
  /** Herdsman's own projection: working, settling, blocked, lost, unknown, or starting. */
  projection: string;
  stale?: boolean;
  pendingAsk?: { question: string; files?: readonly string[] };
  result?: {
    status: "completed" | "failed";
    text?: string;
    error?: string;
    completedAt: number;
    resultRef?: string;
  };
  task?: string;
  startedAt?: number;
  activity?: readonly string[];
  resumable?: boolean;
};

function boundText(
  value: string | undefined,
  limit: number,
): string | undefined {
  if (!value) return undefined;
  const text = value.length > limit ? value.slice(0, limit) : value;
  return text;
}

function boundBytes(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const bytes = Buffer.from(value, "utf8");
  return bytes.length > TEXT_LIMIT_BYTES
    ? bytes.subarray(0, TEXT_LIMIT_BYTES).toString("utf8")
    : value;
}

function activityRows(activity: readonly string[] | undefined): string[] {
  const rows = (activity ?? [])
    .map((row) => row.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  return rows.slice(-ACTIVITY_ROWS);
}

export function herdsmanAgentState(
  source: Pick<
    HerdsmanRpcAgentSource,
    "projection" | "stale" | "pendingAsk" | "result"
  >,
): HerdsmanAgentState {
  if (source.pendingAsk) return "asks";
  if (source.result)
    return source.result.status === "failed" ? "failed" : "finished";
  if (source.projection === "lost") return "closed";
  if (source.projection === "starting") return "starting";
  if (source.stale || source.projection === "unknown") return "stale";
  return "running";
}

export function herdsmanRpcAgent(
  source: HerdsmanRpcAgentSource,
): HerdsmanRpcAgent {
  const state = herdsmanAgentState(source);
  const activity = activityRows(source.activity);
  return {
    label: source.label,
    definition: source.definition ?? "unknown",
    parent: source.parentLabel ?? null,
    state,
    ...(source.task ? { task: boundText(source.task, TASK_LIMIT_CHARS) } : {}),
    ...(state === "running" && activity.length ? { activity } : {}),
    ...(source.startedAt !== undefined ? { startedAt: source.startedAt } : {}),
    ...(source.result ? { endedAt: source.result.completedAt } : {}),
    ...(source.pendingAsk
      ? {
          question: {
            text: boundBytes(source.pendingAsk.question) ?? "",
            files: [...(source.pendingAsk.files ?? [])],
          },
        }
      : {}),
    ...(source.result?.text ? { answer: boundBytes(source.result.text) } : {}),
    ...(source.result?.resultRef ? { resultRef: source.result.resultRef } : {}),
    ...(source.resumable ? { resumable: true } : {}),
  };
}

type AgentTrim = (agent: HerdsmanRpcAgent) => HerdsmanRpcAgent;

const withoutActivity: AgentTrim = ({ activity: _activity, ...agent }) => agent;
const withoutText: AgentTrim = ({ answer: _answer, question, ...agent }) => ({
  ...agent,
  ...(question ? { question: { text: "", files: question.files } } : {}),
});
const withoutTask: AgentTrim = ({ task: _task, ...agent }) => agent;

/**
 * Serializes within the size budget by trimming activity, then answer and
 * question text, then tasks, then the tail of the agent list.
 */
export function serializeHerdsmanRpcSnapshot(
  snapshot: HerdsmanRpcSnapshot,
  limitBytes = HERDSMAN_SNAPSHOT_LIMIT_BYTES,
): string {
  const bounded: HerdsmanRpcSnapshot = {
    ...snapshot,
    agents: snapshot.agents.slice(0, AGENT_LIMIT),
  };
  const render = (agents: HerdsmanRpcAgent[]): string =>
    JSON.stringify({ ...bounded, agents });
  const fits = (text: string): boolean =>
    Buffer.byteLength(text, "utf8") <= limitBytes;
  let agents = bounded.agents;
  for (const trim of [withoutActivity, withoutText, withoutTask]) {
    agents = agents.map(trim);
    const text = render(agents);
    if (fits(text)) return text;
  }
  while (agents.length) {
    agents = agents.slice(0, -1);
    const text = render(agents);
    if (fits(text)) return text;
  }
  return render(agents);
}

/** Opaque timer handle; only the injected timers interpret it. */
export type HerdsmanFeedTimer = object | number;

export type HerdsmanFeedTimers = {
  now(): number;
  schedule(callback: () => void, delayMs: number): HerdsmanFeedTimer;
  cancel(handle: HerdsmanFeedTimer): void;
};

const defaultTimers: HerdsmanFeedTimers = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Trailing-throttled publisher: at most one publish per throttle window, and the
 * state that is published is the one loaded at publish time. A failed load is
 * dropped; the next state change requests another publish.
 */
export function createHerdsmanStatusFeed(options: {
  load(): Promise<HerdsmanRpcSnapshot>;
  publish(snapshot: string): void;
  throttleMs?: number;
  timers?: HerdsmanFeedTimers;
}): { request(): void; dispose(): void } {
  const timers = options.timers ?? defaultTimers;
  const throttleMs = options.throttleMs ?? HERDSMAN_FEED_THROTTLE_MS;
  let timer: HerdsmanFeedTimer | undefined;
  let dirty = false;
  let inFlight = false;
  let disposed = false;
  let publishedAt = Number.NEGATIVE_INFINITY;
  const schedule = (): void => {
    if (disposed || timer !== undefined) return;
    const delay = Math.max(0, publishedAt + throttleMs - timers.now());
    timer = timers.schedule(() => void fire(), delay);
  };
  const fire = async (): Promise<void> => {
    timer = undefined;
    if (disposed) return;
    if (inFlight) {
      schedule();
      return;
    }
    if (!dirty) return;
    dirty = false;
    inFlight = true;
    let snapshot: HerdsmanRpcSnapshot;
    try {
      snapshot = await options.load();
    } catch {
      inFlight = false;
      return;
    }
    inFlight = false;
    if (disposed) return;
    publishedAt = timers.now();
    options.publish(serializeHerdsmanRpcSnapshot(snapshot));
    if (dirty) schedule();
  };
  return {
    request() {
      if (disposed) return;
      dirty = true;
      schedule();
    },
    dispose() {
      disposed = true;
      dirty = false;
      if (timer !== undefined) timers.cancel(timer);
      timer = undefined;
    },
  };
}

const COMMAND_USAGE =
  "Usage: /hm steer|interrupt|reply|close|continue <label> [text]";
const AGENT_LABEL = /^[a-z][a-z0-9_-]{0,31}$/u;

export type ParsedHerdsmanCommand =
  | { action: HerdsmanCommandAction; label: string; text?: string }
  | { error: string };

export function parseHerdsmanCommand(raw: string): ParsedHerdsmanCommand {
  const match = /^\s*(\S+)([\s\S]*)$/u.exec(raw ?? "");
  if (!match) return { error: COMMAND_USAGE };
  const action = match[1]!;
  if (!HERDSMAN_COMMAND_ACTIONS.includes(action as HerdsmanCommandAction))
    return { error: `Unknown /hm sub-command: ${action}\n${COMMAND_USAGE}` };
  const rest = match[2]!.replace(/^\s+/u, "");
  const label = /^\S*/u.exec(rest)![0];
  if (!AGENT_LABEL.test(label))
    return {
      error: `Invalid agent label: ${label || "(missing)"}\n${COMMAND_USAGE}`,
    };
  const text = rest.slice(label.length).replace(/^\s+/u, "");
  if (action === "close")
    return text
      ? { error: `/hm close takes no text\n${COMMAND_USAGE}` }
      : { action: action as HerdsmanCommandAction, label };
  if (!text.trim())
    return { error: `/hm ${action} requires text after the label` };
  return { action: action as HerdsmanCommandAction, label, text };
}

/**
 * Registers `/hm`. The sub-commands drive the same controller operations the
 * `*_agent` tools use; unsupported ones are refused from `capabilities`.
 */
export function registerHerdsmanCommand(options: {
  registerCommand(
    name: string,
    command: {
      description: string;
      handler(raw: string, ctx: ExtensionCommandContext): Promise<void>;
    },
  ): void;
  capabilities(): readonly HerdsmanCommandAction[];
  run(
    action: HerdsmanCommandAction,
    params: { agent: string; message?: string },
    ctx: ExtensionCommandContext,
  ): Promise<void>;
  notify(
    ctx: ExtensionCommandContext,
    message: string,
    type: "info" | "error",
  ): void;
}): void {
  options.registerCommand(HERDSMAN_COMMAND_NAME, {
    description: "Control a Pi Herdsman agent from the RPC client",
    handler: async (raw, ctx) => {
      const parsed = parseHerdsmanCommand(raw);
      if ("error" in parsed) return options.notify(ctx, parsed.error, "error");
      if (!options.capabilities().includes(parsed.action))
        return options.notify(
          ctx,
          `Herdsman does not support /hm ${parsed.action} in this version`,
          "error",
        );
      try {
        await options.run(
          parsed.action,
          {
            agent: parsed.label,
            ...(parsed.text !== undefined ? { message: parsed.text } : {}),
          },
          ctx,
        );
      } catch (error) {
        options.notify(ctx, String(error).replace(/^Error: /u, ""), "error");
        return;
      }
      options.notify(ctx, `Herdsman: ${parsed.action} ${parsed.label}`, "info");
    },
  });
}
