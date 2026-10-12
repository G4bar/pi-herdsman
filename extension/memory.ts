/**
 * Project memory core: the append-only log, the summary tree, the bounded view
 * and the identifier extractor shared with the zoom gate.
 *
 * No model calls and no Pi event wiring live here; the compactor, the session
 * wiring and the tools build on these primitives.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { claimProcessLock } from "./lock.ts";
import { herdsmanDataRoot } from "./storage.ts";

export type MemoryKind = "user" | "lead" | "tool" | "echo" | "work" | "note";

export type MemorySource = {
  /** Pi session file the entry came from. */
  session: string;
  /** Pi session entry id. */
  entry: string;
  /** Page index when a long text was split over several messages. */
  part: number;
  /** Images are never stored; the flag keeps them reachable through `src`. */
  images?: true;
};

export type MemoryMessage = {
  i: number;
  kind: MemoryKind;
  text: string;
  size: number;
  date: string;
  src: MemorySource;
  hash: string;
};

/** A message before the store assigns its permanent id. */
export type DerivedMessage = Omit<MemoryMessage, "i">;

/** A built tree node line in `tree/YYYY-MM-DD.jsonl`. */
export type MemoryNodeLine = {
  l: number;
  i: number;
  text: string;
  size: number;
};

/** A node of the tree, named `id+n`: `l` and `i` in `node(l, i)`. */
export type ViewLine = readonly [l: number, i: number];

export type MemoryView = {
  version: 1;
  T: number;
  chat: ViewLine[];
  compaction: ViewLine[];
};

/** The inputs of one compaction call, or of a message read whole. */
export type NodeInputs =
  | { kind: "message"; id: number; text: string }
  | { kind: "merge"; line: ViewLine; first: string; second: string };

export type MemoryJob =
  { kind: "message"; id: number } | { kind: "merge"; line: ViewLine };

/** A node at or under this many bytes is built without a model call. */
export const LEAF_BYTES = 512;
/** Tool output is clipped to this many characters of head and tail. */
export const ECHO_CHARS = 30_000;
/** Longer text is split into consecutive messages of this many characters. */
export const PAGE_CHARS = 30_000;
export const CHAT_BYTES = 128_000;
export const CHAT_TARGET_BYTES = 64_000;
export const COMPACTION_BYTES = 32_000;
export const COMPACTION_TARGET_BYTES = 16_000;
/** The view is sent as blocks of this many lines, for the cache marks. */
export const VIEW_BLOCK_LINES = 4;
export const UNBUILT_LINE = "(not summarized yet: zoom it)";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function projectMemoryKey(projectPath: string): string {
  return sha256(realpathSync(projectPath)).slice(0, 16);
}

/** `herdsmanDataRoot()/memory/<projectKey>`, one directory per project. */
export function projectMemoryRoot(projectPath: string): string {
  return join(herdsmanDataRoot(), "memory", projectMemoryKey(projectPath));
}

// --- message derivation -----------------------------------------------------

type MessagePart = { kind: MemoryKind; text: string; images: boolean };
type ContentBlock = { type: string; text?: string };

/** Splits one Pi entry into the memory messages it contributes. */
export function deriveMessages(
  entry: SessionEntry,
  sessionPath: string,
): DerivedMessage[] {
  const parts = entryParts(entry);
  if (parts.length === 0) return [];
  const hash = entryHash(entry);
  return parts.map((part, index) => ({
    kind: part.kind,
    text: part.text,
    size: Buffer.byteLength(part.text, "utf8"),
    date: entry.timestamp,
    src: {
      session: sessionPath,
      entry: entry.id,
      part: index,
      ...(part.images ? { images: true as const } : {}),
    },
    hash,
  }));
}

/** The dedupe key of a Pi entry: its timestamp, type and content. */
export function entryHash(entry: SessionEntry): string {
  return sha256(
    JSON.stringify([entry.timestamp, entry.type, entryContent(entry)]),
  );
}

/** The content a dedupe hash covers: text, content blocks or summary. */
function entryContent(entry: SessionEntry): string {
  if (entry.type === "message")
    return JSON.stringify(
      (entry.message as { content?: unknown }).content ?? entry.message,
    );
  if (entry.type === "custom_message") return JSON.stringify(entry.content);
  if (entry.type === "compaction" || entry.type === "branch_summary")
    return entry.summary;
  return "";
}

