import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ProcessLockOccupiedError } from "./lock.ts";
import {
  CHAT_BYTES,
  CHAT_TARGET_BYTES,
  COMPACTION_BYTES,
  COMPACTION_TARGET_BYTES,
  ECHO_CHARS,
  LEAF_BYTES,
  MemoryStore,
  PAGE_CHARS,
  UNBUILT_LINE,
  clipEcho,
  deriveMessages,
  entryHash,
  extractIdentifiers,
  lineLabel,
  mostDuePair,
  nodeAt,
  nodeStart,
  parseLineLabel,
  projectMemoryKey,
  projectMemoryRoot,
  renderBlocks,
  renderLine,
  renderView,
  type IdentifierKind,
  type MemoryIdentifier,
  type MemoryKind,
  type ViewLine,
} from "./memory.ts";

const SESSION = "/sessions/1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d.jsonl";
const DAY_ONE = "2026-01-02T03:04:05.000Z";

let entryCounter = 0;

function nextEntryId(): string {
  entryCounter += 1;
  return `entry-${entryCounter}`;
}

function entryBase(timestamp = DAY_ONE): {
  id: string;
  parentId: null;
  timestamp: string;
} {
  return { id: nextEntryId(), parentId: null, timestamp };
}

function userEntry(text: string, timestamp = DAY_ONE): SessionEntry {
  return {
    ...entryBase(timestamp),
    type: "message",
    message: { role: "user", content: text, timestamp: 0 },
  } as unknown as SessionEntry;
}

function assistantEntry(content: unknown[]): SessionEntry {
  return {
    ...entryBase(),
    type: "message",
    message: { role: "assistant", content },
  } as unknown as SessionEntry;
}

function toolResultEntry(content: unknown): SessionEntry {
  return {
    ...entryBase(),
    type: "message",
    message: { role: "toolResult", toolName: "read", content },
  } as unknown as SessionEntry;
}

function customMessageEntry(content: unknown, details?: unknown): SessionEntry {
  return {
    ...entryBase(),
    type: "custom_message",
    customType: "pi-herdsman-agent-result",
    content,
    details,
    display: true,
  } as unknown as SessionEntry;
}

function bashEntry(
  command: string,
  output: string,
  extra: Record<string, unknown> = {},
): SessionEntry {
  return {
    ...entryBase(),
    type: "message",
    message: {
      role: "bashExecution",
      command,
      output,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 0,
      ...extra,
    },
  } as unknown as SessionEntry;
}

