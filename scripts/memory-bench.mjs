#!/usr/bin/env node
/**
 * The compactor bench: replay one kept project store's compaction calls once
 * per thinking arm, so the shipped default is picked on measured cost and line
 * quality instead of a guess.
 *
 * It is opt-in and it spends real money, so it needs `--yes`. The replay sends
 * the exact request the runtime sends (`buildCompactionRequest`), with the same
 * over-length retry conversation (`overLengthRetry`), so an arm's numbers are
 * the runtime's numbers for that thinking level. Its inputs are cuts of the
 * store's final `view.json`, not the views the live run sent: every arm sees
 * the same cut, so cross-arm comparisons are exact and recorded-vs-replay is
 * approximate (later merges coarsen the prefix an early node is cut at).
 *
 *   npm run bench -- --store /tmp/pi-herdsman-memory-baseline/memory-quality-memory --yes
 *   node scripts/memory-bench.mjs --store <dir> --arms low --yes
 *
 * The store directory is read-only (`main/`, `tree/`, `view.json`, optional
 * `session.jsonl`). Opening it through `MemoryStore` would take its lock and
 * rewrite its view, so the bench reads the logs instead.
 *
 * Without `--yes` the bench only reports the replay size, the recorded run and
 * its cost estimate; `--limit` replays a prefix, for wiring checks.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
  IMAGE_BODY,
  LEAF_BYTES,
  extractIdentifiers,
  nodeLength,
  nodeStart,
  renderBlocks,
} from "../extension/memory.ts";
import {
  MAX_LENGTH_RETRIES,
  assistantText,
  buildCompactionRequest,
  markLossy,
  overLengthRetry,
} from "../extension/memory-compactor.ts";
import { LOSSY_MARKER } from "../extension/memory-prompts.ts";
import { memoryStoreStats } from "./smoke.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BENCH_MODEL = "opencode-go/deepseek-v4.1-flash";
const BENCH_ARMS = ["medium", "low", "minimal", "off"];
const BENCH_CONCURRENCY = 4;
const BENCH_CALL_TIMEOUT_MS = 180_000;
const BENCH_PROGRESS_EVERY = 10;
/** The arms the model actually supports, in clamp order. */
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
/**
 * The identifier classes phase 10 scores retention on, so an arm's overall
 * retention is comparable with the recorded baseline's 0.586.
 */
const RETENTION_CLASSES = new Set(["uuid", "ref", "path", "number"]);
/** Every class the extractor knows, for the per-class table. */
const IDENTIFIER_CLASSES = ["uuid", "ref", "path", "url", "number", "code"];

// --- arguments --------------------------------------------------------------

function parseBenchArgs(args) {
  const { values } = parseArgs({
    args,
    options: {
      store: { type: "string" },
      arms: { type: "string" },
      model: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string" },
      timeout: { type: "string" },
      out: { type: "string" },
      yes: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "allow-anthropic": { type: "boolean" },
    },
  });
  if (!values.store) throw new Error("--store <dir> is required");
  // The same gate the smoke uses: a live run must not spend on anthropic/*
  // unless the caller asks for it.
  const model = values.model ?? BENCH_MODEL;
  if (model.startsWith("anthropic/") && !values["allow-anthropic"])
    throw new Error("an anthropic/* model needs --allow-anthropic");
  const arms = (values.arms ?? BENCH_ARMS.join(","))
    .split(",")
    .map((arm) => arm.trim())
    .filter((arm) => arm !== "");
  for (const arm of arms)
    if (!THINKING_LEVELS.includes(arm))
      throw new Error(
        `--arms entry ${JSON.stringify(arm)} is not a thinking level`,
      );
  const positive = (name, value) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
      throw new Error(`--${name} must be a positive integer`);
    return parsed;
  };
  return {
    store: resolve(values.store),
    arms,
    model,
    limit: positive("limit", values.limit),
    concurrency:
      positive("concurrency", values.concurrency) ?? BENCH_CONCURRENCY,
    timeoutMs:
      (positive("timeout", values.timeout) ?? BENCH_CALL_TIMEOUT_MS / 1000) *
      1000,
    out: values.out === undefined ? undefined : resolve(values.out),
    yes: values.yes ?? false,
    dryRun: values["dry-run"] ?? false,
  };
}

// --- the store, read-only ---------------------------------------------------