function entryParts(entry: SessionEntry): MessagePart[] {
  if (entry.type === "custom_message") {
    const { text, images } = contentText(entry.content);
    if (!text && !images) return [];
    const label = customLabel(entry.details);
    return pages("work", label ? `[${label}] ${text}` : text, images);
  }
  if (entry.type !== "message") return [];
  const message = entry.message as {
    role?: string;
    content?: unknown;
  };
  if (message.role === "user") {
    const { text, images } = contentText(message.content);
    return text || images ? pages("user", text, images) : [];
  }
  if (message.role === "assistant") {
    const parts: MessagePart[] = [];
    for (const block of assistantBlocks(message.content)) {
      if (block.type === "text") {
        if (block.text) parts.push(...pages("lead", block.text, false));
      } else if (block.type === "toolCall") {
        if (block.call) parts.push(...pages("tool", block.call, false));
      }
    }
    return parts;
  }
  if (message.role === "toolResult") {
    const { text, images } = contentText(message.content);
    const clipped = clipEcho(text);
    return text || images ? pages("echo", clipped, images) : [];
  }
  // Other roles (bash executions) are not memory messages.
  return [];
}

type AssistantBlock = { type: string; text?: string; call?: string };

function assistantBlocks(content: unknown): AssistantBlock[] {
  if (!Array.isArray(content)) return [];
  return content.map((block) => {
    const record = block as {
      type?: string;
      text?: string;
      name?: string;
      arguments?: unknown;
    };
    if (record.type === "text")
      return { type: "text", text: record.text ?? "" };
    if (record.type === "toolCall")
      return {
        type: "toolCall",
        call: `${record.name} ${JSON.stringify(record.arguments ?? {})}`,
      };
    // Thoughts are never logged.
    return { type: record.type ?? "" };
  });
}

function contentText(content: unknown): { text: string; images: boolean } {
  if (typeof content === "string") return { text: content, images: false };
  if (!Array.isArray(content)) return { text: "", images: false };
  const texts: string[] = [];
  let images = false;
  for (const block of content as ContentBlock[]) {
    if (block.type === "text" && typeof block.text === "string")
      texts.push(block.text);
    else if (block.type === "image") images = true;
  }
  return { text: texts.filter(Boolean).join("\n"), images };
}

function customLabel(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const record = details as Record<string, unknown>;
  const label = record.agentLabel ?? record.label;
  return typeof label === "string" && label ? label : undefined;
}

function pages(kind: MemoryKind, text: string, images: boolean): MessagePart[] {
  if (!text) return images ? [{ kind, text, images: true }] : [];
  const parts: MessagePart[] = [];
  for (let at = 0; at < text.length; at += PAGE_CHARS)
    parts.push({ kind, text: text.slice(at, at + PAGE_CHARS), images: false });
  if (images) parts[0] = { ...parts[0], images: true };
  return parts;
}

/** A tool result keeps its head and tail, 30,000 characters in all. */
export function clipEcho(text: string): string {
  if (text.length <= ECHO_CHARS) return text;
  const side = Math.floor(ECHO_CHARS / 2) - 64;
  const omitted = text.length - side * 2;
  const marker = `\n[... ${omitted} characters omitted ...]\n`;
  return `${text.slice(0, side)}${marker}${text.slice(text.length - side)}`;
}

// --- tree coordinates -------------------------------------------------------

export function nodeKey(line: ViewLine): string {
  return `${line[0]}:${line[1]}`;
}

/** The first message the node covers. */
export function nodeStart(line: ViewLine): number {
  return line[1] * 2 ** line[0];
}

/** How many messages the node covers. */
export function nodeLength(line: ViewLine): number {
  return 2 ** line[0];
}

/** The `id+n` name the model uses to open a node. */
export function lineLabel(line: ViewLine): string {
  return `${nodeStart(line)}+${nodeLength(line)}`;
}

/** `node(l, i)` for a first message `id` and a covered count `n`. */
export function nodeAt(id: number, n: number): ViewLine | undefined {
  if (!Number.isInteger(id) || id < 0) return undefined;
  if (!Number.isSafeInteger(n) || n < 1) return undefined;
  const l = Math.log2(n);
  if (!Number.isInteger(l) || id % n !== 0) return undefined;
  return [l, id / n];
}