function withProject<T>(run: (project: string) => T): T {
  const project = mkdtempSync(join(tmpdir(), "pi-herdsman-memory-"));
  try {
    return run(project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

// --- message derivation -----------------------------------------------------

test("each Pi entry kind derives its memory messages", () => {
  const cases: [string, SessionEntry, { kind: string; text: string }[]][] = [
    ["user text", userEntry("hello"), [{ kind: "user", text: "hello" }]],
    [
      "assistant text",
      assistantEntry([{ type: "text", text: "an answer" }]),
      [{ kind: "lead", text: "an answer" }],
    ],
    [
      "assistant tool call",
      assistantEntry([
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "a.ts" },
        },
      ]),
      [{ kind: "tool", text: 'read {"path":"a.ts"}' }],
    ],
    [
      "assistant text then tool call",
      assistantEntry([
        { type: "text", text: "looking" },
        {
          type: "toolCall",
          id: "call-2",
          name: "ls",
          arguments: { path: "." },
        },
      ]),
      [
        { kind: "lead", text: "looking" },
        { kind: "tool", text: 'ls {"path":"."}' },
      ],
    ],
    [
      "tool result",
      toolResultEntry("file body"),
      [{ kind: "echo", text: "file body" }],
    ],
    [
      "labelled custom message",
      customMessageEntry("done", { agentLabel: "scout" }),
      [{ kind: "work", text: "[scout] done" }],
    ],
    [
      "unlabelled custom message",
      customMessageEntry("done", {}),
      [{ kind: "work", text: "done" }],
    ],
  ];
  for (const [name, entry, expected] of cases) {
    const messages = deriveMessages(entry, SESSION);
    assert.deepEqual(
      messages.map(({ kind, text }) => ({ kind, text })),
      expected,
      name,
    );
    assert.deepEqual(
      messages.map((message) => message.src.part),
      expected.map((_, index) => index),
      name,
    );
    for (const message of messages) {
      assert.equal(message.size, Buffer.byteLength(message.text), name);
      assert.equal(message.date, entry.timestamp, name);
      assert.equal(message.src.session, SESSION, name);
      assert.equal(message.src.entry, entry.id, name);
      assert.equal(message.hash, entryHash(entry), name);
    }
  }
});

test("entries that are not chat are not memory messages", () => {
  const entries: [string, SessionEntry][] = [
    ["thinking", assistantEntry([{ type: "thinking", thinking: "hmm" }])],
    [
      "compaction",
      {
        ...entryBase(),
        type: "compaction",
        summary: "a summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 10,
      } as unknown as SessionEntry,
    ],
    [
      "branch summary",
      {
        ...entryBase(),
        type: "branch_summary",
        fromId: "entry-1",
        summary: "a summary",
      } as unknown as SessionEntry,
    ],
    [
      "custom entry",
      {
        ...entryBase(),
        type: "custom",
        customType: "pi-herdsman-agent-definition",
      } as unknown as SessionEntry,
    ],
    [
      "model change",
      {
        ...entryBase(),
        type: "model_change",
        provider: "p",
        modelId: "m",
      } as unknown as SessionEntry,
    ],
    [
      "thinking change",
      {
        ...entryBase(),
        type: "thinking_level_change",
        thinkingLevel: "high",
      } as unknown as SessionEntry,
    ],
    [
      "label",
      {
        ...entryBase(),
        type: "label",
        targetId: "entry-1",
        label: "bookmark",
      } as unknown as SessionEntry,
    ],
    [
      "bash execution without context",
      {
        ...entryBase(),
        type: "message",
        message: {
          role: "bashExecution",
          command: "ls",
          output: "files",
          exitCode: 0,
          excludeFromContext: true,
        },
      } as unknown as SessionEntry,
    ],
    ["empty user text", userEntry("")],
  ];
  for (const [name, entry] of entries)
    assert.deepEqual(deriveMessages(entry, SESSION), [], name);
});

test("a bash execution logs the command and then its output", () => {
  const [command, output] = deriveMessages(bashEntry("ls", "files"), SESSION);
  assert.deepEqual([command.kind, command.text], ["user", "Ran `ls`"]);
  assert.equal(output.kind, "echo");
  assert.equal(output.text.includes("files"), true);

  const [failed, notes] = deriveMessages(
    bashEntry("false", "", { exitCode: 1 }),
    SESSION,
  );
  assert.equal(failed.text, "Ran `false`");
  assert.equal(notes.text.includes("exited with code 1"), true);

  // `!!cmd` is excluded from context, so it is not memory either.
  assert.deepEqual(
    deriveMessages(
      bashEntry("ls", "files", { excludeFromContext: true }),
      SESSION,
    ),
    [],
  );

  const [longCommand, longOutput] = deriveMessages(
    bashEntry("cat big.log", "z".repeat(50_000)),
    SESSION,
  );
  assert.equal(longCommand.text, "Ran `cat big.log`");
  assert.equal(longOutput.kind, "echo");
  assert.equal(longOutput.size <= ECHO_CHARS, true);
  assert.equal(longOutput.text.includes("characters omitted"), true);
});

test("long texts are split into pages and tool output is clipped", () => {
  const text = "x".repeat(65_000);
  const paged = deriveMessages(userEntry(text), SESSION);
  assert.deepEqual(
    paged.map((message) => message.text.length),
    [30_000, 30_000, 5_000],
  );
  assert.deepEqual(
    paged.map((message) => message.src.part),
    [0, 1, 2],
  );
  assert.equal(
    paged.reduce((size, message) => size + message.size, 0),
    Buffer.byteLength(text),
  );

  const output = `${"head".repeat(10_000)}${"tail".repeat(10_000)}`;
  const [echo] = deriveMessages(toolResultEntry(output), SESSION);
  assert.equal(echo.kind, "echo");
  assert.equal(echo.size <= ECHO_CHARS, true);
  assert.equal(echo.text.startsWith("head"), true);
  assert.equal(echo.text.endsWith("tail"), true);
  assert.match(echo.text, /\[\.\.\. \d+ characters omitted \.\.\.\]/);
  assert.equal(clipEcho("short"), "short");
});

test("splitting and clipping never cut a surrogate pair", () => {
  const emoji = "😀";
  // The page boundary falls between the two halves of the pair.
  const paged = deriveMessages(
    userEntry(`${"x".repeat(PAGE_CHARS - 1)}${emoji}${"y".repeat(10)}`),
    SESSION,
  );
  assert.equal(paged.length, 2);
  assert.deepEqual(
    paged.map((page) => hasLoneSurrogate(page.text)),
    [false, false],
  );
  assert.equal(
    paged.map((page) => page.text).join(""),
    `${"x".repeat(PAGE_CHARS - 1)}${emoji}${"y".repeat(10)}`,
  );

  // The clip's head cut falls between the two halves of the pair.
  const head = "a".repeat(14_935);
  const clipped = clipEcho(`${head}${emoji}${"b".repeat(20_000)}`);
  assert.equal(hasLoneSurrogate(clipped), false);
  assert.equal(clipped.length <= ECHO_CHARS, true);
  assert.equal(clipped.startsWith(head), true);
});

function hasLoneSurrogate(text: string): boolean {
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(at + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      at += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

test("messages record the images they had", () => {
  const [withImage] = deriveMessages(
    userEntry([
      { type: "text", text: "look at this" },
      { type: "image", data: "base64", mimeType: "image/png" },
    ] as unknown as string),
    SESSION,
  );
  assert.equal(withImage.text, "look at this");
  assert.equal(withImage.src.images, true);

  const [imageOnly] = deriveMessages(
    userEntry([
      { type: "image", data: "base64", mimeType: "image/png" },
    ] as unknown as string),
    SESSION,
  );
  assert.equal(imageOnly.text, "");
  assert.equal(imageOnly.src.images, true);
});

test("an entry keeps one stable dedupe hash", () => {
  const entry = userEntry("same words");
  const first = deriveMessages(entry, SESSION);
  assert.deepEqual(
    deriveMessages(entry, SESSION).map((message) => message.hash),
    first.map((message) => message.hash),
  );
  // The hash covers the entry's timestamp, type and content, not its id.
  assert.equal(entryHash(entry), entryHash(userEntry("same words")));
  assert.notEqual(entryHash(entry), entryHash(userEntry("other words")));
});

// --- tree coordinates -------------------------------------------------------

test("nodes are named by their first message and size", () => {
  assert.deepEqual(nodeAt(40, 8), [3, 5]);
  assert.deepEqual(nodeAt(0, 1), [0, 0]);
  assert.deepEqual(parseLineLabel("40+8"), [3, 5]);
  assert.equal(lineLabel([3, 5]), "40+8");
  assert.equal(nodeStart([3, 5]), 40);
  assert.equal(nodeAt(3, 8), undefined);
  assert.equal(parseLineLabel("40+7"), undefined);
  assert.equal(parseLineLabel("40+8+1"), undefined);
  assert.equal(parseLineLabel("nonsense"), undefined);
});

// --- gist 3.1 equivalence ---------------------------------------------------

type PushState = {
  keep: number;
  life: number;
  state: number;
  older: PushState | null;
} | null;

/** Taelin's rollback push, verbatim in the gist (rollback_state_list.js). */
function push(newState: number, states: PushState): PushState {
  if (states === null) {
    return { keep: 0, life: 0, state: newState, older: null };
  }
  const { keep, life, state, older } = states;
  if (keep === 0) return { keep: 1, life, state, older };
  if (life > 0) {
    return {
      keep: 0,
      life: 0,
      state: newState,
      older: { keep: 0, life: life - 1, state, older },
    };
  }
  return { keep: 0, life, state: newState, older: push(state, older) };
}

/** The view his states make: each state runs up to the next newer one. */
function pushView(states: PushState, T: number): ViewLine[] {
  const indexes: number[] = [];
  for (let node = states; node; node = node.older) indexes.push(node.state);
  const lines: ViewLine[] = [];
  for (let at = indexes.length - 1; at >= 0; at -= 1) {
    const start = indexes[at];
    const end = at === 0 ? T : indexes[at - 1];
    const length = end - start;
    lines.push([Math.log2(length), start / length]);
  }
  return lines;
}

/** The same pick measured from a pair's first message: the wrong rule. */
function pairFromFirst(
  lines: readonly ViewLine[],
  T: number,
): number | undefined {
  let best: { index: number; first: number; l: number } | undefined;
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const [l, i] = lines[index];
    const next = lines[index + 1];
    if (next[0] !== l || next[1] !== i + 1 || i % 2 !== 0) continue;
    const first = nodeStart(lines[index]);
    if (best === undefined) {
      best = { index, first, l };
      continue;
    }
    if ((T - first) / 2 ** l > (T - best.first) / 2 ** best.l)
      best = { index, first, l };
  }
  return best?.index;
}

function merged(lines: ViewLine[], index: number): ViewLine[] {
  const [l, i] = lines[index];
  return [...lines.slice(0, index), [l + 1, i / 2], ...lines.slice(index + 2)];
}

test("the view merges as Taelin's push does at every step", () => {
  let states: PushState = null;
  let lines: ViewLine[] = [];
  for (let t = 0; t <= 20_000; t += 1) {
    const T = t + 1;
    states = push(t, states);
    const expected = pushView(states, T).map(lineLabel);
    lines = [...lines, [0, t]];
    while (lines.length > expected.length) {
      const index = mostDuePair(lines, T, () => true);
      assert.notEqual(index, undefined, `no mergeable pair at message ${t}`);
      lines = merged(lines, index!);
    }
    assert.deepEqual(lines.map(lineLabel), expected, `message ${t}`);
  }
});

test("measuring a pair's age from its first message diverges", () => {
  // The gist's own example: at T=10 this view merges 0-7 from the first
  // message, while measuring from the last message merges 8-9.
  const view: ViewLine[] = [
    [2, 0],
    [2, 1],
    [0, 8],
    [0, 9],
  ];
  assert.equal(pairFromFirst(view, 10), 0);
  assert.equal(
    mostDuePair(view, 10, () => true),
    2,
  );

  let states: PushState = null;
  let lines: ViewLine[] = [];
  let matches = 0;
  for (let t = 0; t <= 20_000; t += 1) {
    const T = t + 1;
    states = push(t, states);
    const expected = pushView(states, T).map(lineLabel);
    lines = [...lines, [0, t]];
    while (lines.length > expected.length) {
      const index = pairFromFirst(lines, T);
      if (index === undefined) break;
      lines = merged(lines, index);
    }
    if (lines.map(lineLabel).join() === expected.join()) matches += 1;
  }
  assert.ok(matches < 1_000, `the wrong rule matched push ${matches} times`);
});

// --- view math --------------------------------------------------------------

test("the view is a sawtooth over its byte bounds", () => {
  const text = (line: ViewLine) =>
    `${lineLabel(line)} ${"x".repeat(LEAF_BYTES / 2)}`;
  const bytes = (lines: readonly ViewLine[]) =>
    lines.reduce(
      (size, line) => size + Buffer.byteLength(renderLine(line, text(line))),
      0,
    );
  let lines: ViewLine[] = [];
  let batches = 0;
  for (let i = 0; i < 2_000; i += 1) {
    const before = lines;
    lines = [...lines, [0, i]];
    const size = bytes(lines);
    if (size <= CHAT_BYTES) {
      // Between batches, lines are only appended.
      assert.deepEqual(lines.slice(0, before.length), before, `message ${i}`);
      continue;
    }
    batches += 1;
    while (bytes(lines) > CHAT_TARGET_BYTES) {
      const index = mostDuePair(lines, i + 1, () => true);
      assert.notEqual(index, undefined, `no mergeable pair at message ${i}`);
      lines = merged(lines, index!);
    }
    assert.equal(bytes(lines) <= CHAT_TARGET_BYTES, true, `message ${i}`);
  }
  assert.equal(batches > 1, true, "the sweep must reach more than one batch");
});

test("the compaction view follows the chat and cuts at built lines", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      store.appendEntry(userEntry("a".repeat(LEAF_BYTES + 1)), SESSION);
      // Nothing is built yet, so the compaction view holds nothing.
      assert.deepEqual(store.view.chat, [[0, 0]]);
      assert.deepEqual(store.view.compaction, []);
      assert.equal(store.renderCompaction(), "<chat>\n</chat>");

      store.appendNode([0, 0], "built line");
      assert.deepEqual(store.view.compaction, [[0, 0]]);
      assert.equal(store.renderCompaction(), "<chat>\n0+1|built line\n</chat>");

      store.appendEntry(userEntry("b".repeat(LEAF_BYTES + 1)), SESSION);
      store.appendNode([0, 1], "another line");
      // Only built lines are in it.
      assert.deepEqual(store.view.compaction, [
        [0, 0],
        [0, 1],
      ]);
    } finally {
      store.close();
    }
  });
});

