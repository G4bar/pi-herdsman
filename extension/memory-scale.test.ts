/**
 * The phase 15 scale test: no model, no network, one real `MemoryStore` fed
 * thousands of messages of about 2 KB each, with a deterministic fake compactor
 * that answers every queued job with an exact 512-byte line. It checks the
 * three claims a never-ending project memory rests on: the view stays bounded
 * however long the project runs, the view survives a close and a fresh load
 * without a rebuild, and any message is still readable verbatim by its id from
 * the day files through the offset index, without reading the log whole.
 *
 * The store fsyncs twice per append and once per built node, so the temp root
 * is the fastest the platform has and the run size follows it: the phase's
 * 2,049 messages where fsync costs nothing (Linux's `/dev/shm` tmpfs, about
 * four seconds), and 512 where every write reaches a disk, about ten
 * milliseconds per 2 KB message and the ten-second file budget `npm test`
 * allows. The size used and the wall time are printed, not asserted.
 *
 * The phase's primary size, 4,097, needs about six seconds of tmpfs fsync
 * alone, which leaves no room in that budget for the rest of the file. The
 * per-append writes are the design under test, so the check cannot skip them.
 */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

const realFs = await import("node:fs");

const FAST_ROOT = statSync("/dev/shm", { throwIfNoEntry: false })?.isDirectory()
  ? "/dev/shm"
  : tmpdir();
const MESSAGES = FAST_ROOT === "/dev/shm" ? 2_049 : 512;
const AGENT_DIR = mkdtempSync(join(FAST_ROOT, "pi-herdsman-scale-agent-"));
const PROJECT = mkdtempSync(join(tmpdir(), "pi-herdsman-scale-project-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
after(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true });
  rmSync(PROJECT, { recursive: true, force: true });
});

const MAIN_LOG = /[\\/]main[\\/].+\.jsonl$/;
/** Every main-log read while `counting` is on: where it sought and how much. */
const reads: { path: string; position: number; bytes: number }[] = [];
const openPaths = new Map<number, string>();
let counting = false;
let fullReads = 0;
mock.module("node:fs", {
  namedExports: {
    ...realFs,
    openSync: (path: any, ...rest: any[]) => {
      const descriptor = realFs.openSync(path, ...rest);
      if (counting) openPaths.set(descriptor, String(path));
      return descriptor;
    },
    readSync: (...args: any[]) => {
      const read = realFs.readSync(...args);
      const path = openPaths.get(args[0]);
      if (counting && path && MAIN_LOG.test(path))
        reads.push({ path, position: args[4], bytes: read });
      return read;
    },
    readFileSync: (...args: any[]) => {
      if (counting && typeof args[0] === "string" && MAIN_LOG.test(args[0]))
        fullReads += 1;
      return realFs.readFileSync(...args);
    },
  },
});

const {
  CHAT_BYTES,
  CHAT_TARGET_BYTES,
  LEAF_BYTES,
  MemoryStore,
  UNBUILT_LINE,
  lineLabel,
  projectMemoryRoot,
} = await import("./memory.ts");
type ViewLine = import("./memory.ts").ViewLine;
const { LOSSY_MARKER } = await import("./memory-prompts.ts");

const MESSAGE_BYTES = 2_000;
const DAY = "2026-01-02T03:04:05.000Z";
const UNBUILT_BYTES = Buffer.byteLength(UNBUILT_LINE, "utf8");
/** The widest a line renders: its label, its separator and a full node. */
const MAX_LINE =
  Buffer.byteLength(`${MESSAGES}+${MESSAGES}`, "utf8") + 1 + LEAF_BYTES;

function messageBody(i: number): string {
  return `message ${i} ${"m".repeat(MESSAGE_BYTES)}`;
}

/** The fake compactor's line: deterministic and exactly the 512-byte bound. */
function fakeNodeText(line: ViewLine): string {
  return `${line[0]}:${line[1]} ${"y".repeat(LEAF_BYTES)}`.slice(0, LEAF_BYTES);
}