export function parseLineLabel(label: string): ViewLine | undefined {
  const match = /^([0-9]+)\+([0-9]+)$/.exec(label.trim());
  if (!match) return undefined;
  return nodeAt(Number(match[1]), Number(match[2]));
}

// --- view math --------------------------------------------------------------

/**
 * The most due mergeable pair of adjacent sibling lines, as its left index.
 *
 * Due is `(T - last) / 2^l`: how long ago the pair ended, measured in its own
 * line size. Among equal pairs the oldest wins.
 */
export function mostDuePair(
  lines: readonly ViewLine[],
  T: number,
  canMerge: (parent: ViewLine) => boolean,
): number | undefined {
  let best: { index: number; l: number; age: number; last: number } | undefined;
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const [l, i] = lines[index];
    const next = lines[index + 1];
    if (next[0] !== l || next[1] !== i + 1 || i % 2 !== 0) continue;
    if (!canMerge([l + 1, i / 2])) continue;
    const last = (i + 2) * 2 ** l - 1;
    const age = T - last;
    if (age <= 0) continue;
    if (best === undefined) {
      best = { index, l, age, last };
      continue;
    }
    // `age / 2^l`, compared as integers so equal pairs stay exactly equal.
    const left = age * 2 ** best.l;
    const right = best.age * 2 ** l;
    if (left > right || (left === right && last < best.last))
      best = { index, l, age, last };
  }
  return best?.index;
}

/** Merges the most due pair, or undefined when no pair can merge. */
export function mergeMostDue(
  lines: readonly ViewLine[],
  T: number,
  canMerge: (parent: ViewLine) => boolean,
): ViewLine[] | undefined {
  const index = mostDuePair(lines, T, canMerge);
  if (index === undefined) return undefined;
  const [l, i] = lines[index];
  return [...lines.slice(0, index), [l + 1, i / 2], ...lines.slice(index + 2)];
}

export function renderLine(line: ViewLine, text: string | undefined): string {
  const body = text === undefined ? UNBUILT_LINE : text.replace(/\r?\n/g, " ");
  return `${lineLabel(line)}|${body}`;
}

export function renderView(
  lines: readonly ViewLine[],
  textOf: (line: ViewLine) => string | undefined,
): string {
  const rendered = lines.map((line) => renderLine(line, textOf(line)));
  return ["<chat>", ...rendered, "</chat>"].join("\n");
}

/** The view as an ordered list of blocks, for the cache marks. */
export function renderBlocks(
  lines: readonly ViewLine[],
  textOf: (line: ViewLine) => string | undefined,
  blockLines = VIEW_BLOCK_LINES,
): string[] {
  const blocks: string[] = [];
  for (let at = 0; at < lines.length; at += blockLines)
    blocks.push(
      lines
        .slice(at, at + blockLines)
        .map((line) => renderLine(line, textOf(line)))
        .join("\n"),
    );
  return blocks;
}

// --- identifiers ------------------------------------------------------------

export type IdentifierKind =
  "uuid" | "ref" | "path" | "url" | "number" | "code";

export type MemoryIdentifier = { kind: IdentifierKind; value: string };

const IDENTIFIER_ORDER: readonly IdentifierKind[] = [
  "uuid",
  "ref",
  "path",
  "url",
  "number",
  "code",
];