test("the compaction view merges down once it passes its own bound", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      // 400-byte lines are call-free, their join is not.
      const body = "c".repeat(400);
      for (let i = 0; i < 90; i += 1)
        store.appendEntry(userEntry(body), SESSION);
      const size = (lines: readonly ViewLine[]) =>
        lines.reduce(
          (total, line) =>
            total + Buffer.byteLength(renderLine(line, store.nodeText(line))),
          0,
        );
      assert.equal(store.view.compaction.length, 90);
      const before = size(store.view.compaction);
      assert.equal(before > COMPACTION_BYTES, true);
      // The merge is queued, but until its parent is built the compaction view
      // keeps every line.
      assert.deepEqual(store.nextJob(), { kind: "merge", line: [1, 0] });

      store.appendNode([1, 0], "two lines merged");
      assert.deepEqual(store.view.compaction[0], [1, 0]);
      assert.equal(size(store.view.compaction) < before, true);
    } finally {
      store.close();
    }
  });
});

test("the view renders lines, blocks and lookups", () => {
  const text = (line: ViewLine) =>
    line[0] === 0 ? `summary ${line[1]}\nsecond row` : undefined;
  assert.equal(renderLine([0, 3], "a\nb"), "3+1|a b");
  assert.equal(renderLine([0, 3], undefined), `3+1|${UNBUILT_LINE}`);
  assert.equal(renderLine([3, 5], "x"), "40+8|x");
  assert.equal(
    renderView(
      [
        [0, 0],
        [1, 0],
      ],
      text,
    ),
    `<chat>\n0+1|summary 0 second row\n0+2|${UNBUILT_LINE}\n</chat>`,
  );
  const lines: ViewLine[] = [
    [0, 0],
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
  ];
  const blocks = renderBlocks(lines, text);
  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks.map((block) => block.split("\n").length),
    [4, 1],
  );
});