/** Every record of one JSONL file; a torn line is not one. */
function jsonlRecords(text) {
  const records = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn or unreadable line never becomes a record.
    }
  }
  return records;
}

/** Every record of one store part, in file order. */
async function logRecords(directory) {
  let names;
  try {
    names = (await readdir(directory))
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
  const records = [];
  for (const name of names)
    records.push(
      ...jsonlRecords(await readFile(join(directory, name), "utf8")),
    );
  return records;
}

/**
 * One kept store as the bench needs it: messages by id, built node lines, the
 * saved view cut at a node, and the node inputs. `textOf` mirrors
 * `MemoryStore.nodeText` and the same rule in phase 10's `memoryStoreStats`:
 * a short leaf, or a merge of two short children, has its text without a call.
 * The bench asserts its numbers against that function, so drift is caught.
 */
async function loadBenchStore(root) {
  const messages = await logRecords(join(root, "main"));
  const tree = await logRecords(join(root, "tree"));
  let view = { T: messages.length, chat: [], compaction: [] };
  try {
    const parsed = JSON.parse(await readFile(join(root, "view.json"), "utf8"));
    if (Array.isArray(parsed?.chat) && Array.isArray(parsed?.compaction))
      view = parsed;
  } catch {
    // An empty store writes no view; an unreadable one has no view to read.
  }
  const bodies = new Map(messages.map((message) => [message.i, message]));
  const built = new Map(tree.map((node) => [`${node.l}:${node.i}`, node.text]));
  const derived = new Map();
  const textOf = (line) => {
    const key = `${line[0]}:${line[1]}`;
    if (built.has(key)) return built.get(key);
    if (derived.has(key)) return derived.get(key);
    const [l, i] = line;
    let text;
    if (l === 0) {
      const record = bodies.get(i);
      if (record) {
        const body = record.text || (record.src?.images ? IMAGE_BODY : "");
        const leaf = `${record.kind}: ${body}`;
        if (Buffer.byteLength(leaf, "utf8") <= LEAF_BYTES) text = leaf;
      }
    } else {
      const first = textOf([l - 1, i * 2]);
      const second = textOf([l - 1, i * 2 + 1]);
      if (first !== undefined && second !== undefined) {
        const joined = `${first}\n${second}`;
        if (Buffer.byteLength(joined, "utf8") <= LEAF_BYTES) text = joined;
      }
    }
    derived.set(key, text);
    return text;
  };
  const nodeInputs = (line) => {
    const [l, i] = line;
    if (l === 0) {
      const record = bodies.get(i);
      if (!record) return undefined;
      return {
        kind: "message",
        id: i,
        messageKind: record.kind,
        text: record.text ?? "",
      };
    }
    const first = textOf([l - 1, i * 2]);
    const second = textOf([l - 1, i * 2 + 1]);
    if (first === undefined || second === undefined) return undefined;
    return { kind: "merge", line, first, second };
  };
  /** `MemoryStore.compactionLinesBefore`: only lines that end before `line`. */
  const compactionLinesBefore = (line) => {
    const limit =
      line[0] === 0 ? nodeStart(line) : nodeStart(line) + nodeLength(line);
    return view.compaction.filter(
      (entry) => nodeStart(entry) + nodeLength(entry) <= limit,
    );
  };
  return {
    root,
    messages,
    view,
    tree,
    sessionFile: join(root, "session.jsonl"),
    inputsOf: nodeInputs,
    textOf,
    renderCompactionBlocks: (line) =>
      renderBlocks(compactionLinesBefore(line), textOf),
  };
}

/** The input text one node is scored against: its message, or both children. */
function inputTextOf(inputs) {
  return inputs.kind === "message"
    ? inputs.text
    : `${inputs.first}\n${inputs.second}`;
}

// --- the recorded run -------------------------------------------------------

/** The token and attempt totals the phase 10 usage entries recorded. */
async function loadRecordedUsage(sessionFile) {
  let records = [];
  try {
    records = jsonlRecords(await readFile(sessionFile, "utf8"));
  } catch {
    // A store kept without its session has no recorded usage to compare.
  }
  const byNode = new Map();
  const totals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    attempts: 0,
    calls: 0,
  };
  for (const record of records) {
    if (record?.customType !== "pi-herdsman-memory-usage") continue;
    const data = record.data ?? {};
    byNode.set(`${data.node?.[0]}:${data.node?.[1]}`, data);
    totals.input += data.input ?? 0;
    totals.output += data.output ?? 0;
    totals.reasoning += data.reasoning ?? 0;
    totals.cacheRead += data.cacheRead ?? 0;
    totals.cacheWrite += data.cacheWrite ?? 0;
    totals.attempts += data.attempts ?? 1;
    totals.calls += 1;
  }
  return { byNode, totals };
}