const IDENTIFIER_PATTERNS: readonly {
  kind: IdentifierKind;
  pattern: RegExp;
}[] = [
  // 8-4-4-4-12 hex, case-insensitive.
  {
    kind: "uuid",
    pattern:
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
  // `result:` followed by an agent label, with an optional `#N` index.
  { kind: "ref", pattern: /result:[A-Za-z0-9_-]+(?:#[0-9]+)?/g },
  // A scheme followed by `://`; matched here so it is not also a path.
  { kind: "url", pattern: /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g },
  // Text in backticks, usually a command.
  { kind: "code", pattern: /`([^`\n]+)`/g },
  // Four or more digits, or digits with a decimal point.
  { kind: "number", pattern: /\b[0-9]{4,}\b|\b[0-9]+\.[0-9]+\b/g },
];

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const EXTENSION = /\.[A-Za-z0-9]{1,8}$/;
const TRAILING_PUNCTUATION = /[.,;:)\]}>'"]+$/;
const LEADING_PUNCTUATION = /^["'([{]+/;

/**
 * Typed identifiers in text, in first-appearance order, deduped.
 *
 * The zoom gate compares the identifiers an action uses against the ones the
 * view already holds, so this errs toward extracting more, never less.
 */
export function extractIdentifiers(text: string): MemoryIdentifier[] {
  const found: { kind: IdentifierKind; value: string; index: number }[] = [];
  for (const { kind, pattern } of IDENTIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      found.push({
        kind,
        value: identifierValue(kind, match),
        index: match.index ?? 0,
      });
    }
  }
  // Double quotes separate tokens, because JSON arguments quote their values.
  for (const match of text.matchAll(/[^\s"]+/g)) {
    const value = trimToken(match[0]);
    if (!value || SCHEME.test(value)) continue;
    if (!value.includes("/") && !EXTENSION.test(value)) continue;
    found.push({ kind: "path", value, index: match.index ?? 0 });
  }
  found.sort(
    (left, right) =>
      left.index - right.index ||
      IDENTIFIER_ORDER.indexOf(left.kind) -
        IDENTIFIER_ORDER.indexOf(right.kind),
  );
  const seen = new Set<string>();
  return found
    .filter(({ kind, value }) => {
      const key = `${kind}\u0000${value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ kind, value }) => ({ kind, value }));
}

function identifierValue(
  kind: IdentifierKind,
  match: RegExpMatchArray,
): string {
  // A UUID is matched case-insensitively, so one spelling is used everywhere.
  if (kind === "uuid") return match[0].toLowerCase();
  if (kind === "code") return match[1];
  return trimToken(match[0]);
}

function trimToken(token: string): string {
  return token
    .replace(LEADING_PUNCTUATION, "")
    .replace(TRAILING_PUNCTUATION, "");
}

// --- store ------------------------------------------------------------------

type MessageRecord = MemoryMessage & { file: string; offset: number };
type NodeRecord = { file: string; offset: number; size: number };

/**
 * One project's memory: the append-only logs, the built nodes, the view and
 * the ready compaction queues. The process that opens it owns it.
 */
export class MemoryStore {
  readonly projectPath: string;
  readonly root: string;
  /** True when the saved view could not be used and was rebuilt. */
  viewRebuilt = false;

  private readonly release: () => void;
  private records: MessageRecord[] = [];
  private nodes = new Map<string, NodeRecord>();
  private chat: ViewLine[] = [];
  private compaction: ViewLine[] = [];
  private chatSize = 0;
  private compactionSize = 0;
  private torn = new Set<string>();
  private queue: MemoryJob[] = [];
  private queued = new Set<string>();
  private closed = false;

