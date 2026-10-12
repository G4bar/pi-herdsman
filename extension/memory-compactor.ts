/**
 * The project-memory compactor: it turns ready nodes into built nodes with
 * direct model calls.
 *
 * It owns no Pi events (phase 4 does); it exposes `onMessage` for new work,
 * `whenSettled` for a per-turn wait, and `stop` for shutdown. Every built node
 * goes through `MemoryStore.appendNode`, the only journal of built summaries.
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Model,
  ModelThinkingLevel,
  Usage,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCompactorDefinition } from "./agent-definitions.ts";
import {
  LEAF_BYTES,
  MemoryStore,
  extractIdentifiers,
  nodeLength,
  nodeStart,
  type MemoryJob,
  type NodeInputs,
  type ViewLine,
} from "./memory.ts";
import {
  LOSSY_MARKER,
  MEMORY_VIEW_DESCRIPTION,
  compressTask,
  mergeTask,
  tooLongTask,
} from "./memory-prompts.ts";
import { modelToken, resolveConfiguredModel } from "./model-selection.ts";

/** How many compaction calls may run at once, from gist §4. */
export const MAX_CONCURRENT_COMPACTIONS = 8;
/** How many over-length retries a node gets, from gist §4. */
export const MAX_LENGTH_RETRIES = 5;
/** Consecutive failures of one node before the failure callback fires once. */
export const FAILURES_BEFORE_REPORT = 3;

export type MemoryCompactorUsage = {
  line: ViewLine;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  retries: number;
};

export type MemoryCompactorFailure = {
  line: ViewLine;
  failures: number;
  error: string;
};

export type MemoryCompactorCallbacks = {
  onNodeBuilt?: (line: ViewLine, text: string) => void;
  onUsage?: (usage: MemoryCompactorUsage) => void;
  onFailure?: (failure: MemoryCompactorFailure) => void;
};

export type MemoryCompactor = {
  /** A new message or node may have made work ready; try to start it. */
  onMessage(): void;
  /**
   * Resolves once every node that covers messages up to `upToIndex` is built,
   * or once every remaining one has failed.
   */
  whenSettled(upToIndex: number, signal?: AbortSignal): Promise<void>;
  /** Aborts every call in flight. Nothing partial is appended. */
  stop(): void;
};

class CompactionFailure extends Error {}

export function start(
  store: MemoryStore,
  ctx: ExtensionContext,
  callbacks: MemoryCompactorCallbacks = {},
): MemoryCompactor {
  const definition = resolveCompactorDefinition(ctx);
  const model = definition.model
    ? resolveConfiguredModel(ctx, definition.model)
    : ctx.model;
  if (!model) {
    throw new Error(
      definition.model
        ? `project memory compactor model ${JSON.stringify(definition.model)} is not available`
        : "project memory compactor has no model: the definition sets none and the session has none",
    );
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(
      `project memory compactor model ${modelToken(model)} has no configured credentials`,
    );
  }
  const requested = definition.thinking ?? ctx.thinkingLevel;
  const reasoning = requested
    ? clampThinkingLevel(model, requested as ModelThinkingLevel)
    : undefined;
  const runner = new CompactorRunner(store, ctx, model, reasoning, callbacks, {
    systemPrompt: `${MEMORY_VIEW_DESCRIPTION}\n\n${definition.body}`,
  });
  runner.pump();
  return runner;
}

class CompactorRunner implements MemoryCompactor {
  private readonly store: MemoryStore;
  private readonly ctx: ExtensionContext;
  private readonly model: Model<Api>;
  private readonly reasoning: ModelThinkingLevel | undefined;
  private readonly callbacks: MemoryCompactorCallbacks;
  private readonly systemPrompt: string;
  private readonly controllers = new Set<AbortController>();
  private readonly failures = new Map<string, number>();
  private readonly reported = new Set<string>();
  private readonly waiters = new Set<() => void>();
  /** Jobs that failed and wait for the next `onMessage`. */
  private retry: MemoryJob[] = [];
  private slots = 0;
  private stopped = false;
  private pumping = false;
  private warmKey: string | undefined;
  private warmGate: Promise<void> | undefined;
  private warmRelease: (() => void) | undefined;

  constructor(
    store: MemoryStore,
    ctx: ExtensionContext,
    model: Model<Api>,
    reasoning: ModelThinkingLevel | undefined,
    callbacks: MemoryCompactorCallbacks,
    options: { systemPrompt: string },
  ) {
    this.store = store;
    this.ctx = ctx;
    this.model = model;
    this.reasoning = reasoning;
    this.callbacks = callbacks;
    this.systemPrompt = options.systemPrompt;
  }