test("the latest view line holds the newest mention", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      store.appendEntry(userEntry("we chose sqlite for storage"), SESSION);
      store.appendEntry(userEntry("sqlite is gone, use postgres"), SESSION);
      store.appendEntry(userEntry("unrelated"), SESSION);
      assert.deepEqual(store.latestLineContaining("sqlite"), [0, 1]);
      assert.deepEqual(store.latestLineContaining("unrelated"), [0, 2]);
      assert.equal(store.latestLineContaining("mysql"), undefined);
    } finally {
      store.close();
    }
  });
});

// --- identifiers ------------------------------------------------------------

function identifierValues(text: string, kind: IdentifierKind): string[] {
  return extractIdentifiers(text)
    .filter((identifier) => identifier.kind === kind)
    .map((identifier) => identifier.value);
}

test("identifiers are typed, ordered and deduped", () => {
  const samples: [IdentifierKind, string, string[]][] = [
    [
      "uuid",
      "session 550E8400-E29B-41D4-A716-446655440000 done",
      ["550e8400-e29b-41d4-a716-446655440000"],
    ],
    ["uuid", "550e8400-e29b-41d4-a716-44665544000 short", []],
    [
      "ref",
      "see result:scout#12 and result:researcher",
      ["result:scout#12", "result:researcher"],
    ],
    ["ref", "result: and result:", []],
    ["path", "open src/app.ts now", ["src/app.ts"]],
    ["path", "read ./extension/memory.ts, please", ["./extension/memory.ts"]],
    [
      "path",
      "list extension/ and package.json",
      ["extension/", "package.json"],
    ],
    ["path", "see /tmp/file.ts).", ["/tmp/file.ts"]],
    ["path", "a bare word like documentation is not one", []],
    ["path", "README", []],
    [
      "url",
      "https://example.com/docs?a=1 is live",
      ["https://example.com/docs?a=1"],
    ],
    ["url", "no scheme in this text", []],
    ["number", "commit 1234 and 3.14", ["1234", "3.14"]],
    ["number", "only 123 here", []],
    ["code", "run `git status --short` first", ["git status --short"]],
    ["code", "no code here", []],
  ];
  for (const [kind, text, expected] of samples)
    assert.deepEqual(
      identifierValues(text, kind),
      expected,
      `${kind}: ${text}`,
    );

  assert.deepEqual(extractIdentifiers("a/b.ts a/b.ts 12345 12345"), [
    { kind: "path", value: "a/b.ts" },
    { kind: "number", value: "12345" },
  ]);
  assert.deepEqual(extractIdentifiers("12345 then /tmp/a.ts"), [
    { kind: "number", value: "12345" },
    { kind: "path", value: "/tmp/a.ts" },
  ]);
  // A URL is a URL, never also a path.
  assert.deepEqual(identifierValues("https://example.com/a.ts", "path"), []);
});