  constructor(projectPath: string) {
    this.projectPath = realpathSync(projectPath);
    this.root = projectMemoryRoot(this.projectPath);
    mkdirSync(join(this.root, "main"), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, "tree"), { recursive: true, mode: 0o700 });
    this.release = claimProcessLock(join(this.root, "lock"), {
      name: "project memory",
      occupiedMessage: "Project memory is already open",
    });
    try {
      this.writeProjectFile();
      this.load();
    } catch (error) {
      this.release();
      this.closed = true;
      throw error;
    }
  }

  get messageCount(): number {
    return this.records.length;
  }

  get view(): MemoryView {
    return {
      version: 1,
      T: this.records.length,
      chat: this.chat.map((line) => [...line] as ViewLine),
      compaction: this.compaction.map((line) => [...line] as ViewLine),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.release();
  }

  /** Derives and appends every memory message of one Pi entry. */
  appendEntry(
    entry: SessionEntry,
    sessionPath: string,
  ): readonly MemoryMessage[] {
    return deriveMessages(entry, sessionPath).map((message) =>
      this.appendMessage(message),
    );
  }

  /** Appends one message and its leaf line. */
  appendMessage(message: DerivedMessage): MemoryMessage {
    this.assertOpen();
    const i = this.records.length;
    const record: MemoryMessage = {
      i,
      kind: message.kind,
      text: message.text,
      size: message.size,
      date: message.date,
      src: message.src,
      hash: message.hash,
    };
    const file = this.dayFile("main", message.date);
    const offset = this.appendLine(file, JSON.stringify(record));
    this.records.push({ ...record, file, offset });
    this.pushLeaf(i);
    this.seedLeaf(i);
    this.syncCompaction();
    this.saveView();
    return record;
  }

  /** Logs a node the compactor built, then refreshes the view and the queue. */
  appendNode(line: ViewLine, text: string): void {
    this.assertOpen();
    const [l, i] = line;
    if (!Number.isInteger(l) || l < 0 || !Number.isInteger(i) || i < 0)
      throw new Error("Invalid project memory node coordinates");
    if (typeof text !== "string" || text.length === 0)
      throw new Error("Invalid project memory node text");
    // Each node is built once and never built again.
    if (this.nodes.has(nodeKey(line))) return;
    const record: MemoryNodeLine = {
      l,
      i,
      text,
      size: Buffer.byteLength(text, "utf8"),
    };
    const file = this.dayFile("tree", this.nodeDate(line));
    const offset = this.appendLine(file, JSON.stringify(record));
    this.nodes.set(nodeKey(line), {
      file,
      offset,
      size: record.size,
    });
    this.chatSize = this.bytes(this.chat);
    if (this.chatSize > CHAT_BYTES) this.mergeChatBatch();
    this.refreshJobs(line);
    this.syncCompaction();
    this.saveView();
  }

  /** The text of a built or call-free node, or undefined when it needs a call. */
  nodeText(line: ViewLine): string | undefined {
    const built = this.nodes.get(nodeKey(line));
    if (built) return readLogText(built.file, built.offset);
    const [l, i] = line;
    if (!this.withinLog(line)) return undefined;
    if (l === 0) {
      const record = this.records[i];
      if (!record || record.size > LEAF_BYTES) return undefined;
      return readLogText(record.file, record.offset);
    }
    const first = this.nodeText([l - 1, i * 2]);
    const second = this.nodeText([l - 1, i * 2 + 1]);
    if (first === undefined || second === undefined) return undefined;
    const joined = `${first}\n${second}`;
    return Buffer.byteLength(joined, "utf8") <= LEAF_BYTES ? joined : undefined;
  }

  /** True when the node must be built by a compaction call. */
  needsCall(line: ViewLine): boolean {
    return this.nodeSize(line) === undefined;
  }

  /** True when the node's two children are already available. */
  canBuildWithoutCall(line: ViewLine): boolean {
    return this.nodeText(line) !== undefined;
  }

  nodeInputs(line: ViewLine): NodeInputs | undefined {
    const [l, i] = line;
    if (!this.withinLog(line)) return undefined;
    if (l === 0) {
      const record = this.records[i];
      if (!record) return undefined;
      return {
        kind: "message",
        id: i,
        text: readLogText(record.file, record.offset) ?? "",
      };
    }
    const first = this.nodeText([l - 1, i * 2]);
    const second = this.nodeText([l - 1, i * 2 + 1]);
    if (first === undefined || second === undefined) return undefined;
    return { kind: "merge", line, first, second };
  }

  messageText(i: number): string | undefined {
    const record = this.records[i];
    return record ? readLogText(record.file, record.offset) : undefined;
  }

  messageSource(i: number): MemorySource | undefined {
    const record = this.records[i];
    return record
      ? {
          ...record.src,
          ...(record.src.images ? { images: true as const } : {}),
        }
      : undefined;
  }

  /** The next node that is ready to build, in start order. */
  nextJob(): MemoryJob | undefined {
    const job = this.queue.shift();
    if (job) this.queued.delete(jobKey(job));
    return job;
  }

  /** Puts a job the compactor could not build back at the end of the queue. */
  requeueJob(job: MemoryJob): void {
    const line: ViewLine = job.kind === "message" ? [0, job.id] : job.line;
    if (this.needsCall(line)) this.enqueue(job);
  }

  renderChat(): string {
    return renderView(this.chat, (line) => this.nodeText(line));
  }

  renderCompaction(): string {
    return renderView(this.compaction, (line) => this.nodeText(line));
  }

  renderChatBlocks(): string[] {
    return renderBlocks(this.chat, (line) => this.nodeText(line));
  }

  /** The latest view line whose summary contains `text`. */
  latestLineContaining(text: string): ViewLine | undefined {
    for (let index = this.chat.length - 1; index >= 0; index -= 1) {
      const line = this.chat[index];
      const node = this.nodeText(line);
      if (node !== undefined && node.includes(text)) return line;
    }
    return undefined;
  }

  // --- loading --------------------------------------------------------------

  private writeProjectFile(): void {
    const path = join(this.root, "project.json");
    if (statSync(path, { throwIfNoEntry: false })) return;
    const project = {
      version: 1,
      key: basename(this.root),
      path: this.projectPath,
    };
    writeFileSync(path, `${JSON.stringify(project)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
  }

  private load(): void {
    this.records = [];
    this.nodes.clear();
    this.torn.clear();
    this.readLog("main", (value, file, offset) =>
      this.loadMessage(value, file, offset),
    );
    this.readLog("tree", (value, file, offset) =>
      this.loadNode(value, file, offset),
    );

    const saved = this.readViewFile();
    if (saved && this.viewUsable(saved)) {
      this.chat = saved.chat;
      this.compaction = saved.compaction;
      this.chatSize = this.bytes(this.chat);
    } else {
      // A missing, unparsable or stale view is rebuilt deterministically; the
      // rebuild costs a prompt-cache miss, which phase 7 records.
      this.viewRebuilt = true;
      this.chat = [];
      this.compaction = [];
      this.chatSize = 0;
    }
    // A crash between the log append and the view write leaves unviewed
    // messages; they append as leaves, exactly as they would have live.
    for (let i = this.chatEnd(); i < this.records.length; i += 1)
      this.pushLeaf(i);

    this.syncCompaction();
    for (let i = 0; i < this.records.length; i += 1) this.seedLeaf(i);
    for (const key of [...this.nodes.keys()]) {
      const [l, i] = key.split(":");
      this.refreshJobs([Number(l), Number(i)]);
    }
    this.saveView();
  }

  private loadMessage(value: unknown, file: string, offset: number): void {
    const record = value as MemoryMessage;
    if (!record || typeof record !== "object") return;
    // Ids are linear, so a line that breaks the sequence is not this log.
    if (record.i !== this.records.length) return;
    if (!isKind(record.kind) || typeof record.text !== "string") return;
    if (!Number.isInteger(record.size) || record.size < 0) return;
    if (typeof record.date !== "string" || typeof record.hash !== "string")
      return;
    if (!isSource(record.src)) return;
    this.records.push({ ...record, file, offset });
  }

  private loadNode(value: unknown, file: string, offset: number): void {
    const record = value as MemoryNodeLine;
    if (!record || typeof record !== "object") return;
    const { l, i, text, size } = record;
    if (!Number.isInteger(l) || l < 0 || !Number.isInteger(i) || i < 0) return;
    if (typeof text !== "string" || text.length === 0) return;
    if (!Number.isInteger(size) || size < 0) return;
    this.nodes.set(nodeKey([l, i]), { file, offset, size });
  }

  private readLog(
    directory: string,
    accept: (value: unknown, file: string, offset: number) => void,
  ): void {
    const path = join(this.root, directory);
    let names: string[];
    try {
      names = readdirSync(path)
        .filter((name) => name.endsWith(".jsonl"))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      const file = join(path, name);
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      let offset = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        // A torn last line is ignored; the next append starts on a new line.
        const torn = index === lines.length - 1 && line !== "";
        if (line !== "") {
          if (torn) this.torn.add(file);
          else {
            try {
              accept(JSON.parse(line), file, offset);
            } catch {
              // An unreadable line is not part of the log.
            }
          }
        }
        offset += Buffer.byteLength(line, "utf8") + 1;
      }
    }
  }

  private readViewFile(): MemoryView | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(this.root, "view.json"), "utf8"));
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object") return undefined;
    const view = parsed as MemoryView;
    if (view.version !== 1) return undefined;
    if (!isViewLines(view.chat) || !isViewLines(view.compaction))
      return undefined;
    return view;
  }

  private viewUsable(view: MemoryView): boolean {
    if (!Number.isInteger(view.T) || view.T < 0) return false;
    // The view may not reach past the newest message it claims to cover.
    const limit = Math.min(view.T, this.records.length);
    const covers = (
      lines: readonly ViewLine[],
      usable: (line: ViewLine) => boolean,
    ) => {
      let position = 0;
      for (const line of lines) {
        if (nodeStart(line) !== position) return false;
        position = nodeStart(line) + nodeLength(line);
        if (position > limit) return false;
        if (!usable(line)) return false;
      }
      return true;
    };
    const built = (line: ViewLine) => this.nodeText(line) !== undefined;
    // Only a pending leaf may be unbuilt in the chat view; an unbuilt merge
    // line, or any unbuilt line in the compaction view, is a lost summary.
    return (
      covers(view.chat, (line) => line[0] === 0 || built(line)) &&
      covers(view.compaction, built)
    );
  }

  // --- writing --------------------------------------------------------------

  private appendLine(file: string, line: string): number {
    const prefix = this.torn.has(file) ? "\n" : "";
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    writeFileSync(file, `${prefix}${line}\n`, {
      encoding: "utf8",
      flag: "a",
      flush: true,
    });
    this.torn.delete(file);
    return size + Buffer.byteLength(prefix, "utf8");
  }

  private dayFile(directory: "main" | "tree", date: string): string {
    return join(this.root, directory, `${dayKey(date)}.jsonl`);
  }

  private nodeDate(line: ViewLine): string {
    const first = this.records[nodeStart(line)];
    return first ? first.date : new Date().toISOString();
  }

  private saveView(): void {
    writeAtomically(
      join(this.root, "view.json"),
      `${JSON.stringify(this.view)}\n`,
    );
  }

  // --- view -----------------------------------------------------------------

  private withinLog(line: ViewLine): boolean {
    const [l, i] = line;
    if (l < 0 || i < 0) return false;
    return (i + 1) * 2 ** l <= this.records.length;
  }

  /** The size of a node's text, without reading it. */
  private nodeSize(line: ViewLine): number | undefined {
    const built = this.nodes.get(nodeKey(line));
    if (built) return built.size;
    const [l, i] = line;
    if (!this.withinLog(line)) return undefined;
    if (l === 0) {
      const record = this.records[i];
      return record && record.size <= LEAF_BYTES ? record.size : undefined;
    }
    const first = this.nodeSize([l - 1, i * 2]);
    if (first === undefined) return undefined;
    const second = this.nodeSize([l - 1, i * 2 + 1]);
    if (second === undefined) return undefined;
    const joined = first + second + 1;
    return joined <= LEAF_BYTES ? joined : undefined;
  }

  private lineBytes(line: ViewLine): number {
    return Buffer.byteLength(renderLine(line, this.nodeText(line)), "utf8");
  }

  private bytes(lines: readonly ViewLine[]): number {
    let size = 0;
    for (const line of lines) size += this.lineBytes(line);
    return size;
  }

  /** The last message the view covers; its leaf lines end here. */
  private chatEnd(): number {
    let end = 0;
    for (const line of this.chat)
      end = Math.max(end, nodeStart(line) + nodeLength(line));
    return end;
  }

  private pushLeaf(id: number): void {
    const line: ViewLine = [0, id];
    this.chat.push(line);
    this.chatSize += this.lineBytes(line);
    if (this.chatSize > CHAT_BYTES) this.mergeChatBatch();
  }

  /** One batch merges the most due pairs until the view fits its target. */
  private mergeChatBatch(): void {
    while (this.chatSize > CHAT_TARGET_BYTES) {
      const index = mostDuePair(
        this.chat,
        this.records.length,
        (parent) => this.nodeText(parent) !== undefined,
      );
      if (index === undefined) return;
      this.chatSize += this.applyMerge(this.chat, index);
    }
  }

  private applyMerge(lines: ViewLine[], index: number): number {
    const [l, i] = lines[index];
    const parent: ViewLine = [l + 1, i / 2];
    const delta =
      this.lineBytes(parent) -
      this.lineBytes(lines[index]) -
      this.lineBytes(lines[index + 1]);
    lines.splice(index, 2, parent);
    return delta;
  }

  /**
   * The compaction view is the chat view merged further: only built lines,
   * cut at the first unbuilt one, and merged down once it passes its bound.
   */
  private syncCompaction(): void {
    const source: ViewLine[] = [];
    for (const line of this.chat) {
      if (this.nodeText(line) === undefined) break;
      source.push(line);
    }
    const sourceEnd =
      source.length > 0
        ? nodeStart(source[source.length - 1]) +
          nodeLength(source[source.length - 1])
        : 0;
    // Drop compaction lines the chat no longer covers, and any line whose end
    // is not a chat boundary (the chat may have merged past it).
    while (this.compaction.length > 0) {
      const last = this.compaction[this.compaction.length - 1];
      const end = nodeStart(last) + nodeLength(last);
      if (end <= sourceEnd && source.some((line) => nodeStart(line) === end))
        break;
      this.compaction.pop();
    }
    const covered =
      this.compaction.length > 0
        ? nodeStart(this.compaction[this.compaction.length - 1]) +
          nodeLength(this.compaction[this.compaction.length - 1])
        : 0;
    const from = source.findIndex((line) => nodeStart(line) === covered);
    if (from >= 0) this.compaction.push(...source.slice(from));

    this.compactionSize = this.bytes(this.compaction);
    while (this.compactionSize > COMPACTION_BYTES) {
      const index = mostDuePair(
        this.compaction,
        this.records.length,
        (parent) => this.nodeText(parent) !== undefined,
      );
      if (index === undefined) break;
      this.compactionSize += this.applyMerge(this.compaction, index);
    }
  }

  // --- work queues ----------------------------------------------------------

  /** Queues the work a message unblocks: its leaf, or its call-free ancestors. */
  private seedLeaf(id: number): void {
    if (this.needsCall([0, id])) {
      this.enqueue({ kind: "message", id });
      return;
    }
    this.refreshJobs([0, id]);
  }

  private enqueue(job: MemoryJob): void {
    const key = jobKey(job);
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push(job);
  }

  /**
   * Queues the mergeable ancestors a freshly built node unblocks. Call-free
   * ancestors are carried through; the first node that needs a call is queued.
   */
  private refreshJobs(line: ViewLine): void {
    let current: ViewLine = [line[0] + 1, Math.floor(line[1] / 2)];
    for (;;) {
      if (!this.withinLog(current)) return;
      if (this.nodeText(current) !== undefined)
        current = [current[0] + 1, Math.floor(current[1] / 2)];
      else {
        if (this.nodeInputs(current) !== undefined)
          this.enqueue({ kind: "merge", line: current });
        return;
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Project memory is closed");
  }
}

function jobKey(job: MemoryJob): string {
  return job.kind === "message"
    ? `message:${job.id}`
    : `merge:${nodeKey(job.line)}`;
}

function isKind(value: unknown): value is MemoryKind {
  return (
    value === "user" ||
    value === "lead" ||
    value === "tool" ||
    value === "echo" ||
    value === "work" ||
    value === "note"
  );
}

function isSource(value: unknown): value is MemorySource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.session === "string" &&
    typeof source.entry === "string" &&
    Number.isInteger(source.part) &&
    (source.part as number) >= 0
  );
}

function isViewLines(value: unknown): value is ViewLine[] {
  return (
    Array.isArray(value) &&
    value.every(
      (line) =>
        Array.isArray(line) &&
        line.length === 2 &&
        Number.isInteger(line[0]) &&
        Number.isInteger(line[1]) &&
        line[0] >= 0 &&
        line[1] >= 0,
    )
  );
}

function dayKey(date: string): string {
  const day = date.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const parsed = new Date(date);
  if (!Number.isFinite(parsed.getTime()))
    throw new Error("Invalid project memory date");
  return parsed.toISOString().slice(0, 10);
}

/** Reads the text field of one log line, on demand. */
function readLogText(file: string, offset: number): string | undefined {
  const line = readLine(file, offset);
  if (line === undefined) return undefined;
  try {
    const parsed = JSON.parse(line) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : undefined;
  } catch {
    return undefined;
  }
}

/** Reads one raw line of a log file. */
function readLine(file: string, offset: number): string | undefined {
  const descriptor = openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    let position = offset;
    for (;;) {
      const buffer = Buffer.allocUnsafe(65536);
      const read = readSync(descriptor, buffer, 0, buffer.length, position);
      if (read <= 0) return undefined;
      const line = buffer.subarray(0, read);
      const end = line.indexOf(0x0a);
      if (end >= 0) {
        chunks.push(line.subarray(0, end));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(line);
      position += read;
    }
  } finally {
    closeSync(descriptor);
  }
}

function writeAtomically(path: string, content: string): void {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