// --- metrics ----------------------------------------------------------------

function share(kept, total) {
  return total ? kept / total : 0;
}

/** USD from tokens and a model price table, as the smoke report does. */
function tokenCost(tokens, price) {
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite) /
    1e6
  );
}

/**
 * One arm's row. `built` holds the finished nodes: the final marked line, the
 * node inputs it came from, its attempts, its summed tokens and its wall time.
 */
function armMetrics({ built, failures, wallMs, price }) {
  const tokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let attempts = 0;
  let millis = 0;
  let over = 0;
  let lossy = 0;
  let bytes = 0;
  const attemptsByNode = {};
  const identifiers = new Map();
  for (const result of built) {
    attempts += result.attempts;
    millis += result.ms;
    tokens.input += result.usage.input;
    tokens.output += result.usage.output;
    tokens.reasoning += result.usage.reasoning ?? 0;
    tokens.cacheRead += result.usage.cacheRead;
    tokens.cacheWrite += result.usage.cacheWrite;
    attemptsByNode[result.attempts] =
      (attemptsByNode[result.attempts] ?? 0) + 1;
    const size = Buffer.byteLength(result.text, "utf8");
    bytes += size;
    if (size > LEAF_BYTES) over += 1;
    if (result.text.endsWith(LOSSY_MARKER)) lossy += 1;
    for (const identifier of extractIdentifiers(inputTextOf(result.inputs))) {
      const counter = identifiers.get(identifier.kind) ?? { total: 0, kept: 0 };
      // A UUID is stored lowercase, so its comparison ignores case.
      const kept =
        identifier.kind === "uuid"
          ? result.text.toLowerCase().includes(identifier.value)
          : result.text.includes(identifier.value);
      counter.total += 1;
      if (kept) counter.kept += 1;
      identifiers.set(identifier.kind, counter);
    }
  }
  const classRow = (kind) => {
    const counter = identifiers.get(kind) ?? { total: 0, kept: 0 };
    return {
      total: counter.total,
      kept: counter.kept,
      share: share(counter.kept, counter.total),
    };
  };
  const overall = { total: 0, kept: 0 };
  for (const kind of RETENTION_CLASSES) {
    const counter = identifiers.get(kind);
    if (!counter) continue;
    overall.total += counter.total;
    overall.kept += counter.kept;
  }
  const byClass = {};
  for (const kind of IDENTIFIER_CLASSES) byClass[kind] = classRow(kind);
  return {
    calls: built.length,
    failures: failures.length,
    attempts,
    meanAttempts: share(attempts, built.length),
    attemptsByNode,
    tokens: { ...tokens, cost: tokenCost(tokens, price) },
    meanOutput: share(tokens.output, built.length),
    meanReasoning: share(tokens.reasoning, built.length),
    overLeafShare: share(over, built.length),
    lossyShare: share(lossy, built.length),
    meanNodeBytes: share(bytes, built.length),
    retention: { ...overall, share: share(overall.kept, overall.total) },
    byClass,
    // Per node, retries included: `ms` is the node's whole wall time.
    meanCallMs: share(millis, built.length),
    wallMs,
  };
}

/** The recorded tree lines as one pseudo-arm, to check the metric code. */
function recordedRow(store, usage, price) {
  const built = [];
  for (const node of store.tree) {
    const inputs = store.inputsOf([node.l, node.i]);
    if (!inputs) continue;
    const entry = usage.byNode.get(`${node.l}:${node.i}`);
    built.push({
      text: node.text ?? "",
      inputs,
      attempts: entry?.attempts ?? 1,
      ms: 0,
      usage: {
        input: entry?.input ?? 0,
        output: entry?.output ?? 0,
        reasoning: entry?.reasoning ?? null,
        cacheRead: entry?.cacheRead ?? 0,
        cacheWrite: entry?.cacheWrite ?? 0,
      },
    });
  }
  return armMetrics({ built, failures: [], wallMs: 0, price });
}