test("identifiers survive JSON, markdown, shell and prose", () => {
  const samples: [string, MemoryIdentifier[]][] = [
    [
      'fetch {"url":"https://a.com/x","timeout":5000}',
      [
        { kind: "url", value: "https://a.com/x" },
        { kind: "number", value: "5000" },
      ],
    ],
    [
      "run `/tmp/x.json` now",
      [
        { kind: "code", value: "/tmp/x.json" },
        { kind: "path", value: "/tmp/x.json" },
      ],
    ],
    [
      "see --file=/tmp/x.json and >/tmp/out.txt",
      [
        { kind: "path", value: "/tmp/x.json" },
        { kind: "path", value: "/tmp/out.txt" },
      ],
    ],
    [
      "read [docs](https://x.com/a) first",
      [{ kind: "url", value: "https://x.com/a" }],
    ],
    ['{"path":"src/app.ts"}', [{ kind: "path", value: "src/app.ts" }]],
    // Prose and versions are not paths, and never half a number.
    ["e.g. this, i.e. that, Node.js and 1.2.3", []],
    // A capitalized name without a directory is treated as prose too.
    ["AGENTS.md", []],
  ];
  for (const [text, expected] of samples)
    assert.deepEqual(extractIdentifiers(text), expected, text);
});

test("a bare file name needs a lowercase extension with a letter", () => {
  const samples: [string, string[]][] = [
    ["memory.ts exists", ["memory.ts"]],
    ["x.ts and a.json", ["x.ts", "a.json"]],
    [".env is a file", [".env"]],
    ["read a_doc-1.md, please", ["a_doc-1.md"]],
    ["Node.js", []],
    ["AGENTS.md", []],
    ["e.g", []],
    ["1.2", []],
    ["v1.2.3", []],
    ["file.TS", []],
    // A directory always makes a path.
    ["see docs/AGENTS.md", ["docs/AGENTS.md"]],
  ];
  for (const [text, expected] of samples)
    assert.deepEqual(identifierValues(text, "path"), expected, text);
});

test("identifiers used by tool calls and tool results are all extracted", () => {
  const call = assistantEntry([
    {
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: {
        path: "/home/gabar/projects/pi-herdsman/extension/memory.ts",
      },
    },
  ]);
  const [toolCall] = deriveMessages(call, SESSION);
  assert.deepEqual(extractIdentifiers(toolCall.text), [
    {
      kind: "path",
      value: "/home/gabar/projects/pi-herdsman/extension/memory.ts",
    },
  ]);

  // A `read`/`ls` result: a file name, a session UUID, a result ref and paths.
  const output = [
    "memory.ts exists",
    "result:scout#3",
    "session 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    "extension/ package.json",
  ].join("\n");
  const [echo] = deriveMessages(toolResultEntry(output), SESSION);
  const expected: MemoryIdentifier[] = [
    { kind: "path", value: "memory.ts" },
    { kind: "ref", value: "result:scout#3" },
    { kind: "uuid", value: "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d" },
    { kind: "path", value: "extension/" },
    { kind: "path", value: "package.json" },
  ];
  assert.deepEqual(extractIdentifiers(echo.text), expected);
});

// --- store ------------------------------------------------------------------

test("the store round-trips its log, tree and view", () => {
  withProject((project) => {
    const long = "a".repeat(LEAF_BYTES + 1);
    const store = new MemoryStore(project);
    try {
      store.appendEntry(userEntry("hello"), SESSION);
      store.appendEntry(
        assistantEntry([
          { type: "text", text: "answered" },
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "x" },
          },
        ]),
        SESSION,
      );
      store.appendEntry(userEntry(long), SESSION);
      assert.equal(store.needsCall([0, 3]), true);
      store.appendNode([0, 3], "a compact line");
    } finally {
      store.close();
    }

    const expectedView = store.view;
    const expectedChat = store.renderChat();
    assert.equal(store.messageCount, 4);
    assert.equal(expectedChat.includes("a compact line"), true);
    assert.equal(
      readFileSync(join(store.root, "view.json"), "utf8").length > 0,
      true,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(store.root, "project.json"), "utf8")),
      {
        version: 1,
        key: projectMemoryKey(store.projectPath),
        path: store.projectPath,
      },
    );
    assert.deepEqual(readdirSync(join(store.root, "tree")), [
      "2026-01-02.jsonl",
    ]);

    const reopened = new MemoryStore(project);
    try {
      assert.equal(reopened.viewRebuilt, false);
      assert.equal(reopened.messageCount, 4);
      assert.deepEqual(reopened.view, expectedView);
      assert.equal(reopened.renderChat(), expectedChat);
      assert.deepEqual(reopened.view.chat, [
        [0, 0],
        [0, 1],
        [0, 2],
        [0, 3],
      ]);
    } finally {
      reopened.close();
    }
  });
});

