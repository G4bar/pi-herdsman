/**
 * The model-facing text of project memory: the view description shared with the
 * Lead prompt, and the byte-exact compaction task templates from gist §4.
 *
 * The 512-byte limit and the lossy marker are constants shared with the store.
 */
import {
  LEAF_BYTES,
  lineLabel,
  nodeLength,
  nodeStart,
  renderLine,
  type MemoryKind,
  type ViewLine,
} from "./memory.ts";

/** Marks a summary line that dropped exact values from its input. */
export const LOSSY_MARKER = "…[ids]";

/** Shows the model the 512-byte line length, because it cannot count bytes. */
export const RULER = "-".repeat(LEAF_BYTES);

/**
 * The `# The view` section (gist §5), renamed to the Lead and adapted for
 * project memory. Phase 5 reuses it in the Lead prompt unchanged.
 */
export const MEMORY_VIEW_DESCRIPTION = `# The view

The Lead's memory: the whole project chat between the Lead and the user, shared
by every session in the project, oldest first, inside <chat> tags, as one-line
summaries:

  id+n|text   the n messages from id on, summarized (newlines as spaces)

Each message has a kind:
- user: the user's words
- lead: the Lead's replies
- tool: the Lead's tool calls
- echo: tool results
- work: an agent's report, starting "[Name]"
- note: memories imported from a session that existed before the memory

The summaries form a binary tree: each message is compressed into a line (a
short message is its own line), then adjacent lines are merged in pairs, again
and again. So recent lines cover one message each, and older lines cover more. A
message not summarized yet shows as "(not summarized yet: zoom it)". A text too
long for one message is split over several in a row.

Tools:
- zoom(id, n) opens line id+n into the two lines it was made from;
- zoom(id, 1) gives message id whole, with its images
- date(id) gives the date and time of message id

A line ending in …[ids] left out exact values, so zoom it before using them.`;

/** The Lead prompt section that carries the view while memory is active. */
export const MEMORY_PROMPT_SECTION = "pi_herdsman_memory";

/** The memory tools, projected into the Lead's active set only while active. */
export const MEMORY_TOOL_NAMES = ["zoom", "date"] as const;

/**
 * The Lead's project-memory prompt: the view description and the behavior
 * rules. It is static, with no dates, counts or state, so the cached prefix
 * does not change between turns (ADR 0009).
 */
export const MEMORY_LEAD_PROMPT = `${MEMORY_VIEW_DESCRIPTION}

# Turns

1. The view is your memory, and its latest word on a thing is the truth.
2. When you need information, find its latest mention in the view and zoom until
   you have it whole before you act, guess or ask.
3. The user's words matter most.
4. Summaries keep little tool output, so say in your reply what you learned that
   will matter later.
5. Never wait for background work (no sleep, no polling). Continue, or end the
   turn and say what is running.
6. Never make anything look further along than it was.
7. A <last_exchange> block after the view repeats the previous user message and
   your reply to it, verbatim.`;

/** The leaf task: compress one whole message into a line. */
export function compressTask(input: {
  id: number;
  kind: MemoryKind;
  text: string;
}): string {
  return [
    `Compaction: compress message ${input.id} into one line of at most ${LEAF_BYTES} bytes`,
    `(about 70 words), the length of this ruler:`,
    RULER,
    `<input>`,
    `${input.kind}: ${input.text}`,
    `</input>`,
  ].join("\n");
}

/** The merge task: merge two adjacent built lines into one. */
export function mergeTask(input: {
  line: ViewLine;
  first: string;
  second: string;
}): string {
  const first: ViewLine = [input.line[0] - 1, input.line[1] * 2];
  const second: ViewLine = [input.line[0] - 1, input.line[1] * 2 + 1];
  const start = nodeStart(input.line);
  const end = start + nodeLength(input.line) - 1;
  return [
    `Compaction: merge lines ${lineLabel(first)} and ${lineLabel(second)}, adjacent, into one line of at most`,
    `${LEAF_BYTES} bytes (about 70 words), the length of this ruler:`,
    RULER,
    `<chat> may hold their messages, ${start} to ${end}, in more detail: take details`,
    `of them from there too.`,
    `<input>`,
    renderLine(first, input.first),
    renderLine(second, input.second),
    `</input>`,
  ].join("\n");
}

/** The retry after a line came back over the limit. */
export function tooLongTask(input: { bytes: number; cut: string }): string {
  return [
    `Too long: your line is ${input.bytes} bytes, over the ${LEAF_BYTES}-byte limit. Write`,
    `the whole line again for the same <input>, cutting just enough of the`,
    `least valuable items to fit before this cut:`,
    `${input.cut}| ← LIMIT`,
  ].join("\n");
}