/**
 * Answers every queued job the way the compactor does: read `nodeInputs`, then
 * `appendNode` with one line. It returns how many nodes it built.
 */
function drain(store: InstanceType<typeof MemoryStore>): number {
  let built = 0;
  for (;;) {
    const job = store.nextJob();
    if (!job) return built;
    const line: ViewLine = job.kind === "message" ? [0, job.id] : job.line;
    assert.ok(store.nodeInputs(line), `inputs for ${lineLabel(line)}`);
    const text = fakeNodeText(line);
    assert.equal(Buffer.byteLength(text, "utf8"), LEAF_BYTES);
    store.appendNode(line, text);
    built += 1;
  }
}

/** The view's lines, as comparable strings. */
function lines(store: InstanceType<typeof MemoryStore>): string[] {
  return store.view.chat.map((line) => line.join("+"));
}

function isPrefix(prefix: string[], value: string[]): boolean {
  return (
    prefix.length <= value.length &&
    prefix.every((line, index) => line === value[index])
  );
}

/**
 * The chat view's rendered bytes, counted incrementally the way the store
 * counts them: every line is a built node here, so this needs no log read.
 */
function ledger(store: InstanceType<typeof MemoryStore>): number {
  let total = 0;
  for (const line of store.view.chat)
    total += Buffer.byteLength(lineLabel(line), "utf8") + 1 + LEAF_BYTES;
  return total;
}

/** The same bytes read back through every node's text: the check of `ledger`. */
function measured(store: InstanceType<typeof MemoryStore>): number {
  let total = 0;
  for (const line of store.view.chat) {
    const text = store.nodeText(line);
    total +=
      Buffer.byteLength(lineLabel(line), "utf8") +
      1 +
      (text === undefined ? UNBUILT_BYTES : Buffer.byteLength(text, "utf8"));
  }
  return total;
}

