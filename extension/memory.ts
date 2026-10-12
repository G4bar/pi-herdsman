/**
 * Project memory core: the append-only log, the summary tree, the bounded view
 * and the identifier extractor shared with the zoom gate.
 *
 * No model calls and no Pi event wiring live here; the compactor, the session
 * wiring and the tools build on these primitives.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  convertToLlm,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { claimProcessLock } from "./lock.ts";
import { herdsmanDataRoot, writeAtomically } from "./storage.ts";

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
  | {
      kind: "message";
      id: number;
      /** `kind` names the variant, so the memory kind has its own field. */
      messageKind: MemoryKind;
      text: string;
    }
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
const UNBUILT_BYTES = Buffer.byteLength(UNBUILT_LINE, "utf8");
/** The body of a message that only carried images. Images are not stored. */
const IMAGE_BODY = "(image)";
const IMAGE_BODY_BYTES = Buffer.byteLength(IMAGE_BODY, "utf8");

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
    command?: unknown;
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
  if (message.role === "bashExecution") {
    // Pi's own text: `Ran <cmd>` plus the fenced output and its notes. The
    // user's command is their words; the output is an echo. A command can
    // hold newlines, so its own length decides where it ends.
    const [converted] = convertToLlm([entry.message]);
    if (!converted) return [];
    const text = contentText(converted.content).text;
    const { command } = message as { command?: unknown };
    const head = typeof command === "string" ? `Ran \`${command}\`` : "";
    const user = head && text.startsWith(head) ? head : text.split("\n")[0];
    return [
      ...pages("user", user, false),
      ...pages("echo", clipEcho(text.slice(user.length).trim()), false),
    ];
  }
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
  let at = 0;
  while (at < text.length) {
    const end =
      at + PAGE_CHARS >= text.length
        ? text.length
        : safeCut(text, at + PAGE_CHARS);
    parts.push({ kind, text: text.slice(at, end), images: false });
    at = end;
  }
  if (images) parts[0] = { ...parts[0], images: true };
  return parts;
}

/** A tool result keeps its head and tail, 30,000 characters in all. */
export function clipEcho(text: string): string {
  if (text.length <= ECHO_CHARS) return text;
  const side = Math.floor(ECHO_CHARS / 2) - 64;
  const head = safeCut(text, side);
  const tail = safeCut(text, text.length - side);
  const omitted = tail - head;
  const marker = `\n[... ${omitted} characters omitted ...]\n`;
  return `${text.slice(0, head)}${marker}${text.slice(tail)}`;
}