test("a torn last line is ignored and the next append starts a new line", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      store.appendEntry(userEntry("first"), SESSION);
    } finally {
      store.close();
    }
    const file = join(projectMemoryRoot(project), "main", "2026-01-02.jsonl");
    appendFileSync(file, '{"i":1,"kind":"user"');

    const reopened = new MemoryStore(project);
    try {
      assert.equal(reopened.messageCount, 1);
      assert.equal(reopened.viewRebuilt, false);
      reopened.appendEntry(userEntry("second"), SESSION);
      assert.equal(reopened.messageCount, 2);
      assert.equal(reopened.messageText(0), "first");
      assert.equal(reopened.messageText(1), "second");
    } finally {
      reopened.close();
    }
    assert.deepEqual(
      readFileSync(file, "utf8")
        .split("\n")
        .slice(0, 4)
        .map((line) => {
          try {
            return JSON.parse(line).text;
          } catch {
            return line;
          }
        }),
      ["first", '{"i":1,"kind":"user"', "second", ""],
    );

    const reloaded = new MemoryStore(project);
    try {
      assert.equal(reloaded.messageCount, 2);
      assert.equal(reloaded.messageText(1), "second");
    } finally {
      reloaded.close();
    }
  });
});

test("a missing or unusable view is rebuilt", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      store.appendEntry(userEntry("a".repeat(LEAF_BYTES + 1)), SESSION);
      store.appendEntry(userEntry("b".repeat(LEAF_BYTES + 1)), SESSION);
    } finally {
      store.close();
    }
    const viewPath = join(projectMemoryRoot(project), "view.json");
    writeFileSync(viewPath, "not json at all");
    const corrupt = new MemoryStore(project);
    try {
      assert.equal(corrupt.viewRebuilt, true);
      assert.deepEqual(corrupt.view.chat, [
        [0, 0],
        [0, 1],
      ]);
      assert.equal(corrupt.messageCount, 2);
    } finally {
      corrupt.close();
    }

    // A view that shows a merge the tree never built is rebuilt too.
    writeFileSync(
      viewPath,
      JSON.stringify({ version: 1, T: 2, chat: [[1, 0]], compaction: [] }),
    );
    const stale = new MemoryStore(project);
    try {
      assert.equal(stale.viewRebuilt, true);
      assert.deepEqual(stale.view.chat, [
        [0, 0],
        [0, 1],
      ]);
      assert.equal(stale.renderChat().includes(UNBUILT_LINE), true);
    } finally {
      stale.close();
    }

    // A view that reaches past the newest message is rebuilt as well.
    writeFileSync(
      viewPath,
      JSON.stringify({
        version: 1,
        T: 3,
        chat: [
          [0, 0],
          [0, 1],
          [0, 2],
        ],
        compaction: [],
      }),
    );
    const short = new MemoryStore(project);
    try {
      assert.equal(short.viewRebuilt, true);
      assert.deepEqual(short.view.chat, [
        [0, 0],
        [0, 1],
      ]);
    } finally {
      short.close();
    }

    const rebuilt = new MemoryStore(project);
    try {
      assert.equal(rebuilt.viewRebuilt, false);
    } finally {
      rebuilt.close();
    }
  });
});

test("one project has one owner", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      assert.throws(() => new MemoryStore(project), ProcessLockOccupiedError);
    } finally {
      store.close();
    }
    const reopened = new MemoryStore(project);
    reopened.close();
  });
});

test("messages roll over into one file per day", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      store.appendEntry(userEntry("day one"), SESSION);
      store.appendEntry(
        userEntry("day two", "2026-01-03T03:04:05.000Z"),
        SESSION,
      );
      store.appendNode([0, 1], "a line for day two");
    } finally {
      store.close();
    }
    assert.deepEqual(readdirSync(join(projectMemoryRoot(project), "main")), [
      "2026-01-02.jsonl",
      "2026-01-03.jsonl",
    ]);
    assert.deepEqual(readdirSync(join(projectMemoryRoot(project), "tree")), [
      "2026-01-03.jsonl",
    ]);

    const reopened = new MemoryStore(project);
    try {
      assert.equal(reopened.viewRebuilt, false);
      assert.deepEqual(
        [reopened.messageText(0), reopened.messageText(1)],
        ["day one", "day two"],
      );
      assert.deepEqual(reopened.view.chat, [
        [0, 0],
        [0, 1],
      ]);
      assert.equal(reopened.renderChat().includes("a line for day two"), true);
    } finally {
      reopened.close();
    }
  });
});

test("the store queues the work its messages unblock", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      store.appendEntry(userEntry("small"), SESSION);
      assert.equal(store.needsCall([0, 0]), false);
      assert.equal(store.nextJob(), undefined);
      assert.equal(store.renderChat().includes("0+1|user: small"), true);

      store.appendEntry(userEntry("a".repeat(LEAF_BYTES + 1)), SESSION);
      assert.equal(store.needsCall([0, 1]), true);
      assert.equal(store.renderChat().includes(UNBUILT_LINE), true);
      assert.deepEqual(store.nextJob(), { kind: "message", id: 1 });
      assert.deepEqual(store.nodeInputs([0, 1]), {
        kind: "message",
        id: 1,
        messageKind: "user",
        text: "a".repeat(LEAF_BYTES + 1),
      });
      // A failed call is tried again.
      store.requeueJob({ kind: "message", id: 1 });
      assert.deepEqual(store.nextJob(), { kind: "message", id: 1 });

      store.appendNode([0, 1], "one compact line");
      assert.equal(store.nextJob(), undefined);
      assert.equal(store.renderChat().includes("one compact line"), true);

      // Two call-free leaves whose join is too long queue their merge.
      const wide = "b".repeat(LEAF_BYTES - 100);
      store.appendEntry(userEntry(wide), SESSION);
      const last = userEntry(wide);
      store.appendEntry(last, SESSION);
      assert.equal(store.needsCall([1, 1]), true);
      assert.equal(store.canBuildWithoutCall([0, 2]), true);
      assert.deepEqual(store.nextJob(), { kind: "merge", line: [1, 1] });
      store.appendNode([1, 1], "their merged line");
      assert.deepEqual(store.messageSource(3), {
        session: SESSION,
        entry: last.id,
        part: 0,
      });
    } finally {
      store.close();
    }
  });
});