  onMessage(): void {
    if (this.stopped) return;
    const retry = this.retry;
    this.retry = [];
    for (const job of retry) this.store.requeueJob(job);
    this.pump();
  }

  async whenSettled(upToIndex: number, signal?: AbortSignal): Promise<void> {
    while (
      !this.stopped &&
      !this.isSettled(upToIndex) &&
      !this.failedCovers(upToIndex)
    ) {
      if (signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.waiters.delete(wake);
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        this.waiters.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
        if (signal?.aborted) wake();
      });
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.retry = [];
    this.releaseWarm();
    this.notify();
  }

  // --- scheduling -----------------------------------------------------------

  private pump(): void {
    if (this.stopped || this.pumping) return;
    this.pumping = true;
    void this.drain().finally(() => {
      this.pumping = false;
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.slots < MAX_CONCURRENT_COMPACTIONS) {
      const job = this.store.nextJob();
      if (!job) return;
      await this.gate();
      if (this.stopped) {
        this.store.requeueJob(job);
        return;
      }
      this.launch(job);
    }
  }

  /**
   * Cache warm-up: when a burst starts on a new compaction-view prefix, the
   * first call goes alone and the rest wait for its first stream event, so
   * they read the written prefix from the cache. Best effort: a call that
   * settles without an event releases the rest too.
   */
  private async gate(): Promise<void> {
    if (this.slots === 0) {
      this.startBurst();
      return;
    }
    if (this.warmGate) await this.warmGate;
  }

  private startBurst(): void {
    this.releaseWarm();
    let key: string;
    try {
      key = this.store.renderCompaction();
    } catch {
      return;
    }
    if (key === this.warmKey) return;
    this.warmKey = key;
    this.warmGate = new Promise((resolve) => {
      this.warmRelease = resolve;
    });
  }

  private releaseWarm(): void {
    const release = this.warmRelease;
    if (!release) return;
    this.warmRelease = undefined;
    release();
  }

  private launch(job: MemoryJob): void {
    this.slots += 1;
    void this.run(job).finally(() => {
      this.slots -= 1;
      this.releaseWarm();
      this.notify();
      this.pump();
    });
  }

  private async run(job: MemoryJob): Promise<void> {
    const line = jobLine(job);
    const inputs = this.store.nodeInputs(line);
    if (!inputs) return;
    const request: Message[] = [
      userMessage(this.store.renderCompaction(line)),
      userMessage(this.task(inputs)),
    ];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    try {
      const built = await this.build(request, usage, inputs);
      if (this.stopped || !built) return;
      const text = this.markLossy(inputs, built.text);
      this.store.appendNode(line, text);
      this.callbacks.onNodeBuilt?.(line, text);
      this.callbacks.onUsage?.({
        line,
        ...usage,
        retries: built.retries,
      });
      this.failures.delete(jobKey(job));
    } catch (error) {
      if (this.stopped) return;
      this.fail(
        job,
        error instanceof Error ? error.message : "compaction call failed",
      );
    }
    this.notify();
  }

  /**
   * One node build: at most `MAX_LENGTH_RETRIES` over-length retries in the
   * same conversation, keeping the shortest line seen. Throws on a failed,
   * aborted or empty call.
   */
  private async build(
    request: Message[],
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    },
    inputs: NodeInputs,
  ): Promise<{ text: string; retries: number } | undefined> {
    let shortest: string | undefined;
    let retries = 0;
    for (let attempt = 0; attempt <= MAX_LENGTH_RETRIES; attempt += 1) {
      const message = await this.call(request);
      retries = attempt;
      if (message.stopReason === "error" || message.stopReason === "aborted")
        throw new CompactionFailure(
          message.errorMessage ?? `compaction ${message.stopReason}`,
        );
      addUsage(usage, message.usage);
      const text = normalizeOutput(messageText(message));
      if (text === "")
        throw new CompactionFailure("compaction returned an empty line");
      const size = Buffer.byteLength(text, "utf8");
      if (shortest === undefined || size < Buffer.byteLength(shortest, "utf8"))
        shortest = text;
      if (size <= LEAF_BYTES) return { text, retries };
      if (attempt === MAX_LENGTH_RETRIES) break;
      request.push(
        message,
        userMessage(
          tooLongTask({ bytes: size, cut: firstBytes(text, LEAF_BYTES) }),
        ),
      );
    }
    if (shortest === undefined) return undefined;
    return { text: shortest, retries };
  }