test("a long project keeps its view bounded and its messages readable by id", () => {
  const startedAt = Date.now();
  const store = new MemoryStore(PROJECT);
  let built = 0;
  let merges = 0;
  let overBound = 0;
  let overTarget = 0;
  let maxChat = 0;
  let maxAfterMerge = 0;
  let batch = lines(store);
  let previous = 0;
  for (let i = 0; i < MESSAGES; i += 1) {
    const before = lines(store);
    const body = messageBody(i);
    store.appendMessage({
      kind: "user",
      text: body,
      size: Buffer.byteLength(body, "utf8"),
      date: DAY,
      src: {
        session: "/tmp/pi-herdsman-scale-session.jsonl",
        entry: `e${i}`,
        part: 0,
      },
      hash: `h${i}`,
    });
    // The store merges the chat while the drain builds the parents it needs, so
    // a batch boundary is only visible after both.
    built += drain(store);
    const after = lines(store);
    const merged = !isPrefix(before, after);
    const bytes = ledger(store);
    if (bytes > CHAT_BYTES) overBound += 1;
    if (bytes > maxChat) maxChat = bytes;
    if (merged) {
      merges += 1;
      // Between two boundaries the view only grew at its end, and a batch only
      // opens once the view is within one line of its merge target.
      assert.ok(
        isPrefix(batch, before),
        `the view changed below its bound at message ${i}`,
      );
      assert.ok(
        previous + MAX_LINE >= CHAT_TARGET_BYTES,
        `message ${i} merged at ${previous} bytes, under the target`,
      );
      // Every view line is built here, so the ledger is the real view.
      assert.equal(bytes, measured(store), `view bytes at message ${i}`);
      // The batch has parents by now, and closed near its own target.
      assert.ok(
        store.view.chat.some((line) => line[0] > 0),
        `no parent after the merge at message ${i}`,
      );
      if (bytes > CHAT_TARGET_BYTES + MAX_LINE) overTarget += 1;
      if (bytes > maxAfterMerge) maxAfterMerge = bytes;
      batch = after;
    }
    previous = bytes;
  }
  const buildMs = Date.now() - startedAt;
  assert.equal(store.messageCount, MESSAGES);
  // The hard bound holds after every batch, and the batch that closes lands
  // within one line of the target.
  assert.equal(overBound, 0, `the view passed ${CHAT_BYTES} bytes`);
  assert.equal(overTarget, 0, `a closed batch sat above its target`);
  assert.ok(merges > 0, "the view never merged");
  // A node per message and one per merge is the whole tree: no unbounded
  // growth follows from the run length.
  assert.ok(built <= 2 * MESSAGES, `${built} nodes for ${MESSAGES} messages`);
  assert.equal(store.loadWarnings.length, 0);
  const view = store.view;
  assert.deepEqual(view.compaction.length > 0, true);
  store.close();

  // A fresh load uses the saved view: no rebuild, and the same lines.
  const reopened = new MemoryStore(PROJECT);
  assert.equal(reopened.viewRebuilt, false);
  assert.deepEqual(reopened.loadWarnings, []);
  assert.equal(reopened.messageCount, MESSAGES);
  assert.deepEqual(reopened.view, view);

  // Every built node is a 512-byte line plus the lossy marker's room, and no
  // more; the fake compactor writes no marker, so the marker's room is slack.
  let treeNodes = 0;
  const tree = join(projectMemoryRoot(PROJECT), "tree");
  for (const name of readdirSync(tree).sort()) {
    for (const line of readFileSync(join(tree, name), "utf8").split("\n")) {
      if (line === "") continue;
      const node = JSON.parse(line) as { text: string; size: number };
      treeNodes += 1;
      assert.equal(node.size, Buffer.byteLength(node.text, "utf8"));
      assert.ok(
        node.size <= LEAF_BYTES + Buffer.byteLength(LOSSY_MARKER, "utf8"),
        `tree node of ${node.size} bytes`,
      );
    }
  }
  assert.equal(treeNodes, built);

  // Any message is still readable verbatim by its id, from its own offset in
  // its day file: one seek per id, never the whole log.
  const mainPath = join(
    projectMemoryRoot(PROJECT),
    "main",
    `${DAY.slice(0, 10)}.jsonl`,
  );
  const mainText = realFs.readFileSync(mainPath, "utf8");
  const offsets: number[] = [];
  let position = 0;
  for (const line of mainText.split("\n")) {
    if (line === "") break;
    offsets.push(position);
    position += Buffer.byteLength(line, "utf8") + 1;
  }
  const fileBytes = Buffer.byteLength(mainText, "utf8");
  assert.equal(offsets.length, MESSAGES);
  assert.equal(fileBytes, position);
  const sampled = [0, 1, MESSAGES - 1, Math.floor(MESSAGES / 2)];
  counting = true;
  let readBytes = 0;
  try {
    for (const id of sampled) {
      reads.length = 0;
      assert.equal(reopened.messageText(id), messageBody(id));
      assert.equal(reads.length, 1, `${reads.length} reads for id ${id}`);
      assert.equal(reads[0].path, mainPath);
      assert.equal(reads[0].position, offsets[id]);
      assert.ok(reads[0].bytes <= 65_536);
      readBytes += reads[0].bytes;
    }
    // Looking up a handful of messages never reads the log whole.
    assert.equal(fullReads, 0);
    assert.ok(readBytes < fileBytes, `${readBytes} bytes of ${fileBytes}`);
  } finally {
    counting = false;
  }
  reopened.close();
  console.log(
    `memory-scale: ${MESSAGES} messages, ${built} built nodes, ${merges} batches, view ${maxChat} of ${CHAT_BYTES} bytes (${maxAfterMerge} after a batch), built in ${buildMs} ms, lookups read ${readBytes} of ${fileBytes} bytes`,
  );
});
