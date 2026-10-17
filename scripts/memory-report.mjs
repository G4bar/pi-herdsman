#!/usr/bin/env node
/**
 * The memory ledger report: turn waits, compactor builds and cache-read share
 * from one or more Pi session files. Plain Node, no dependencies.
 *
 *   node scripts/memory-report.mjs <session.jsonl> [more.jsonl ...]
 *
 * It reads only the `pi-herdsman-memory-turn` and `pi-herdsman-memory-usage`
 * custom entries, plus the `usage` of assistant messages that follow a turn
 * entry. Unknown entries and entries written before `ms` existed are ignored,
 * so an old session still reports its turns and builds.
 *
 * Approximation: Lead usage counts every assistant message after the first
 * turn entry of a file, so it also includes abandoned branches and any turn
 * after memory went inactive. The cache-read share is a rough figure, not a
 * per-turn join.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TURN_ENTRY = "pi-herdsman-memory-turn";
const USAGE_ENTRY = "pi-herdsman-memory-usage";

/** Every usable JSON record of one file; a torn line is not one. */
function records(file) {
  const found = [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read ${file}: ${error instanceof Error ? error.message : error}`,
    );
  }
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      found.push(JSON.parse(line));
    } catch {
      // A torn or unreadable line never becomes a record.
    }
  }
  return found;
}

/** One file's ledger: the turns, the builds and the Lead request usages. */
function ledgerOf(file) {
  const turns = [];
  const builds = [];
  const lead = [];
  let sawTurn = false;
  for (const record of records(file)) {
    if (record?.type === "custom" && record.customType === TURN_ENTRY) {
      sawTurn = true;
      const data = record.data ?? {};
      if (typeof data.ms === "number")
        turns.push({
          ms: data.ms,
          outcome: data.outcome,
          placeholders:
            typeof data.placeholders === "number" ? data.placeholders : 0,
        });
      continue;
    }
    if (record?.type === "custom" && record.customType === USAGE_ENTRY) {
      const data = record.data ?? {};
      builds.push({
        ms: typeof data.ms === "number" ? data.ms : undefined,
        attempts: typeof data.attempts === "number" ? data.attempts : 1,
        retries: typeof data.retries === "number" ? data.retries : 0,
        input: data.input ?? 0,
        cacheRead: data.cacheRead ?? 0,
        cacheWrite: data.cacheWrite ?? 0,
      });
      continue;
    }
    // The Lead's own requests: only turns that carry a turn entry count.
    if (
      sawTurn &&
      record?.type === "message" &&
      record.message?.role === "assistant" &&
      record.message.usage
    )
      lead.push(record.message.usage);
  }
  return { turns, builds, lead };
}

/** Nearest-rank percentile, or undefined for an empty set. */
function percentile(values, p) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[index];
}

function seconds(ms) {
  return ms === undefined ? "n/a" : `${(ms / 1000).toFixed(2)} s`;
}

function millis(ms) {
  return ms === undefined ? "n/a" : `${Math.round(ms)} ms`;
}

function percent(kept, total) {
  return total === 0 ? "n/a" : `${Math.round((kept / total) * 100)}%`;
}

/** Pi's `usage.input` excludes cached tokens, so the share is over all three. */
function cacheShare(usages) {
  const totals = usages.reduce(
    (sum, usage) => ({
      input: sum.input + (usage.input ?? 0),
      cacheRead: sum.cacheRead + (usage.cacheRead ?? 0),
      cacheWrite: sum.cacheWrite + (usage.cacheWrite ?? 0),
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0 },
  );
  return percent(totals.cacheRead, totals.input + totals.cacheRead + totals.cacheWrite);
}

function mean(values) {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function report(files) {
  const turns = [];
  const builds = [];
  const lead = [];
  for (const file of files) {
    const ledger = ledgerOf(file);
    turns.push(...ledger.turns);
    builds.push(...ledger.builds);
    lead.push(...ledger.lead);
  }

  const waits = turns.map((turn) => turn.ms);
  const buildMs = builds
    .map((build) => build.ms)
    .filter((ms) => ms !== undefined);
  const outcomes = { settled: 0, expired: 0, aborted: 0 };
  for (const turn of turns)
    if (turn.outcome in outcomes) outcomes[turn.outcome] += 1;

  const lines = [];
  lines.push(`sessions   ${files.length}`);
  lines.push(`turns      ${turns.length}`);
  lines.push(
    `wait       p50 ${seconds(percentile(waits, 0.5))} · ` +
      `p95 ${seconds(percentile(waits, 0.95))} · ` +
      `max ${seconds(waits.length === 0 ? undefined : Math.max(...waits))}`,
  );
  lines.push(
    `outcome    settled ${outcomes.settled} · expired ${outcomes.expired} ` +
      `(${percent(outcomes.expired, turns.length)}) · ` +
      `aborted ${outcomes.aborted} (${percent(outcomes.aborted, turns.length)})`,
  );
  lines.push(
    `placeholders mean ${mean(turns.map((turn) => turn.placeholders)).toFixed(2)}`,
  );
  lines.push(`builds     ${builds.length}`);
  lines.push(
    `build ms   p50 ${millis(percentile(buildMs, 0.5))} · ` +
      `p95 ${millis(percentile(buildMs, 0.95))}`,
  );
  lines.push(
    `per build  ${mean(builds.map((build) => build.attempts)).toFixed(3)} attempts · ` +
      `${mean(builds.map((build) => build.retries)).toFixed(3)} retries`,
  );
  lines.push(
    `cache read compactor ${cacheShare(builds)} · lead ${cacheShare(lead)}`,
  );
  return lines.join("\n");
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: node scripts/memory-report.mjs <session.jsonl> ...");
    return 1;
  }
  try {
    console.log(report(files.map((file) => resolve(file))));
  } catch (error) {
    console.error(
      `memory-report: ${error instanceof Error ? error.message : error}`,
    );
    return 1;
  }
  return 0;
}

process.exitCode = main();