/** The recorded numbers of an arm must match phase 10's own store stats. */
async function checkAgainstStoreStats(store, row) {
  const stats = await memoryStoreStats(store.root);
  if (!stats) throw new Error(`${store.root} has no store to check`);
  const near = (left, right, label) =>
    assert.ok(
      Math.abs(left - right) < 1e-9,
      `${label}: bench ${left} against phase 10 store stats ${right}`,
    );
  near(row.overLeafShare, stats.overLeafShare, "over-leaf share");
  near(row.lossyShare, stats.lossyShare, "lossy share");
  near(row.retention.share, stats.identifiers.share, "retention");
  for (const kind of RETENTION_CLASSES)
    near(
      row.byClass[kind].share,
      stats.identifiers.byKind[kind]?.share ?? 0,
      `${kind} retention`,
    );
  return stats;
}

// --- the replay -------------------------------------------------------------

/** One model call of the replay, with its own abort and timeout. */
async function callModel(client, request, reasoning) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), client.timeoutMs);
  try {
    const options = { signal: controller.signal };
    // OpenCode routes a request by this header; the runtime sends it too.
    if (client.sessionId) options.sessionId = client.sessionId;
    if (reasoning && reasoning !== "off") options.reasoning = reasoning;
    const stream = client.runtime.streamSimple(
      client.model,
      {
        systemPrompt: request.systemPrompt,
        messages: [...request.messages],
      },
      options,
    );
    let final;
    for await (const event of stream) {
      if (event.type === "done") final = event.message;
      else if (event.type === "error") final = event.error;
    }
    if (!final) throw new Error("compaction stream ended early");
    if (final.stopReason === "error" || final.stopReason === "aborted")
      throw new Error(
        final.errorMessage ?? `compaction ${final.stopReason ?? "failed"}`,
      );
    return final;
  } finally {
    clearTimeout(timer);
  }
}

function addUsage(total, usage) {
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
  if (typeof usage.reasoning === "number")
    total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
}

/**
 * One node, replayed with the runtime's own retry rule: at most
 * `MAX_LENGTH_RETRIES` over-length retries in the same conversation, keeping
 * the shortest line seen. `overLengthRetry` is the runtime's, so the retry
 * conversation is the same one.
 */
async function replayNode(client, line) {
  const inputs = client.store.inputsOf(line);
  if (!inputs) throw new Error("node inputs are not available");
  const request = buildCompactionRequest(
    inputs,
    client.store.renderCompactionBlocks(line),
    client.body,
  );
  const usage = {
    input: 0,
    output: 0,
    reasoning: null,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let shortest;
  const started = Date.now();
  for (let attempt = 0; attempt <= MAX_LENGTH_RETRIES; attempt += 1) {
    const message = await callModel(client, request, client.reasoning);
    addUsage(usage, message.usage ?? {});
    const text = assistantText(message);
    if (text === "") throw new Error("compaction returned an empty line");
    const size = Buffer.byteLength(text, "utf8");
    if (
      shortest === undefined ||
      size < Buffer.byteLength(shortest.text, "utf8")
    )
      shortest = { text };
    const retry = overLengthRetry(message, text);
    if (!retry)
      return {
        line,
        inputs,
        text: markLossy(inputs, text),
        attempts: attempt + 1,
        usage,
        ms: Date.now() - started,
      };
    if (attempt === MAX_LENGTH_RETRIES) break;
    request.messages.push(...retry);
  }
  return {
    line,
    inputs,
    text: markLossy(inputs, shortest.text),
    attempts: MAX_LENGTH_RETRIES + 1,
    usage,
    ms: Date.now() - started,
  };
}

async function replayArm(client, nodes) {
  const built = [];
  const failures = [];
  let next = 0;
  const started = Date.now();
  const progress = () => {
    const done = built.length + failures.length;
    if (done % BENCH_PROGRESS_EVERY !== 0) return;
    process.stderr.write(
      `bench ${client.arm}: ${done}/${nodes.length} calls\n`,
    );
  };
  const worker = async () => {
    while (next < nodes.length) {
      const node = nodes[next++];
      try {
        const result = await replayNode(client, [node.l, node.i]);
        built.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ node: [node.l, node.i], error: message });
        if (failures.length === 1)
          console.error(
            `bench ${client.arm}: ${node.l}+${node.i} failed: ${message}`,
          );
      }
      progress();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(client.concurrency, nodes.length) }, worker),
  );
  process.stderr.write(
    `bench ${client.arm}: ${built.length} calls, ${failures.length} failed, ` +
      `${Math.round((Date.now() - started) / 1000)}s\n`,
  );
  return { built, failures, wallMs: Date.now() - started };
}