/** Moves a cut back when it would split a surrogate pair. */
function safeCut(text: string, at: number): number {
  const code = text.charCodeAt(at);
  return at > 0 && at < text.length && code >= 0xdc00 && code <= 0xdfff
    ? at - 1
    : at;
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
  // A scheme followed by `://`, up to the quote or bracket that ends it.
  { kind: "url", pattern: /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"`\\<>]+/g },
  // Text in backticks, usually a command.
  { kind: "code", pattern: /`([^`\n]+)`/g },
  // Four or more digits, or a decimal, but never half of a longer version.
  {
    kind: "number",
    pattern: /(?<![\w.])\d{4,}(?!\.?\d)|(?<![\w.])\d+\.\d+(?!\.?\d)/g,
  },
];

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
// A bare file name: a 2-8 character lowercase extension holding a letter.
const FILE_EXTENSION = /\.[a-z0-9]{2,8}$/;
const HAS_LETTER = /[a-z]/;
const UPPERCASE = /[A-Z]/;
// Tokens stop at the punctuation JSON, markdown and shells wrap values in.
const TOKEN = /[^\s"`=<>()[\]{},;]+/g;
const TRAILING_PUNCTUATION = /[.,;:)\]}>'"`]+$/;
const LEADING_PUNCTUATION = /^["'([{`]+/;

/**
 * A bare file name (no directory) counts as a path only with a 2-8 character
 * lowercase extension that holds a letter, so prose such as `e.g`, `i.e`,
 * `Node.js` and `1.2.3` is not one; a token containing `/` always is.
 */
function isBareFileName(token: string): boolean {
  const extension = FILE_EXTENSION.exec(token);
  if (!extension || UPPERCASE.test(token)) return false;
  return HAS_LETTER.test(extension[0]);
}

/**
 * Typed identifiers in text, in first-appearance order, deduped.
 *
 * The zoom gate compares the identifiers an action uses against the ones the
 * view already holds, so this errs toward extracting more, never less. UUIDs
 * are stored lowercase and must be compared case-insensitively.
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
  // JSON arguments escape newlines, tabs and quotes; a space keeps the
  // tokens on either side apart. Indices come from the unescaped text.
  for (const match of text.replace(/\\[nrt"\\]/g, " ").matchAll(TOKEN)) {
    const value = trimToken(match[0]);
    if (!value || SCHEME.test(value)) continue;
    if (!value.includes("/") && !isBareFileName(value)) continue;
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

type MessageRecord = Omit<MemoryMessage, "text"> & {
  file: string;
  offset: number;
};
type NodeRecord = { file: string; offset: number; size: number };

/** The size of a message body, without reading it. */
function bodySize(record: MessageRecord): number {
  if (record.size > 0) return record.size;
  return record.src.images ? IMAGE_BODY_BYTES : 0;
}

/** A leaf node is the message word for word, tagged with its kind. */
function leafText(kind: MemoryKind, body: string): string {
  return `${kind}: ${body}`;
}

/** The size of a leaf node's text: the ASCII kind tag plus the body. */
function leafSize(record: MessageRecord): number {
  return record.kind.length + 2 + bodySize(record);
}

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
  /** The newest main day file; main files never go backwards. */
  private mainDay = "";
  /** True while a chat batch still owes merges it could not make yet. */
  private batching = false;
  /** Lines the load pass could not use, so log damage is never silent. */
  readonly loadWarnings: string[] = [];

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
    const file = join(
      this.root,
      "main",
      `${this.nextMainDay(message.date)}.jsonl`,
    );
    const offset = this.appendLine(file, JSON.stringify(record));
    this.records.push({
      i,
      kind: record.kind,
      size: record.size,
      date: record.date,
      src: record.src,
      hash: record.hash,
      file,
      offset,
    });
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
    const file = this.treeFile(this.nodeDate(line));
    const offset = this.appendLine(file, JSON.stringify(record));
    this.nodes.set(nodeKey(line), {
      file,
      offset,
      size: record.size,
    });
    this.chatSize = this.bytes(this.chat);
    if (this.chatSize > CHAT_BYTES) this.batching = true;
    if (this.batching) this.mergeChatBatch();
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
      if (!record || leafSize(record) > LEAF_BYTES) return undefined;
      return leafText(record.kind, this.messageBody(i));
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

  /** True when the node's text is available without a compaction call. */
  canBuildWithoutCall(line: ViewLine): boolean {
    return this.nodeSize(line) !== undefined;
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
        messageKind: record.kind,
        text: this.messageBody(i),
      };
    }
    const first = this.nodeText([l - 1, i * 2]);
    const second = this.nodeText([l - 1, i * 2 + 1]);
    if (first === undefined || second === undefined) return undefined;
    return { kind: "merge", line, first, second };
  }

  messageText(i: number): string | undefined {
    return this.records[i] ? this.messageBody(i) : undefined;
  }

  /** A message's body: its words, or the image placeholder it only had. */
  private messageBody(i: number): string {
    const record = this.records[i];
    if (!record) return "";
    const text = readLogText(record.file, record.offset);
    if (text) return text;
    return record.src.images ? IMAGE_BODY : "";
  }

  messageKind(i: number): MemoryKind | undefined {
    return this.records[i]?.kind;
  }

  messageDate(i: number): string | undefined {
    return this.records[i]?.date;
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

  renderCompaction(line?: ViewLine): string {
    const lines = line ? this.compactionLinesBefore(line) : this.compaction;
    return renderView(lines, (entry) => this.nodeText(entry));
  }

  /**
   * The compaction view cut at a node: the lines before a message, or the
   * lines up to a merge's last message. Only built lines are in it.
   */
  compactionLinesBefore(line: ViewLine): ViewLine[] {
    const limit =
      line[0] === 0 ? nodeStart(line) : nodeStart(line) + nodeLength(line);
    return this.compaction.filter(
      (entry) => nodeStart(entry) + nodeLength(entry) <= limit,
    );
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
    this.loadWarnings.length = 0;
    this.mainDay = "";
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
      // rebuild costs a prompt-cache miss, which phase 7 records. An empty
      // project has no view to lose.
      if (this.records.length > 0) this.viewRebuilt = true;
      this.chat = [];
      this.compaction = [];
      this.chatSize = 0;
    }
    // A crash between the log append and the view write leaves unviewed
    // messages; they append as leaves, exactly as they would have live.
    for (let i = this.chatEnd(); i < this.records.length; i += 1)
      this.pushLeaf(i);

    // A saved view above the batch target may be an unfinished batch, but a
    // rebuild at open would rewrite it; the next append carries it on.
    this.batching = this.chatSize > CHAT_BYTES;

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
    if (!isKind(record.kind) || typeof record.text !== "string") return;
    if (!Number.isInteger(record.size) || record.size < 0) return;
    if (typeof record.date !== "string" || typeof record.hash !== "string")
      return;
    if (!isSource(record.src)) return;
    // Ids are linear, so a line that breaks the sequence is not this log.
    if (record.i !== this.records.length) {
      this.warn(
        `${basename(file)}: message i=${record.i} is out of sequence at ${this.records.length}`,
      );
      return;
    }
    // Texts are read on demand, so only the index stays in memory.
    this.records.push({
      i: record.i,
      kind: record.kind,
      size: record.size,
      date: record.date,
      src: record.src,
      hash: record.hash,
      file,
      offset,
    });
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
      if (directory === "main") {
        const day = name.slice(0, 10);
        if (day > this.mainDay) this.mainDay = day;
      }
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      let offset = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        // A torn last line is ignored, unless it already holds complete JSON;
        // either way the next append starts on a new line.
        const torn = index === lines.length - 1 && line !== "";
        if (line !== "") {
          if (torn) this.torn.add(file);
          try {
            accept(JSON.parse(line), file, offset);
          } catch {
            if (!torn)
              this.warn(`${basename(file)}: unreadable line at ${offset}`);
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
    const built = (line: ViewLine) => this.canBuildWithoutCall(line);
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

  private treeFile(date: string): string {
    return join(this.root, "tree", `${dayKey(date)}.jsonl`);
  }

  /**
   * Main files never go backwards, so a backfilled older date still appends
   * after the newest file and message ids stay in file order.
   */
  private nextMainDay(date: string): string {
    const day = dayKey(date);
    if (day > this.mainDay) this.mainDay = day;
    return this.mainDay;
  }

  private warn(message: string): void {
    this.loadWarnings.push(message);
  }

  private nodeDate(line: ViewLine): string {
    const first = this.records[nodeStart(line)];
    return first ? first.date : new Date().toISOString();
  }

  private saveView(): void {
    // An empty project writes nothing but its project.json.
    if (this.records.length === 0) return;
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
      if (!record) return undefined;
      const size = leafSize(record);
      return size <= LEAF_BYTES ? size : undefined;
    }
    const first = this.nodeSize([l - 1, i * 2]);
    if (first === undefined) return undefined;
    const second = this.nodeSize([l - 1, i * 2 + 1]);
    if (second === undefined) return undefined;
    const joined = first + second + 1;
    return joined <= LEAF_BYTES ? joined : undefined;
  }

  /**
   * The rendered size of a line, without reading its text. A `\r\n` renders as
   * one space, so a line holding carriage returns measures a byte or two long.
   */
  private lineBytes(line: ViewLine): number {
    const size = this.nodeSize(line);
    const body = size === undefined ? UNBUILT_BYTES : size;
    return Buffer.byteLength(lineLabel(line), "utf8") + 1 + body;
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
    if (this.chatSize > CHAT_BYTES) this.batching = true;
    if (this.batching) this.mergeChatBatch();
  }

  /**
   * One batch merges the most due pairs until the view fits its target. A
   * batch that runs out of built parents stays open: each later message, and
   * each node the compactor builds, carries it on.
   */
  private mergeChatBatch(): void {
    while (this.chatSize > CHAT_TARGET_BYTES) {
      const index = mostDuePair(this.chat, this.records.length, (parent) =>
        this.canBuildWithoutCall(parent),
      );
      if (index === undefined) return;
      this.chatSize += this.applyMerge(this.chat, index);
    }
    this.batching = false;
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
      if (!this.canBuildWithoutCall(line)) break;
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
    // Merged down to the target only once it passes the bound, so compactions
    // keep reading each other's view from the prompt cache.
    if (this.compactionSize > COMPACTION_BYTES) {
      while (this.compactionSize > COMPACTION_TARGET_BYTES) {
        const index = mostDuePair(
          this.compaction,
          this.records.length,
          (parent) => this.canBuildWithoutCall(parent),
        );
        if (index === undefined) break;
        this.compactionSize += this.applyMerge(this.compaction, index);
      }
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
      if (this.canBuildWithoutCall(current)) {
        current = [current[0] + 1, Math.floor(current[1] / 2)];
        continue;
      }
      if (this.inputsReady(current))
        this.enqueue({ kind: "merge", line: current });
      return;
    }
  }

  /** True when a node's inputs exist, without reading them. */
  private inputsReady(line: ViewLine): boolean {
    const [l, i] = line;
    if (l === 0) return this.withinLog(line);
    return (
      this.canBuildWithoutCall([l - 1, i * 2]) &&
      this.canBuildWithoutCall([l - 1, i * 2 + 1])
    );
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