/** Answers every ready compaction like the compactor, so the tree fills. */
function drain(store: MemoryStore): number {
  let built = 0;
  for (;;) {
    const job = store.nextJob();
    if (!job) return built;
    const line: ViewLine = job.kind === "message" ? [0, job.id] : job.line;
    store.appendNode(line, `summary ${built} ${"z".repeat(600)}`);
    built += 1;
  }
}

/** The rendered byte size of a view, as the model receives it. */
function viewBytes(store: MemoryStore, lines: readonly ViewLine[]): number {
  return lines.reduce(
    (total, line) =>
      total + Buffer.byteLength(renderLine(line, store.nodeText(line)), "utf8"),
    0,
  );
}

function chatBytes(store: MemoryStore): number {
  return viewBytes(store, store.view.chat);
}

function compactionBytes(store: MemoryStore): number {
  return viewBytes(store, store.view.compaction);
}

test("a leaf line carries the kind and the message word for word", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      const entries: [SessionEntry, MemoryKind][] = [
        [userEntry("hello"), "user"],
        [assistantEntry([{ type: "text", text: "an answer" }]), "lead"],
        [
          assistantEntry([
            {
              type: "toolCall",
              id: "call-1",
              name: "read",
              arguments: { path: "x" },
            },
          ]),
          "tool",
        ],
        [toolResultEntry("a result"), "echo"],
        [customMessageEntry("done", { agentLabel: "scout" }), "work"],
        [
          userEntry([
            { type: "image", data: "x", mimeType: "image/png" },
          ] as unknown as string),
          "user",
        ],
      ];
      for (const [entry, kind] of entries) {
        for (const message of store.appendEntry(entry, SESSION)) {
          assert.equal(store.messageKind(message.i), kind);
          const body = message.text || "(image)";
          assert.equal(
            store.renderChat().includes(`${message.i}+1|${kind}: ${body}`),
            true,
            `${kind} at ${message.i}`,
          );
        }
      }

      // The 512-byte rule measures the tagged line, not the bare text.
      const tagged = store.appendEntry(
        userEntry("t".repeat(LEAF_BYTES - 4)),
        SESSION,
      );
      assert.equal(store.needsCall([0, tagged[0].i]), true);
      const bare = store.appendEntry(
        userEntry("t".repeat(LEAF_BYTES - 8)),
        SESSION,
      );
      assert.equal(store.needsCall([0, bare[0].i]), false);
    } finally {
      store.close();
    }
  });
});

test("an empty project writes nothing but its project.json", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      assert.equal(store.messageCount, 0);
      assert.equal(store.renderChat(), "<chat>\n</chat>");
      assert.equal(store.viewRebuilt, false);
    } finally {
      store.close();
    }
    const root = projectMemoryRoot(project);
    assert.equal(statSync(join(root, "project.json")).isFile(), true);
    assert.equal(
      statSync(join(root, "view.json"), { throwIfNoEntry: false }),
      undefined,
    );

    const reopened = new MemoryStore(project);
    try {
      assert.equal(reopened.messageCount, 0);
    } finally {
      reopened.close();
    }
    assert.equal(
      statSync(join(root, "view.json"), { throwIfNoEntry: false }),
      undefined,
    );
  });
});

test("a backfilled older date still appends in id order", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      store.appendEntry(
        userEntry("later one", "2026-01-03T03:04:05.000Z"),
        SESSION,
      );
      store.appendEntry(
        userEntry("backfilled", "2025-12-01T03:04:05.000Z"),
        SESSION,
      );
      store.appendEntry(
        userEntry("later two", "2026-01-03T04:00:00.000Z"),
        SESSION,
      );
    } finally {
      store.close();
    }
    // Main files never go backwards, so the log stays in id order.
    assert.deepEqual(readdirSync(join(projectMemoryRoot(project), "main")), [
      "2026-01-03.jsonl",
    ]);

    const reopened = new MemoryStore(project);
    try {
      assert.deepEqual(reopened.loadWarnings, []);
      assert.equal(reopened.viewRebuilt, false);
      assert.equal(reopened.messageCount, 3);
      assert.deepEqual(
        [0, 1, 2].map((i) => reopened.messageText(i)),
        ["later one", "backfilled", "later two"],
      );
      assert.deepEqual(reopened.view.chat, [
        [0, 0],
        [0, 1],
        [0, 2],
      ]);
    } finally {
      reopened.close();
    }
  });
});

test("damaged log lines are reported instead of dropped silently", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      store.appendEntry(userEntry("first"), SESSION);
      store.appendEntry(userEntry("second"), SESSION);
    } finally {
      store.close();
    }
    const file = join(projectMemoryRoot(project), "main", "2026-01-02.jsonl");
    const first = JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
    appendFileSync(file, "nonsense\n");
    appendFileSync(file, `${JSON.stringify({ ...first, i: 5 })}\n`);

    const reopened = new MemoryStore(project);
    try {
      assert.equal(reopened.messageCount, 2);
      const warnings = reopened.loadWarnings.join("\n");
      assert.match(warnings, /unreadable line/);
      assert.match(warnings, /out of sequence/);
      assert.equal(reopened.viewRebuilt, false);
    } finally {
      reopened.close();
    }
  });
});