// --- arm planning -----------------------------------------------------------

/**
 * The requested arms with the level the runtime would actually send. The
 * runtime clamps a level to the model, so two requests can mean one request;
 * a repeated level is reported and run once.
 */
function planArms(model, requested) {
  const supported = getSupportedThinkingLevels(model);
  const plan = [];
  const first = new Map();
  for (const arm of requested) {
    // Exactly what the runtime sends: the requested level, clamped to the
    // model, and no `reasoning` option at all when the clamp leaves `off`.
    const sent = clampThinkingLevel(model, arm);
    const key = sent;
    const seen = first.get(key);
    if (seen !== undefined) {
      plan.push({
        arm,
        sent,
        collapsed: true,
        sameAs: seen,
        reason: `${arm} clamps to ${sent}, the same request`,
      });
      continue;
    }
    first.set(key, arm);
    plan.push({ arm, sent, collapsed: false, clamped: sent !== arm });
  }
  return { plan, supported };
}

// --- reporting --------------------------------------------------------------

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function armLine(label, row) {
  return (
    `${label}: ${row.calls} calls, ${row.attempts} attempts ` +
    `(${row.meanAttempts.toFixed(3)}/call), output ${row.tokens.output} ` +
    `(reasoning ${row.tokens.reasoning}), $${row.tokens.cost.toFixed(4)}, ` +
    `over-512 ${percent(row.overLeafShare)}, lossy ${percent(row.lossyShare)}, ` +
    `retention ${row.retention.share.toFixed(3)} (${row.retention.kept}/${row.retention.total}), ` +
    `mean ${Math.round(row.meanCallMs)}ms/call`
  );
}

function markdownTable(rows) {
  const header =
    "| arm | sent | calls | leaf/merge | attempts/call | output | reasoning | USD | over-512 | lossy | retention | uuid | ref | number | path | code | mean latency |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const lines = rows.map(({ arm, sent, row, leaf, merge }) =>
    [
      arm,
      sent === null || sent === undefined ? "off" : sent,
      row.calls,
      `${leaf}/${merge}`,
      row.meanAttempts.toFixed(3),
      row.tokens.output,
      row.tokens.reasoning,
      row.tokens.cost.toFixed(4),
      percent(row.overLeafShare),
      percent(row.lossyShare),
      `${row.retention.share.toFixed(3)} (${row.retention.kept}/${row.retention.total})`,
      `${row.byClass.uuid.share.toFixed(3)} (${row.byClass.uuid.kept}/${row.byClass.uuid.total})`,
      `${row.byClass.ref.share.toFixed(3)} (${row.byClass.ref.kept}/${row.byClass.ref.total})`,
      `${row.byClass.number.share.toFixed(3)} (${row.byClass.number.kept}/${row.byClass.number.total})`,
      `${row.byClass.path.share.toFixed(3)} (${row.byClass.path.kept}/${row.byClass.path.total})`,
      `${row.byClass.code.share.toFixed(3)} (${row.byClass.code.kept}/${row.byClass.code.total})`,
      `${Math.round(row.meanCallMs)}ms`,
    ].join(" | "),
  );
  return [header, ...lines.map((line) => `| ${line} |`)].join("\n");
}

// --- main -------------------------------------------------------------------