  /** One direct model call, with its own abort controller. */
  private async call(request: Message[]): Promise<AssistantMessage> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const stream = this.ctx.modelRegistry.streamSimple(
        this.model,
        { systemPrompt: this.systemPrompt, messages: [...request] },
        {
          signal: controller.signal,
          ...(this.reasoning && this.reasoning !== "off"
            ? { reasoning: this.reasoning }
            : {}),
        },
      );
      let final: AssistantMessage | undefined;
      let first = true;
      for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
        if (first) {
          first = false;
          this.releaseWarm();
        }
        if (event.type === "done") final = event.message;
        else if (event.type === "error") final = event.error;
      }
      if (!final) throw new CompactionFailure("compaction stream ended early");
      return final;
    } finally {
      this.controllers.delete(controller);
    }
  }

  private task(inputs: NodeInputs): string {
    return inputs.kind === "message"
      ? compressTask({
          id: inputs.id,
          kind: inputs.messageKind,
          text: inputs.text,
        })
      : mergeTask({
          line: inputs.line,
          first: inputs.first,
          second: inputs.second,
        });
  }

  /**
   * The deterministic lossy marker: a line that dropped an input identifier,
   * or whose merge child was already lossy, ends with ` …[ids]`.
   */
  private markLossy(inputs: NodeInputs, text: string): string {
    if (text.endsWith(LOSSY_MARKER)) return text;
    let lossy: boolean;
    if (inputs.kind === "message") {
      lossy = extractIdentifiers(inputs.text).some(
        (identifier) => !text.includes(identifier.value),
      );
    } else {
      lossy =
        inputs.first.endsWith(LOSSY_MARKER) ||
        inputs.second.endsWith(LOSSY_MARKER) ||
        extractIdentifiers(inputs.first).some(
          (identifier) => !text.includes(identifier.value),
        ) ||
        extractIdentifiers(inputs.second).some(
          (identifier) => !text.includes(identifier.value),
        );
    }
    return lossy ? `${text} ${LOSSY_MARKER}` : text;
  }

  private fail(job: MemoryJob, error: string): void {
    const key = jobKey(job);
    const failures = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, failures);
    this.retry.push(job);
    if (failures === FAILURES_BEFORE_REPORT && !this.reported.has(key)) {
      this.reported.add(key);
      this.callbacks.onFailure?.({ line: jobLine(job), failures, error });
    }
    this.notify();
  }

  private notify(): void {
    for (const wake of [...this.waiters]) wake();
  }

  // --- settle checks --------------------------------------------------------

  private isSettled(upToIndex: number): boolean {
    return this.builtThrough() >= upToIndex + 1;
  }

  /** How many messages from 0 on are fully covered by built lines. */
  private builtThrough(): number {
    const lines = this.store.compactionLinesBefore([0, this.store.view.T + 1]);
    if (lines.length === 0) return 0;
    const last = lines[lines.length - 1];
    return nodeStart(last) + nodeLength(last);
  }

  private failedCovers(upToIndex: number): boolean {
    if (this.retry.length === 0) return false;
    const from = this.builtThrough();
    if (from > upToIndex) return true;
    const failed = new Set(this.retry.map(jobKey));
    for (const node of frontier(from, upToIndex + 1)) {
      if (this.store.nodeText(node) !== undefined) continue;
      if (!failed.has(nodeJobKey(node))) return false;
    }
    return true;
  }
}

// --- helpers ----------------------------------------------------------------

function jobLine(job: MemoryJob): ViewLine {
  return job.kind === "message" ? [0, job.id] : job.line;
}

function jobKey(job: MemoryJob): string {
  return nodeJobKey(jobLine(job));
}

/** Matches `MemoryStore`'s internal job key for a node. */
function nodeJobKey(line: ViewLine): string {
  return line[0] === 0 ? `message:${line[1]}` : `merge:${line[0]}:${line[1]}`;
}

/** The smallest aligned power-of-two nodes covering `[from, limit)`. */
function frontier(from: number, limit: number): ViewLine[] {
  const nodes: ViewLine[] = [];
  let position = from;
  while (position < limit) {
    let level = 0;
    while (
      position % 2 ** (level + 1) === 0 &&
      position + 2 ** (level + 1) <= limit
    )
      level += 1;
    nodes.push([level, position / 2 ** level]);
    position += 2 ** level;
  }
  return nodes;
}

function userMessage(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

function messageText(message: AssistantMessage): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

function addUsage(
  total: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  },
  usage: Usage,
): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
}

/** Trim, flatten newlines and drop any leading `id+n|` head the model added. */
function normalizeOutput(raw: string): string {
  return raw
    .trim()
    .replace(/\r?\n/g, " ")
    .replace(/^[0-9]+\+[0-9]+\|\s?/, "")
    .trim();
}

/** The first `limit` UTF-8 bytes, never splitting a code point. */
function firstBytes(text: string, limit: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= limit) return text;
  let end = limit;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}