test("a torn last line that is complete JSON is kept", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      store.appendEntry(userEntry("first"), SESSION);
      store.appendEntry(userEntry("second"), SESSION);
    } finally {
      store.close();
    }
    const file = join(projectMemoryRoot(project), "main", "2026-01-02.jsonl");
    const content = readFileSync(file, "utf8");
    writeFileSync(file, content.slice(0, -1));

    const reopened = new MemoryStore(project);
    try {
      assert.equal(reopened.messageCount, 2);
      assert.deepEqual(reopened.loadWarnings, []);
      reopened.appendEntry(userEntry("third"), SESSION);
      assert.equal(reopened.messageCount, 3);
      assert.equal(reopened.messageText(2), "third");
    } finally {
      reopened.close();
    }

    const reloaded = new MemoryStore(project);
    try {
      assert.deepEqual(
        [0, 1, 2].map((i) => reloaded.messageText(i)),
        ["first", "second", "third"],
      );
    } finally {
      reloaded.close();
    }
  });
});

test("messages the saved view does not cover are appended at load", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      for (const text of ["one", "two", "three"])
        store.appendEntry(userEntry(text), SESSION);
    } finally {
      store.close();
    }
    // A crash between the log append and the view write leaves T behind.
    writeFileSync(
      join(projectMemoryRoot(project), "view.json"),
      JSON.stringify({ version: 1, T: 1, chat: [[0, 0]], compaction: [] }),
    );

    const reopened = new MemoryStore(project);
    try {
      assert.equal(reopened.viewRebuilt, false);
      assert.deepEqual(reopened.loadWarnings, []);
      assert.equal(reopened.messageCount, 3);
      assert.deepEqual(reopened.view.chat, [
        [0, 0],
        [0, 1],
        [0, 2],
      ]);
      assert.equal(
        JSON.parse(readFileSync(join(reopened.root, "view.json"), "utf8")).T,
        3,
      );
    } finally {
      reopened.close();
    }
  });
});

test("the compaction view can be cut at a node", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      for (const text of ["first", "second", "third"])
        store.appendEntry(userEntry(text), SESSION);
      assert.equal(
        store.renderCompaction(),
        "<chat>\n0+1|user: first\n1+1|user: second\n2+1|user: third\n</chat>",
      );
      // Before a message: the lines that end at or before it.
      assert.deepEqual(store.compactionLinesBefore([0, 2]), [
        [0, 0],
        [0, 1],
      ]);
      assert.equal(store.renderCompaction([0, 2]).includes("third"), false);
      assert.deepEqual(store.compactionLinesBefore([0, 0]), []);
      // Before a merge: the lines up to the merge's last message.
      assert.deepEqual(store.compactionLinesBefore([1, 0]), [
        [0, 0],
        [0, 1],
      ]);
    } finally {
      store.close();
    }
  });
});

test("the store keeps both views inside their batch bounds", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    const body = "m".repeat(3000);
    try {
      let chatGrew = false;
      let chatFell = false;
      let compactionGrew = false;
      let compactionFell = false;
      for (let i = 0; i < 90; i += 1) {
        store.appendEntry(userEntry(body), SESSION);
        // Drain like the compactor, watching the compaction view for each
        // node it builds, where its own merges land.
        for (;;) {
          const job = store.nextJob();
          if (!job) break;
          store.appendNode(
            job.kind === "message" ? [0, job.id] : job.line,
            `summary ${"z".repeat(3000)}`,
          );
          const compaction = compactionBytes(store);
          assert.equal(
            compaction <= COMPACTION_BYTES + 3100,
            true,
            `compaction at ${i}`,
          );
          if (compaction > COMPACTION_TARGET_BYTES) compactionGrew = true;
          else if (compactionGrew) compactionFell = true;
        }

        const chat = chatBytes(store);
        assert.equal(chat <= CHAT_BYTES, true, `chat size at ${i}`);
        if (chat > CHAT_TARGET_BYTES) chatGrew = true;
        else if (chatGrew) chatFell = true;
      }
      // Each view grew past its target and later fell back to it.
      assert.equal(chatGrew && chatFell, true);
      assert.equal(compactionGrew && compactionFell, true);
    } finally {
      store.close();
    }
  });
});

test("a batch that cannot finish keeps going as parents appear", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      // 400-byte messages are call-free leaves; their pairs are not.
      const body = "s".repeat(400);
      for (let i = 0; i < 340; i += 1)
        store.appendEntry(userEntry(body), SESSION);
      const stuck = chatBytes(store);
      assert.equal(stuck > CHAT_BYTES, true);

      // The open batch merges as soon as one parent exists, without waiting
      // for the size to pass the trigger again.
      store.appendNode([1, 0], "first pair");
      const once = chatBytes(store);
      assert.equal(once < stuck, true);
      store.appendNode([1, 1], "second pair");
      assert.equal(chatBytes(store) < once, true);
    } finally {
      store.close();
    }
  });
});

test("the compaction view merges down to its own target", () => {
  withProject((project) => {
    const store = new MemoryStore(project);
    try {
      const body = "c".repeat(400);
      let merges = 0;
      let last = 0;
      let max = 0;
      for (let i = 0; i < 300; i += 1) {
        store.appendEntry(userEntry(body), SESSION);
        drain(store);
        const size = compactionBytes(store);
        max = Math.max(max, size);
        if (size < last) merges += 1;
        last = size;
      }
      assert.equal(merges > 0, true);
      assert.equal(max <= COMPACTION_BYTES + 700, true);
    } finally {
      store.close();
    }
  });
});