async function main() {
  const args = parseBenchArgs(process.argv.slice(2));
  const store = await loadBenchStore(args.store);
  if (store.messages.length === 0)
    throw new Error(`${args.store} has no messages; is it a kept store?`);
  const usage = await loadRecordedUsage(store.sessionFile);

  const allNodes = store.tree;
  if (allNodes.length === 0)
    throw new Error(`${args.store} has no built nodes to replay`);
  const nodes = args.limit ? allNodes.slice(0, args.limit) : allNodes;
  const leaf = nodes.filter((node) => node.l === 0).length;
  const leafAll = allNodes.filter((node) => node.l === 0).length;

  const runtime = await ModelRuntime.create({
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = runtime.getModel(
    args.model.split("/")[0],
    args.model.split("/").slice(1).join("/"),
  );
  if (!model) throw new Error(`model ${args.model} is not available`);
  const auth = await runtime.getAuth(model);
  if (!auth) throw new Error(`model ${args.model} has no configured auth`);
  const { plan, supported } = planArms(model, args.arms);
  const price = model.cost;

  // The recorded run is the free reference row, and the check that the bench's
  // metric code is the one phase 10 measured with.
  const recorded = recordedRow(store, usage, price);
  const stats = await checkAgainstStoreStats(store, recorded);

  console.log(`store      ${args.store}`);
  console.log(
    `store      ${store.messages.length} messages, ${store.view.compaction.length} compaction lines, ${allNodes.length} call nodes`,
  );
  console.log(
    `replay     ${nodes.length} nodes: ${leaf} leaf, ${nodes.length - leaf} merge`,
  );
  console.log(
    `recorded   ${usage.totals.calls} calls, ${usage.totals.output} output ` +
      `(${usage.totals.reasoning} reasoning), ` +
      `$${tokenCost(usage.totals, price).toFixed(4)}, ` +
      `${(usage.totals.attempts / (usage.totals.calls || 1)).toFixed(3)} attempts/call`,
  );
  console.log(`recorded   ${armLine("lines", recorded)}`);
  console.log(`model      ${args.model}, sends ${supported.join("/")}`);
  for (const entry of plan)
    console.log(
      `arm        ${entry.arm} -> ${entry.sent ?? "off (no reasoning option)"}` +
        (entry.collapsed
          ? ` (${entry.reason}; run once)`
          : entry.clamped
            ? " (clamped)"
            : ""),
    );
  const estimated = tokenCost(usage.totals, price);
  console.log(
    `estimate   about $${estimated.toFixed(2)} for one arm at the recorded level, ` +
      `less at a lower one; ${plan.filter((entry) => !entry.collapsed).length} arm(s) to run`,
  );
  console.log(
    `checked    metrics agree with phase 10 store stats (${stats.calls} lines)`,
  );

  // The recorded run's own lines are the free reference row: the same store,
  // the same nodes and the same request shape, so it is the medium arm unless
  // a replay of it runs too.
  const rows = [
    {
      arm: "recorded (medium→high, live)",
      sent: "high",
      row: recorded,
      leaf: leafAll,
      merge: allNodes.length - leafAll,
    },
  ];

  if (args.dryRun) {
    console.log(`\n${markdownTable(rows)}`);
    return 0;
  }
  if (!args.yes)
    throw new Error(
      "the bench spends money on live model calls; pass --yes to run it",
    );

  for (const entry of plan) {
    if (entry.collapsed) continue;
    const client = {
      runtime,
      model,
      store,
      body: BODY,
      reasoning: entry.sent,
      sessionId: `memory-bench-${entry.arm}-${randomUUID()}`,
      timeoutMs: args.timeoutMs,
      concurrency: args.concurrency,
      arm: entry.arm,
    };
    const { built, failures, wallMs } = await replayArm(client, nodes);
    const row = armMetrics({ built, failures, wallMs, price });
    rows.push({
      ...entry,
      row,
      leaf: nodes.filter((node) => node.l === 0).length,
      merge: nodes.filter((node) => node.l !== 0).length,
    });
    console.log(armLine(entry.arm, row));
    if (args.out) {
      await mkdir(dirname(args.out), { recursive: true });
      await writeFile(
        args.out,
        `${JSON.stringify(
          {
            store: args.store,
            model: args.model,
            nodes: nodes.length,
            leaf,
            merge: nodes.length - leaf,
            recorded: {
              arm: "recorded",
              sent: "high",
              leaf: leafAll,
              merge: allNodes.length - leafAll,
              ...recorded,
            },
            arms: rows.slice(1).map(({ arm, sent, row: metrics }) => ({
              arm,
              sent: sent ?? null,
              ...metrics,
            })),
          },
          null,
          2,
        )}\n`,
      );
    }
  }

  console.log(`\n${markdownTable(rows)}`);
  return rows.some(({ row }) => row.failures > 0) ? 1 : 0;
}

const BODY = stripFrontmatter(
  await readFile(
    join(repoRoot, "extension", "agent-definitions", "compactor.md"),
    "utf8",
  ),
);

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(
      `bench: FAIL ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
