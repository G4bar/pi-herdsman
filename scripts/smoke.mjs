import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import {
  IMAGE_BODY,
  LEAF_BYTES,
  extractIdentifiers,
  renderView,
} from "../extension/memory.ts";
import { LOSSY_MARKER } from "../extension/memory-prompts.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scenarioNames = [
  "core",
  "continuation",
  "chief-tree",
  "manager-recovery",
  "memory-cache",
  "memory-quality",
  "memory-horizon",
];
const SMOKE_MODEL_KEY = "pi-herdsman.smoke-model";
const MAX_SOCKET_PATH_BYTES = 100;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_CHIEF_TREE_RESULT_BYTES = 16 * 1024;
const POLL_MS = 250;
const OBSERVATION_TIMEOUT_MS = 5_000;
const CONTROL_STALL_MS = 15_000;
const MODEL_STALL_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const DEFAULT_MANAGER_READY_TIMEOUT_MS = 6 * 60_000;
const MAX_MANAGER_READY_TIMEOUT_MS = 10 * 60_000;
/** The arms `memory-horizon` can run; `native-continue` is the fair baseline. */
const HORIZON_ARMS = ["memory", "native-continue", "native-fresh"];
const MAX_HORIZON_RUNS = 8;
const MANAGER_DIAGNOSTIC_PREFIX = "[pi-herdsman-manager-diagnostic] ";
const HERDR_ROUTING_KEYS = [
  "HERDR_SOCKET_PATH",
  "HERDR_CLIENT_SOCKET_PATH",
  "HERDR_SESSION",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
  "HERDR_PANE_ID",
];

export function parseScenario(args) {
  if (args.length > 1) throw new Error(`unexpected smoke argument: ${args[1]}`);
  const scenario = args[0] ?? "core";
  if (!scenarioNames.includes(scenario))
    throw new Error(`unknown smoke scenario: ${scenario}`);
  return scenario;
}

/** True when `path` resolves to or inside `directory`. */
function insideDirectory(directory, path) {
  const relativePath = relative(directory, path);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

export function parseSmokeArgs(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      model: { type: "string" },
      yes: { type: "boolean" },
      keep: { type: "string" },
      "allow-anthropic": { type: "boolean" },
      "manager-ready-timeout-ms": { type: "string" },
      "manager-recovery-diagnostics": { type: "boolean" },
      runs: { type: "string" },
      arms: { type: "string" },
      "with-fresh": { type: "boolean" },
      "max-cost": { type: "string" },
      quick: { type: "boolean" },
    },
  });
  const scenario = parseScenario(positionals);
  const timeout = values["manager-ready-timeout-ms"];
  const managerReadyTimeoutMs =
    timeout === undefined ? undefined : Number(timeout);
  if (
    timeout !== undefined &&
    (scenario !== "manager-recovery" ||
      !/^\d+$/.test(timeout) ||
      !Number.isSafeInteger(managerReadyTimeoutMs) ||
      managerReadyTimeoutMs < 1 ||
      managerReadyTimeoutMs > MAX_MANAGER_READY_TIMEOUT_MS)
  )
    throw new Error(
      `--manager-ready-timeout-ms must be a positive integer no greater than ${MAX_MANAGER_READY_TIMEOUT_MS}, and is only valid for manager-recovery`,
    );
  const managerRecoveryDiagnostics =
    values["manager-recovery-diagnostics"] ?? false;
  if (managerRecoveryDiagnostics && scenario !== "manager-recovery")
    throw new Error(
      "--manager-recovery-diagnostics is only valid for manager-recovery",
    );
  const memoryScenario =
    scenario === "memory-cache" ||
    scenario === "memory-quality" ||
    scenario === "memory-horizon";
  const allowAnthropic = values["allow-anthropic"] ?? false;
  if (allowAnthropic && !memoryScenario)
    throw new Error(
      "--allow-anthropic is only valid for memory-cache, memory-quality and memory-horizon",
    );
  if (values.keep !== undefined) {
    if (!memoryScenario)
      throw new Error(
        "--keep is only valid for memory-cache, memory-quality and memory-horizon",
      );
    const keep = resolve(values.keep);
    if (insideDirectory(repoRoot, keep))
      throw new Error("--keep must point outside the repository");
    if (insideDirectory(join(homedir(), ".pi", "agent"), keep))
      throw new Error("--keep must point outside the pi agent directory");
  }
  if (
    memoryScenario &&
    values.model?.startsWith("anthropic/") &&
    !allowAnthropic
  )
    throw new Error("an anthropic/* model needs --allow-anthropic");
  const horizonOnly = (flag) => {
    if (scenario !== "memory-horizon")
      throw new Error(`${flag} is only valid for memory-horizon`);
  };
  const runs = values.runs === undefined ? undefined : Number(values.runs);
  if (values.runs !== undefined) {
    horizonOnly("--runs");
    if (
      !/^\d+$/.test(values.runs) ||
      !Number.isSafeInteger(runs) ||
      runs < 1 ||
      runs > MAX_HORIZON_RUNS
    )
      throw new Error(
        `--runs must be a positive integer no greater than ${MAX_HORIZON_RUNS}`,
      );
  }
  const arms = values.arms
    ?.split(",")
    .map((arm) => arm.trim())
    .filter((arm) => arm !== "");
  if (values.arms !== undefined) {
    horizonOnly("--arms");
    if (!arms.length || arms.some((arm) => !HORIZON_ARMS.includes(arm)))
      throw new Error(
        `--arms entries must be one of ${HORIZON_ARMS.join(", ")}`,
      );
    if (new Set(arms).size !== arms.length)
      throw new Error("--arms must not repeat an arm");
  }
  const withFresh = values["with-fresh"] ?? false;
  if (withFresh) horizonOnly("--with-fresh");
  const quick = values.quick ?? false;
  if (quick) horizonOnly("--quick");
  const maxCost =
    values["max-cost"] === undefined ? undefined : Number(values["max-cost"]);
  if (values["max-cost"] !== undefined) {
    horizonOnly("--max-cost");
    if (!Number.isFinite(maxCost) || maxCost <= 0)
      throw new Error("--max-cost must be a positive number of USD");
  }
  return {
    scenario,
    model: values.model,
    yes: values.yes ?? false,
    keep: values.keep,
    allowAnthropic,
    managerReadyTimeoutMs,
    managerRecoveryDiagnostics,
    runs,
    arms,
    withFresh,
    maxCost,
    quick,
  };
}

export function managerDiagnosticLines(contents) {
  if (typeof contents !== "string") return [];
  const safeLines = [];
  const seen = new Set();
  for (const line of contents.split(/\r?\n/)) {
    const prefixIndex = line.indexOf(MANAGER_DIAGNOSTIC_PREFIX);
    if (prefixIndex < 0) continue;
    let diagnostic;
    try {
      diagnostic = JSON.parse(
        line.slice(prefixIndex + MANAGER_DIAGNOSTIC_PREFIX.length),
      );
    } catch {
      continue;
    }
    let safe;
    if (
      [
        "session_start_reached",
        "initial_inbox_drain_start",
        "project_assignment_scope_start",
        "project_assignment_scope_complete",
        "project_assignment_topology_start",
        "project_assignment_topology_complete",
        "project_assignment_live_lead_start",
        "project_assignment_live_lead_complete",
      ].includes(diagnostic?.event)
    )
      safe = { event: diagnostic.event };
    else if (
      [
        "inbox_preflight",
        "inbox_preflight_recheck",
        "inbox_peer_presence",
      ].includes(diagnostic?.event) &&
      (diagnostic.event === "inbox_peer_presence"
        ? ["pass", "missing"]
        : diagnostic.event === "inbox_preflight_recheck"
          ? ["pass", "held", "stale"]
          : ["pass", "held"]
      ).includes(diagnostic.reason)
    )
      safe = { event: diagnostic.event, reason: diagnostic.reason };
    else if (
      ["inbox_candidates", "inbox_drain_complete"].includes(
        diagnostic?.event,
      ) &&
      Number.isInteger(diagnostic.count) &&
      diagnostic.count >= 0 &&
      diagnostic.count <= 1000 &&
      (diagnostic.event !== "inbox_drain_complete" ||
        typeof diagnostic.sessionStable === "boolean")
    )
      safe = {
        event: diagnostic.event,
        count: diagnostic.count,
        ...(diagnostic.event === "inbox_drain_complete"
          ? { sessionStable: diagnostic.sessionStable }
          : {}),
      };
    else if (
      diagnostic?.event === "inbox_catch" &&
      [
        "cleanup",
        "authorization",
        "send",
        "drain",
        "reconcile",
        "candidate_scan",
        "transaction",
      ].includes(diagnostic.category)
    )
      safe = { event: diagnostic.event, category: diagnostic.category };
    else if (
      diagnostic?.event === "project_assignment_authorization" &&
      ["authorized", "rejected", "error"].includes(diagnostic.outcome) &&
      [
        "matched",
        "target_or_workspace_mismatch",
        "lease_mismatch",
        "workspace_scope_mismatch",
        "assignment_evidence_mismatch",
        "worktree_topology_mismatch",
        "branch_placement_mismatch",
        "live_lead_mismatch",
        "workspace_placement_mismatch",
        "authorization_exception",
      ].includes(diagnostic.reason)
    )
      safe = {
        event: diagnostic.event,
        outcome: diagnostic.outcome,
        reason: diagnostic.reason,
      };
    else if (
      diagnostic?.event === "project_assignment_send" &&
      ["resolved", "rejected"].includes(diagnostic.outcome) &&
      typeof diagnostic.triggerTurn === "boolean"
    )
      safe = {
        event: diagnostic.event,
        outcome: diagnostic.outcome,
        triggerTurn: diagnostic.triggerTurn,
      };
    if (safe) {
      const safeLine =
        `${MANAGER_DIAGNOSTIC_PREFIX}${JSON.stringify(safe)}`.slice(0, 512);
      if (!seen.has(safeLine)) {
        seen.add(safeLine);
        safeLines.push(safeLine);
        if (safeLines.length > 16) seen.delete(safeLines.shift());
      }
    }
  }
  return safeLines;
}

export async function captureManagerLeadDiagnostics(
  ctx,
  paneId,
  readPane = nestedPaneText,
) {
  if (!ctx.managerRecoveryDiagnostics) return;
  ctx.managerRecovery.leadDiagnostics = [];
  try {
    ctx.managerRecovery.leadDiagnostics = managerDiagnosticLines(
      await readPane(ctx, paneId, "recent-unwrapped"),
    );
  } catch (error) {
    ctx.managerRecovery.leadDiagnosticsError = String(
      error?.message ?? error,
    ).slice(0, 200);
  }
}

export function formatSmokeFailure(error, stage) {
  const name = typeof error?.name === "string" ? error.name : typeof error;
  const message =
    typeof error?.message === "string" ? error.message : String(error);
  if (error?.code === "SMOKE_STALLED" || error?.code === "SMOKE_TIMEOUT") {
    const smoke = error.smoke ?? {};
    return `${name}: ${message}\nstage: ${smoke.stage ?? stage ?? "not recorded"}\nkind: ${error.code === "SMOKE_STALLED" ? "STALLED" : "TIMEOUT"}\nelapsed: ${smoke.elapsedMs ?? "unknown"}ms\ninactive: ${smoke.inactiveMs ?? "unknown"}ms\nlast progress: ${JSON.stringify(smoke.lastProgress ?? null)}\nlast evidence: ${JSON.stringify(smoke.lastEvidence ?? null)}\nlast observation error: ${smoke.lastObservationError ?? "none"}`;
  }
  return `stage: ${stage ?? "not recorded"}\nerror: ${name}: ${message}`;
}

function markStage(ctx, stage) {
  ctx.stage = stage;
}

function smokeWaitError(
  code,
  stage,
  startedAt,
  lastProgressAt,
  lastProgress,
  lastEvidence,
  lastObservationError,
) {
  const now = Date.now();
  const error = new Error(
    code === "SMOKE_STALLED"
      ? `${stage}: no meaningful progress`
      : `${stage}: hard deadline exceeded`,
  );
  error.code = code;
  error.smoke = {
    stage,
    elapsedMs: now - startedAt,
    inactiveMs: now - lastProgressAt,
    lastProgress,
    lastEvidence,
    lastObservationError,
  };
  return error;
}

function observationFailure(message) {
  const error = new Error(message);
  error.code = "SMOKE_OBSERVATION";
  return error;
}

export async function waitForEvidence(
  ctx,
  stage,
  inspect,
  { timeoutMs, stallMs, pollMs = POLL_MS },
) {
  markStage(ctx, stage);
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastProgress;
  let lastProgressKey;
  let lastEvidence;
  let lastObservationError;
  while (true) {
    const now = Date.now();
    if (now - startedAt >= timeoutMs)
      throw smokeWaitError(
        "SMOKE_TIMEOUT",
        stage,
        startedAt,
        lastProgressAt,
        lastProgress,
        lastEvidence,
        lastObservationError,
      );
    let observed;
    try {
      observed = await inspect();
    } catch (error) {
      if (error?.code !== "SMOKE_OBSERVATION") throw error;
      observed = { done: false, observationError: error.message };
    }
    lastObservationError = observed.observationError;
    if (Object.hasOwn(observed, "evidence")) lastEvidence = observed.evidence;
    if (Object.hasOwn(observed, "progress")) {
      const key = JSON.stringify(observed.progress);
      if (key !== lastProgressKey) {
        lastProgressKey = key;
        lastProgress = observed.progress;
        lastProgressAt = Date.now();
      }
    }
    if (Date.now() - startedAt >= timeoutMs)
      throw smokeWaitError(
        "SMOKE_TIMEOUT",
        stage,
        startedAt,
        lastProgressAt,
        lastProgress,
        lastEvidence,
        lastObservationError,
      );
    if (observed.done) return observed.value;
    const after = Date.now();
    if (after - lastProgressAt >= stallMs)
      throw smokeWaitError(
        "SMOKE_STALLED",
        stage,
        startedAt,
        lastProgressAt,
        lastProgress,
        lastEvidence,
        lastObservationError,
      );
    await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (after - startedAt))));
  }
}

export async function resolveSmokeModel(override, execute = run) {
  if (override !== undefined) {
    const model = override.trim();
    if (!model) throw new Error("smoke --model must not be empty");
    return model;
  }
  try {
    const { stdout } = await execute(
      "git",
      ["config", "--get", SMOKE_MODEL_KEY],
      { cwd: repoRoot },
    );
    const model = stdout.trim();
    if (model) return model;
  } catch (error) {
    if (error?.code !== 1) throw error;
  }
  throw new Error(
    `smoke model is not configured; run: git config --local ${SMOKE_MODEL_KEY} 'provider/model:thinking' or pass --model`,
  );
}

export function isolatedEnv(base, paths) {
  const env = { ...base };
  for (const key of HERDR_ROUTING_KEYS) delete env[key];
  Object.assign(env, {
    HERDR_CONFIG_PATH: paths.herdrConfig,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_STATE_HOME: paths.xdgState,
    PI_CODING_AGENT_DIR: paths.piAgent,
    PI_CODING_AGENT_SESSION_DIR: paths.piSessions,
  });
  return env;
}

export function nestedControlEnv(base, paths, sessionName) {
  return { ...isolatedEnv(base, paths), HERDR_SESSION: sessionName };
}

export function nestedHerdrApiSocketPath(paths, sessionName) {
  const directory = join(paths.xdgConfig, "herdr", "sessions", sessionName);
  for (const name of ["herdr.sock", "herdr-client.sock"]) {
    const bytesIncludingTerminator =
      Buffer.byteLength(join(directory, name)) + 1;
    assert.ok(
      bytesIncludingTerminator <= MAX_SOCKET_PATH_BYTES,
      `nested Herdr ${name} path is too long (${bytesIncludingTerminator} bytes; maximum ${MAX_SOCKET_PATH_BYTES})`,
    );
  }
  return join(directory, "herdr.sock");
}

export function candidateArgs(config) {
  assert.ok(
    typeof config.candidateExtension === "string" &&
      isAbsolute(config.candidateExtension),
    "candidate extension path must be absolute",
  );
  assert.ok(
    typeof config.herdrStateExtension === "string" &&
      isAbsolute(config.herdrStateExtension),
    "Herdr state extension path must be absolute",
  );
  const args = [
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--extension",
    config.candidateExtension,
    "--extension",
    config.herdrStateExtension,
    ...(config.chiefTreeProbeExtension
      ? ["--extension", config.chiefTreeProbeExtension]
      : []),
    "--model",
    config.model,
  ];
  if (config.chiefTreeProbeExtension)
    assert.ok(
      isAbsolute(config.chiefTreeProbeExtension),
      "Chief tree probe path must be absolute",
    );
  return args;
}

export function chiefTreeProbeSource(resultPath) {
  assert.ok(
    typeof resultPath === "string" && isAbsolute(resultPath),
    "Chief tree result path must be absolute",
  );
  return `import { appendFileSync } from "node:fs";
const resultPath = ${JSON.stringify(resultPath)};
export default function (pi) {
  function record(label) {
    appendFileSync(resultPath, JSON.stringify({ label, tools: [...pi.getActiveTools()].sort() }) + "\\n");
  }
  pi.registerCommand("smoke-tools", {
    description: "Record active tools for isolated smoke",
    handler: async (args) => {
      if (args === "lead" || args === "chief") record(args);
    },
  });
  pi.on("session_tree", () => record("tree"));
}`;
}

export function parseToolSnapshots(contents) {
  assert.ok(
    typeof contents === "string" &&
      Buffer.byteLength(contents) <= MAX_CHIEF_TREE_RESULT_BYTES,
  );
  const snapshots = new Map();
  for (const line of contents.trim().split("\n")) {
    const { label, tools } = JSON.parse(line);
    assert.ok(["lead", "chief", "tree"].includes(label));
    assert.ok(Array.isArray(tools));
    assert.ok(tools.every((tool) => typeof tool === "string"));
    const normalized = [...tools].sort();
    const previous = snapshots.get(label);
    if (previous)
      assert.deepEqual(
        normalized,
        previous,
        `conflicting ${label} tool snapshots`,
      );
    else snapshots.set(label, normalized);
  }
  return snapshots;
}

export function distinctPaneCount(processes) {
  return new Set(processes.map(({ paneId }) => paneId)).size;
}

export function chiefTreeBranchPlan(
  contents,
  startupPrompt,
  startupMarker,
  chiefPrompt,
  chiefMarker,
) {
  const entries = sessionEntries(contents);
  const byId = new Map(
    entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );
  const isAncestor = (ancestorId, descendantId) => {
    const visited = new Set();
    let parentId = byId.get(descendantId)?.parentId;
    while (parentId && !visited.has(parentId)) {
      if (parentId === ancestorId) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  };
  const userFor = (prompt) =>
    entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "user" &&
        messageText(entry.message.content) === prompt,
    );
  const answerFor = (user, marker) =>
    entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        isAncestor(user?.id, entry.id) &&
        entry.message.stopReason === "stop" &&
        messageText(entry.message.content)
          .split(/\r?\n/)
          .some((line) => line.trim() === marker),
    );
  const startupUser = userFor(startupPrompt);
  const startupAnswer = answerFor(startupUser, startupMarker);
  const chiefUser = userFor(chiefPrompt);
  const chiefAnswer = answerFor(chiefUser, chiefMarker);
  if (
    !startupUser ||
    !startupAnswer ||
    !chiefUser ||
    !chiefAnswer ||
    !isAncestor(startupAnswer.id, chiefUser.id) ||
    !isAncestor(chiefUser.id, chiefAnswer.id)
  )
    return {
      error:
        "saved transcript does not contain one completed Chief turn descended from the startup Lead branch",
    };
  const userPrompts = entries.filter(
    (entry) => entry.type === "message" && entry.message?.role === "user",
  );
  if (
    userPrompts.length !== 2 ||
    userPrompts[0]?.id !== startupUser.id ||
    userPrompts[1]?.id !== chiefUser.id
  )
    return { error: "saved transcript contains an unexpected user prompt" };
  const completedTurns = entries.filter(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      entry.message.stopReason === "stop",
  );
  if (
    completedTurns.length !== 2 ||
    completedTurns[0]?.id !== startupAnswer.id ||
    completedTurns[1]?.id !== chiefAnswer.id
  )
    return {
      error: "saved transcript contains an unexpected completed model turn",
    };
  return { targetId: startupAnswer.id };
}

export function chiefTreeFooter(output) {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const matches = [...text.matchAll(/^[ \t]*\((\d+)\/(\d+)\)(?:[ \t]|$)/gm)];
  if (!matches.length) return null;
  const [, selected, total] = matches.at(-1);
  const position = Number(selected);
  const count = Number(total);
  return position > 0 && count > 0 && position <= count
    ? { selected: position, total: count }
    : null;
}

export function chiefTreeSelectedRow(output, marker) {
  output = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const expected = `assistant: ${marker}`;
  const rows = output.split(/\r?\n/).filter((line) => line.includes(expected));
  return rows.length === 1 && /^[ \t│├└─⊟⊞]*›\s/.test(rows[0]);
}

export function countChiefTreeEvents(contents, baseline = 0) {
  return (
    contents
      .split("\n")
      .filter(Boolean)
      .filter((line) => JSON.parse(line).label === "tree").length - baseline
  );
}

export function chiefTreeBranchTransition(
  text,
  snapshots,
  treeEventsBefore,
  treeEvents,
) {
  if (text.includes("Summarize branch?"))
    return {
      done: true,
      value: { state: "summary-dialog", treeEventsBefore, treeEvents },
      progress: { state: "summary-dialog" },
    };
  const treeLoaded = (snapshots?.has("tree") ?? false) && treeEvents > 0;
  return {
    done: treeLoaded,
    value: treeLoaded ? { state: "tree-loaded", treeEvents } : undefined,
    progress: { treeEvents, treeSnapshot: treeLoaded },
  };
}

export function staffDelegateResults(contents) {
  return sessionEntries(contents).flatMap((entry) => {
    const message = entry.message;
    if (
      entry.type !== "message" ||
      message?.role !== "toolResult" ||
      message.toolName !== "delegate_project" ||
      message.isError
    )
      return [];
    try {
      const value = JSON.parse(messageText(message.content));
      return value?.ok === true && value.action === "delegate" ? [value] : [];
    } catch {
      return [];
    }
  });
}

export function staffActionResults(contents, toolName, action, prompt) {
  const entries = sessionEntries(contents);
  const byId = new Map(
    entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );
  const promptEntry =
    prompt === undefined
      ? null
      : entries.find(
          (entry) =>
            entry.type === "message" &&
            entry.message?.role === "user" &&
            messageText(entry.message.content) === prompt,
        );
  const descendsFromPrompt = (entry) => {
    if (prompt === undefined) return true;
    if (!promptEntry) return false;
    const visited = new Set();
    let parentId = entry.parentId;
    while (parentId && !visited.has(parentId)) {
      if (parentId === promptEntry.id) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  };
  return entries.flatMap((entry) => {
    const message = entry.message;
    if (
      entry.type !== "message" ||
      message?.role !== "toolResult" ||
      message.toolName !== toolName ||
      message.isError ||
      !descendsFromPrompt(entry)
    )
      return [];
    const value = message.details;
    return value?.ok === true && value.action === action ? [value] : [];
  });
}

export function projectMessageEntries(contents, branch, sessionId) {
  return sessionEntries(contents).filter(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-herdsman-project_message" &&
      entry.details?.branch === branch &&
      entry.details?.fromSessionId === sessionId,
  );
}

export function retainedProjectMessageRecord(records, branch, sessionId, text) {
  return (
    records.find(
      (record) =>
        record?.branch === branch &&
        record?.fromSessionId === sessionId &&
        record?.text === text &&
        typeof record?.id === "string" &&
        record.id.length > 0,
    ) ?? null
  );
}

export function managerCleanupTarget(
  worktrees,
  branch,
  worktreePath,
  retirementRequested = false,
) {
  if (typeof worktreePath !== "string" || !worktreePath)
    throw new Error("captured worktree path is unavailable");
  const matches = worktrees.filter((item) => item.branch === branch);
  if (matches.length === 0 && retirementRequested) return null;
  if (matches.length !== 1)
    throw new Error("exact branch must identify one worktree");
  const [target] = matches;
  if (target.path !== worktreePath)
    throw new Error("exact branch worktree path does not match captured path");
  if (typeof target.open_workspace_id !== "string" || !target.open_workspace_id)
    throw new Error("exact branch worktree has no workspace identity");
  return target;
}

export async function prepareManagerRepository(paths, execute = run) {
  const cwd = join(paths.root, "project");
  await mkdir(cwd);
  await execute("git", ["init", "--initial-branch=main", cwd]);
  await execute(
    "git",
    [
      "-c",
      "user.name=Herdsman Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "Smoke root",
    ],
    { cwd },
  );
  return cwd;
}

export function assertManagerFreshPrimary(
  workspaceId,
  primaryCheckoutPath,
  workspace,
  topology,
) {
  assert.equal(workspace?.workspace_id, workspaceId);
  const repoKey = topology?.source?.repo_key;
  assert.ok(
    typeof repoKey === "string" && repoKey.length > 0,
    "worktree source repo key must be a non-empty string",
  );
  assert.ok(topology?.source?.repo_name);
  assert.equal(topology?.source?.source_workspace_id, workspaceId);
  const sourceCheckoutPath = topology?.source?.source_checkout_path;
  assert.ok(
    typeof sourceCheckoutPath === "string" &&
      sourceCheckoutPath.length > 0 &&
      isAbsolute(sourceCheckoutPath),
    "worktree source checkout path must be a non-empty absolute path",
  );
  assert.equal(resolve(sourceCheckoutPath), primaryCheckoutPath);
  assert.ok(Array.isArray(topology.worktrees));
  assert.ok(
    topology.worktrees.length <= 1,
    "bootstrap must have no linked worktrees",
  );
  assert.ok(
    topology.worktrees.every(
      (item) =>
        !item.open_workspace_id || item.open_workspace_id === workspaceId,
    ),
    "bootstrap unexpectedly contains a linked workspace",
  );
  return repoKey;
}

export async function deleteBranchIfPresent(
  branch,
  execute = run,
  cwd = repoRoot,
) {
  try {
    await execute(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd },
    );
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
  await execute("git", ["branch", "-D", branch], { cwd });
  return true;
}

export function hasSuccessfulSupervisorMessage(contents, text) {
  const entries = sessionEntries(contents);
  const calls = entries.flatMap((entry) =>
    entry.type === "message" &&
    entry.message?.role === "assistant" &&
    Array.isArray(entry.message.content)
      ? entry.message.content.filter(
          (block) =>
            block?.type === "toolCall" &&
            block.name === "message_supervisor" &&
            block.arguments?.message === text,
        )
      : [],
  );
  return calls.some((call) =>
    entries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message.toolName === "message_supervisor" &&
        entry.message.toolCallId === call.id &&
        !entry.message.isError,
    ),
  );
}

export function leadReadyCompleted(contents, text) {
  const entries = sessionEntries(contents);
  const calls = entries.flatMap((entry, index) =>
    entry.type === "message" &&
    entry.message?.role === "assistant" &&
    Array.isArray(entry.message.content)
      ? entry.message.content
          .filter(
            (block) =>
              block?.type === "toolCall" &&
              block.name === "message_supervisor" &&
              block.arguments?.message === text,
          )
          .map((block) => ({ id: block.id, index }))
      : [],
  );
  const resultIndex = entries.findIndex(
    (entry, index) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "message_supervisor" &&
      !entry.message.isError &&
      calls.some(
        (call) => call.index < index && call.id === entry.message.toolCallId,
      ),
  );
  return (
    resultIndex >= 0 &&
    entries
      .slice(resultIndex + 1)
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "assistant" &&
          entry.message.stopReason === "stop",
      )
  );
}

export function verifiedLeadSession(childSession, expectedSession) {
  return (
    !!childSession &&
    typeof expectedSession === "string" &&
    expectedSession.length > 0 &&
    childSession.id === expectedSession
  );
}

export function managerReadyAnswer(contents, branch, leadSessionId) {
  const entries = sessionEntries(contents);
  const receipt = entries.findIndex(
    (entry) =>
      typeof leadSessionId === "string" &&
      leadSessionId.length > 0 &&
      entry.type === "custom_message" &&
      entry.customType === "pi-herdsman-project_message" &&
      entry.details?.branch === branch &&
      entry.details?.fromSessionId === leadSessionId &&
      entry.content ===
        `Project ${branch} from lead ${leadSessionId}:\n\nMANAGER_RECOVERY_READY`,
  );
  const readyMarkers = entries.flatMap((entry, index) =>
    entry.type === "message" &&
    entry.message?.role === "assistant" &&
    messageText(entry.message.content)
      .split(/\r?\n/)
      .some((line) => line.trim() === "PI_HERDSMAN_MANAGER_RECOVERY_READY")
      ? [{ entry, index }]
      : [],
  );
  const answer = readyMarkers.find(
    ({ entry }) => entry.message.stopReason === "stop",
  )?.entry;
  const answerAfterReceipt =
    receipt < 0
      ? null
      : (readyMarkers.find(
          ({ entry, index }) =>
            index > receipt && entry.message.stopReason === "stop",
        )?.entry ?? null);
  const prematureReady = readyMarkers.some(
    ({ index }) => receipt < 0 || index < receipt,
  );
  const prematureFinish = entries.some(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      Array.isArray(entry.message.content) &&
      entry.message.content.some(
        (block) =>
          block?.type === "toolCall" &&
          block.name === "message_staff" &&
          block.arguments?.message === "MANAGER_RECOVERY_FINISH",
      ),
  );
  return {
    receipt: receipt >= 0,
    answer: answer ?? null,
    answerAfterReceipt,
    prematureReady,
    prematureFinish,
  };
}

export function managerReadyEntryEvidence(contents, branch, leadSessionId) {
  const entries = sessionEntries(contents);
  const receiptText = `Project ${branch} from lead ${leadSessionId}:\n\nMANAGER_RECOVERY_READY`;
  const receipts = [];
  const markers = [];
  entries.forEach((entry, index) => {
    if (
      typeof leadSessionId === "string" &&
      leadSessionId.length > 0 &&
      entry.type === "custom_message" &&
      entry.customType === "pi-herdsman-project_message" &&
      entry.details?.branch === branch &&
      entry.details?.fromSessionId === leadSessionId &&
      entry.content === receiptText
    )
      receipts.push(index);
    if (
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      messageText(entry.message.content).includes(
        "PI_HERDSMAN_MANAGER_RECOVERY_READY",
      )
    )
      markers.push(index);
  });
  const centers = [
    ...receipts.slice(-1),
    ...markers.slice(0, 1),
    ...markers.slice(-2),
  ];
  const indices = new Set();
  for (const center of centers)
    for (
      let index = Math.max(0, center - 2);
      index <= Math.min(entries.length - 1, center + 2);
      index++
    )
      indices.add(index);
  return [...indices]
    .sort((a, b) => a - b)
    .map((index) => {
      const entry = entries[index];
      return {
        index,
        id: entry.id ?? null,
        parentId: entry.parentId ?? null,
        type: entry.type ?? null,
        customType: entry.customType ?? null,
        role: entry.message?.role ?? null,
        stopReason: entry.message?.stopReason ?? null,
        receipt: receipts.includes(index),
        readyMarker:
          entry.type === "message" &&
          messageText(entry.message?.content).includes(
            "PI_HERDSMAN_MANAGER_RECOVERY_READY",
          ),
      };
    });
}

function shellCommand(args) {
  assert.ok(
    Array.isArray(args) &&
      args.length > 0 &&
      args.every((arg) => typeof arg === "string"),
  );
  return args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

function sessionEntries(contents) {
  return contents
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function managerProjectMessageSettled(
  contents,
  branch,
  fromSessionId,
  marker,
) {
  const entries = sessionEntries(contents);
  const receipt = entries.findIndex(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-herdsman-project_message" &&
      entry.details?.branch === branch &&
      entry.details?.fromSessionId === fromSessionId &&
      String(entry.content).includes(marker),
  );
  return (
    receipt >= 0 &&
    entries
      .slice(receipt + 1)
      .some(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "assistant" &&
          entry.message.stopReason === "stop",
      )
  );
}

export function savedSessionHeaderEvidence(contents, expectedSessionId) {
  const header = sessionEntries(contents).find(
    (entry) => entry.type === "session",
  );
  return {
    expectedSessionId,
    actualSessionId: typeof header?.id === "string" ? header.id : null,
    sessionHeaderFound: !!header,
    sessionIdMatches: header?.id === expectedSessionId,
  };
}

export function continuationSessionEvidence(contents, expectedSessionId, task) {
  const normalize = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const taskFound = typeof task === "string" && normalize(task).length > 0;
  const header = savedSessionHeaderEvidence(contents, expectedSessionId);
  return {
    sessionHeaderFound: header.sessionHeaderFound,
    sessionIdMatches: header.sessionIdMatches,
    continuationTaskFound: taskFound,
    taskInstructionFound:
      taskFound &&
      sessionEntries(contents).some(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "user" &&
          normalize(messageText(entry.message.content)).includes(
            normalize(task),
          ),
      ),
  };
}

export function correlatedContinuationTask(
  contents,
  resultId,
  expectedSessionId,
  prompt,
) {
  const entries = sessionEntries(contents);
  const byId = new Map(
    entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );
  const ancestors = [];
  const visited = new Set();
  let entry = byId.get(resultId);
  let promptFound = false;
  while (entry && !visited.has(entry.id)) {
    visited.add(entry.id);
    if (
      entry.type === "message" &&
      entry.message?.role === "user" &&
      messageText(entry.message.content) === prompt
    ) {
      promptFound = true;
      break;
    }
    ancestors.unshift(entry);
    entry = byId.get(entry.parentId);
  }
  if (!promptFound) return null;
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const message = ancestors[index].message;
    if (
      ancestors[index].type !== "message" ||
      message?.role !== "toolResult" ||
      message.toolName !== "continue_agent" ||
      message.isError ||
      message.details?.ok !== true ||
      message.details.action !== "continue" ||
      message.details.session_id !== expectedSessionId
    )
      continue;
    for (const candidate of ancestors.slice(0, index).reverse()) {
      if (
        candidate.type !== "message" ||
        candidate.message?.role !== "assistant" ||
        !Array.isArray(candidate.message.content)
      )
        continue;
      const call = candidate.message.content.find(
        (block) =>
          block?.type === "toolCall" &&
          block.name === "continue_agent" &&
          typeof block.id === "string" &&
          block.id === message.toolCallId,
      );
      if (!call) continue;
      const task = call.arguments?.task;
      // Keep the exact task in memory only; reject oversized tasks rather than truncate them.
      return typeof task === "string" &&
        task.trim() &&
        Buffer.byteLength(task) <= 16 * 1024
        ? task
        : null;
    }
  }
  return null;
}

async function sessionPathEvidence(ctx, path, expectedSessionId) {
  const absolutePath = resolve(path);
  const isolatedSessions = resolve(ctx.paths.piSessions);
  const relativePath = relative(isolatedSessions, absolutePath);
  const evidence = {
    path: absolutePath,
    exists: null,
    ...savedSessionHeaderEvidence("", expectedSessionId),
  };
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    return { ...evidence, error: "outside isolated session directory" };

  let details;
  try {
    details = await lstat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return { ...evidence, exists: false };
    return { ...evidence, error: String(error.message).slice(0, 200) };
  }
  evidence.exists = true;
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size > MAX_SESSION_BYTES
  )
    return { ...evidence, error: "not a bounded regular session file" };
  try {
    return {
      ...evidence,
      ...savedSessionHeaderEvidence(
        await readFile(absolutePath, "utf8"),
        expectedSessionId,
      ),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { ...evidence, exists: false };
    return { ...evidence, error: String(error.message).slice(0, 200) };
  }
}

export async function managerChildSessionEvidence(
  ctx,
  agents,
  workspaceId,
  expectedSessionId,
) {
  const candidates = [];
  for (const agent of agents
    .filter((item) => item.workspace_id === workspaceId)
    .slice(0, 10)) {
    const identity = agent.agent_session;
    const candidate = {
      identityKind: identity?.kind ?? null,
      reportedSessionId:
        identity?.kind === "id" && typeof identity.value === "string"
          ? identity.value
          : null,
    };
    if (identity?.kind === "path" && typeof identity.value === "string")
      Object.assign(
        candidate,
        await sessionPathEvidence(ctx, identity.value, expectedSessionId),
      );
    else if (identity?.kind === "id" && typeof identity.value === "string") {
      try {
        const session = await exactIsolatedSession(ctx, identity.value);
        if (session)
          Object.assign(candidate, {
            path: session.path,
            exists: true,
            ...savedSessionHeaderEvidence(session.contents, expectedSessionId),
          });
      } catch (error) {
        candidate.error = String(error.message).slice(0, 200);
      }
    }
    candidates.push(candidate);
  }

  let expectedSessionFile = null;
  try {
    const session = await exactIsolatedSession(ctx, expectedSessionId);
    if (session)
      expectedSessionFile = {
        path: session.path,
        exists: true,
        ...savedSessionHeaderEvidence(session.contents, expectedSessionId),
      };
  } catch (error) {
    expectedSessionFile = { error: String(error.message).slice(0, 200) };
  }
  return { workspaceId, expectedSessionId, candidates, expectedSessionFile };
}

function messageText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("\n")
    : "";
}

function assistantResultsForPrompt(contents, prompt, marker, matchesMarker) {
  const entries = sessionEntries(contents);
  const promptEntry = entries.find(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "user" &&
      messageText(entry.message.content) === prompt,
  );
  if (!promptEntry) return [];
  const byId = new Map(
    entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );
  const descendsFromPrompt = (entry) => {
    let parentId = entry.parentId;
    const visited = new Set();
    while (parentId && !visited.has(parentId)) {
      if (parentId === promptEntry.id) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  };
  return entries.filter((entry) => {
    if (
      entry.type !== "message" ||
      entry.message?.role !== "assistant" ||
      entry.message.stopReason !== "stop"
    )
      return false;
    if (!descendsFromPrompt(entry)) return false;
    return matchesMarker(messageText(entry.message.content), marker);
  });
}

function assistantResultForPrompt(contents, prompt, marker) {
  return (
    assistantResultsForPrompt(contents, prompt, marker, (text, expected) =>
      text.split(/\r?\n/).some((line) => line.trim() === expected),
    )[0] ?? null
  );
}

export function continuationResultsForPrompt(contents, prompt, marker) {
  return assistantResultsForPrompt(contents, prompt, marker, (text, expected) =>
    text.split(/\s+/).includes(expected),
  );
}

export function assistantResultForSession(session, prompt, marker) {
  return assistantResultForPrompt(session.contents, prompt, marker);
}

// Transcript evidence of a completed response, not Pi's whole-run settlement signal.
export function assistantResponseCompletedForSession(session, prompt) {
  return (
    assistantResultsForPrompt(session.contents, prompt, "", () => true).length >
    0
  );
}

function summarizeSession(contents) {
  const entries = sessionEntries(contents);
  const header = entries.find((entry) => entry.type === "session");
  const tools = new Set();
  const messages = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message ?? {};
    for (const tool of message.toolsAdded ?? [])
      if (tool.name) tools.add(tool.name);
    const text = messageText(message.content);
    const calls = Array.isArray(message.content)
      ? message.content
          .filter((block) => block?.type === "toolCall")
          .map((block) => block.name)
      : [];
    if (
      message.role === "system" &&
      typeof message.sections?.tools === "string"
    ) {
      for (const [, name] of message.sections.tools.matchAll(
        /^\s*-\s+([\w-]+):/gm,
      ))
        tools.add(name);
    }
    if (message.role !== "system" || calls.length || text)
      messages.push({
        role: message.role,
        stopReason: message.stopReason,
        errorMessage:
          typeof message.errorMessage === "string"
            ? message.errorMessage.slice(0, 500)
            : undefined,
        toolName: message.toolName,
        isError: message.isError,
        tools: calls,
        text: text.slice(0, 500),
      });
  }
  return {
    session: header ? { id: header.id, cwd: header.cwd } : null,
    tools: [...tools].slice(0, 100),
    recentMessages: messages.slice(-16),
  };
}

async function run(file, args, options = {}) {
  return execFileAsync(file, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    ...options,
  });
}

function protocolError(message) {
  const error = new Error(message);
  error.code = "SMOKE_PROTOCOL";
  throw error;
}

export function parseHerdrOutput(stdout, args) {
  let value;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    protocolError(
      `herdr ${args.slice(0, 2).join(" ")} returned malformed JSON`,
    );
  }
  if (args[0] === "status" && args[1] === "--json") return value;
  // Session JSON is emitted by the CLI rather than the API response envelope.
  if (args[0] === "session" && args.at(-1) === "--json") return value;
  if (
    !value ||
    typeof value !== "object" ||
    !Object.hasOwn(value, "id") ||
    !Object.hasOwn(value, "result")
  )
    protocolError(
      `herdr ${args.slice(0, 2).join(" ")} returned no result envelope`,
    );
  return value.result;
}

async function herdr(args, options = {}) {
  const { stdout } = await run("herdr", args, options);
  return parseHerdrOutput(stdout, args);
}

async function tryHerdr(args, options = {}) {
  try {
    return { ok: true, value: await herdr(args, options) };
  } catch (error) {
    if (error?.code === "SMOKE_PROTOCOL") throw error;
    return {
      ok: false,
      error: error?.message ?? String(error),
      herdrCode: herdrErrorCode(error),
    };
  }
}

export function herdrErrorCode(error) {
  try {
    const value = JSON.parse(String(error?.stderr ?? "").trim());
    return typeof value?.error?.code === "string"
      ? value.error.code
      : undefined;
  } catch {
    return undefined;
  }
}

export function candidateStartObservationError(observed, paneId) {
  if (observed.ok) return undefined;
  if (observed.herdrCode === "pane_not_found")
    throw new Error(`candidate pane ${paneId} disappeared`);
  return { done: false, observationError: observed.error };
}

export function requireTestedBaseline(name, actualVersion, baselineVersion) {
  const parse = (version, kind) => {
    const match =
      typeof version === "string" && /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match)
      throw new Error(
        kind === "baseline"
          ? `smoke: invalid ${name} tested baseline: ${version}`
          : `smoke: invalid ${name} version: ${version}`,
      );
    return match.slice(1).map(Number);
  };
  const actual = parse(actualVersion, "actual");
  const minimum = parse(baselineVersion, "baseline");
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== minimum[i]) {
      if (actual[i] < minimum[i])
        throw new Error(
          `smoke: ${name} ${actualVersion} is below tested baseline ${baselineVersion}`,
        );
      return;
    }
  }
}

async function preflight(pkg) {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID)
    throw new Error("smoke must run from a Herdr-managed Pi session");
  const nodeEngine = pkg?.engines?.node;
  const nodeBaseline =
    typeof nodeEngine === "string"
      ? /^>=(\d+\.\d+\.\d+)$/.exec(nodeEngine)?.[1]
      : undefined;
  const piBaseline = pkg?.piHerdsman?.runtime?.pi;
  const herdrBaseline = pkg?.piHerdsman?.runtime?.herdr?.version;
  requireTestedBaseline("Node", process.versions.node, nodeBaseline);
  const [{ stdout: piVersion }, status] = await Promise.all([
    run("pi", ["--version"], { timeout: OBSERVATION_TIMEOUT_MS }),
    herdr(["status", "--json"], { timeout: OBSERVATION_TIMEOUT_MS }),
  ]);
  const actualPiVersion = piVersion.trim();
  requireTestedBaseline("Pi", actualPiVersion, piBaseline);
  if (!status?.server?.running) throw new Error("Herdr server is not running");
  if (!status?.server?.compatible)
    throw new Error("Herdr client/server are incompatible");
  const herdrClientVersion = status.client?.version;
  if (typeof herdrClientVersion !== "string")
    throw new Error("Herdr client version is unavailable or invalid");
  requireTestedBaseline("Herdr", herdrClientVersion, herdrBaseline);
  return {
    piVersion: actualPiVersion,
    herdrClientVersion,
  };
}

async function createIsolation() {
  const root = await mkdtemp(join(await realpath("/tmp"), "phs-"));
  const paths = {
    root,
    xdgConfig: join(root, "xdg-config"),
    xdgState: join(root, "xdg-state"),
    herdrConfig: join(root, "herdr.toml"),
    piAgent: join(root, "pi-agent"),
    piSessions: join(root, "pi-sessions"),
    herdrStateExtension: join(
      root,
      "pi-agent",
      "extensions",
      "herdr-agent-state.ts",
    ),
    authLink: join(root, "pi-agent", "auth.json"),
  };
  try {
    await Promise.all([
      mkdir(paths.xdgConfig, { recursive: true }),
      mkdir(paths.xdgState, { recursive: true }),
      mkdir(join(paths.piAgent, "extensions"), { recursive: true }),
      mkdir(paths.piSessions, { recursive: true }),
    ]);
    await writeFile(paths.herdrConfig, "[experimental]\nallow_nested = true\n");
    return paths;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function linkIfPresent(source, target) {
  try {
    await symlink(source, target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function preparePi(paths, model, execute = run) {
  const sourceAgentDir =
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const env = isolatedEnv(process.env, paths);
  const authArgs = ["auth", "check", "--model", model, "--no-refresh"];
  try {
    await execute("pi", authArgs, {
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return "ambient";
  } catch {
    if (
      !(await linkIfPresent(join(sourceAgentDir, "auth.json"), paths.authLink))
    )
      throw new Error(
        "Pi auth check failed and no current auth.json is available",
      );
    try {
      await execute("pi", authArgs, {
        env,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return "auth.json symlink";
    } catch {
      throw new Error(
        "Pi auth check failed with ambient credentials and auth.json",
      );
    }
  }
}

async function prepareHerdr(paths) {
  await run("herdr", ["config", "check"], {
    env: isolatedEnv(process.env, paths),
    stdio: ["ignore", "ignore", "pipe"],
  });
  await run("herdr", ["integration", "install", "pi"], {
    env: isolatedEnv(process.env, paths),
    stdio: ["ignore", "ignore", "pipe"],
  });
  await access(paths.herdrStateExtension);
}

async function startNestedHerdr(
  paths,
  owned,
  primaryCheckoutPath,
  managerRecoveryDiagnostics,
) {
  const id = randomUUID().slice(0, 12);
  const sessionName = `pi-herdsman-smoke-${id}`;
  owned.sessionName = sessionName;
  nestedHerdrApiSocketPath(paths, sessionName);
  const host = await herdr(
    [
      "tab",
      "create",
      "--workspace",
      process.env.HERDR_WORKSPACE_ID,
      "--cwd",
      primaryCheckoutPath,
      "--label",
      `smoke-${id}`,
      "--no-focus",
      "--env",
      `HERDR_CONFIG_PATH=${paths.herdrConfig}`,
      "--env",
      `XDG_CONFIG_HOME=${paths.xdgConfig}`,
      "--env",
      `XDG_STATE_HOME=${paths.xdgState}`,
      "--env",
      `PI_CODING_AGENT_DIR=${paths.piAgent}`,
      "--env",
      `PI_CODING_AGENT_SESSION_DIR=${paths.piSessions}`,
      ...(managerRecoveryDiagnostics
        ? ["--env", "PI_HERDSMAN_MANAGER_DIAGNOSTICS=1"]
        : []),
    ],
    { env: process.env },
  );
  const result = host;
  owned.hostTabId = result.tab?.tab_id;
  owned.hostPaneId = result.root_pane?.pane_id;
  assert.ok(
    owned.hostTabId && owned.hostPaneId,
    "Herdr tab response omitted owned IDs",
  );
  owned.sessionName = sessionName;
  await run(
    "herdr",
    [
      "pane",
      "run",
      owned.hostPaneId,
      shellCommand([
        process.execPath,
        join(repoRoot, "scripts", "smoke.mjs"),
        "--nested-host",
        sessionName,
        paths.root,
      ]),
    ],
    { env: process.env },
  ).catch((error) => {
    throw new Error(`could not launch nested host: ${error.message}`);
  });
}

function nestedHost(args) {
  const [sessionName, root] = args;
  if (!sessionName || !root)
    throw new Error("nested host requires a session and temp root");
  const paths = {
    root,
    xdgConfig: join(root, "xdg-config"),
    xdgState: join(root, "xdg-state"),
    herdrConfig: join(root, "herdr.toml"),
    piAgent: join(root, "pi-agent"),
    piSessions: join(root, "pi-sessions"),
  };
  const result = spawnSync("herdr", ["--session", sessionName], {
    env: isolatedEnv(process.env, paths),
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

async function nestedCommand(ctx, args) {
  return herdr(args, {
    env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
  });
}

export async function nestedPaneInput(ctx, args, execute = run, options = {}) {
  return execute("herdr", args, {
    env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
    ...options,
  });
}

export async function nestedPaneText(ctx, paneId, source, execute = run) {
  const { stdout } = await nestedPaneInput(
    ctx,
    ["pane", "read", paneId, "--source", source, "--lines", "120"],
    execute,
    { timeout: OBSERVATION_TIMEOUT_MS },
  );
  return stdout;
}

export async function submitPaneCommand(ctx, paneId, command, execute = run) {
  return nestedPaneInput(ctx, ["pane", "run", paneId, command], execute);
}

async function tryNestedCommand(ctx, args) {
  return tryHerdr(args, {
    env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
    timeout: OBSERVATION_TIMEOUT_MS,
  });
}

async function waitForNestedHerdr(ctx) {
  return waitForEvidence(
    ctx,
    "nested-herdr-ready",
    async () => {
      const result = await tryNestedCommand(ctx, ["pane", "list"]);
      return result.ok
        ? { done: true, value: result.value }
        : { done: false, observationError: result.error };
    },
    { timeoutMs: 30_000, stallMs: CONTROL_STALL_MS, pollMs: 150 },
  );
}

async function startCandidate(ctx) {
  assert.equal(ctx.candidateExtension, join(ctx.repoRoot, "dist", "index.js"));
  assert.equal(
    ctx.herdrStateExtension,
    join(ctx.paths.piAgent, "extensions", "herdr-agent-state.ts"),
  );
  assert.ok(
    isAbsolute(ctx.herdrStateExtension),
    "Herdr state extension path must be absolute",
  );
  await Promise.all([
    access(ctx.candidateExtension),
    access(ctx.herdrStateExtension),
    ...(ctx.chiefTreeProbeExtension
      ? [access(ctx.chiefTreeProbeExtension)]
      : []),
  ]);
  const panes = await nestedCommand(ctx, ["pane", "list"]);
  assert.ok(Array.isArray(panes.panes), "Herdr pane list result is malformed");
  const pane = panes.panes.find(
    (item) => resolve(item.cwd ?? "") === ctx.rootCwd,
  );
  const paneId = pane?.pane_id;
  assert.ok(paneId, "nested primary pane ID was not found");
  assert.ok(pane.workspace_id, "nested primary workspace ID was not found");
  ctx.rootWorkspaceId = pane.workspace_id;
  assert.equal(resolve(pane.cwd), ctx.rootCwd);
  ctx.rootPaneId = paneId;
  const prompt = ctx.initialPrompt;
  assert.ok(
    prompt === undefined || typeof prompt === "string",
    "candidate initial prompt must be a string when present",
  );
  const args = candidateArgs({
    candidateExtension: ctx.candidateExtension,
    herdrStateExtension: ctx.herdrStateExtension,
    ...(ctx.chiefTreeProbeExtension
      ? { chiefTreeProbeExtension: ctx.chiefTreeProbeExtension }
      : {}),
    model: ctx.model,
  });
  await run(
    "herdr",
    [
      "pane",
      "run",
      paneId,
      shellCommand(["pi", ...args, ...(prompt === undefined ? [] : [prompt])]),
    ],
    {
      env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
    },
  );
  await waitForEvidence(
    ctx,
    "candidate-start",
    async () => {
      const observed = await tryNestedCommand(ctx, [
        "pane",
        "process-info",
        "--pane",
        paneId,
      ]);
      const observationError = candidateStartObservationError(observed, paneId);
      if (observationError) return observationError;
      const matches = candidateProcess(
        observed.value,
        ctx.candidateExtension,
        ctx.herdrStateExtension,
      );
      return {
        done: matches.length > 0,
        value: paneId,
        progress: {
          pids: matches
            .map((proc) => proc.pid)
            .filter(Boolean)
            .sort(),
        },
        evidence: observed.value.process_info,
      };
    },
    { timeoutMs: 30_000, stallMs: CONTROL_STALL_MS },
  );
  return paneId;
}

function corePrompt(expected) {
  return `Delegate this task to one implementer.\n\nDo not read package.json yourself. The implementer must delegate exactly one scout to read package.json and determine its exact "name" and "version". The implementer must return that result to you.\n\nWhen the delegated work is complete, output exactly:\n\nPI_HERDSMAN_SMOKE_OK ${expected}\n\nDo not output that marker before the implementer reports its result.`;
}

function continuationPrompt() {
  return `Delegate exactly one bounded task to an implementer: read package.json, remember its exact package name, and return only CONTINUATION_FIRST_DONE. After that result reaches you, output exactly PI_HERDSMAN_CONTINUATION_FIRST. Do not read package.json yourself.`;
}

export function managerRecoveryFreshPrompt(branch) {
  return `Use delegate_project exactly once to start new project work. Set its \`task\` argument to the delegated task below and its \`branch\` argument to exactly ${branch}. Omit \`base\` and \`files\`.\n\nThe delegated task is:\n- do not modify any files;\n- immediately call message_supervisor with exactly MANAGER_RECOVERY_READY;\n- then end the turn and wait for further instruction.\n\nManager handshake: after delegate_project returns, end this turn immediately. Do not call any other tool, output any recovery marker, or send any message_staff. Wait until the exact MANAGER_RECOVERY_READY message from this Lead is delivered into your conversation; do not infer delivery from the delegate result, a Lead transcript, or other evidence. Only after that delivered message, reply exactly PI_HERDSMAN_MANAGER_RECOVERY_READY and end the turn.`;
}

export function managerRecoveryResumePrompt(branch) {
  return `Resume the existing work on branch ${branch}.\n\nCall resume_project using only:\n${JSON.stringify({ branch })}\n\nDo not start new work.\n\nAfter recovery succeeds, reply exactly PI_HERDSMAN_MANAGER_RECOVERY_RECOVERED and end the turn.`;
}

export function managerRecoveryPostRecoveryPrompt() {
  return "Recall the exact context marker you were instructed to remember before recovery using your prior conversation context. This information must reach the Manager before your normal result boundary, so send it now with message_supervisor. If information can wait until the normal result boundary, do not send it early; let the automatic result handoff carry it. Use exactly the recalled marker as the message and no other tool.";
}

export function managerRecoveryLeadContextPrompt(marker) {
  return `Remember this exact context marker for later: ${marker}\n\nReply with exactly the marker and do not call any tools.`;
}

export function managerRecoveryStopPrompt(session) {
  return `Pause the existing project work. Call stop_lead exactly once using only ${JSON.stringify({ session })}. After stop_lead succeeds, reply exactly PI_HERDSMAN_MANAGER_RECOVERY_PAUSED.`;
}

export function managerRecoveryReviewPrompt(branch) {
  return `Use message_staff to send a nonblocking request for the Lead to confirm readiness for review of ${branch}. Routine information that can wait should be left to the Lead's automatic result handoff. Then end the turn.`;
}

export function managerRecoveryResumeOnlyPrompt(branch) {
  return `Resume the existing project work on the exact full branch string ${JSON.stringify(branch)}. Copy that branch string verbatim; do not shorten, summarize, normalize, or otherwise alter it.\n\nCall resume_project exactly once using only these arguments:\n${JSON.stringify({ branch })}\n\nDo not call any other tool.\n\nAfter resume_project succeeds, reply exactly:\nPI_HERDSMAN_MANAGER_RECOVERY_RESUMED`;
}

export function managerRecoveryResumeDiagnostics(contents, prompt) {
  const entries = sessionEntries(contents);
  const byId = new Map(
    entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );
  const isDescendantOf = (entry, ancestorId) => {
    const visited = new Set();
    let parentId = entry.parentId;
    while (parentId && !visited.has(parentId)) {
      if (parentId === ancestorId) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  };
  const promptEntry = entries.find(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "user" &&
      messageText(entry.message.content) === prompt,
  );
  if (!promptEntry) return [];
  return entries.flatMap((entry) => {
    if (
      entry.type !== "message" ||
      entry.message?.role !== "assistant" ||
      !isDescendantOf(entry, promptEntry.id)
    )
      return [];
    return (Array.isArray(entry.message.content) ? entry.message.content : [])
      .filter(
        (part) => part.type === "toolCall" && part.name === "resume_project",
      )
      .map((call) => {
        const result = entries.find(
          (candidate) =>
            candidate.type === "message" &&
            candidate.message?.role === "toolResult" &&
            candidate.message.toolName === "resume_project" &&
            candidate.message.toolCallId === call.id,
        );
        return {
          branch: call.arguments?.branch ?? null,
          arguments: call.arguments ?? null,
          result: result
            ? {
                isError: result.message.isError === true,
                details: result.message.details ?? null,
                content: messageText(result.message.content),
              }
            : null,
        };
      });
  });
}

export function initialPromptForScenario(scenario, ctx) {
  switch (scenario) {
    case "core":
      return corePrompt(ctx.expectedPackage);
    case "continuation":
      return continuationPrompt();
    case "chief-tree":
      return "Reply exactly with PI_HERDSMAN_CHIEF_TREE_STARTUP.";
    case "manager-recovery":
      return undefined;
    case "memory-cache":
    case "memory-quality":
    case "memory-horizon":
      return undefined;
    default:
      throw new Error(`unknown smoke scenario: ${scenario}`);
  }
}

export function memoryScenarioOptions(ctx) {
  return {
    model: ctx.model,
    yes: ctx.yes,
    keep: ctx.keep,
    allowAnthropic: ctx.allowAnthropic,
    runs: ctx.runs,
    arms: ctx.arms,
    withFresh: ctx.withFresh,
    maxCost: ctx.maxCost,
    quick: ctx.quick,
  };
}

export async function runScenario(ctx, scenario) {
  markStage(ctx, scenario);
  switch (scenario) {
    case "core":
      return runCoreSmoke(ctx);
    case "continuation":
      return runContinuationSmoke(ctx);
    case "chief-tree":
      return runChiefTreeSmoke(ctx);
    case "manager-recovery":
      return runManagerRecoverySmoke(ctx);
    case "memory-cache":
      return runMemoryCacheScenario(memoryScenarioOptions(ctx));
    case "memory-quality":
      return runMemoryScenario(memoryScenarioOptions(ctx));
    case "memory-horizon":
      return runMemoryHorizonScenario(memoryScenarioOptions(ctx));
    default:
      throw new Error(`unknown smoke scenario: ${scenario}`);
  }
}

function hasExtensionArg(argv, extension) {
  return argv.some(
    (arg, index) => arg === "--extension" && argv[index + 1] === extension,
  );
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandLineHasPath(cmdline, path) {
  return new RegExp(`(?:^|[\\s"'])${escapedPattern(path)}(?:$|[\\s"'])`).test(
    cmdline,
  );
}

function candidateProcessMatch(proc, extension, integration) {
  if (Array.isArray(proc.argv))
    return hasExtensionArg(proc.argv, extension) &&
      hasExtensionArg(proc.argv, integration)
      ? "argv"
      : null;
  if (typeof proc.cmdline === "string")
    return commandLineHasPath(proc.cmdline, extension) &&
      commandLineHasPath(proc.cmdline, integration)
      ? "cmdline"
      : null;
  return null;
}

function candidateProcess(processInfo, extension, integration) {
  return (processInfo?.process_info?.foreground_processes ?? []).filter(
    (proc) => candidateProcessMatch(proc, extension, integration),
  );
}

export function listedPanes(value) {
  assert.ok(Array.isArray(value?.panes), "Herdr pane list result is malformed");
  return value.panes.map((pane) => {
    assert.ok(
      typeof pane?.pane_id === "string" && pane.pane_id,
      "Herdr pane list entry is malformed",
    );
    return { paneId: pane.pane_id };
  });
}

export async function inspectPaneProcesses(
  panes,
  rootPaneId,
  inspect,
  extension,
  integration,
) {
  const paneIds = [
    ...new Set(
      panes.map((pane) => (typeof pane === "string" ? pane : pane.paneId)),
    ),
  ].filter((paneId) => paneId && paneId !== rootPaneId);
  const inspected = await Promise.all(
    paneIds.map(async (paneId) => {
      try {
        return { paneId, info: await inspect(paneId) };
      } catch (error) {
        if (error?.code === "SMOKE_PROTOCOL") throw error;
        return { paneId, error: error?.message ?? String(error) };
      }
    }),
  );
  const records = inspected.flatMap(({ paneId, info, error }) => {
    const processes = info?.process_info?.foreground_processes;
    if (error) return [{ paneId, pid: null, processMatch: false, error }];
    if (!Array.isArray(processes) || !processes.length)
      return [
        {
          paneId,
          pid: null,
          processMatch: false,
          error: "no foreground process records",
        },
      ];
    return processes.map((proc) => {
      const processMatchSource = candidateProcessMatch(
        proc,
        extension,
        integration,
      );
      return {
        paneId,
        pid: proc.pid ?? null,
        processMatch: !!processMatchSource,
        processMatchSource,
        error: null,
      };
    });
  });
  const verified = new Map();
  for (const record of records) {
    if (record.processMatch && record.pid != null)
      verified.set(`${record.paneId}\0${record.pid}`, record);
  }
  return { records, verified: [...verified.values()] };
}

export async function bestEffortProcessDiagnostics(...args) {
  try {
    return (await inspectPaneProcesses(...args)).records.slice(0, 40);
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 500) };
  }
}

async function inspectCandidateProcesses(ctx) {
  const listed = await tryNestedCommand(ctx, ["pane", "list"]);
  if (!listed.ok) throw observationFailure(listed.error);
  const inspection = await inspectPaneProcesses(
    listedPanes(listed.value),
    ctx.rootPaneId,
    async (paneId) => {
      const result = await tryNestedCommand(ctx, [
        "pane",
        "process-info",
        "--pane",
        paneId,
      ]);
      if (!result.ok) throw observationFailure(result.error);
      return result.value;
    },
    ctx.candidateExtension,
    ctx.herdrStateExtension,
  );
  const errors = inspection.records
    .filter((record) => record.error)
    .map((record) => `${record.paneId}: ${record.error}`);
  if (errors.length) throw observationFailure(errors.join("; "));
  return inspection;
}

async function rootSessionSnapshot(ctx) {
  const observed = await tryNestedCommand(ctx, ["agent", "list"]);
  if (!observed.ok) throw observationFailure(observed.error);
  const listed = observed.value;
  const rootAgent = (listed.agents ?? []).find(
    (agent) => agent.pane_id === ctx.rootPaneId,
  );
  const sessionPath = rootAgent?.agent_session?.value;
  if (!sessionPath || rootAgent.agent_session?.kind !== "path") return null;
  const absolutePath = resolve(sessionPath);
  const sessionRoot = resolve(ctx.paths.piSessions);
  const relativePath = relative(sessionRoot, absolutePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    throw new Error(
      "root Pi session path is outside the isolated session directory",
    );
  let details;
  try {
    details = await lstat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error("root Pi session is not a regular isolated session file");
  if (details.size > MAX_SESSION_BYTES)
    throw new Error(
      `root Pi session exceeds ${MAX_SESSION_BYTES} byte read limit`,
    );
  const contents = await readFile(absolutePath, "utf8");
  const header = sessionEntries(contents).find(
    (entry) => entry.type === "session",
  );
  if (!header) return null;
  if (header.cwd !== ctx.rootCwd)
    throw new Error(
      "root Pi session cwd does not match the candidate repository",
    );
  return { path: absolutePath, status: rootAgent.agent_status, contents };
}

export async function isolatedSessionDetails(ctx, agent) {
  const identity = agent?.agent_session;
  if (identity?.kind !== "path" || typeof identity.value !== "string")
    return null;
  const path = resolve(identity.value);
  const isolatedSessions = resolve(ctx.paths.piSessions);
  const relativePath = relative(isolatedSessions, path);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    throw new Error(
      "managed Pi session path is outside the isolated session directory",
    );
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !details.isFile() ||
    details.isSymbolicLink() ||
    details.size > MAX_SESSION_BYTES
  )
    throw new Error(
      "managed Pi session is not a bounded regular isolated session file",
    );
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const header = sessionEntries(contents).find(
    (entry) => entry.type === "session",
  );
  if (!header?.id)
    throw new Error("managed Pi session has no persisted session ID");
  return { path, id: header.id, contents };
}

export async function exactIsolatedSession(ctx, id) {
  const root = ctx.paths.piSessions;
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
  );
  if (files.length > 256)
    throw new Error(
      "too many isolated Pi session files to identify Lead safely",
    );
  const matches = [];
  for (const entry of files) {
    const session = await isolatedSessionDetails(ctx, {
      agent_session: {
        kind: "path",
        value: join(entry.parentPath, entry.name),
      },
    });
    if (session?.id === id) matches.push(session);
  }
  if (matches.length > 1)
    throw new Error(`ambiguous isolated Pi session ID: ${id}`);
  return matches[0];
}

async function agentSessionId(ctx, agent) {
  const identity = agent?.agent_session;
  if (identity?.kind === "id" && typeof identity.value === "string")
    return identity.value;
  return (await isolatedSessionDetails(ctx, agent))?.id;
}

async function runCoreSmoke(ctx) {
  const marker = `PI_HERDSMAN_SMOKE_OK ${ctx.expectedPackage}`;
  const observed = new Map();
  await waitForEvidence(
    ctx,
    "core-delegation",
    async () => {
      const inspection = await inspectCandidateProcesses(ctx);
      for (const item of inspection.verified) {
        observed.set(`${item.paneId}\0${item.pid}`, item);
      }
      ctx.coreProcessEvidence = [...observed.values()].slice(-40);
      ctx.coreProcessDiagnostics = inspection.records.slice(0, 40);
      const session = await rootSessionSnapshot(ctx);
      if (session) {
        ctx.rootSessionPath = session.path;
        const assistantResult = assistantResultForSession(
          session,
          ctx.initialPrompt,
          marker,
        );
        if (assistantResult) ctx.assistantResult = assistantResult;
      }
      const paneCount = distinctPaneCount([...observed.values()]);
      return {
        done: !!ctx.assistantResult && paneCount >= 2,
        progress: {
          rootSessionBytes: session ? Buffer.byteLength(session.contents) : 0,
          verifiedProcesses: [...observed.keys()].sort(),
          assistantResultFound: !!ctx.assistantResult,
        },
        evidence: {
          paneCount,
          rootSession: session ? summarizeSession(session.contents) : null,
          processRecords: inspection.records.slice(-10),
        },
        value: paneCount,
      };
    },
    { timeoutMs: 6 * 60_000, stallMs: MODEL_STALL_MS },
  );
  ctx.descendantCount = distinctPaneCount([...observed.values()]);
  await waitForDescendantsToExit(ctx);
}

async function runContinuationSmoke(ctx) {
  const deadline = Date.now() + 6 * 60_000;
  const firstPrompt = ctx.initialPrompt;
  const firstMarker = "PI_HERDSMAN_CONTINUATION_FIRST";
  const secondMarker = "PI_HERDSMAN_CONTINUATION_SECOND";
  const expectedName = JSON.parse(
    await readFile(join(ctx.repoRoot, "package.json"), "utf8"),
  ).name;
  let firstSession;
  let firstGeneration;
  const firstPids = new Set();

  const childAgents = async () => {
    const listed = await tryNestedCommand(ctx, ["agent", "list"]);
    if (!listed.ok) throw observationFailure(listed.error);
    return (listed.value.agents ?? []).filter(
      (agent) => agent.pane_id && agent.pane_id !== ctx.rootPaneId,
    );
  };

  const promptRoot = async (prompt) => {
    await nestedCommand(ctx, ["agent", "prompt", ctx.rootPaneId, prompt]);
  };

  firstSession = await waitForEvidence(
    ctx,
    "continuation-first-generation",
    async () => {
      const listed = await tryNestedCommand(ctx, ["agent", "list"]);
      if (!listed.ok) return { done: false, observationError: listed.error };
      const agents = (listed.value.agents ?? []).filter(
        (agent) => agent.pane_id && agent.pane_id !== ctx.rootPaneId,
      );
      if (agents.length > 1)
        throw new Error(
          `continuation-first-generation: expected one managed Agent, observed ${agents.length}`,
        );
      let session;
      let sessionError;
      let pids = [];
      for (const agent of agents) {
        try {
          session = await isolatedSessionDetails(ctx, agent);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          sessionError = error.message;
        }
        if (session) {
          const observed = await tryNestedCommand(ctx, [
            "pane",
            "process-info",
            "--pane",
            agent.pane_id,
          ]);
          if (!observed.ok)
            return {
              done: false,
              observationError: observed.error,
              evidence: { sessionId: session.id, paneId: agent.pane_id },
            };
          pids = candidateProcess(
            observed.value,
            ctx.candidateExtension,
            ctx.herdrStateExtension,
          )
            .map(({ pid }) => pid)
            .filter((pid) => pid != null);
          firstSession = { ...session, paneId: agent.pane_id };
          for (const pid of pids) firstPids.add(pid);
          break;
        }
      }
      return {
        done: !!firstSession && pids.length > 0,
        value: firstSession,
        progress: {
          childCount: agents.length,
          sessionId: session?.id ?? null,
          sessionBytes: session ? Buffer.byteLength(session.contents) : 0,
          candidatePids: pids.sort(),
        },
        evidence: {
          sessionError,
          agents: agents.map(({ pane_id, agent_status }) => ({
            pane_id,
            agent_status,
          })),
        },
      };
    },
    { timeoutMs: 6 * 60_000, stallMs: MODEL_STALL_MS, pollMs: 200 },
  );
  if (!firstPids.size)
    throw new Error(
      "continuation-first-generation: no candidate process identity was observed",
    );

  await waitForEvidence(
    ctx,
    "continuation-first-result",
    async () => {
      const session = await rootSessionSnapshot(ctx);
      const result =
        session && assistantResultForSession(session, firstPrompt, firstMarker);
      return {
        done: !!result,
        progress: {
          rootSessionBytes: session ? Buffer.byteLength(session.contents) : 0,
          resultFound: !!result,
        },
        evidence: session ? summarizeSession(session.contents) : null,
      };
    },
    { timeoutMs: 6 * 60_000, stallMs: MODEL_STALL_MS },
  );
  firstSession.contents = await readFile(firstSession.path, "utf8");
  if (
    !sessionEntries(firstSession.contents).some(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        messageText(entry.message.content).includes("CONTINUATION_FIRST_DONE"),
    )
  )
    throw new Error(
      "continuation-first-result: persisted managed session did not contain its first result",
    );

  await waitForEvidence(
    ctx,
    "continuation-first-cleanup",
    async () => {
      const listed = await tryNestedCommand(ctx, ["pane", "list"]);
      if (!listed.ok) return { done: false, observationError: listed.error };
      const paneStillExists = listedPanes(listed.value).some(
        ({ paneId }) => paneId === firstSession.paneId,
      );
      return {
        done: !paneStillExists,
        progress: { paneStillExists },
        evidence: { paneId: firstSession.paneId },
      };
    },
    { timeoutMs: 60_000, stallMs: CONTROL_STALL_MS, pollMs: 300 },
  );
  const panesAfterFirst = listedPanes(
    await nestedCommand(ctx, ["pane", "list"]),
  );
  if (panesAfterFirst.some((pane) => pane.paneId === firstSession.paneId))
    throw new Error(
      "continuation-first-cleanup: first managed pane did not disappear",
    );
  const savedAfterCleanup = await isolatedSessionDetails(ctx, {
    agent_session: { kind: "path", value: firstSession.path },
  });
  if (savedAfterCleanup.id !== firstSession.id)
    throw new Error(
      "continuation-session-identity: first cleanup changed the persisted Pi session ID",
    );

  const followup = `Continue the exact saved Pi session at ${firstSession.path}. This is the same implementer you delegated previously. Without rereading package.json, return the package name you were asked to remember, followed by exactly ${secondMarker}. The final answer to me must include that marker.`;
  await promptRoot(followup);
  firstGeneration = await waitForEvidence(
    ctx,
    "continuation-second-generation",
    async () => {
      const agents = await childAgents();
      let matchingSessionSeen = false;
      let matchingPane;
      for (const agent of agents) {
        const session = await isolatedSessionDetails(ctx, agent).catch(
          (error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          },
        );
        if (
          session?.path !== firstSession.path ||
          session.id !== firstSession.id
        )
          continue;
        matchingSessionSeen = true;
        matchingPane = agent.pane_id;
        const observed = await tryNestedCommand(ctx, [
          "pane",
          "process-info",
          "--pane",
          agent.pane_id,
        ]);
        if (!observed.ok)
          return { done: false, observationError: observed.error };
        const matches = candidateProcess(
          observed.value,
          ctx.candidateExtension,
          ctx.herdrStateExtension,
        );
        for (const proc of matches) {
          if (
            proc.pid != null &&
            !firstPids.has(proc.pid) &&
            agent.pane_id !== firstSession.paneId
          ) {
            firstGeneration = proc.pid;
            ctx.continuationSecondPaneId = agent.pane_id;
          }
        }
      }
      return {
        done: firstGeneration !== undefined,
        value: firstGeneration,
        progress: {
          matchingSessionSeen,
          matchingPane: matchingPane ?? null,
          newPid: firstGeneration ?? null,
        },
        evidence: { childCount: agents.length },
      };
    },
    {
      timeoutMs: Math.max(1, deadline - Date.now()),
      stallMs: CONTROL_STALL_MS,
      pollMs: 200,
    },
  );

  await waitForEvidence(
    ctx,
    "continuation-follow-up",
    async () => {
      const session = await rootSessionSnapshot(ctx);
      const matchingResults =
        session &&
        continuationResultsForPrompt(session.contents, followup, secondMarker);
      const result = matchingResults?.[0];
      if (result) {
        if (!messageText(result.message.content).includes(expectedName))
          throw new Error(
            "continuation-follow-up: final result did not return the remembered package name",
          );
        if (matchingResults.length !== 1 || matchingResults[0].id !== result.id)
          throw new Error(
            `continuation-follow-up: expected exactly one final result, observed ${matchingResults.length}`,
          );
        const contents = await readFile(firstSession.path, "utf8");
        const evidence = continuationSessionEvidence(
          contents,
          firstSession.id,
          correlatedContinuationTask(
            session.contents,
            result.id,
            firstSession.id,
            followup,
          ),
        );
        ctx.continuationSessionEvidence = evidence;
        if (
          !evidence.sessionIdMatches ||
          !evidence.continuationTaskFound ||
          !evidence.taskInstructionFound
        )
          throw new Error(
            `continuation-session-identity: persisted ID or remembered-context follow-up was not preserved; evidence: ${JSON.stringify(evidence)}`,
          );
        await waitForDescendantsToExit(ctx);
        const finalSession = await rootSessionSnapshot(ctx);
        const finalResults = finalSession
          ? continuationResultsForPrompt(
              finalSession.contents,
              followup,
              secondMarker,
            )
          : [];
        if (finalResults.length !== 1)
          throw new Error(
            `continuation-follow-up: expected one final owner result after cleanup, observed ${finalResults.length}`,
          );
        ctx.continuationSessionId = firstSession.id;
        ctx.continuationSessionPath = firstSession.path;
        ctx.continuationFirstPaneId = firstSession.paneId;
        ctx.continuationGenerationPid = firstGeneration;
        return {
          done: true,
          value: true,
          progress: {
            rootSessionBytes: Buffer.byteLength(session.contents),
            resultFound: true,
          },
        };
      }
      return {
        done: false,
        progress: {
          rootSessionBytes: session ? Buffer.byteLength(session.contents) : 0,
          resultFound: false,
        },
        evidence: session ? summarizeSession(session.contents) : null,
      };
    },
    { timeoutMs: Math.max(1, deadline - Date.now()), stallMs: MODEL_STALL_MS },
  );
}

async function runManagerRecoverySmoke(ctx) {
  const branch = `herdsman/smoke-manager-recovery-${randomUUID()}`;
  const contextMarker = `MANAGER_RECOVERY_CONTEXT_${randomUUID()}`;
  ctx.managerRecovery = {
    branch,
    contextMarker,
    leadReadyTimeoutMs: ctx.managerReadyTimeoutMs,
  };
  ctx.owned.managerBranch = branch;
  let waitRootSessionBytes = 0;
  const rootSnapshot = async () => {
    const snapshot = await rootSessionSnapshot(ctx);
    waitRootSessionBytes = snapshot ? Buffer.byteLength(snapshot.contents) : 0;
    return snapshot;
  };
  const promptRoot = (prompt) =>
    nestedCommand(ctx, ["agent", "prompt", ctx.rootPaneId, prompt]);
  const promptAgent = (paneId, prompt) =>
    nestedCommand(ctx, ["agent", "prompt", paneId, prompt]);
  const agents = async () => {
    const result = await tryNestedCommand(ctx, ["agent", "list"]);
    if (!result.ok) throw observationFailure(result.error);
    return result.value.agents ?? [];
  };
  const worktrees = async () => {
    const observed = await tryNestedCommand(ctx, [
      "worktree",
      "list",
      "--workspace",
      ctx.rootWorkspaceId,
    ]);
    if (!observed.ok) throw observationFailure(observed.error);
    const result = observed.value;
    return result.worktrees ?? [];
  };
  const primaryPath = ctx.primaryCheckoutPath;
  const rootWorkspace = (
    await nestedCommand(ctx, ["workspace", "get", ctx.rootWorkspaceId])
  ).workspace;
  const rootTopology = await nestedCommand(ctx, [
    "worktree",
    "list",
    "--workspace",
    ctx.rootWorkspaceId,
  ]);
  const repoKey = assertManagerFreshPrimary(
    ctx.rootWorkspaceId,
    primaryPath,
    rootWorkspace,
    rootTopology,
  );
  const matchingWorktrees = async () =>
    (await worktrees()).filter((item) => item.branch === branch);
  const paneInfo = async (paneId) => {
    const result = await tryNestedCommand(ctx, [
      "pane",
      "process-info",
      "--pane",
      paneId,
    ]);
    if (!result.ok) throw observationFailure(result.error);
    return result.value;
  };
  const paneExists = async (paneId) =>
    listedPanes(await nestedCommand(ctx, ["pane", "list"])).some(
      (pane) => pane.paneId === paneId,
    );
  const candidatePids = async (paneId) => {
    const info = await paneInfo(paneId);
    return candidateProcess(
      info,
      ctx.candidateExtension,
      ctx.herdrStateExtension,
    )
      .map((proc) => proc.pid)
      .filter((pid) => pid != null);
  };
  const waitFor = async (label, inspect, timeout = 6 * 60_000) => {
    try {
      return await waitForEvidence(
        ctx,
        `manager-recovery-${label}`,
        async () => {
          const value = await inspect();
          const ready = ctx.managerRecovery.readyEvidence ?? {};
          const progress =
            label === "ready"
              ? {
                  delegationCount: ready.delegationCount ?? 0,
                  childFound: !!ready.childFound,
                  childSessionVerified: !!ready.childSessionVerified,
                  leadCompleted: !!ready.leadCompleted,
                  receipt: !!ready.receipt,
                  managerAnswerAfterReceipt: !!ready.managerAnswerAfterReceipt,
                }
              : [
                    "lead-context-acknowledgment",
                    "direct-handoff-settled",
                    "graceful-close",
                    "review-message",
                    "graceful-resume",
                    "recovery",
                    "project-message-retained",
                    "project-complete",
                  ].includes(label)
                ? { rootSessionBytes: waitRootSessionBytes, observed: !!value }
                : { observed: !!value };
          return {
            done: !!value,
            value,
            progress,
            evidence: ctx.managerRecovery.readyEvidence,
          };
        },
        {
          timeoutMs: timeout,
          stallMs: [
            "ready",
            "lead-context-acknowledgment",
            "direct-handoff-settled",
            "graceful-close",
            "review-message",
            "graceful-resume",
            "recovery",
            "project-message-retained",
            "project-complete",
          ].includes(label)
            ? MODEL_STALL_MS
            : CONTROL_STALL_MS,
        },
      );
    } catch (error) {
      if (error.code !== "SMOKE_STALLED" && error.code !== "SMOKE_TIMEOUT")
        throw error;
      if (label === "ready") {
        ctx.managerRecovery.readyEvidence ??= {};
        try {
          const session = await rootSnapshot();
          const results = session ? staffDelegateResults(session.contents) : [];
          const evidence = ctx.managerRecovery.readyEvidence;
          evidence.entries = session
            ? managerReadyEntryEvidence(
                session.contents,
                branch,
                results[0]?.session,
              )
            : [];
          if (
            results.length === 1 &&
            typeof results[0].session === "string" &&
            typeof results[0].workspace_id === "string"
          ) {
            let listedAgents = [];
            try {
              listedAgents = await agents();
              evidence.childSession = await managerChildSessionEvidence(
                ctx,
                listedAgents,
                results[0].workspace_id,
                results[0].session,
              );
              if (ctx.managerRecoveryDiagnostics) {
                const lead = listedAgents.find(
                  (agent) =>
                    agent.workspace_id === results[0].workspace_id &&
                    typeof agent.pane_id === "string" &&
                    agent.pane_id !== ctx.rootPaneId,
                );
                if (lead) {
                  try {
                    evidence.leadDiagnostics = managerDiagnosticLines(
                      await nestedPaneText(
                        ctx,
                        lead.pane_id,
                        "recent-unwrapped",
                      ),
                    );
                  } catch {
                    evidence.leadDiagnostics = [];
                  }
                } else evidence.leadDiagnostics = [];
              }
            } catch (error) {
              evidence.childSession = {
                error: String(error.message).slice(0, 200),
              };
            }
          }
        } catch (error) {
          ctx.managerRecovery.readyEvidence.entriesError = String(error).slice(
            0,
            200,
          );
        }
      }
      if (label === "ready")
        error.smoke.lastEvidence =
          ctx.managerRecovery.readyEvidence ?? error.smoke.lastEvidence;
      throw error;
    }
  };

  markStage(ctx, "fresh-session-identity");
  const freshRoot = await waitFor(
    "fresh-session",
    async () =>
      (await agents()).find(
        (agent) =>
          agent.pane_id === ctx.rootPaneId &&
          (agent.agent_session?.kind === "id" ||
            agent.agent_session?.kind === "path") &&
          typeof agent.agent_session.value === "string" &&
          agent.agent_session.value.length > 0,
      ),
    30_000,
  );
  const persistedFreshRoot = () =>
    freshRoot.agent_session.kind === "id"
      ? exactIsolatedSession(ctx, freshRoot.agent_session.value)
      : isolatedSessionDetails(ctx, freshRoot);
  assert.equal(
    await persistedFreshRoot(),
    undefined,
    "Manager bootstrap must precede Pi transcript persistence",
  );
  markStage(ctx, "manager-mode-command");
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager");
  markStage(ctx, "manager-mode-active-wait");
  await nestedCommand(ctx, [
    "pane",
    "wait-output",
    ctx.rootPaneId,
    "--match",
    "Manager mode active.",
    "--timeout",
    "15000",
  ]);
  assert.equal(
    await persistedFreshRoot(),
    undefined,
    "/manager must not manufacture a conversation",
  );

  const prompt = managerRecoveryFreshPrompt(branch);
  markStage(ctx, "fresh-delegation");
  await promptRoot(prompt);
  markStage(ctx, "lead-ready-handshake");
  const ready = await waitFor(
    "ready",
    async () => {
      const session = await rootSnapshot();
      const results = session ? staffDelegateResults(session.contents) : [];
      let child;
      if (
        results.length === 1 &&
        typeof results[0].session === "string" &&
        results[0].session.length > 0
      )
        for (const agent of await agents())
          if (
            agent.workspace_id === results[0].workspace_id &&
            (await agentSessionId(ctx, agent)) === results[0].session
          ) {
            child = agent;
            break;
          }
      const childSession =
        child &&
        (child.agent_session?.kind === "id"
          ? await exactIsolatedSession(ctx, results[0].session)
          : await isolatedSessionDetails(ctx, child));
      const childVerified = verifiedLeadSession(
        childSession,
        results[0]?.session,
      );
      const leadCompleted =
        childVerified &&
        leadReadyCompleted(childSession.contents, "MANAGER_RECOVERY_READY");
      const {
        receipt,
        answer,
        answerAfterReceipt,
        prematureReady,
        prematureFinish,
      } =
        session && results.length === 1
          ? managerReadyAnswer(session.contents, branch, results[0].session)
          : {
              receipt: false,
              answer: null,
              answerAfterReceipt: null,
              prematureReady: false,
              prematureFinish: false,
            };
      ctx.managerRecovery.readyEvidence = {
        delegationCount: results.length,
        childFound: !!child,
        childIdentity: child?.agent_session?.kind ?? null,
        childSessionVerified: !!childVerified,
        leadReadyResult: !!(
          childVerified &&
          hasSuccessfulSupervisorMessage(
            childSession.contents,
            "MANAGER_RECOVERY_READY",
          )
        ),
        leadCompleted: !!leadCompleted,
        receipt,
        managerAnswer: !!answer,
        managerAnswerAfterReceipt: !!answerAfterReceipt,
        prematureReady,
        prematureFinish,
        rootRecent: session
          ? summarizeSession(session.contents).recentMessages.slice(-6)
          : [],
        leadRecent: childSession
          ? summarizeSession(childSession.contents).recentMessages.slice(-6)
          : [],
        rootCustom: session
          ? sessionEntries(session.contents)
              .filter(
                (entry) =>
                  entry.type === "custom_message" &&
                  entry.customType === "pi-herdsman-project_message" &&
                  entry.details?.branch === branch &&
                  entry.details?.fromSessionId === results[0]?.session,
              )
              .slice(-3)
              .map((entry) => ({
                type: entry.customType,
                content: String(entry.content).slice(0, 200),
              }))
          : [],
      };
      return results.length === 1 &&
        leadCompleted &&
        receipt &&
        answerAfterReceipt &&
        !prematureReady &&
        !prematureFinish
        ? { results, answer, child }
        : null;
    },
    ctx.managerReadyTimeoutMs ?? DEFAULT_MANAGER_READY_TIMEOUT_MS,
  );
  const first = ready.results[0];
  await captureManagerLeadDiagnostics(ctx, ready.child.pane_id);
  markStage(ctx, "initial-assignment-validation");
  assert.equal(first.ok, true);
  assert.equal(first.action, "delegate");
  assert.match(first.session, /^[0-9a-f-]{36}$/i);
  assert.equal(first.branch, branch);
  assert.ok(first.workspace_id);
  const initialWorktrees = await matchingWorktrees();
  assert.equal(initialWorktrees.length, 1, "expected one matching worktree");
  const worktree = initialWorktrees[0];
  const worktreePath = worktree.path ?? worktree.worktree_path;
  const workspaceId = first.workspace_id;
  assert.ok(worktreePath, "worktree path was not reported");
  ctx.managerRecovery = {
    ...ctx.managerRecovery,
    sessionId: first.session,
    workspaceId,
    worktreePath,
  };
  markStage(ctx, "initial-topology-validation");
  ctx.owned.managerWorkspaceId = workspaceId;
  ctx.owned.managerWorktreePath = worktreePath;

  const initialAgent = (await agents()).find(
    (agent) => agent.workspace_id === workspaceId,
  );
  assert.ok(initialAgent, "delegated Lead was not listed in its workspace");
  const paneId = initialAgent.pane_id;
  assert.ok(paneId);
  assert.equal(await agentSessionId(ctx, initialAgent), first.session);
  assert.equal(initialAgent.workspace_id, workspaceId);
  const panes = listedPanes(await nestedCommand(ctx, ["pane", "list"]));
  assert.ok(panes.some((pane) => pane.paneId === paneId));
  const placement = await paneInfo(paneId);
  const initialProcesses = candidateProcess(
    placement,
    ctx.candidateExtension,
    ctx.herdrStateExtension,
  );
  assert.equal(
    initialProcesses.length,
    1,
    "expected one child candidate process",
  );
  const initialPid = initialProcesses[0].pid;
  assert.ok(initialPid);
  const pane = (await nestedCommand(ctx, ["pane", "list"])).panes.find(
    (item) => item.pane_id === paneId,
  );
  assert.ok(pane, "child pane placement was not listed");
  assert.equal(pane.workspace_id, workspaceId);
  assert.equal(resolve(pane.cwd), resolve(worktreePath));
  ctx.managerRecovery = {
    ...ctx.managerRecovery,
    paneId,
    tabId: pane.tab_id,
    firstPid: initialPid,
  };

  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const runtime = join(
    ctx.paths.piAgent,
    "pi-herdsman",
    "runtime",
    "supervision-v2",
    hash(nestedHerdrApiSocketPath(ctx.paths, ctx.sessionName)),
  );
  const assignmentPath = join(
    runtime,
    "assignments",
    hash(repoKey),
    `${hash(branch)}.json`,
  );
  const managerPath = join(
    runtime,
    "managers",
    `${hash(ctx.rootWorkspaceId)}.json`,
  );
  const assignmentBytes = async () => {
    const details = await lstat(assignmentPath);
    assert.ok(details.isFile() && !details.isSymbolicLink());
    assert.ok(details.size <= 16 * 1024);
    return readFile(assignmentPath, "utf8");
  };
  const managerLease = async () =>
    JSON.parse(await readFile(managerPath, "utf8")).leaseId;
  markStage(ctx, "initial-assignment-validation");
  const initialAssignmentBytes = await assignmentBytes();
  const record = JSON.parse(initialAssignmentBytes);
  assert.equal(record.id, first.session);
  assert.equal(record.branch, branch);
  assert.equal(record.repoKey, repoKey);
  assert.doesNotMatch(record.text, new RegExp(contextMarker));
  assert.equal(typeof record.piSessionFile, "string");
  assert.ok(record.piSessionFile.length > 0);
  assert.deepEqual(
    Object.keys(record).sort(),
    ["branch", "id", "piSessionFile", "repoKey", "text", "version"].sort(),
  );
  const assertUnchangedAssignment = async () =>
    assert.equal(
      await assignmentBytes(),
      initialAssignmentBytes,
      "runtime recovery must not mutate durable project intent",
    );
  const leadContextPrompt = managerRecoveryLeadContextPrompt(contextMarker);
  markStage(ctx, "lead-context-seed");
  await promptAgent(paneId, leadContextPrompt);
  await waitFor("lead-context-acknowledgment", async () => {
    const session = await exactIsolatedSession(ctx, first.session);
    return session &&
      verifiedLeadSession(session, first.session) &&
      assistantResultForSession(session, leadContextPrompt, contextMarker)
      ? session
      : null;
  });
  await waitFor("direct-handoff-settled", async () => {
    const session = await rootSnapshot();
    return session &&
      managerProjectMessageSettled(
        session.contents,
        branch,
        first.session,
        contextMarker,
      )
      ? session
      : null;
  });
  const reviewPrompt = managerRecoveryReviewPrompt(branch);
  await promptRoot(reviewPrompt);
  await waitFor("review-message", async () => {
    const session = await rootSnapshot();
    if (!session) return null;
    return sessionEntries(session.contents).some(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message.toolName === "message_staff" &&
        !entry.message.isError,
    )
      ? session
      : null;
  });
  await waitFor("review-response-completed", async () => {
    const session = await rootSnapshot();
    return session &&
      assistantResponseCompletedForSession(session, reviewPrompt)
      ? session
      : null;
  });
  const closePrompt = managerRecoveryStopPrompt(first.session);
  markStage(ctx, "graceful-close");
  await promptRoot(closePrompt);
  await waitFor(
    "graceful-close",
    async () => {
      const session = await rootSnapshot();
      if (!session) return null;
      const closes = staffActionResults(session.contents, "stop_lead", "stop");
      if (closes.length !== 1) return null;
      const close = closes[0];
      if (
        close.branch !== branch ||
        !assistantResultForSession(
          session,
          closePrompt,
          "PI_HERDSMAN_MANAGER_RECOVERY_PAUSED",
        )
      )
        return null;
      const pids = await candidatePids(paneId).catch(() => []);
      if (pids.length !== 0) return null;
      for (const agent of await agents())
        if ((await agentSessionId(ctx, agent)) === first.session) return null;
      return close;
    },
    30_000,
  );
  markStage(ctx, "graceful-close-validation");
  await assertUnchangedAssignment();
  assert.ok(
    await paneExists(paneId),
    "stop_lead removed the preserved assignment pane",
  );
  const pausedWorktrees = await matchingWorktrees();
  assert.equal(pausedWorktrees.length, 1);
  assert.equal(
    pausedWorktrees[0].path ?? pausedWorktrees[0].worktree_path,
    worktreePath,
  );

  const resumePrompt = managerRecoveryResumeOnlyPrompt(branch);
  ctx.managerRecovery.resumePrompt = resumePrompt;
  markStage(ctx, "graceful-resume");
  await promptRoot(resumePrompt);
  const resumed = await waitFor("graceful-resume", async () => {
    const session = await rootSnapshot();
    if (!session) return null;
    const results = staffActionResults(
      session.contents,
      "resume_project",
      "resume",
      resumePrompt,
    );
    if (
      results.length !== 1 ||
      !assistantResultForSession(
        session,
        resumePrompt,
        "PI_HERDSMAN_MANAGER_RECOVERY_RESUMED",
      )
    )
      return null;
    return results[0];
  });
  markStage(ctx, "graceful-resume-validation");
  assert.equal(resumed.session, first.session);
  assert.equal(resumed.branch, first.branch);
  assert.equal(resumed.workspace_id, workspaceId);
  await assertUnchangedAssignment();
  const resumedWorktrees = await matchingWorktrees();
  assert.equal(resumedWorktrees.length, 1);
  assert.equal(
    resumedWorktrees[0].path ?? resumedWorktrees[0].worktree_path,
    worktreePath,
  );
  const resumedPane = (await nestedCommand(ctx, ["pane", "list"])).panes.find(
    (item) => item.pane_id === paneId,
  );
  assert.ok(resumedPane);
  assert.equal(resumedPane.workspace_id, workspaceId);
  assert.equal(resumedPane.tab_id, ctx.managerRecovery.tabId);
  assert.equal(resolve(resumedPane.cwd), resolve(worktreePath));
  const resumedAgents = [];
  for (const agent of await agents())
    if ((await agentSessionId(ctx, agent)) === first.session)
      resumedAgents.push(agent);
  assert.equal(
    resumedAgents.length,
    1,
    "resume must produce exactly one live Lead for the assignment session",
  );
  const resumedAgent = resumedAgents[0];
  assert.equal(resumedAgent.pane_id, paneId);
  assert.equal(resumedAgent.workspace_id, workspaceId);
  const resumedProcesses = await waitFor(
    "graceful-resume-process",
    async () => {
      const processes = candidateProcess(
        await paneInfo(paneId),
        ctx.candidateExtension,
        ctx.herdrStateExtension,
      );
      return processes.length === 1 && processes[0].pid !== initialPid
        ? processes
        : null;
    },
    30_000,
  );
  const resumedPid = resumedProcesses[0].pid;
  ctx.managerRecovery.resumedPid = resumedPid;
  const previousLease = await managerLease();
  markStage(ctx, "manager-turnover-leave");
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager leave");
  await waitFor(
    "manager-left",
    async () => {
      try {
        await lstat(managerPath);
        return false;
      } catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
      }
    },
    15_000,
  );
  await assertUnchangedAssignment();
  assert.equal((await candidatePids(paneId)).includes(resumedPid), true);
  let retainedLead = false;
  for (const agent of await agents())
    if (
      agent.pane_id === paneId &&
      agent.workspace_id === workspaceId &&
      (await agentSessionId(ctx, agent)) === first.session
    )
      retainedLead = true;
  assert.ok(retainedLead, "exact Lead must survive Manager departure");
  markStage(ctx, "manager-turnover-reenter");
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager");
  await waitFor(
    "manager-reentered",
    async () => {
      try {
        const lease = await managerLease();
        return lease !== previousLease ? lease : null;
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    15_000,
  );
  await assertUnchangedAssignment();
  assert.equal((await candidatePids(paneId)).includes(resumedPid), true);

  const beforeKillAgents = [];
  for (const agent of await agents())
    if ((await agentSessionId(ctx, agent)) === first.session)
      beforeKillAgents.push(agent);
  assert.equal(
    beforeKillAgents.length,
    1,
    "expected one exact Lead before kill",
  );
  const beforeKillAgent = beforeKillAgents[0];
  assert.equal(beforeKillAgent.pane_id, paneId);
  assert.equal(beforeKillAgent.workspace_id, workspaceId);
  const beforeKillInfo = await paneInfo(paneId);
  const proven = candidateProcess(
    beforeKillInfo,
    ctx.candidateExtension,
    ctx.herdrStateExtension,
  );
  assert.equal(proven.length, 1);
  assert.equal(proven[0].pid, resumedPid);
  assert.ok(
    leadReadyCompleted(
      (beforeKillAgent.agent_session?.kind === "id"
        ? await exactIsolatedSession(ctx, first.session)
        : await isolatedSessionDetails(ctx, beforeKillAgent)
      )?.contents ?? "",
      "MANAGER_RECOVERY_READY",
    ),
    "Lead READY turn was not completed immediately before kill",
  );
  process.kill(resumedPid, "SIGKILL");
  markStage(ctx, "executor-loss-verification");
  await waitFor(
    "executor-loss",
    async () => {
      const currentPids = await candidatePids(paneId).catch(() => []);
      let stillLive = false;
      for (const agent of await agents())
        if (
          agent.pane_id === paneId &&
          (await agentSessionId(ctx, agent)) === first.session &&
          ["working", "idle"].includes(agent.agent_status)
        ) {
          stillLive = true;
          break;
        }
      return !currentPids.includes(resumedPid) && !stillLive;
    },
    30_000,
  );
  assert.ok(
    await paneExists(paneId),
    "child pane did not survive executor loss",
  );
  const retainedWorktrees = await matchingWorktrees();
  assert.equal(retainedWorktrees.length, 1);
  assert.equal(
    retainedWorktrees[0].path ?? retainedWorktrees[0].worktree_path,
    worktreePath,
  );

  markStage(ctx, "missing-worktree");
  await nestedCommand(ctx, ["workspace", "close", workspaceId]);
  await run("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: ctx.primaryCheckoutPath,
  });
  assert.equal((await matchingWorktrees()).length, 0);
  await assertUnchangedAssignment();

  const recoveryPrompt = managerRecoveryResumePrompt(branch);
  markStage(ctx, "assignment-recovery");
  await promptRoot(recoveryPrompt);
  markStage(ctx, "recovered-identity-validation");
  const recovery = await waitFor("recovery", async () => {
    const session = await rootSnapshot();
    const results =
      session &&
      staffActionResults(
        session.contents,
        "resume_project",
        "resume",
        recoveryPrompt,
      );
    return results?.length === 1 &&
      assistantResultForSession(
        session,
        recoveryPrompt,
        "PI_HERDSMAN_MANAGER_RECOVERY_RECOVERED",
      )
      ? { session, results }
      : null;
  });
  const recovered = recovery.results[0];
  assert.equal(recovered.session, first.session);
  assert.equal(recovered.branch, first.branch);
  assert.ok(recovered.workspace_id);
  assert.equal(recovery.results.length, 1);
  const afterWorktrees = await matchingWorktrees();
  assert.equal(afterWorktrees.length, 1);
  assert.equal(
    afterWorktrees[0].path ?? afterWorktrees[0].worktree_path,
    worktreePath,
  );
  let recoveredAgent;
  for (const agent of await agents())
    if ((await agentSessionId(ctx, agent)) === first.session) {
      recoveredAgent = agent;
      break;
    }
  assert.ok(recoveredAgent);
  assert.equal(await agentSessionId(ctx, recoveredAgent), first.session);
  assert.equal(recoveredAgent.workspace_id, recovered.workspace_id);
  const recoveredPaneId = recoveredAgent.pane_id;
  const recoveredPane = (await nestedCommand(ctx, ["pane", "list"])).panes.find(
    (item) => item.pane_id === recoveredPaneId,
  );
  assert.ok(recoveredPane);
  assert.equal(recoveredPane.workspace_id, recovered.workspace_id);
  assert.equal(resolve(recoveredPane.cwd), resolve(worktreePath));
  const recoveredProcesses = await waitFor("new-pid", async () => {
    const processes = candidateProcess(
      await paneInfo(recoveredPaneId),
      ctx.candidateExtension,
      ctx.herdrStateExtension,
    );
    return processes.length === 1 && processes[0].pid !== resumedPid
      ? processes
      : null;
  });
  const recoveredPid = recoveredProcesses[0].pid;
  assert.notEqual(recoveredPid, initialPid);
  assert.notEqual(recoveredPid, resumedPid);
  ctx.managerRecovery.recoveredPid = recoveredPid;
  await assertUnchangedAssignment();

  markStage(ctx, "manager-away-before-project-message");
  const currentLease = await managerLease();
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager leave");
  await waitFor(
    "manager-left-before-project-message",
    async () => {
      try {
        await lstat(managerPath);
        return false;
      } catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
      }
    },
    15_000,
  );
  await promptAgent(recoveredPaneId, managerRecoveryPostRecoveryPrompt());
  const messagesDirectory = join(
    dirname(assignmentPath),
    `${hash(branch)}.messages`,
  );
  const retainedRecord = await waitFor("project-message-retained", async () => {
    try {
      const names = await readdir(messagesDirectory);
      const records = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          records.push(
            JSON.parse(await readFile(join(messagesDirectory, name), "utf8")),
          );
        } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
            throw error;
        }
      }
      return retainedProjectMessageRecord(
        records,
        branch,
        first.session,
        contextMarker,
      );
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });
  assert.ok(retainedRecord);
  assert.equal(retainedRecord.text, contextMarker);
  markStage(ctx, "replacement-manager-reentry");
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager");
  await waitFor(
    "replacement-manager-reentered",
    async () => {
      try {
        const lease = await managerLease();
        return lease !== currentLease ? lease : null;
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    15_000,
  );
  markStage(ctx, "project-message-delivery");
  const delivered = await waitFor("project-message-delivery", async () => {
    const session = await rootSnapshot();
    if (!session) return null;
    const records = projectMessageEntries(
      session.contents,
      branch,
      first.session,
    );
    return records.some((entry) => entry.details?.id === retainedRecord.id)
      ? session
      : null;
  });
  const deliveredRecords = projectMessageEntries(
    delivered.contents,
    branch,
    first.session,
  ).filter((entry) => entry.details?.id === retainedRecord.id);
  assert.equal(deliveredRecords.length, 1);
  assert.equal(
    deliveredRecords[0].content,
    `Project ${branch} from lead ${first.session}:\n\n${contextMarker}`,
  );
  markStage(ctx, "project-retirement");
  ctx.owned.managerWorktreeRetirementRequested = true;
  await nestedCommand(ctx, [
    "worktree",
    "remove",
    "--workspace",
    recovered.workspace_id,
  ]);
  await waitFor(
    "assignment-removed",
    async () => {
      try {
        await lstat(assignmentPath);
        return false;
      } catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
      }
    },
    15_000,
  );
  await assert.rejects(lstat(assignmentPath), { code: "ENOENT" });
  await assert.rejects(lstat(messagesDirectory), { code: "ENOENT" });
  assert.equal((await matchingWorktrees()).length, 0);
  await run(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: ctx.primaryCheckoutPath },
  );
  ctx.managerRecovery.retired = branch;
  markStage(ctx, "manager-leave-command-submission");
  await submitPaneCommand(ctx, ctx.rootPaneId, "/manager leave");
  markStage(ctx, "manager-leave-output-wait");
  await nestedCommand(ctx, [
    "pane",
    "wait-output",
    ctx.rootPaneId,
    "--match",
    "Manager mode left.",
    "--timeout",
    "15000",
  ]);
  markStage(ctx, "post-leave-validation");
}

async function runChiefTreeSmoke(ctx) {
  const deadline = Date.now() + 90_000;
  const startupTurn = (session) => {
    const entries = sessionEntries(session.contents);
    const prompt = entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "user" &&
        messageText(entry.message.content) === ctx.initialPrompt,
    );
    const response =
      prompt &&
      assistantResultForSession(
        session,
        ctx.initialPrompt,
        "PI_HERDSMAN_CHIEF_TREE_STARTUP",
      );
    return prompt && response ? { prompt, response } : null;
  };

  // Establish the exact pre-Chief assistant branch before changing roles.
  await waitForEvidence(
    ctx,
    "chief-tree-startup",
    async () => {
      const session = await rootSessionSnapshot(ctx);
      const turn = session && startupTurn(session);
      return {
        done: !!turn,
        value: turn,
        progress: {
          rootSessionBytes: session ? Buffer.byteLength(session.contents) : 0,
          startupFound: !!turn,
        },
        evidence: session ? summarizeSession(session.contents) : null,
      };
    },
    { timeoutMs: 90_000, stallMs: MODEL_STALL_MS },
  );

  const readSnapshotContents = async () => {
    const details = await lstat(ctx.chiefTreeResultFile);
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size > MAX_CHIEF_TREE_RESULT_BYTES
    )
      throw new Error(
        "chief-tree-probe: result path is not a bounded regular file",
      );
    return readFile(ctx.chiefTreeResultFile, "utf8");
  };
  const readSnapshots = async () =>
    parseToolSnapshots(await readSnapshotContents());
  const awaitSnapshot = async (label) =>
    waitForEvidence(
      ctx,
      `chief-tree-${label}-snapshot`,
      async () => {
        let snapshots;
        try {
          snapshots = await readSnapshots();
        } catch (error) {
          if (error.code === "ENOENT")
            return { done: false, observationError: error.message };
          throw error;
        }
        return {
          done: snapshots.has(label),
          value: snapshots,
          progress: { labels: [...snapshots.keys()].sort() },
          evidence: { labels: [...snapshots.keys()].sort() },
        };
      },
      { timeoutMs: 15_000, stallMs: CONTROL_STALL_MS, pollMs: 200 },
    );
  await submitPaneCommand(ctx, ctx.rootPaneId, "/smoke-tools lead");
  await awaitSnapshot("lead");
  await submitPaneCommand(ctx, ctx.rootPaneId, "/chief");
  await nestedCommand(ctx, [
    "pane",
    "wait-output",
    ctx.rootPaneId,
    "--match",
    "Chief mode active.",
    "--timeout",
    "15000",
  ]);

  await submitPaneCommand(ctx, ctx.rootPaneId, "/smoke-tools chief");
  await awaitSnapshot("chief");
  const chiefPrompt = "Reply exactly with PI_HERDSMAN_CHIEF_TREE_POST_CHIEF.";
  await submitPaneCommand(ctx, ctx.rootPaneId, chiefPrompt);
  const branchPlan = await waitForEvidence(
    ctx,
    "chief-tree-branch",
    async () => {
      const session = await rootSessionSnapshot(ctx);
      if (session) {
        const plan = chiefTreeBranchPlan(
          session.contents,
          ctx.initialPrompt,
          "PI_HERDSMAN_CHIEF_TREE_STARTUP",
          chiefPrompt,
          "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
        );
        if (!plan.error)
          return {
            done: true,
            value: plan,
            progress: {
              rootSessionBytes: Buffer.byteLength(session.contents),
              branchFound: true,
            },
          };
        return {
          done: false,
          progress: {
            rootSessionBytes: Buffer.byteLength(session.contents),
            branchFound: false,
          },
          evidence: plan.error,
        };
      }
      return {
        done: false,
        progress: { rootSessionBytes: 0, branchFound: false },
      };
    },
    { timeoutMs: Math.max(1, deadline - Date.now()), stallMs: MODEL_STALL_MS },
  );
  ctx.chiefTreeBranchPlan = branchPlan;

  await submitPaneCommand(ctx, ctx.rootPaneId, "/tree");
  const initialTree = await waitForEvidence(
    ctx,
    "chief-tree-selection",
    async () => {
      let treeText;
      try {
        treeText = await nestedPaneText(ctx, ctx.rootPaneId, "visible");
      } catch (error) {
        return {
          done: false,
          observationError: error?.message ?? String(error),
        };
      }
      const footer = chiefTreeFooter(treeText);
      const selected =
        !!footer &&
        chiefTreeSelectedRow(treeText, "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF");
      return {
        done: selected,
        value: { footer, treeText },
        progress: {
          selected: footer?.selected ?? null,
          total: footer?.total ?? null,
        },
        evidence: { footer },
      };
    },
    { timeoutMs: 5_000, stallMs: CONTROL_STALL_MS, pollMs: 150 },
  );
  const { footer } = initialTree;
  let treeText = initialTree.treeText;

  let startupSelected = false;
  for (let attempt = 0; attempt < footer.total; attempt++) {
    treeText = await nestedPaneText(ctx, ctx.rootPaneId, "visible");
    const currentFooter = chiefTreeFooter(treeText);
    if (!currentFooter || currentFooter.total !== footer.total)
      throw new Error(
        "chief-tree-selection: tree footer disappeared or changed while locating the startup branch",
      );
    if (chiefTreeSelectedRow(treeText, "PI_HERDSMAN_CHIEF_TREE_STARTUP")) {
      startupSelected = true;
      break;
    }
    const before = currentFooter.selected;
    await nestedPaneInput(ctx, ["pane", "send-keys", ctx.rootPaneId, "up"]);
    await waitForEvidence(
      ctx,
      "chief-tree-selection-move",
      async () => {
        let text;
        try {
          text = await nestedPaneText(ctx, ctx.rootPaneId, "visible");
        } catch (error) {
          return {
            done: false,
            observationError: error?.message ?? String(error),
          };
        }
        const next = chiefTreeFooter(text);
        if (!next || next.total !== footer.total)
          throw new Error(
            "chief-tree-selection: tree footer disappeared or changed",
          );
        return {
          done: next.selected !== before,
          progress: { selected: next.selected },
          evidence: { selected: next.selected, total: next.total },
        };
      },
      { timeoutMs: 5_000, stallMs: CONTROL_STALL_MS, pollMs: 100 },
    );
  }
  if (!startupSelected)
    throw new Error(
      `chief-tree-selection: startup answer was not selected after checking ${footer.total} tree rows; Enter was not sent`,
    );
  const treeEventsBefore = countChiefTreeEvents(await readSnapshotContents());
  await nestedPaneInput(ctx, ["pane", "send-keys", ctx.rootPaneId, "enter"]);
  const transition = await waitForEvidence(
    ctx,
    "chief-tree-branch-load",
    async () => {
      let text;
      try {
        text = await nestedPaneText(ctx, ctx.rootPaneId, "visible");
      } catch (error) {
        return {
          done: false,
          observationError: error?.message ?? String(error),
        };
      }
      let snapshots;
      let treeEvents = 0;
      try {
        snapshots = await readSnapshots();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (snapshots)
        treeEvents = countChiefTreeEvents(
          await readSnapshotContents(),
          treeEventsBefore,
        );
      return {
        ...chiefTreeBranchTransition(
          text,
          snapshots,
          treeEventsBefore,
          treeEvents,
        ),
        evidence: {
          footer: chiefTreeFooter(text),
          treeEvents,
          treeEventsBefore,
        },
      };
    },
    { timeoutMs: 15_000, stallMs: CONTROL_STALL_MS },
  );
  if (transition.state === "summary-dialog") {
    await nestedPaneInput(ctx, ["pane", "send-keys", ctx.rootPaneId, "enter"]);
    await waitForEvidence(
      ctx,
      "chief-tree-branch-tree-snapshot",
      async () => {
        let snapshots;
        try {
          snapshots = await readSnapshots();
        } catch (error) {
          if (error.code === "ENOENT")
            return { done: false, observationError: error.message };
          throw error;
        }
        const treeEvents = countChiefTreeEvents(
          await readSnapshotContents(),
          treeEventsBefore,
        );
        const done =
          snapshots.has("tree") && treeEvents > transition.treeEvents;
        return {
          done,
          progress: { treeEvents, treeSnapshot: done },
          evidence: {
            treeEvents,
            treeEventsBeforeDialog: transition.treeEvents,
          },
        };
      },
      { timeoutMs: 15_000, stallMs: CONTROL_STALL_MS },
    );
  }

  const snapshots = await awaitSnapshot("tree");
  ctx.chiefTreeProbeDiagnostics = Object.fromEntries(snapshots);
  const lead = snapshots.get("lead");
  const chief = snapshots.get("chief");
  const tree = snapshots.get("tree");
  assert.ok(
    lead && chief && tree,
    "chief-tree-probe: three snapshots required",
  );
  assert.notDeepEqual(
    chief,
    lead,
    "Chief tools must differ from ordinary Lead tools",
  );
  assert.deepEqual(
    tree,
    lead,
    "selecting the pre-Chief branch must restore ordinary Lead tools",
  );

  const followup = "Reply exactly PI_HERDSMAN_CHIEF_TREE_FOLLOWUP.";
  await submitPaneCommand(ctx, ctx.rootPaneId, followup);
  await waitForEvidence(
    ctx,
    "chief-tree-follow-up",
    async () => {
      const session = await rootSessionSnapshot(ctx);
      const done = !!(
        session &&
        assistantResultForSession(
          session,
          followup,
          "PI_HERDSMAN_CHIEF_TREE_FOLLOWUP",
        )
      );
      return {
        done,
        value: true,
        progress: {
          rootSessionBytes: session ? Buffer.byteLength(session.contents) : 0,
          resultFound: done,
        },
        evidence: session ? summarizeSession(session.contents) : null,
      };
    },
    { timeoutMs: Math.max(1, deadline - Date.now()), stallMs: MODEL_STALL_MS },
  );
}

async function waitForDescendantsToExit(ctx) {
  await waitForEvidence(
    ctx,
    "descendant-cleanup",
    async () => {
      const inspection = await inspectCandidateProcesses(ctx);
      return {
        done: inspection.verified.length === 0,
        progress: {
          live: inspection.verified
            .map(({ paneId, pid }) => `${paneId}:${pid}`)
            .sort(),
        },
        evidence: inspection.records.slice(-20),
      };
    },
    { timeoutMs: 60_000, stallMs: CONTROL_STALL_MS, pollMs: 500 },
  );
}

async function collectDiagnostics(ctx, owned, failure) {
  const diagnostics = {};
  const env = nestedControlEnv(process.env, ctx.paths, ctx.sessionName);
  diagnostics.chiefTreeProbe = ctx.chiefTreeProbeDiagnostics ?? null;
  diagnostics.managerRecovery = ctx.managerRecovery ?? null;
  diagnostics.continuationSession = ctx.continuationSessionEvidence ?? null;
  diagnostics.failure = failure?.smoke ?? null;
  diagnostics.stage = ctx.stage ?? null;
  diagnostics.preflight = ctx.preflight ?? null;
  const [agents, panes, rootSession, rootPane, hostPane] =
    await Promise.allSettled([
      tryHerdr(["agent", "list"], { env, timeout: OBSERVATION_TIMEOUT_MS }),
      tryHerdr(["pane", "list"], { env, timeout: OBSERVATION_TIMEOUT_MS }),
      rootSessionSnapshot(ctx),
      ctx.rootPaneId
        ? run(
            "herdr",
            [
              "pane",
              "read",
              ctx.rootPaneId,
              "--source",
              "recent-unwrapped",
              "--lines",
              "120",
            ],
            { env, timeout: OBSERVATION_TIMEOUT_MS },
          )
        : null,
      owned.hostPaneId
        ? run(
            "herdr",
            [
              "pane",
              "read",
              owned.hostPaneId,
              "--source",
              "recent-unwrapped",
              "--lines",
              "80",
            ],
            { timeout: OBSERVATION_TIMEOUT_MS },
          )
        : null,
    ]);
  diagnostics.agents =
    agents.status === "fulfilled"
      ? agents.value
      : { ok: false, error: agents.reason?.message };
  diagnostics.panes =
    panes.status === "fulfilled"
      ? panes.value
      : { ok: false, error: panes.reason?.message };
  diagnostics.observedCoreProcesses = ctx.coreProcessEvidence ?? [];
  diagnostics.coreProcessDiagnostics = ctx.coreProcessDiagnostics ?? [];
  const paneIds = diagnostics.panes.ok
    ? listedPanes(diagnostics.panes.value)
    : [];
  diagnostics.processes = await bestEffortProcessDiagnostics(
    paneIds,
    ctx.rootPaneId,
    async (paneId) => {
      const result = await tryHerdr(
        ["pane", "process-info", "--pane", paneId],
        { env, timeout: OBSERVATION_TIMEOUT_MS },
      );
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    ctx.candidateExtension,
    ctx.herdrStateExtension,
  );
  try {
    const session =
      rootSession.status === "fulfilled" ? rootSession.value : null;
    diagnostics.rootSession = session
      ? {
          path: session.path,
          status: session.status,
          ...summarizeSession(session.contents),
          gracefulResumeCalls: ctx.managerRecovery?.resumePrompt
            ? managerRecoveryResumeDiagnostics(
                session.contents,
                ctx.managerRecovery.resumePrompt,
              )
            : null,
        }
      : { error: "no saved root Pi session was available" };
  } catch (error) {
    diagnostics.rootSession = { error: error.message };
  }
  diagnostics.root =
    rootPane.status === "fulfilled"
      ? rootPane.value.stdout.slice(-20_000)
      : { error: rootPane.reason?.message ?? null };
  diagnostics.host =
    hostPane.status === "fulfilled"
      ? hostPane.value.stdout.slice(-12_000)
      : { error: hostPane.reason?.message ?? null };
  const knownDescendants = [
    ...new Set(
      [
        ...(ctx.coreProcessEvidence ?? []).map((item) => item.paneId),
        ctx.continuationFirstPaneId,
        ctx.continuationSecondPaneId,
        ctx.managerRecovery?.paneId,
      ].filter((id) => id && id !== ctx.rootPaneId && id !== owned.hostPaneId),
    ),
  ].slice(0, 4);
  const descendantReads = await Promise.allSettled(
    knownDescendants.map((paneId) =>
      run(
        "herdr",
        [
          "pane",
          "read",
          paneId,
          "--source",
          "recent-unwrapped",
          "--lines",
          "80",
        ],
        { env, timeout: OBSERVATION_TIMEOUT_MS },
      ),
    ),
  );
  diagnostics.descendants = descendantReads.map((entry, index) =>
    entry.status === "fulfilled"
      ? {
          paneId: knownDescendants[index],
          output: entry.value.stdout.slice(-12_000),
        }
      : { paneId: knownDescendants[index], error: entry.reason?.message },
  );
  try {
    const serialized = JSON.stringify(diagnostics);
    console.error(`diagnostics: ${serialized}`);
  } catch {
    console.error("diagnostics: collection failed");
  }
}

async function cleanup(paths, owned, ctx) {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  const remainingTimeout = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("smoke cleanup deadline exhausted");
    return Math.min(OBSERVATION_TIMEOUT_MS, remaining);
  };
  const cleanupRun = (file, args, options = {}) =>
    run(file, args, { ...options, timeout: remainingTimeout() });
  const cleanupHerdr = (args, options = {}) =>
    herdr(args, { ...options, timeout: remainingTimeout() });
  const failures = [];
  try {
    await unlink(paths.authLink);
  } catch (error) {
    if (error.code !== "ENOENT")
      failures.push(`auth symlink: ${error.message}`);
  }
  if (owned.managerBranch) {
    let managerWorktreeSafe = true;
    try {
      assert.equal(owned.managerBranch, ctx.managerRecovery.branch);
      const listed = await cleanupHerdr(
        ["worktree", "list", "--workspace", ctx.rootWorkspaceId],
        {
          env: nestedControlEnv(process.env, paths, owned.sessionName),
        },
      );
      if (!Array.isArray(listed.worktrees))
        throw new Error("Herdr worktree topology is unavailable");
      const worktrees = listed.worktrees;
      const target = managerCleanupTarget(
        worktrees,
        owned.managerBranch,
        owned.managerWorktreePath,
        owned.managerWorktreeRetirementRequested === true,
      );
      if (target) {
        const env = nestedControlEnv(process.env, paths, owned.sessionName);
        await cleanupHerdr(
          ["worktree", "remove", "--workspace", target.open_workspace_id],
          {
            env,
          },
        );
      }
    } catch (error) {
      managerWorktreeSafe = false;
      failures.push(
        `manager worktree ${owned.managerWorkspaceId ?? owned.managerBranch}: ${error.message}`,
      );
    }
    if (managerWorktreeSafe) {
      try {
        assert.equal(owned.managerBranch, ctx.managerRecovery.branch);
        await deleteBranchIfPresent(
          owned.managerBranch,
          cleanupRun,
          ctx.primaryCheckoutPath ?? repoRoot,
        );
      } catch (error) {
        failures.push(
          `manager branch ${owned.managerBranch}: ${error.message}`,
        );
      }
    }
  }
  if (owned.sessionName) {
    const env = nestedControlEnv(process.env, paths, owned.sessionName);
    let deleted = false;
    try {
      await tryHerdr(["session", "stop", owned.sessionName, "--json"], {
        env,
        timeout: remainingTimeout(),
      });
      for (let i = 0; i < 3 && !deleted; i++) {
        const deletion = await tryHerdr(
          ["session", "delete", owned.sessionName, "--json"],
          { env, timeout: remainingTimeout() },
        );
        const sessions = await tryHerdr(["session", "list", "--json"], {
          env,
          timeout: remainingTimeout(),
        });
        if (!sessions.ok)
          throw new Error(
            `could not verify nested session deletion: ${sessions.error}`,
          );
        const rows = sessions.value?.sessions;
        if (!Array.isArray(rows))
          throw new Error("Herdr session list result is malformed");
        deleted = !rows.some((item) => item.name === owned.sessionName);
        if (!deletion.ok && !deleted)
          throw new Error(
            `session delete delivery is ambiguous; session still listed: ${deletion.error}`,
          );
        if (!deleted && i < 2) await sleep(Math.min(300, remainingTimeout()));
      }
    } catch (error) {
      failures.push(
        `nested session cleanup ${owned.sessionName}: ${error.message}`,
      );
    }
    if (
      !deleted &&
      !failures.some((item) =>
        item.startsWith(`nested session cleanup ${owned.sessionName}:`),
      )
    )
      failures.push(
        `nested session remains: ${owned.sessionName}; temp=${paths.root}`,
      );
    if (
      !deleted &&
      !failures.some((item) => item.startsWith("nested session remains"))
    )
      failures.push(
        `nested session remains: ${owned.sessionName}; temp=${paths.root}`,
      );
  }
  if (owned.hostTabId) {
    try {
      await cleanupHerdr(["tab", "close", owned.hostTabId]);
    } catch (error) {
      failures.push(`host tab ${owned.hostTabId}: ${error.message}`);
    }
  }
  const sessionMayRemain =
    owned.sessionName &&
    failures.some(
      (item) => item.includes(owned.sessionName) && item.includes("cleanup"),
    );
  if (
    !sessionMayRemain &&
    !failures.some((failure) => failure.startsWith("nested session remains"))
  ) {
    try {
      await rm(paths.root, { recursive: true, force: true });
    } catch (error) {
      failures.push(`temporary state: ${error.message}`);
    }
  }
  return failures.length ? failures.join("\n") : null;
}

function cleanupEvidence(owned) {
  return `session=${owned.sessionName ?? "not-created"} host-tab=${owned.hostTabId ?? "not-created"} host-pane=${owned.hostPaneId ?? "not-created"}`;
}

// --- memory scenario ---------------------------------------------------------
//
// The smoke runner cannot drive a multi-turn ordinary Lead session, so this
// scenario drives Pi in RPC mode with the Lead environment instead. It runs two
// arms once each: `memory` (the project is listed in `memoryProjects`, so the
// Lead uses project memory) and `native` (the project is not listed, so Pi
// compacts natively). Both arms share the script, the fixture, the Lead model,
// the delegated agents and the native compaction threshold, so the only
// difference is project memory. See docs/development/smoke-testing.md.

const MEMORY_LEAD_MODEL = "opencode-go/deepseek-v4.1-flash";
const MEMORY_COMPACTOR_MODEL = "opencode-go/deepseek-v4.1-flash";
const MEMORY_AGENT_MODEL = "opencode-go/deepseek-v4.1-flash";
/** deepseek-v4.1-flash via opencode-go, USD per million tokens. */
const MEMORY_MODEL_PRICE = {
  input: 0.15,
  output: 0.6,
  cacheRead: 0.003,
  cacheWrite: 0,
};
/** Pi compacts when contextTokens > contextWindow - reserveTokens. */
const MEMORY_CONTEXT_WINDOW = 1_000_000;
const MEMORY_NATIVE_THRESHOLD = 60_000;
const MEMORY_RESERVE_TOKENS = MEMORY_CONTEXT_WINDOW - MEMORY_NATIVE_THRESHOLD;
const MEMORY_TURN_TIMEOUT_MS = 240_000;
const MEMORY_RESULT_TIMEOUT_MS = 180_000;
/**
 * How long a shutdown may take before the harness SIGTERMs it. It has to clear
 * the extension's 20 s shutdown drain for in-flight compaction calls plus the
 * kill grace below, or the drain is killed mid-flight and its node is lost.
 */
const MEMORY_SHUTDOWN_TIMEOUT_MS = 90_000;
const MEMORY_KILL_GRACE_MS = 10_000;
/** The native arm must compact at least this often for the A/B to mean anything. */
const MEMORY_MIN_NATIVE_COMPACTIONS = 2;
const MEMORY_TARGET_TURN_RATIO = 0.95;
/**
 * The cache scenario measures the Anthropic-only view mark, so its Lead model
 * must speak the Anthropic Messages API. The opencode-go proxy fronts it; the
 * mark itself never reaches a non-Anthropic provider.
 */
const MEMORY_CACHE_DEFAULT_MODEL = "opencode-go/claude-haiku-5-5";
/** Eight no-tool prose turns, long enough to read a stable cache prefix. */
const MEMORY_CACHE_TURNS = [
  "Reply with at least 900 characters of plain prose describing the number seven, and use no tools.",
  "Reply with at least 900 characters of plain prose describing the number nine, and use no tools.",
  "Reply with at least 900 characters of plain prose describing the number twelve, and use no tools.",
  "Reply with at least 900 characters of plain prose describing the number fifteen, and use no tools.",
  "Reply with at least 900 characters of plain prose describing the number twenty-one, and use no tools.",
  "Reply with at least 900 characters of plain prose describing the number eighteen, and use no tools.",
  "Reply with at least 900 characters of plain prose describing the number twenty-four, and use no tools.",
  "Reply with at least 900 characters of plain prose describing the number thirty, and use no tools.",
];

/** Exact early values the recall probes score against. */
const MEMORY_FACTS = {
  planPath: "plans/billing/PLAN.md",
  errorLine:
    "ERR_BILLING_PORT: expected 5432 but got 5433 in src/config.mjs:12",
};

async function copyFile(from, to) {
  await writeFile(to, await readFile(from));
}

/** The store directory key, matching `projectMemoryKey` in extension/memory.ts. */
function memoryStoreKey(project) {
  return createHash("sha256")
    .update(project, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Copies one store part into a `--keep` directory. A part the run never wrote
 * (for example an empty project has no `tree/`) is not an error.
 */
export async function copyIfExists(from, to) {
  try {
    await cp(from, to, { recursive: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
    throw error;
  }
}

/** One JSONL log as records; a torn last line is not a record. */
function memoryJsonl(text) {
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
async function memoryLogRecords(root, part) {
  let names;
  try {
    names = (await readdir(join(root, part))).filter((name) =>
      name.endsWith(".jsonl"),
    );
  } catch {
    return [];
  }
  names.sort();
  const records = [];
  for (const name of names)
    records.push(
      ...memoryJsonl(await readFile(join(root, part, name), "utf8")),
    );
  return records;
}

/** The identifier classes whose retention a node build is scored on. */
const MEMORY_RETENTION_CLASSES = new Set(["uuid", "ref", "path", "number"]);

/**
 * Read-only stats over one project store, read after its session shut down.
 * The store is append-only JSONL, so this reads the logs instead of opening the
 * store, which would take its lock and rewrite its view. `undefined` means the
 * arm never had a store, as in the native arm.
 */
export async function memoryStoreStats(root) {
  try {
    await stat(root);
  } catch {
    return undefined;
  }
  const messages = await memoryLogRecords(root, "main");
  const built = await memoryLogRecords(root, "tree");
  let view = { chat: [], compaction: [] };
  try {
    const parsed = JSON.parse(await readFile(join(root, "view.json"), "utf8"));
    if (Array.isArray(parsed?.chat)) view = parsed;
  } catch {
    // An empty store writes no view; an unreadable one has no view to read.
  }

  const key = (line) => `${line[0]}:${line[1]}`;
  const bodies = new Map(messages.map((message) => [message.i, message]));
  const nodeText = new Map(
    built.map((node) => [key([node.l, node.i]), node.text]),
  );
  const derived = new Map();
  // The same rule the store applies: a short leaf, or a merge of two short
  // children, has its text without a compaction call.
  const textOf = (line) => {
    const id = key(line);
    if (nodeText.has(id)) return nodeText.get(id);
    if (derived.has(id)) return derived.get(id);
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
    derived.set(id, text);
    return text;
  };

  const chat = view.chat;
  const sizes = built.map((node) =>
    typeof node.size === "number"
      ? node.size
      : Buffer.byteLength(node.text ?? "", "utf8"),
  );
  const sum = sizes.reduce((total, size) => total + size, 0);
  const share = (kept, total) => (total ? kept / total : 0);
  const messagesByKind = {};
  for (const message of messages)
    messagesByKind[message.kind] = (messagesByKind[message.kind] ?? 0) + 1;

  // For every node a call built: the share of its input identifiers that
  // survived verbatim. A leaf's input is its message text; a merge's is its two
  // child lines.
  const identifiers = { total: 0, kept: 0, byKind: {} };
  for (const node of built) {
    const output = typeof node.text === "string" ? node.text : "";
    const input =
      node.l === 0
        ? (bodies.get(node.i)?.text ?? "")
        : [
            textOf([node.l - 1, node.i * 2]),
            textOf([node.l - 1, node.i * 2 + 1]),
          ]
            .filter((text) => text !== undefined)
            .join("\n");
    for (const identifier of extractIdentifiers(input)) {
      if (!MEMORY_RETENTION_CLASSES.has(identifier.kind)) continue;
      // A UUID is stored lowercase, so its comparison ignores case.
      const verbatim =
        identifier.kind === "uuid"
          ? output.toLowerCase().includes(identifier.value)
          : output.includes(identifier.value);
      identifiers.total += 1;
      const counter = (identifiers.byKind[identifier.kind] ??= {
        total: 0,
        kept: 0,
      });
      counter.total += 1;
      if (verbatim) {
        identifiers.kept += 1;
        counter.kept += 1;
      }
    }
  }
  for (const counter of Object.values(identifiers.byKind))
    counter.share = share(counter.kept, counter.total);
  identifiers.share = share(identifiers.kept, identifiers.total);

  return {
    messages: messages.length,
    messagesByKind,
    // The view's own nodes: a call builds exactly one node, so every other view
    // node was assembled without one; `unbuilt` still waits for a call.
    viewNodes: chat.length,
    viewCalls: chat.filter((line) => nodeText.has(key(line))).length,
    nodesWithoutCall: chat.filter(
      (line) => !nodeText.has(key(line)) && textOf(line) !== undefined,
    ).length,
    unbuilt: chat.filter((line) => textOf(line) === undefined).length,
    calls: built.length,
    viewBytes: Buffer.byteLength(
      renderView(chat, (line) => textOf(line)),
      "utf8",
    ),
    overLeafShare: share(
      sizes.filter((size) => size > LEAF_BYTES).length,
      sizes.length,
    ),
    meanNodeBytes: sizes.length ? sum / sizes.length : 0,
    lossyShare: share(
      built.filter((node) => (node.text ?? "").endsWith(LOSSY_MARKER)).length,
      built.length,
    ),
    identifiers,
  };
}

/**
 * Copies the evidence a `--keep` directory preserves before the temp root is
 * deleted: the project memory store, the Lead session JSONL and the report.
 */
async function keepMemoryArtifacts(keep, scenario, runs, reportPath) {
  const target = resolve(keep);
  await mkdir(target, { recursive: true });
  for (const run of runs) {
    const directory = join(target, `${scenario}-${run.arm}`);
    await mkdir(directory, { recursive: true });
    for (const part of ["tree", "main", "view.json"])
      await copyIfExists(join(run.storeRoot, part), join(directory, part));
    await copyFile(run.sessionFile, join(directory, "session.jsonl"));
    await copyFile(reportPath, join(directory, "report.json"));
  }
  return target;
}

/** Live memory child processes and temp roots, for signal cleanup. */
const memoryLiveChildren = new Set();
const memoryLiveRoots = new Set();
let memorySignalHandlersInstalled = false;

/**
 * Kills live memory children and removes their temp roots, so an interrupt
 * does not orphan a metered `pi` child or leak fixture/session/store files.
 */
export async function cleanupMemoryResources({ children, roots }) {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // A child that already exited is fine.
    }
  }
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  return roots.length;
}

/** Registers the one-time SIGINT/SIGTERM guards for a memory run. */
export function installMemorySignalHandlers() {
  if (memorySignalHandlersInstalled) return;
  memorySignalHandlersInstalled = true;
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ])
    process.once(signal, () => {
      const children = [...memoryLiveChildren];
      const roots = [...memoryLiveRoots];
      memoryLiveChildren.clear();
      memoryLiveRoots.clear();
      void cleanupMemoryResources({ children, roots }).finally(() =>
        process.exit(code),
      );
    });
}

/** The environment an ordinary Lead runs with: no managed-agent identity. */
function memoryLeadEnv(agentDir, disableMark = false) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, HERDR_ENV: "1" };
  for (const key of Object.keys(env))
    if (key.startsWith("PI_HERDSMAN_")) delete env[key];
  if (disableMark) env.PI_HERDSMAN_MEMORY_DISABLE_VIEW_MARK = "1";
  return env;
}

/** Extra extension paths the smoke loads, e.g. pi-black for Anthropic. */
function memorySmokeExtensions() {
  const raw = process.env.PI_HERDSMAN_SMOKE_EXTENSIONS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/** One generated fixture module, large enough that a full read is real context. */
function memoryLargeModule(index) {
  const lines = [`// module ${index}: generated fixture`];
  for (let i = 0; i < 350; i++)
    lines.push(
      `export function module${index}_${i}(value) { return value + ${i}; } // padding ${"x".repeat(48)}`,
    );
  return `${lines.join("\n")}\n`;
}

/** The suite prints a long output and one exact error line, then fails. */
function memorySuiteSource() {
  return [
    "const lines = [];",
    "for (let i = 0; i < 120; i++) lines.push(`[suite] case ${i} ok (${(i * 7) % 97} ms)`);",
    'console.log(lines.join("\\n"));',
    `console.log(${JSON.stringify(MEMORY_FACTS.errorLine)});`,
    "process.exit(1);",
    "",
  ].join("\n");
}

/**
 * The horizon scenario's cheap bulk turn: about 7 KB (2k tokens) of
 * deterministic log lines per call, so a turn costs context without a large
 * file read. Facts the probes ask about never live in this file.
 */
function horizonEmitSource() {
  return [
    'const topic = process.argv[2] ?? "topic";',
    "const lines = Number(process.argv[3] ?? 40);",
    "for (let i = 0; i < lines; i++) {",
    '  const token = ((i * 2654435761) % 4294967296).toString(16).padStart(8, "0");',
    '  console.log(`[${topic}] step ${i} ok token ${token} elapsed ${(i * 13) % 997} ms ${".".repeat(120)}`);',
    "}",
    "",
  ].join("\n");
}

/**
 * The fixture an arm shares. The horizon scenario needs the native threshold
 * low enough to compact many times, and no file that holds a fact its probes
 * ask about: every early fact is planted in the user's own turns.
 */
async function writeMemoryFixture(project, { horizon = false } = {}) {
  await mkdir(join(project, ".pi", "agents"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "scripts"), { recursive: true });
  await mkdir(join(project, "plans", "billing"), { recursive: true });
  await writeFile(
    join(project, ".pi", "settings.json"),
    `${JSON.stringify(
      {
        compaction: {
          reserveTokens: horizon
            ? MEMORY_HORIZON_RESERVE_TOKENS
            : MEMORY_RESERVE_TOKENS,
        },
      },
      null,
      2,
    )}\n`,
  );
  // Only the cheap model is pinned: the thinking level stays the bundled
  // default, so a quality run measures what ships.
  await writeFile(
    join(project, ".pi", "agents", "compactor.md"),
    `---\nname: compactor\nbodyMode: append\nmodel: ${MEMORY_COMPACTOR_MODEL}\n---\n`,
  );
  await writeFile(
    join(project, "README.md"),
    "# Billing fixture\n\nA small project used by the memory smoke scenario.\n",
  );
  if (horizon) {
    await writeFile(
      join(project, "src", "format.mjs"),
      "export function formatAmount(value) {\n  return value.toFixed(2);\n}\n\nexport function formatInvoice(invoice) {\n  return `${invoice.id}: ${formatAmount(invoice.total)}`;\n}\n",
    );
    await writeFile(join(project, "scripts", "emit.mjs"), horizonEmitSource());
    return;
  }
  await writeFile(
    join(project, "src", "config.mjs"),
    `export const port = 5433;\nexport const database = "postgres";\nexport const apiPrefix = "/v2";\n`,
  );
  for (let i = 1; i <= 8; i++)
    await writeFile(
      join(project, "src", `module-${i}.mjs`),
      memoryLargeModule(i),
    );
  await writeFile(
    join(project, "scripts", "run-suite.mjs"),
    memorySuiteSource(),
  );
}

/**
 * The fixed script. `settles` is how many `agent_settled` runs the step waits
 * for: a delegation step waits for its own turn and the result-triggered turn.
 */
function memorySteps() {
  return [
    {
      prompt:
        "Standing decision for this project: use Postgres 16 on port 5433; never MySQL; the API prefix is /v2. Acknowledge in one short sentence and do not use tools.",
    },
    {
      prompt:
        "Write a short plan to the file plans/billing/PLAN.md that records the standing decision and the billing endpoints. Use the write tool, then reply done.",
    },
    {
      prompt:
        "Delegate one scout (definition scout, label scout-1) to inspect this project and report its file layout and the database configuration. Do not delegate further. When its result arrives, reply with its agent session id and its result ref.",
      settles: 2,
    },
    {
      prompt:
        "Run `node scripts/run-suite.mjs` and reply with the exact error line it printed.",
    },
    {
      prompt:
        "Read src/module-1.mjs and src/module-2.mjs in full. Reply with the first line of each file.",
    },
    {
      prompt:
        "Read src/module-3.mjs and src/module-4.mjs in full. Reply with the first line of each file.",
    },
    {
      prompt:
        "Run `node scripts/run-suite.mjs` again and reply with the last line it printed.",
    },
    {
      prompt:
        "Read src/module-5.mjs and src/module-6.mjs in full. Reply with one exported symbol per file.",
    },
    {
      prompt:
        "Read src/module-7.mjs and src/module-8.mjs in full. Reply with one exported symbol per file.",
    },
    {
      prompt:
        "Append a section titled '## Modules' to plans/billing/PLAN.md listing src/module-1.mjs through src/module-8.mjs. Use the edit tool.",
    },
    {
      prompt:
        "Delegate a scout (definition scout, label scout-2) to inspect src/config.mjs and scripts/run-suite.mjs and report how the port is configured. Do not delegate further. Reply done when delegated.",
      settles: 2,
    },
    {
      prompt:
        "Read src/module-1.mjs and src/module-3.mjs in full. Reply with one exported symbol per file.",
    },
    {
      prompt:
        "Run `node scripts/run-suite.mjs` and reply with one line from its output that names the port.",
    },
    {
      prompt:
        "Read src/module-2.mjs and src/module-4.mjs in full. Reply with one exported symbol per file.",
    },
    {
      prompt:
        "Delegate a reviewer (definition reviewer, label reviewer-1) to review plans/billing/PLAN.md for correctness and missing cases. Do not delegate further; review directly. Reply done when delegated.",
      settles: 2,
    },
    {
      prompt:
        "Read src/module-5.mjs and src/module-7.mjs in full. Reply with one exported symbol per file.",
    },
    {
      prompt:
        "Edit src/config.mjs to add the comment line '// billing port' above the port export. Use the edit tool.",
    },
    {
      prompt:
        "Run `node scripts/run-suite.mjs` after the change and reply with the exit code you observed.",
    },
    {
      prompt:
        "Read src/module-6.mjs and src/module-8.mjs in full. Reply with one exported symbol per file.",
    },
    {
      prompt:
        "Summarize in 5 bullets what this project is, from src/ and scripts/.",
    },
    {
      prompt:
        "Read src/module-1.mjs and src/module-2.mjs in full. Reply with one exported symbol per file.",
    },
    {
      prompt:
        "Append a '## Validation' section to plans/billing/PLAN.md naming scripts/run-suite.mjs. Use the edit tool.",
    },
    {
      prompt:
        "Read src/module-3.mjs and src/module-4.mjs in full. Reply with one exported symbol per file.",
    },
    {
      prompt:
        "Read src/module-5.mjs and src/module-6.mjs in full. Reply with one exported symbol per file.",
    },
    {
      prompt:
        "Read src/module-7.mjs and src/module-8.mjs in full. Reply with one exported symbol per file.",
    },
    {
      prompt: "Reply with a short status: what is running, and what is left.",
    },
  ];
}

/**
 * The last turns: one cold probe per turn, asked with no hints. `contains` is a
 * list of exact strings, or a function of the run facts, that the reply must
 * contain. `action` probes score the `continue_agent` call instead.
 */
function memoryProbes() {
  return [
    {
      name: "planPath",
      prompt:
        "Cold recall, no hints: what is the exact path of the plan file I asked you to write earlier? Reply with just the path.",
      contains: [MEMORY_FACTS.planPath],
    },
    {
      name: "scoutSession",
      prompt:
        "Cold recall, no hints: what was the agent session id of the first scout you delegated? Reply with just the id.",
      contains: (facts) => [facts.firstScoutSession],
    },
    {
      name: "scoutRef",
      prompt:
        "Cold recall, no hints: what result ref did the first scout's result carry? Reply with just the ref.",
      contains: (facts) => [facts.firstScoutRef],
    },
    {
      name: "decision",
      prompt:
        "Cold recall, no hints: which database port did we decide to use, and which database did we forbid? Reply in one line.",
      contains: ["5433", "MySQL"],
    },
    {
      name: "errorLine",
      prompt:
        "Cold recall, no hints: what exact error line did the test suite print when you ran it early on? Reply with just that line.",
      contains: [MEMORY_FACTS.errorLine],
    },
    {
      name: "continueFirstScout",
      prompt:
        "Continue the first scout with: reply with the single word DONE and nothing else. Use continue_agent with its exact session id.",
      action: true,
    },
  ];
}

/** The full ordered script: fixed turns, then the probes. */
function memoryScript() {
  return [
    ...memorySteps().map((step) => ({ ...step, probe: false })),
    ...memoryProbes().map((step) => ({ ...step, probe: true })),
  ];
}

/**
 * Drives one Pi RPC session through the script and returns its stderr. One JSON
 * record per line, split on LF only; U+2028 can appear inside JSON.
 *
 * `continueSession` resumes the newest session in `sessionDir` (`--continue`),
 * which is how the `native-continue` arm keeps one growing session across
 * segments. `onTurn` runs after every step, so a run can stop between turns;
 * throwing from it still shuts the child down.
 */
async function memoryRpcRun({
  project,
  agentDir,
  sessionDir,
  extension,
  extensions,
  model,
  steps,
  disableMark = false,
  continueSession = false,
  onTurn,
}) {
  const child = spawn(
    "pi",
    [
      "--mode",
      "rpc",
      "--model",
      model,
      "--thinking",
      "low",
      "--approve",
      "--no-extensions",
      "--extension",
      extension,
      ...extensions.flatMap((path) => ["--extension", path]),
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-mcp",
      "--session-dir",
      sessionDir,
      ...(continueSession ? ["--continue"] : []),
    ],
    {
      cwd: project,
      env: memoryLeadEnv(agentDir, disableMark),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  memoryLiveChildren.add(child);
  child.once("exit", () => memoryLiveChildren.delete(child));
  let stdoutBuffer = "";
  let stderr = "";
  let nextId = 0;
  let settleCount = 0;
  const pending = new Map();
  const settleWaiters = [];
  const onRecord = (record) => {
    if (record.type === "response" && typeof record.id === "string") {
      const resolve = pending.get(record.id);
      if (resolve) {
        pending.delete(record.id);
        resolve(record);
      }
    } else if (record.type === "agent_settled") {
      settleCount += 1;
      for (let i = settleWaiters.length - 1; i >= 0; i--)
        if (settleWaiters[i].count <= settleCount)
          settleWaiters.splice(i, 1)[0].settle();
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let at;
    while ((at = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, at).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(at + 1);
      if (line === "") continue;
      try {
        onRecord(JSON.parse(line));
      } catch {
        // A torn or non-protocol line is not a record.
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const send = (command) =>
    new Promise((resolve, reject) => {
      const id = `memory-${nextId++}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc ${command.type} timed out`));
      }, MEMORY_TURN_TIMEOUT_MS);
      pending.set(id, (record) => {
        clearTimeout(timer);
        resolve(record);
      });
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  const waitForSettles = (count, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (settleCount >= count) return resolve();
      const waiter = {
        count,
        settle: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        timer: undefined,
      };
      waiter.timer = setTimeout(() => {
        const index = settleWaiters.indexOf(waiter);
        if (index >= 0) settleWaiters.splice(index, 1);
        reject(
          new Error(
            `agent_settled ${count} timed out after ${settleCount} settles`,
          ),
        );
      }, timeoutMs);
      settleWaiters.push(waiter);
    });
  const errors = [];
  let killed;
  try {
    for (const [index, step] of steps.entries()) {
      // Best-effort attribution: a tardy settle from a timed-out step can resolve the next wait.
      const expected = settleCount + (step.settles ?? 1);
      const response = await send({ type: "prompt", message: step.prompt });
      if (!response.success)
        throw new Error(`prompt rejected: ${response.error ?? "unknown"}`);
      try {
        await waitForSettles(
          expected,
          step.settles === 2
            ? MEMORY_RESULT_TIMEOUT_MS
            : MEMORY_TURN_TIMEOUT_MS,
        );
      } catch (error) {
        errors.push(`step ${index}: ${error.message}`);
      }
      if (onTurn) await onTurn();
    }
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      let killTimer;
      const termTimer = setTimeout(() => {
        child.kill("SIGTERM");
        killed = "SIGTERM";
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          killed = "SIGKILL";
          resolve();
        }, MEMORY_KILL_GRACE_MS);
      }, MEMORY_SHUTDOWN_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve();
      });
    });
  }
  return { stderr, errors, killed };
}

/** The newest session JSONL under a session directory. */
async function newestSessionFile(dir) {
  const found = [];
  const walk = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith(".jsonl")) found.push(child);
    }
  };
  await walk(dir);
  const measured = await Promise.all(
    found.map(async (path) => ({ path, mtime: (await stat(path)).mtimeMs })),
  );
  measured.sort((a, b) => b.mtime - a.mtime);
  return measured[0]?.path;
}

function ratioOf(usage) {
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const total = input + cacheRead + cacheWrite;
  return {
    input,
    cacheRead,
    cacheWrite,
    total,
    ratio: total ? cacheRead / total : 0,
  };
}

/** Sums one usage list into the cache-read ratio the phase defines. */
function summedRatio(usages) {
  let cacheRead = 0;
  let total = 0;
  for (const usage of usages) {
    const value = ratioOf(usage);
    cacheRead += value.cacheRead;
    total += value.total;
  }
  return { cacheRead, total, ratio: total ? cacheRead / total : 0 };
}

function summedTokens(usages) {
  const sum = {
    input: 0,
    output: 0,
    reasoning: null,
    cacheRead: 0,
    cacheWrite: 0,
  };
  for (const usage of usages) {
    sum.input += usage.input ?? 0;
    sum.output += usage.output ?? 0;
    // A provider that reports no reasoning leaves the total null, never zero.
    if (typeof usage.reasoning === "number")
      sum.reasoning = (sum.reasoning ?? 0) + usage.reasoning;
    sum.cacheRead += usage.cacheRead ?? 0;
    sum.cacheWrite += usage.cacheWrite ?? 0;
  }
  return sum;
}

/** The Lead's share of one arm: tokens, USD and uncached input per call. */
function leadCost(usages, measured) {
  const tokens = summedTokens(usages);
  const measuredTokens = summedTokens(measured);
  return {
    calls: usages.length,
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cost: usages.reduce((total, usage) => total + (usage.cost?.total ?? 0), 0),
    // The measured set is what `turnRatio` reads, so the two sit together.
    // `input` already excludes the cache-served tokens an Anthropic-style
    // provider reports in `cacheRead`; a provider that folds them in would
    // silently inflate this headline.
    uncachedInputPerCall: measured.length
      ? measuredTokens.input / measured.length
      : 0,
  };
}

/**
 * The compactor's share of one arm. An entry an older run wrote without
 * `kind`, `reasoning` or `attempts` still counts, as a leaf with no reported
 * reasoning and one attempt per `retries`.
 */
function compactorCost(usages) {
  const tokens = summedTokens(usages);
  const reasoningCalls = usages.filter(
    (usage) => typeof usage.reasoning === "number",
  ).length;
  const attempts = usages.reduce(
    (total, usage) => total + (usage.attempts ?? (usage.retries ?? 0) + 1),
    0,
  );
  return {
    calls: usages.length,
    leafCalls: usages.filter((usage) => usage.kind !== "merge").length,
    mergeCalls: usages.filter((usage) => usage.kind === "merge").length,
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    reasoningCalls,
    cacheRead: tokens.cacheRead,
    cost: estimatedCost(tokens),
    meanOutputPerCall: usages.length ? tokens.output / usages.length : 0,
    meanReasoningPerCall: reasoningCalls
      ? tokens.reasoning / reasoningCalls
      : null,
    reasoningShareOfOutput:
      tokens.reasoning !== null && tokens.output
        ? tokens.reasoning / tokens.output
        : null,
    meanAttemptsPerCall: usages.length ? attempts / usages.length : 0,
  };
}

/**
 * The gate's correction of the old zoom-before-act rate: a call that a
 * verbatim `read` or the user's own words let through counted as no zoom. The
 * denominator is every gated call whose identifier the view held; `source` is
 * absent in sessions an older run wrote.
 */
export function memoryGateReport(entries) {
  const inView = entries.filter((entry) =>
    (entry.identifiers ?? []).some((identifier) => identifier.inView),
  );
  const blocked = inView.filter((entry) => entry.blocked === true);
  const zoomSatisfied = inView.filter(
    (entry) =>
      entry.blocked !== true &&
      (entry.identifiers ?? []).some(
        (identifier) => identifier.inView && identifier.source === "zoom",
      ),
  );
  let blockRecovered = true;
  entries.forEach((entry, index) => {
    if (entry.blocked !== true) return;
    const after = entries.slice(index + 1, index + 3);
    if (!after.some((later) => later.tool === entry.tool && !later.blocked))
      blockRecovered = false;
  });
  return {
    entries: entries.length,
    blocks: entries.filter((entry) => entry.blocked === true).length,
    inView: inView.length,
    blockedShare: inView.length ? blocked.length / inView.length : 0,
    // The in-view calls that ran because their value was already verbatim in
    // the turn; `zoomSatisfied` is a subset of these, not a separate group.
    passedInView: inView.length - blocked.length,
    zoomSatisfied: zoomSatisfied.length,
    zoomShare: inView.length ? zoomSatisfied.length / inView.length : 0,
    blockRecovered,
  };
}

function estimatedCost(tokens) {
  // `reasoning` is a subset of `output`, so it is priced inside it and never
  // added again: a provider that reports them apart would undercount here.
  const price = MEMORY_MODEL_PRICE;
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite) /
    1e6
  );
}

function assistantUsages(entries) {
  return entries
    .filter(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        entry.message.usage,
    )
    .map((entry) => entry.message.usage);
}

function compactorUsages(entries) {
  return entries
    .filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "pi-herdsman-memory-usage",
    )
    .map((entry) => entry.data);
}

function gateEntries(entries) {
  return entries.filter(
    (entry) =>
      entry.type === "custom" && entry.customType === "pi-herdsman-memory-gate",
  );
}

/** The facts the recall probes need, read back from the session. */
function memoryRunFacts(entries) {
  const results = entries.filter(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-herdsman-agent-result",
  );
  const contentOf = (pattern) => {
    const entry = results.find((result) =>
      pattern.test(String(result.content ?? "")),
    );
    return entry ? String(entry.content) : "";
  };
  const scout = contentOf(/agent=scout/);
  return {
    firstScoutSession: /session=([0-9a-f-]{36})/i.exec(scout)?.[1],
    firstScoutRef: /Result ref:\s*(result:[a-z][a-z0-9_-]*#\d+)/.exec(
      scout,
    )?.[1],
    reviewerRef: /Result ref:\s*(result:[a-z][a-z0-9_-]*#\d+)/.exec(
      contentOf(/agent=reviewer/),
    )?.[1],
  };
}

/** The assistant text after the last user message whose text is `prompt`. */
function replyAfter(entries, prompt) {
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.type === "message" &&
      entry.message?.role === "user" &&
      messageText(entry.message.content) === prompt
    ) {
      start = i;
      break;
    }
  }
  if (start < 0) return "";
  const parts = [];
  for (let i = start + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message?.role === "user") break;
    if (entry.type !== "message" || entry.message?.role !== "assistant")
      continue;
    for (const block of entry.message.content ?? [])
      if (block?.type === "text" && block.text) parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * The action probe: the last `continue_agent` attempt that used the exact first
 * scout session scores 1 when the gate did not block it.
 */
function continueProbeScore(entries, session) {
  if (!session) return { score: 0, note: "no first scout session recorded" };
  const calls = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant")
      continue;
    for (const block of entry.message.content ?? [])
      if (
        block?.type === "toolCall" &&
        block.name === "continue_agent" &&
        block.arguments?.session === session
      )
        calls.push(block.id);
  }
  if (calls.length === 0)
    return { score: 0, note: "continue_agent never used the exact session" };
  const last = calls[calls.length - 1];
  const result = entries.find(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolCallId === last,
  );
  if (!result) return { score: 0, note: "no result for the last attempt" };
  const text = messageText(result.message.content);
  const blocked = result.message.isError === true && /blocked:/.test(text);
  return {
    score: blocked ? 0 : 1,
    note: blocked ? "last attempt blocked by the gate" : "last attempt ran",
  };
}

/**
 * A probe's `contains`/`mustNot` list, with its function form resolved against
 * the run's facts. Empty entries never score, so an unknown fact reads as "no
 * expected value recorded" instead of a free point.
 */
function probeList(value, facts) {
  const list = typeof value === "function" ? value(facts) : value;
  return (list ?? []).filter(
    (entry) => entry !== undefined && entry !== null && entry !== "",
  );
}

/** A `mustNot` entry is a substring, or a pattern when it is a RegExp. */
function patternHit(text, pattern) {
  return typeof pattern === "string"
    ? text.includes(pattern)
    : pattern.test(text);
}

/** Scores one probe's text: all `must` present, no `mustNot` hit. */
function scoreProbeText(probe, facts, text) {
  const must = probeList(probe.contains, facts).filter(
    (entry) => typeof entry === "string",
  );
  const missing = must.filter((entry) => !text.includes(entry));
  const forbidden = probeList(probe.mustNot, facts).filter((entry) =>
    patternHit(text, entry),
  );
  return {
    score:
      must.length > 0 && missing.length === 0 && forbidden.length === 0 ? 1 : 0,
    note:
      must.length === 0
        ? "no expected value recorded"
        : missing.length > 0
          ? `missing ${missing.length}`
          : forbidden.length > 0
            ? `forbidden ${forbidden.join(", ")}`
            : "matched",
  };
}

/**
 * Scores every probe for one arm. A probe with `file` is graded on that file's
 * text instead of the reply, and an `action` probe on the exact tool call, so
 * the three probe kinds a phase 15 run uses share one scorer.
 */
export function scoreMemoryProbes(entries, facts, probes, files) {
  const scored = probes.map((probe) => {
    const row = {
      name: probe.name,
      category: probe.category,
      factSegment: probe.factSegment,
      askSegment: probe.askSegment,
      age: probe.age,
    };
    if (probe.action) {
      const value = continueProbeScore(entries, facts.firstScoutSession);
      return { ...row, score: value.score, note: value.note };
    }
    const text = probe.file
      ? files?.(probe.file)
      : replyAfter(entries, probe.prompt);
    if (text === undefined)
      return { ...row, score: 0, note: `${probe.file} was not written` };
    return { ...row, ...scoreProbeText(probe, facts, text) };
  });
  return {
    probes: scored,
    total: scored.reduce((sum, probe) => sum + probe.score, 0),
    maxTotal: scored.length,
  };
}

/**
 * The phase 15 score table of one arm-run: the total, the per-category scores,
 * the facts from an earlier segment asked after a restart, and the score by
 * age in turns.
 */
export function horizonScoreTable(probes) {
  const counts = (key, rows) => {
    const table = new Map();
    for (const row of rows) {
      if (row[key] === undefined) continue;
      const entry = table.get(row[key]) ?? { score: 0, max: 0 };
      entry.score += row.score;
      entry.max += 1;
      table.set(row[key], entry);
    }
    return table;
  };
  const rows = (key, table) =>
    [...table.entries()]
      .sort((left, right) =>
        typeof left[0] === "number"
          ? left[0] - right[0]
          : String(left[0]).localeCompare(String(right[0])),
      )
      .map(([name, value]) => ({ [key]: name, ...value }));
  const categories = rows("category", counts("category", probes));
  const ages = rows("age", counts("age", probes));
  const crossSession = probes.filter(
    (probe) =>
      probe.factSegment !== undefined &&
      probe.askSegment !== undefined &&
      probe.factSegment < probe.askSegment,
  );
  return {
    total: probes.reduce((sum, probe) => sum + probe.score, 0),
    maxTotal: probes.length,
    byCategory: categories,
    crossSession: {
      score: crossSession.reduce((sum, probe) => sum + probe.score, 0),
      max: crossSession.length,
    },
    byAge: ages,
  };
}

/**
 * The phase 15 win rule: `memory` is better only when it beats
 * `native-continue` by at least `margin` probes in every paired run and in the
 * mean; `native-continue` is better under the symmetric rule. Anything else is
 * no claim. `native-fresh` measures the floor and never enters the rule.
 */
export function horizonWinRule(totals, margin = MEMORY_HORIZON_WIN_MARGIN) {
  const arm = (name) => totals[name] ?? [];
  const mean = (values) =>
    values.length
      ? values.reduce((total, value) => total + value, 0) / values.length
      : undefined;
  const runIds = [
    ...new Set(
      [...arm("memory"), ...arm("native-continue")].map((row) => row.run),
    ),
  ].sort((left, right) => left - right);
  const pairs = runIds
    .map((run) => ({
      run,
      memory: arm("memory").find((row) => row.run === run)?.total,
      native: arm("native-continue").find((row) => row.run === run)?.total,
    }))
    .filter((pair) => pair.memory !== undefined && pair.native !== undefined);
  const memoryMean = mean(arm("memory").map((row) => row.total));
  const nativeMean = mean(arm("native-continue").map((row) => row.total));
  const freshMean = mean(arm("native-fresh").map((row) => row.total));
  const deltas = pairs.map((pair) => pair.memory - pair.native);
  const meanDelta =
    memoryMean === undefined || nativeMean === undefined
      ? undefined
      : memoryMean - nativeMean;
  const clear = (sign) =>
    deltas.length > 0 &&
    deltas.every((delta) => (sign > 0 ? delta >= margin : delta <= -margin)) &&
    meanDelta !== undefined &&
    (sign > 0 ? meanDelta >= margin : meanDelta <= -margin);
  const claim = clear(1)
    ? "memory better"
    : clear(-1)
      ? "native better"
      : "no claim";
  return {
    claim,
    margin,
    pairs,
    deltas,
    meanDelta,
    memoryMean,
    nativeMean,
    freshMean,
    detail: [
      pairs.length === 0
        ? "no run has both arms"
        : `memory minus native-continue: ${pairs.map((pair) => `run ${pair.run} ${pair.memory - pair.native >= 0 ? "+" : ""}${pair.memory - pair.native}`).join(", ")}; mean ${meanDelta >= 0 ? "+" : ""}${meanDelta.toFixed(2)}`,
      `a claim needs at least ${margin} probes in every paired run and in the mean`,
      freshMean === undefined
        ? "native-fresh did not run"
        : `native-fresh (informational, never in the rule) mean ${freshMean.toFixed(2)}`,
    ].join("; "),
  };
}

/**
 * The across-runs view of one run set: each arm's per-run totals and its mean
 * score per category, plus the win rule over the probe totals.
 */
export function horizonScoreSummary(results) {
  const arms = {};
  for (const [name, runs] of Object.entries(results)) {
    const categories = new Map();
    for (const run of runs)
      for (const row of run.scores?.byCategory ?? []) {
        const entry = categories.get(row.category) ?? {
          category: row.category,
          score: 0,
          max: 0,
        };
        entry.score += row.score;
        entry.max += row.max;
        categories.set(row.category, entry);
      }
    const totals = runs.map((run) => run.probeTotal ?? 0);
    arms[name] = {
      runs: runs.map((run) => ({
        run: run.run,
        valid: run.valid,
        total: run.probeTotal ?? 0,
        maxTotal: run.probeMax ?? 0,
      })),
      mean: {
        total: totals.length
          ? totals.reduce((total, value) => total + value, 0) / totals.length
          : 0,
        maxTotal: runs[0]?.probeMax ?? 0,
        byCategory: [...categories.values()].map((entry) => ({
          category: entry.category,
          mean: runs.length ? entry.score / runs.length : 0,
          // The mean and the per-run maximum, so the two are comparable.
          max: runs.length ? entry.max / runs.length : 0,
        })),
      },
    };
  }
  return {
    arms,
    win: horizonWinRule(
      Object.fromEntries(
        Object.entries(arms).map(([name, value]) => [name, value.runs]),
      ),
    ),
  };
}

/** One arm's step, token, compaction, cache and gate numbers. */
export async function memoryRunReport(run, scored) {
  const usages = assistantUsages(run.entries);
  const compactor = compactorUsages(run.entries);
  const gate = gateEntries(run.entries).map((entry) => entry.data ?? {});
  // The run's first call writes the cache; every later call is measured.
  const measuredTurns = usages.slice(1);
  const lead = leadCost(usages, measuredTurns);
  const compactorCosts = compactorCost(compactor);
  const nativeCompactions = run.entries.filter(
    (entry) => entry.type === "compaction",
  ).length;
  return {
    turns: run.turns,
    llmCalls: usages.length,
    nativeCompactions,
    lead,
    compactor: compactorCosts,
    cost: lead.cost + compactorCosts.cost,
    turnRatio: summedRatio(measuredTurns),
    compactionRatio: summedRatio(compactor),
    wallMs: run.wallMs,
    probes: scored.probes,
    probeTotal: scored.total,
    probeMax: scored.maxTotal,
    gate: memoryGateReport(gate),
    store: await memoryStoreStats(run.storeRoot),
  };
}

/**
 * One cache arm's turn, compaction and disk numbers. Store bytes per project
 * message against session bytes per message is the disk-write evidence for the
 * memory-source decision.
 */
async function memoryCacheRunReport(run) {
  const usages = assistantUsages(run.entries);
  const compactor = compactorUsages(run.entries);
  let storeBytes = 0;
  let memoryMessages = 0;
  const walk = async (path, kind) => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child, entry.name);
        continue;
      }
      const content = await readFile(child, "utf8");
      storeBytes += Buffer.byteLength(content, "utf8");
      if (kind !== "main") continue;
      for (const line of content.split("\n")) {
        if (line === "") continue;
        try {
          JSON.parse(line);
        } catch {
          continue;
        }
        memoryMessages += 1;
      }
    }
  };
  await walk(run.storeRoot, "");

  const sessionBytes = Buffer.byteLength(
    await readFile(run.sessionFile, "utf8"),
    "utf8",
  );
  const sessionMessages = run.entries.filter(
    (entry) => entry.type === "message",
  ).length;
  // The run's first call writes the cache; every later call is measured.
  const measuredTurns = usages.slice(1);

  return {
    turns: measuredTurns.length,
    turnRatio: summedRatio(measuredTurns),
    compactionRatio: summedRatio(compactor),
    compactions: compactor.length,
    memoryMessages,
    sessionMessages,
    storeBytes,
    sessionBytes,
    storeBytesPerMessage: memoryMessages ? storeBytes / memoryMessages : 0,
    sessionBytesPerMessage: sessionMessages
      ? sessionBytes / sessionMessages
      : 0,
  };
}

/** The Markdown table pasted into the PR description. */
export function memoryMarkdown(memory, native) {
  const arms = [
    ["memory", memory],
    ["native", native],
  ];
  const ratio = (value) => (value === null ? "not reported" : value.toFixed(3));
  const rows = [
    "| arm | probe total | turns | LLM calls | input | output | cache read | cost USD | native compactions | turn cache | compaction cache | wall s |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const [name, arm] of arms) {
    const tokens = {
      input: arm.lead.input + arm.compactor.input,
      output: arm.lead.output + arm.compactor.output,
      cacheRead: arm.lead.cacheRead + arm.compactor.cacheRead,
    };
    rows.push(
      `| ${name} | ${arm.probeTotal}/${arm.probeMax} | ${arm.turns} | ${arm.llmCalls} | ${tokens.input} | ${tokens.output} | ${tokens.cacheRead} | ${arm.cost.toFixed(4)} | ${arm.nativeCompactions} | ${arm.turnRatio.ratio.toFixed(3)} | ${arm.compactionRatio.ratio.toFixed(3)} | ${(arm.wallMs / 1000).toFixed(0)} |`,
    );
  }
  rows.push("");
  rows.push(
    "| arm | Lead input | Lead output | Lead cache read | Lead USD | compactor input | compactor output | compactor reasoning | compactor cache read | compactor USD | arm USD |",
  );
  rows.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const [name, arm] of arms) {
    const c = arm.compactor;
    rows.push(
      `| ${name} | ${arm.lead.input} | ${arm.lead.output} | ${arm.lead.cacheRead} | ${arm.lead.cost.toFixed(4)} | ${c.input} | ${c.output} | ${c.reasoning ?? "not reported"} | ${c.cacheRead} | ${c.cost.toFixed(4)} | ${arm.cost.toFixed(4)} |`,
    );
  }
  rows.push("");
  rows.push(
    "| arm | compactor calls | leaf | merge | mean output/call | mean reasoning/call | reasoning share of output | mean attempts/call | Lead uncached input/call |",
  );
  rows.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [name, arm] of arms) {
    const c = arm.compactor;
    rows.push(
      `| ${name} | ${c.calls} | ${c.leafCalls} | ${c.mergeCalls} | ${c.meanOutputPerCall.toFixed(1)} | ${c.meanReasoningPerCall === null ? "not reported" : c.meanReasoningPerCall.toFixed(1)} | ${ratio(c.reasoningShareOfOutput)} | ${c.meanAttemptsPerCall.toFixed(2)} | ${arm.lead.uncachedInputPerCall.toFixed(0)} |`,
    );
  }
  rows.push("");
  rows.push(
    `memory arm gate: ${memory.gate.blocks} blocked of ${memory.gate.entries} gated calls; ${memory.gate.inView} in-view calls: blockedShare ${memory.gate.blockedShare.toFixed(3)}, passedInView ${memory.gate.passedInView}, zoomShare ${memory.gate.zoomShare.toFixed(3)} (${memory.gate.zoomSatisfied} by zoom), blockRecovered ${memory.gate.blockRecovered}`,
  );
  rows.push("");
  rows.push(memoryStoreLine(memory.store));
  rows.push("");
  rows.push("| arm | probe | score | note |");
  rows.push("| --- | --- | --- | --- |");
  for (const [name, arm] of arms)
    for (const probe of arm.probes)
      rows.push(`| ${name} | ${probe.name} | ${probe.score} | ${probe.note} |`);
  return rows.join("\n");
}

/** One line of store shape and identifier retention, or none without a store. */
function memoryStoreLine(store) {
  if (!store) return "memory arm store: none";
  const kinds = Object.entries(store.messagesByKind)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
  return [
    `memory arm store: ${store.messages} messages (${kinds}); ${store.viewNodes} view nodes: ${store.viewCalls} built by a call, ${store.nodesWithoutCall} call-free, ${store.unbuilt} unbuilt; ${store.calls} calls in all;`,
    `view ${store.viewBytes} bytes; over-leaf share ${store.overLeafShare.toFixed(3)}; mean node ${store.meanNodeBytes.toFixed(0)} bytes; lossy share ${store.lossyShare.toFixed(3)};`,
    `identifiers kept ${store.identifiers.share.toFixed(3)} (${store.identifiers.kept}/${store.identifiers.total})`,
  ].join(" ");
}

/** The typed-cost estimate printed before the run. */
function memoryEstimate() {
  const script = memoryScript();
  const delegations = script.filter(
    (step) => step.settles === 2 && !step.probe,
  ).length;
  return [
    "memory smoke estimate:",
    `  two arms, one run each (memory and native, order randomized)`,
    `  script: ${script.length} Lead turns; ${delegations} delegated agents`,
    `  Lead and agents: ${MEMORY_LEAD_MODEL}`,
    `  compactor: ${MEMORY_COMPACTOR_MODEL}`,
    `  native compaction threshold: ${MEMORY_NATIVE_THRESHOLD} tokens`,
    "  real provider calls; the run is long and costs real usage",
    "re-run with --yes to start",
  ].join("\n");
}

/** The Markdown table for the cache scenario. */
function memoryCacheMarkdown(report) {
  const rows = [
    "| arm | turns | turn cache | compaction cache | compactions | store bytes/msg | session bytes/msg |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const arm of [report.withMark, report.withoutMark]) {
    const name = arm === report.withMark ? "withMark" : "withoutMark";
    rows.push(
      `| ${name} | ${arm.turns} | ${arm.turnRatio.ratio.toFixed(3)} | ${arm.compactionRatio.ratio.toFixed(3)} | ${arm.compactions} | ${arm.storeBytesPerMessage.toFixed(0)} | ${arm.sessionBytesPerMessage.toFixed(0)} |`,
    );
  }
  rows.push("");
  rows.push(`with-mark turn cache target: ${MEMORY_TARGET_TURN_RATIO}`);
  return rows.join("\n");
}

/** The cost estimate printed for the cache scenario before `--yes`. */
function memoryCacheEstimate() {
  return [
    "memory-cache smoke estimate:",
    "  two arms, one run each (withMark and withoutMark, order randomized)",
    `  script: ${MEMORY_CACHE_TURNS.length} no-tool Lead turns`,
    `  Lead: ${MEMORY_CACHE_DEFAULT_MODEL}`,
    `  compactor: ${MEMORY_COMPACTOR_MODEL}`,
    "  real provider calls; the run costs real usage",
    "re-run with --yes to start",
  ].join("\n");
}

/**
 * Measures the Anthropic-only view mark: the same fixture runs twice, once with
 * the mark and once with `PI_HERDSMAN_MEMORY_DISABLE_VIEW_MARK=1`. The arms
 * share the script, fixtures and `memoryRpcRun` process handling with the
 * quality scenario; the only difference is the mark.
 */
async function runMemoryCacheScenario(args) {
  const model = args.model ?? MEMORY_CACHE_DEFAULT_MODEL;
  const extensions = memorySmokeExtensions();
  const steps = MEMORY_CACHE_TURNS.map((prompt) => ({ prompt }));
  if (!args.yes) return { estimate: memoryCacheEstimate() };

  const root = await mkdtemp(join(tmpdir(), "pi-herdsman-memory-cache-smoke-"));
  memoryLiveRoots.add(root);
  installMemorySignalHandlers();
  const extension = join(repoRoot, "extension", "index.ts");
  const realAgentDir = join(homedir(), ".pi", "agent");
  // The arms run in a random order, so a warmed shared prefix cannot favor one.
  const arms = Math.random() < 0.5 ? [false, true] : [true, false];
  const runs = [];
  try {
    for (const disableMark of arms) {
      const arm = disableMark ? "withoutMark" : "withMark";
      const project = join(root, `project-${arm}`);
      const agentDir = join(root, `agent-${arm}`);
      const sessionDir = join(root, `sessions-${arm}`);
      await writeMemoryFixture(project);
      await mkdir(join(agentDir, "pi-herdsman"), { recursive: true });
      const realProject = await realpath(project);
      await writeFile(
        join(agentDir, "pi-herdsman", "config.json"),
        `${JSON.stringify({ memoryProjects: [realProject] })}\n`,
      );
      await copyFile(
        join(realAgentDir, "auth.json"),
        join(agentDir, "auth.json"),
      );
      await copyFile(
        join(realAgentDir, "models.json"),
        join(agentDir, "models.json"),
      );
      await mkdir(sessionDir, { recursive: true });
      const run = await memoryRpcRun({
        project,
        agentDir,
        sessionDir,
        extension,
        extensions,
        model,
        steps,
        disableMark,
      });
      const sessionFile = await newestSessionFile(sessionDir);
      if (!sessionFile)
        throw new Error(
          `no session file in ${sessionDir}; stderr: ${run.stderr.slice(-2000)}`,
        );
      const entries = (await readFile(sessionFile, "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
      runs.push({
        arm,
        sessionFile,
        entries,
        storeRoot: join(
          agentDir,
          "pi-herdsman",
          "memory",
          memoryStoreKey(realProject),
        ),
        errors: run.errors,
        stderr: run.stderr,
      });
    }

    const withMarkRun = runs.find((run) => run.arm === "withMark");
    const withoutMarkRun = runs.find((run) => run.arm === "withoutMark");
    const withMark = await memoryCacheRunReport(withMarkRun);
    const withoutMark = await memoryCacheRunReport(withoutMarkRun);
    const armOrder = runs.map((run) => run.arm);
    const report = {
      scenario: "memory-cache",
      model,
      compactorModel: MEMORY_COMPACTOR_MODEL,
      extensions,
      armOrder,
      turns: MEMORY_CACHE_TURNS.length,
      withMarkRatio: withMark.turnRatio.ratio,
      withoutMarkRatio: withoutMark.turnRatio.ratio,
      passed: withMark.turnRatio.ratio >= MEMORY_TARGET_TURN_RATIO,
      notes: [
        "The opencode-go Haiku proxy's cache accounting is not direct Anthropic usage; the ratio is the proxy's report.",
        "Both arms enable project memory on an identical fixture; the without-mark arm sets PI_HERDSMAN_MEMORY_DISABLE_VIEW_MARK=1.",
        `The with-mark turn cache ratio must reach ${MEMORY_TARGET_TURN_RATIO}.`,
        "The compaction ratio is informational: both arms use the DeepSeek compactor, so its delta is uncontrolled cross-run noise.",
        "No gap between turns may exceed 4 minutes; a longer stall fails the turn.",
        `Arm order was randomized: ${armOrder.join(" then ")}.`,
      ],
      withMark,
      withoutMark,
      stepErrors: Object.fromEntries(runs.map((run) => [run.arm, run.errors])),
      stderr: Object.fromEntries(
        runs.map((run) => [run.arm, run.stderr.slice(-4000)]),
      ),
    };
    report.markdown = memoryCacheMarkdown(report);
    const reportPath = join(
      tmpdir(),
      "pi-herdsman-memory-cache-smoke-report.json",
    );
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const keepPath = args.keep
      ? await keepMemoryArtifacts(args.keep, "memory-cache", runs, reportPath)
      : undefined;
    return { report, reportPath, keepPath };
  } finally {
    memoryLiveRoots.delete(root);
    await rm(root, { recursive: true, force: true });
  }
}

async function runMemoryScenario(args) {
  const model = args.model ?? MEMORY_LEAD_MODEL;
  const extensions = memorySmokeExtensions();
  const script = memoryScript();
  const probes = script.filter((step) => step.probe);
  if (!args.yes) return { estimate: memoryEstimate() };

  const root = await mkdtemp(join(tmpdir(), "pi-herdsman-memory-smoke-"));
  memoryLiveRoots.add(root);
  installMemorySignalHandlers();
  const extension = join(repoRoot, "extension", "index.ts");
  const realAgentDir = join(homedir(), ".pi", "agent");
  const arms =
    Math.random() < 0.5 ? ["memory", "native"] : ["native", "memory"];
  const runs = [];
  try {
    for (const arm of arms) {
      const project = join(root, `project-${arm}`);
      const agentDir = join(root, `agent-${arm}`);
      const sessionDir = join(root, `sessions-${arm}`);
      await writeMemoryFixture(project);
      await mkdir(join(agentDir, "pi-herdsman"), { recursive: true });
      await mkdir(join(agentDir, "agents"), { recursive: true });
      await mkdir(join(agentDir, "extensions"), { recursive: true });
      const realProject = await realpath(project);
      await writeFile(
        join(agentDir, "pi-herdsman", "config.json"),
        `${JSON.stringify({
          memoryProjects: arm === "memory" ? [realProject] : [],
        })}\n`,
      );
      await writeFile(
        join(agentDir, "agents", "scout.md"),
        `---\nname: scout\nbodyMode: append\nmodel: ${MEMORY_AGENT_MODEL}\nthinking: low\n---\n`,
      );
      await writeFile(
        join(agentDir, "agents", "reviewer.md"),
        `---\nname: reviewer\nbodyMode: append\nmodel: ${MEMORY_AGENT_MODEL}\nthinking: low\n---\n`,
      );
      await copyFile(
        join(realAgentDir, "auth.json"),
        join(agentDir, "auth.json"),
      );
      await copyFile(
        join(realAgentDir, "models.json"),
        join(agentDir, "models.json"),
      );
      await copyFile(
        join(realAgentDir, "extensions", "herdr-agent-state.ts"),
        join(agentDir, "extensions", "herdr-agent-state.ts"),
      );
      await mkdir(sessionDir, { recursive: true });
      const startedAt = Date.now();
      const run = await memoryRpcRun({
        project,
        agentDir,
        sessionDir,
        extension,
        extensions,
        model,
        steps: script,
      });
      const wallMs = Date.now() - startedAt;
      const sessionFile = await newestSessionFile(sessionDir);
      if (!sessionFile)
        throw new Error(
          `no session file in ${sessionDir}; stderr: ${run.stderr.slice(-2000)}`,
        );
      const entries = (await readFile(sessionFile, "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
      runs.push({
        arm,
        sessionFile,
        entries,
        turns: script.length,
        wallMs,
        errors: run.errors,
        storeRoot: join(
          agentDir,
          "pi-herdsman",
          "memory",
          memoryStoreKey(realProject),
        ),
        stderr: run.stderr,
      });
    }

    const reports = {};
    for (const run of runs) {
      const facts = memoryRunFacts(run.entries);
      const scored = scoreMemoryProbes(run.entries, facts, probes);
      reports[run.arm] = await memoryRunReport(run, scored);
    }
    const memory = reports.memory;
    const native = reports.native;
    // The turn cache ratio is informational here: on DeepSeek it tracks context
    // size, not a broken prefix (there is no view mark). Only the native-arm
    // validity check gates the scenario.
    const passed = native.nativeCompactions >= MEMORY_MIN_NATIVE_COMPACTIONS;
    const report = {
      scenario: "memory-quality",
      model,
      compactorModel: MEMORY_COMPACTOR_MODEL,
      agentModel: MEMORY_AGENT_MODEL,
      extensions,
      nativeThresholdTokens: MEMORY_NATIVE_THRESHOLD,
      armOrder: arms,
      steps: script.length,
      passed,
      notes: [
        "One run per arm: a probe total within 1 is not a win (noise).",
        "The turn cache ratio is informational for this scenario; it tracks context size rather than a broken prefix, because the view mark is Anthropic-only.",
        `The native arm must compact at least ${MEMORY_MIN_NATIVE_COMPACTIONS} times.`,
        "Native summarization usage is not surfaced separately; only its compaction count is reported.",
        `Arm order was randomized: ${arms.join(" then ")}.`,
      ],
      markdown: memoryMarkdown(memory, native),
      memory,
      native,
      stepErrors: Object.fromEntries(runs.map((run) => [run.arm, run.errors])),
      facts: Object.fromEntries(
        runs.map((run) => [run.arm, memoryRunFacts(run.entries)]),
      ),
      stderr: Object.fromEntries(
        runs.map((run) => [run.arm, run.stderr.slice(-4000)]),
      ),
    };
    const reportPath = join(
      tmpdir(),
      "pi-herdsman-memory-quality-smoke-report.json",
    );
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const keepPath = args.keep
      ? await keepMemoryArtifacts(args.keep, "memory-quality", runs, reportPath)
      : undefined;
    return { report, reportPath, keepPath };
  } finally {
    memoryLiveRoots.delete(root);
    await rm(root, { recursive: true, force: true });
  }
}

// --- memory-horizon scenario -------------------------------------------------
//
// UniiChat's claims show over a long horizon, not in 32 turns, so this scenario
// runs five segments of about sixteen turns. A segment is one Pi process, which
// is what `/new` and a restart do.
//
// - `memory`: the project is listed in `memoryProjects`; every segment is a new
//   session file in the same project store.
// - `native-continue`: not listed, and each segment after the first passes
//   `--continue`, so one session file grows and native compaction handles it.
//   This is the fair baseline: the strongest continuity a Pi user can get.
// - `native-fresh` (opt-in): not listed, a new session per segment. The floor,
//   and excluded from any win rule.
//
// The arms share the fixture, the script, the Lead model, the delegations and
// the native threshold, so the only difference is project memory. The probe
// sets, the scoring and the win rule live with the script below. Phase 16 runs
// it full length. See docs/development/smoke-testing.md.

/** Pi compacts when contextTokens > contextWindow - reserveTokens. */
const MEMORY_HORIZON_NATIVE_THRESHOLD = 24_000;
const MEMORY_HORIZON_RESERVE_TOKENS =
  MEMORY_CONTEXT_WINDOW - MEMORY_HORIZON_NATIVE_THRESHOLD;
/** The baseline must compact this often for the A/B to mean anything. */
const MEMORY_HORIZON_MIN_NATIVE_COMPACTIONS = 8;
/** At every memory-arm segment end this share of view nodes must be built. */
const MEMORY_HORIZON_BUILT_NODE_SHARE = 0.95;
const MEMORY_HORIZON_DEFAULT_RUNS = 2;
const MEMORY_HORIZON_DEFAULT_MAX_COST = 3;
/** The phase 15 win rule's margin, in probes, over `native-continue`. */
const MEMORY_HORIZON_WIN_MARGIN = 2;
/** `--quick` keeps the first turns of two segments, then three probes. */
const MEMORY_HORIZON_QUICK_TURNS = 4;
/**
 * The estimate's per-turn constants, both recorded in
 * `plans/unii-memory/results/`: the Lead figure is the phase 10 baseline's
 * memory-arm Lead USD over its 32 fixed turns, and the compactor figure is the
 * phase 12 bench's `thinking: low` arm (the shipped default) over the baseline
 * store's 178 messages.
 */
const MEMORY_HORIZON_LEAD_USD_PER_TURN = 0.0566 / 32;
const MEMORY_HORIZON_MESSAGES_PER_TURN = 178 / 32;
const MEMORY_HORIZON_COMPACTOR_USD_PER_MESSAGE = 0.1923 / 178;

/**
 * Exact early values the horizon script plants in the user's own turns, never
 * in a fixture file. The probes score them; phase 15 owns the probe sets.
 */
const HORIZON_FACTS = {
  planPath: "plans/billing/HORIZON.md",
  engine: "Postgres 16",
  port: "5433",
  forbiddenDatabase: "MySQL",
  apiPrefix: "/v2",
  errorLine:
    "ERR_BILLING_PORT: expected 5432 but got 5433 in src/config.mjs:12",
  phrase: "the billing spike is the only thing that matters this quarter",
  retryLimit: "7 attempts",
  flagName: "billing_v2_shadow",
  correctedApiPrefix: "/v3",
  correctedPort: "5434",
  /** The behavior probe's file, written by the Lead itself. */
  dbFile: "src/db.mjs",
};

/** Thrown by the cost gate; the run stops and reports `incomplete`. */
class HorizonBudgetExceeded extends Error {}

/** Cheap bulk turns: about 7 KB of `emit.mjs` output each to summarize. */
function horizonBulkSteps(count, offset) {
  const topics = [
    "billing",
    "ledger",
    "invoices",
    "retries",
    "audit",
    "webhooks",
    "tenants",
    "exports",
  ];
  const asks = [
    "Reply with the number of lines it printed and its last line.",
    "Reply with the number of lines it printed, in one line.",
    "Reply with the step number on its last line.",
    "Reply with the token on its first line.",
  ];
  return Array.from({ length: count }, (_, index) => ({
    prompt: `Run \`node scripts/emit.mjs ${topics[(offset + index) % topics.length]} 40\` and read no other file. ${asks[index % asks.length]}`,
  }));
}

/**
 * One segment's steps: the facts and delegations of segments 1-3 first, then
 * cheap bulk. Segments 3 and 5 are where phase 15 asks its probe sets.
 */
function horizonSegment(segment) {
  switch (segment) {
    case 1:
      return [
        {
          prompt: `Standing decision for this project: we run ${HORIZON_FACTS.engine} on port ${HORIZON_FACTS.port}, we never use ${HORIZON_FACTS.forbiddenDatabase}, and the API prefix is ${HORIZON_FACTS.apiPrefix}. Acknowledge in one short sentence and do not use tools.`,
        },
        {
          prompt: `Keep this in mind too: ${HORIZON_FACTS.phrase}. Acknowledge in one line and do not use tools.`,
        },
        {
          prompt: `The billing suite failed a minute ago with exactly this line: ${HORIZON_FACTS.errorLine}. Keep that line as it is and do not use tools.`,
        },
        {
          prompt: `Write a short plan to ${HORIZON_FACTS.planPath} that records the standing decision and that exact error line. Use the write tool, then reply done.`,
        },
        {
          prompt:
            "Delegate one scout (definition scout, label scout-1) to inspect this project and report its file layout and what scripts/emit.mjs prints. Do not delegate further. When its result arrives, reply with its agent session id and its result ref.",
          settles: 2,
        },
        ...horizonBulkSteps(11, 0),
      ];
    case 2:
      return [
        {
          prompt: `Second decision: the billing client retries at most ${HORIZON_FACTS.retryLimit}, and the feature flag for the new path is ${HORIZON_FACTS.flagName}. Acknowledge in one line and do not use tools.`,
        },
        {
          prompt: `Append a '## Retries' section to ${HORIZON_FACTS.planPath} naming the retry limit and the flag. Use the edit tool.`,
        },
        {
          prompt:
            "Delegate one scout (definition scout, label scout-2) to inspect src/format.mjs and scripts/emit.mjs and report what they export and print. Do not delegate further. Reply done when delegated.",
          settles: 2,
        },
        ...horizonBulkSteps(13, 6),
      ];
    case 3:
      return [
        {
          prompt: `Correction: the API prefix is now ${HORIZON_FACTS.correctedApiPrefix}, not ${HORIZON_FACTS.apiPrefix}. Acknowledge in one line and do not use tools.`,
        },
        {
          prompt: `Append a '## Prefix' section to ${HORIZON_FACTS.planPath} recording the prefix we use now. Use the edit tool.`,
        },
        {
          prompt: `Delegate one reviewer (definition reviewer, label reviewer-1) to review ${HORIZON_FACTS.planPath} for correctness and missing cases. Do not delegate further; review directly. Reply done when delegated.`,
          settles: 2,
        },
        ...horizonBulkSteps(13, 2),
        ...horizonMidProbes(),
      ];
    case 4:
      return [
        {
          prompt: `Another correction: billing moved to port ${HORIZON_FACTS.correctedPort}, so ${HORIZON_FACTS.correctedApiPrefix} on ${HORIZON_FACTS.correctedPort} is current. Acknowledge in one line and do not use tools.`,
        },
        {
          prompt: `Append a '## Port' section to ${HORIZON_FACTS.planPath} recording the port we use now. Use the edit tool.`,
        },
        ...horizonBulkSteps(14, 3),
      ];
    default:
      return [
        {
          prompt: `Read ${HORIZON_FACTS.planPath} and reply with its section headings, in order.`,
        },
        ...horizonBulkSteps(15, 5),
        ...horizonFinalProbes(),
      ];
  }
}

/**
 * One cold recall probe. `contains` is the `must` list (every entry required,
 * matched as an exact substring) and `mustNot` the values a correct answer may
 * not hold (a string substring, or a pattern for a superseded value's shape).
 * `factSegment`/`factTurn` place the fact the probe scores, so the age in turns
 * is exact; `action` and `file` pick the two probes that are not reply text.
 */
function horizonProbe({
  name,
  category,
  factSegment,
  factTurn,
  prompt,
  contains,
  mustNot,
  action,
  file,
}) {
  return {
    name,
    category,
    factSegment,
    factTurn,
    prompt,
    contains,
    mustNot,
    action,
    file,
    probe: true,
  };
}

/**
 * The exact segment 1 facts, asked cold at the end of two segments: the
 * mid-run set shows how native decay and the memory view differ, and the same
 * four open the final set.
 */
function horizonEarlyProbes() {
  return [
    horizonProbe({
      name: "planPath",
      category: "early",
      factSegment: 1,
      factTurn: 4,
      prompt:
        "Cold recall, no hints: reply with just the path of the plan file I asked you to write.",
      contains: [HORIZON_FACTS.planPath],
    }),
    horizonProbe({
      name: "errorLine",
      category: "early",
      factSegment: 1,
      factTurn: 3,
      prompt:
        "Cold recall, no hints: reply with exactly the error line the billing suite failed with.",
      contains: [HORIZON_FACTS.errorLine],
    }),
    horizonProbe({
      name: "engine",
      category: "early",
      factSegment: 1,
      factTurn: 1,
      prompt:
        "Cold recall, no hints: which database engine and version did we decide to run? Reply in one short line.",
      contains: [HORIZON_FACTS.engine],
    }),
    horizonProbe({
      name: "forbiddenDatabase",
      category: "early",
      factSegment: 1,
      factTurn: 1,
      prompt:
        "Cold recall, no hints: which database did we forbid? Reply with just its name.",
      contains: [HORIZON_FACTS.forbiddenDatabase],
    }),
  ];
}

/** The mid-run set: the four segment 1 facts, asked at the end of segment 3. */
function horizonMidProbes() {
  return horizonEarlyProbes();
}

/**
 * The final set, asked at the end of segment 5: fourteen probes over every
 * property the design claims. No prompt names a fact it scores, and the
 * corrections ask for the current value only, with the superseded one
 * `mustNot`.
 */
function horizonFinalProbes() {
  return [
    ...horizonEarlyProbes(),
    horizonProbe({
      name: "retryLimit",
      category: "early",
      factSegment: 2,
      factTurn: 1,
      prompt:
        "Cold recall, no hints: how many times at most does the billing client retry? Reply with just that.",
      contains: [HORIZON_FACTS.retryLimit],
    }),
    horizonProbe({
      name: "flagName",
      category: "early",
      factSegment: 2,
      factTurn: 1,
      prompt:
        "Cold recall, no hints: reply with just the exact name of the feature flag for the new billing path.",
      contains: [HORIZON_FACTS.flagName],
    }),
    horizonProbe({
      name: "userWords",
      category: "words",
      factSegment: 1,
      factTurn: 2,
      prompt:
        "Cold recall, no hints: quote, as closely as you can, the one sentence I gave you about what is most important to us right now.",
      contains: ["billing spike", "only thing that matters", "this quarter"],
    }),
    horizonProbe({
      name: "scoutASession",
      category: "identifiers",
      factSegment: 1,
      factTurn: 5,
      prompt:
        "Cold recall, no hints: reply with just the session id of the first scout you delegated.",
      contains: (facts) => [facts.firstScoutSession],
    }),
    horizonProbe({
      name: "scoutARef",
      category: "identifiers",
      factSegment: 1,
      factTurn: 5,
      prompt:
        "Cold recall, no hints: reply with just the result ref that scout's result used.",
      contains: (facts) => [facts.firstScoutRef],
    }),
    horizonProbe({
      name: "reviewerRef",
      category: "identifiers",
      factSegment: 3,
      factTurn: 3,
      prompt:
        "Cold recall, no hints: reply with just the result ref the reviewer's result used.",
      contains: (facts) => [facts.reviewerRef],
    }),
    horizonProbe({
      name: "apiPrefix",
      category: "corrections",
      factSegment: 3,
      factTurn: 1,
      prompt:
        "Cold recall, no hints: reply with only the API prefix the billing API uses now, and nothing else.",
      contains: [HORIZON_FACTS.correctedApiPrefix],
      mustNot: [HORIZON_FACTS.apiPrefix],
    }),
    horizonProbe({
      name: "port",
      category: "corrections",
      factSegment: 4,
      factTurn: 1,
      prompt:
        "Cold recall, no hints: reply with only the database port the billing service uses now, and nothing else.",
      contains: [HORIZON_FACTS.correctedPort],
      mustNot: [HORIZON_FACTS.port],
    }),
    horizonProbe({
      name: "dbFile",
      category: "behavior",
      factSegment: 1,
      factTurn: 1,
      prompt: `Cold recall, no hints: write ${HORIZON_FACTS.dbFile} so it connects to our database, using the settings we settled on. Use the write tool, then reply done.`,
      file: HORIZON_FACTS.dbFile,
      contains: [HORIZON_FACTS.engine, HORIZON_FACTS.correctedPort],
      mustNot: [HORIZON_FACTS.forbiddenDatabase],
    }),
    horizonProbe({
      name: "continueScoutA",
      category: "action",
      factSegment: 1,
      factTurn: 5,
      prompt:
        "Continue the first scout you delegated with: report whether src/format.mjs rounds amounts. Use continue_agent with the exact session you recorded, then reply done.",
      action: true,
    }),
  ];
}

/**
 * The turn number of (segment, turn) in the whole run. The probe's age is the
 * distance between the turn that stated its fact and the turn that asks.
 */
function horizonTurnNumber(segments, segment, turn) {
  let position = 0;
  for (let index = 0; index < segment - 1; index += 1)
    position += segments[index].length;
  return position + turn;
}

/** Stamps every probe step with where it is asked and how old its fact is. */
function horizonAnnotateProbes(segments) {
  segments.forEach((steps, index) =>
    steps.forEach((step, at) => {
      if (!step.probe) return;
      step.askSegment = index + 1;
      step.age =
        horizonTurnNumber(segments, index + 1, at + 1) -
        horizonTurnNumber(segments, step.factSegment, step.factTurn);
    }),
  );
  return segments;
}

/** Three probes over the segment 1 facts, so `--quick` can score something. */
function horizonQuickProbes() {
  return [
    horizonProbe({
      name: "planPath",
      category: "early",
      factSegment: 1,
      factTurn: 4,
      prompt:
        "Cold recall, no hints: what is the exact path of the plan file I asked you to write? Reply with just the path.",
      contains: [HORIZON_FACTS.planPath],
    }),
    horizonProbe({
      name: "decision",
      category: "early",
      factSegment: 1,
      factTurn: 1,
      prompt:
        "Cold recall, no hints: which database port did we decide to use, and which database did we forbid? Reply in one line.",
      contains: [HORIZON_FACTS.port, HORIZON_FACTS.forbiddenDatabase],
    }),
    horizonProbe({
      name: "errorLine",
      category: "early",
      factSegment: 1,
      factTurn: 3,
      prompt:
        "Cold recall, no hints: what exact error line did the billing suite fail with? Reply with just that line.",
      contains: [HORIZON_FACTS.errorLine],
    }),
  ];
}

/** The script: one step list per segment, with its probes stamped. */
function horizonScript({ quick = false } = {}) {
  if (!quick) return horizonAnnotateProbes([1, 2, 3, 4, 5].map(horizonSegment));
  const segments = [1, 2].map((segment) =>
    horizonSegment(segment).slice(0, MEMORY_HORIZON_QUICK_TURNS),
  );
  const last = segments[segments.length - 1];
  segments[segments.length - 1] = [...last, ...horizonQuickProbes()];
  return horizonAnnotateProbes(segments);
}

/** One turn's assumed cost: the Lead's calls plus the memory arm's compactor. */
function horizonTurnCostUsd(arm) {
  if (arm !== "memory") return MEMORY_HORIZON_LEAD_USD_PER_TURN;
  return (
    MEMORY_HORIZON_LEAD_USD_PER_TURN +
    MEMORY_HORIZON_MESSAGES_PER_TURN * MEMORY_HORIZON_COMPACTOR_USD_PER_MESSAGE
  );
}

/**
 * The arms, run count and cost estimate for one invocation. The run count drops
 * to 1 when the estimate for the requested one would exceed the cap.
 */
export function horizonPlan(args) {
  const quick = args.quick ?? false;
  const segments = horizonScript({ quick });
  const requestedArms = args.arms ?? ["memory", "native-continue"];
  // `--with-fresh` adds the informational arm to whatever `--arms` asked for.
  const arms =
    args.withFresh && !requestedArms.includes("native-fresh")
      ? [...requestedArms, "native-fresh"]
      : [...requestedArms];
  const maxCost = args.maxCost ?? MEMORY_HORIZON_DEFAULT_MAX_COST;
  const turns = segments.reduce((count, steps) => count + steps.length, 0);
  const estimateUsd = (runs) =>
    arms.reduce((total, arm) => total + horizonTurnCostUsd(arm), 0) *
    turns *
    runs;
  const requested = args.runs ?? (quick ? 1 : MEMORY_HORIZON_DEFAULT_RUNS);
  const reduced = requested > 1 && estimateUsd(requested) > maxCost;
  const runs = reduced ? 1 : requested;
  return {
    quick,
    segments,
    arms,
    turns,
    runs,
    maxCost,
    reduced,
    estimateUsd: estimateUsd(runs),
  };
}

/** The cost assumptions behind the estimate, printed with it and in the report. */
function horizonAssumptions(plan) {
  return [
    `Lead $${MEMORY_HORIZON_LEAD_USD_PER_TURN.toFixed(4)} per turn, from the phase 10 baseline memory arm ($0.0566 over 32 turns).`,
    `compactor $${MEMORY_HORIZON_COMPACTOR_USD_PER_MESSAGE.toFixed(4)} per message at the phase 12 default (thinking low: $0.1923 over 178 messages) times ${MEMORY_HORIZON_MESSAGES_PER_TURN.toFixed(2)} messages per turn, so $${(MEMORY_HORIZON_MESSAGES_PER_TURN * MEMORY_HORIZON_COMPACTOR_USD_PER_MESSAGE).toFixed(4)} per memory-arm turn.`,
    "A native arm is charged its Lead turns only: native summarization usage is not surfaced in the Lead session.",
    "The estimate and the cost gate cover Lead plus compactor-surfaced spend only: a delegated agent's usage is not surfaced, so the real provider spend can pass the cap by the delegations' share.",
    `Estimated $${plan.estimateUsd.toFixed(2)} for ${plan.arms.length} arms x ${plan.runs} run(s) x ${plan.turns} turns; the cap is $${plan.maxCost.toFixed(2)} and stops the run as incomplete.`,
  ];
}

/** The estimate printed before `--yes` starts anything. */
function memoryHorizonEstimate(plan) {
  return [
    "memory-horizon smoke estimate:",
    `  arms: ${plan.arms.join(", ")} (${plan.runs} run(s) each)`,
    `  script: ${plan.segments.length} segments, ${plan.turns} Lead turns (${plan.segments.map((steps) => steps.length).join(" + ")})`,
    `  Lead and agents: ${MEMORY_LEAD_MODEL}`,
    `  compactor: ${MEMORY_COMPACTOR_MODEL} (thinking low, the phase 12 default)`,
    `  native compaction threshold: ${MEMORY_HORIZON_NATIVE_THRESHOLD} tokens`,
    ...horizonAssumptions(plan).map((line) => `  ${line}`),
    plan.reduced
      ? "  --runs was reduced to 1: the estimate for the requested runs exceeds the cap"
      : "",
    "  real provider calls; the run is long and costs real usage",
    "re-run with --yes to start",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Real delegation needs the invoking Herdr workspace, exactly as
 * `memory-quality` does: the isolated agent directory has to carry Herdr's Pi
 * integration. Fail before any spend.
 */
async function requireHerdrWorkspace(realAgentDir) {
  const integration = join(realAgentDir, "extensions", "herdr-agent-state.ts");
  try {
    await access(integration);
  } catch {
    throw new Error(
      `memory-horizon delegates real agents and must run from a Herdr-managed Pi session: ${integration} is missing`,
    );
  }
  return integration;
}

/**
 * The cumulative cost gate. `--max-cost` is a hard stop, not advice: it is
 * checked between turns, against everything the run has spent so far.
 */
function horizonBudget(maxCost) {
  let spentBefore = 0;
  let spent = 0;
  return {
    limit: maxCost,
    get spent() {
      return spent;
    },
    startRun: () => {
      spentBefore = spent;
    },
    observe: (sessionCost) => {
      spent = spentBefore + sessionCost;
      if (spent > maxCost)
        throw new HorizonBudgetExceeded(
          `spent $${spent.toFixed(2)} over the $${maxCost.toFixed(2)} cap`,
        );
    },
    settle: (armCost) => {
      spent = spentBefore + armCost;
    },
  };
}

/** One session's own cost: the Lead's usage plus the compactor's estimated cost. */
function memorySessionCost(entries) {
  const lead = assistantUsages(entries).reduce(
    (total, usage) => total + (usage.cost?.total ?? 0),
    0,
  );
  return lead + compactorCost(compactorUsages(entries)).cost;
}

/** The entries a session file gained since the last read of it. */
async function newSessionEntries(sessionDir, consumed) {
  const sessionFile = await newestSessionFile(sessionDir);
  if (!sessionFile) return { sessionFile: undefined, entries: [] };
  const all = memoryJsonl(await readFile(sessionFile, "utf8"));
  const from = consumed.get(sessionFile) ?? 0;
  consumed.set(sessionFile, all.length);
  return { sessionFile, entries: all.slice(from) };
}

/** One arm-run at the end of one segment: what the segment cost and built. */
async function horizonSegmentEvidence({
  sessionDir,
  storeRoot,
  consumed,
  index,
  steps,
  run,
}) {
  const { sessionFile, entries } = await newSessionEntries(
    sessionDir,
    consumed,
  );
  const store = await memoryStoreStats(storeRoot);
  return {
    index: index + 1,
    turns: steps.length,
    sessionFile,
    entries,
    costUsd: memorySessionCost(entries),
    leadCalls: assistantUsages(entries)
      .map((usage) => ratioOf(usage))
      .map((value) => value.total),
    nativeCompactions: entries.filter((entry) => entry.type === "compaction")
      .length,
    killed: run.killed,
    errors: run.errors,
    store: store
      ? {
          viewBytes: store.viewBytes,
          viewNodes: store.viewNodes,
          unbuilt: store.unbuilt,
          messages: store.messages,
          builtShare: store.viewNodes
            ? (store.viewNodes - store.unbuilt) / store.viewNodes
            : 1,
        }
      : undefined,
  };
}

/**
 * The validity rules for one arm-run: any turn error or stall, a segment
 * process that needed SIGKILL, a memory segment that ended without a store or
 * below the built-node share, an interrupted run's remaining segments, and the
 * `native-continue` baseline's compaction count.
 */
export function horizonValidity({
  arm,
  quick,
  segments,
  errors,
  nativeCompactions,
  aborted,
  plannedSegments,
}) {
  const builtShares = segments
    .map((segment) => segment.store?.builtShare)
    .filter((share) => share !== undefined);
  const issues = [
    ...errors.map((error) => `turn: ${error}`),
    ...segments
      .filter((segment) => segment.killed === "SIGKILL")
      .map((segment) => `segment ${segment.index} needed SIGKILL`),
  ];
  if (!aborted && segments.length !== plannedSegments)
    issues.push(`ran ${segments.length} of ${plannedSegments} segments`);
  if (
    !quick &&
    arm === "native-continue" &&
    nativeCompactions < MEMORY_HORIZON_MIN_NATIVE_COMPACTIONS
  )
    issues.push(
      `native compactions ${nativeCompactions} below ${MEMORY_HORIZON_MIN_NATIVE_COMPACTIONS}`,
    );
  if (arm === "memory") {
    // A store that never appeared is not a built share of 1: it is no memory at
    // all, and the 95% rule has nothing to check.
    const storeless = segments.filter(
      (segment) => !segment.store || segment.store.viewNodes === 0,
    );
    if (storeless.length)
      issues.push(
        `segment ${storeless.map((segment) => segment.index).join(", ")} ended with no project memory store`,
      );
    if (builtShares.some((share) => share < MEMORY_HORIZON_BUILT_NODE_SHARE))
      issues.push(
        `a segment ended below ${MEMORY_HORIZON_BUILT_NODE_SHARE} built nodes`,
      );
  }
  return issues;
}

/**
 * One arm, one run: every segment against the same project, agent directory and
 * session directory. `memory` and `native-fresh` start a new Pi process (and so
 * a new session file) per segment; `native-continue` adds `--continue`.
 */
async function runHorizonArm({
  arm,
  run,
  plan,
  root,
  extension,
  extensions,
  model,
  realAgentDir,
  herdrIntegration,
  budget,
}) {
  const project = join(root, `${arm}-run${run}-project`);
  const agentDir = join(root, `${arm}-run${run}-agent`);
  const sessionDir = join(root, `${arm}-run${run}-sessions`);
  await writeMemoryFixture(project, { horizon: true });
  await mkdir(join(agentDir, "pi-herdsman"), { recursive: true });
  await mkdir(join(agentDir, "agents"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  const realProject = await realpath(project);
  await writeFile(
    join(agentDir, "pi-herdsman", "config.json"),
    `${JSON.stringify({ memoryProjects: arm === "memory" ? [realProject] : [] })}\n`,
  );
  for (const definition of ["scout", "reviewer"])
    await writeFile(
      join(agentDir, "agents", `${definition}.md`),
      `---\nname: ${definition}\nbodyMode: append\nmodel: ${MEMORY_AGENT_MODEL}\nthinking: low\n---\n`,
    );
  await copyFile(join(realAgentDir, "auth.json"), join(agentDir, "auth.json"));
  await copyFile(
    join(realAgentDir, "models.json"),
    join(agentDir, "models.json"),
  );
  await copyFile(
    herdrIntegration,
    join(agentDir, "extensions", "herdr-agent-state.ts"),
  );
  await mkdir(sessionDir, { recursive: true });
  const storeRoot = join(
    agentDir,
    "pi-herdsman",
    "memory",
    memoryStoreKey(realProject),
  );

  const startedAt = Date.now();
  const consumed = new Map();
  // The cost gate needs the arm-run's running total: a continued session file
  // already carries its earlier segments, so its cost replaces, not adds to,
  // the totals of the segment files the other arms own.
  const sessionCosts = new Map();
  const segments = [];
  const entries = [];
  const errors = [];
  let stderr = "";
  let aborted = false;
  budget.startRun();
  for (const [index, steps] of plan.segments.entries()) {
    let result = { errors: [], stderr: "", killed: undefined };
    try {
      result = await memoryRpcRun({
        project,
        agentDir,
        sessionDir,
        extension,
        extensions,
        model,
        steps,
        continueSession: arm === "native-continue" && index > 0,
        onTurn: async () => {
          const sessionFile = await newestSessionFile(sessionDir);
          if (sessionFile)
            sessionCosts.set(
              sessionFile,
              memorySessionCost(
                memoryJsonl(await readFile(sessionFile, "utf8")),
              ),
            );
          budget.observe(
            [...sessionCosts.values()].reduce((total, cost) => total + cost, 0),
          );
        },
      });
    } catch (error) {
      // A fatal turn or a failed spawn is this segment's error, not the end of
      // the run: the arm is reported invalid with the rest of its evidence.
      if (error instanceof HorizonBudgetExceeded) aborted = true;
      else
        result = {
          errors: [`segment ${index + 1}: ${error?.message ?? error}`],
          stderr: "",
          killed: undefined,
        };
    }
    const segment = await horizonSegmentEvidence({
      sessionDir,
      storeRoot,
      consumed,
      index,
      steps,
      run: result,
    });
    segments.push(segment);
    entries.push(...segment.entries);
    errors.push(...segment.errors);
    stderr += result.stderr ?? "";
    if (aborted) break;
  }

  budget.settle(segments.reduce((total, s) => total + s.costUsd, 0));
  const facts = memoryRunFacts(entries);
  // A behavior probe is graded on the file the Lead wrote, so the file is read
  // once at the end of the run: no later step writes it again.
  const probeFiles = new Map();
  for (const step of plan.segments.flat())
    if (step.file)
      probeFiles.set(
        step.file,
        await readFile(join(project, step.file), "utf8").catch(() => undefined),
      );
  const scored = segments.map((segment, index) =>
    scoreMemoryProbes(
      segment.entries,
      facts,
      plan.segments[index].filter((step) => step.probe),
      (file) => probeFiles.get(file),
    ),
  );
  const probes = scored.flatMap((value) => value.probes);
  const promptTokens = segments.flatMap((segment) => segment.leadCalls);
  const nativeCompactions = segments.reduce(
    (total, segment) => total + segment.nativeCompactions,
    0,
  );
  const gate = memoryGateReport(
    gateEntries(entries).map((entry) => entry.data ?? {}),
  );
  const issues = horizonValidity({
    arm,
    quick: plan.quick,
    segments,
    errors,
    nativeCompactions,
    aborted,
    plannedSegments: plan.segments.length,
  });
  return {
    arm,
    run,
    storeRoot,
    sessionFile: segments.at(-1)?.sessionFile,
    issues,
    valid: issues.length === 0 && !aborted,
    aborted,
    costUsd: segments.reduce((total, segment) => total + segment.costUsd, 0),
    nativeCompactions,
    promptTokens: {
      calls: promptTokens.length,
      first: promptTokens[0] ?? 0,
      last: promptTokens.at(-1) ?? 0,
      max: promptTokens.length ? Math.max(...promptTokens) : 0,
      // The view is bounded, so this list stays bounded however long the run is.
      byTurn: promptTokens,
    },
    leadCalls: promptTokens,
    probes,
    probeTotal: probes.reduce((total, probe) => total + probe.score, 0),
    probeMax: probes.length,
    scores: horizonScoreTable(probes),
    // The phase 10 gate numbers, plus the phase 15 name for the in-view calls
    // that ran because their value was already verbatim in the turn.
    gate: { ...gate, verbatimBeforeAct: gate.passedInView },
    wallMs: Date.now() - startedAt,
    errors,
    stderr: stderr.slice(-4000),
    segments: segments.map(({ entries: _entries, ...rest }) => rest),
  };
}

/** The horizon report's Markdown: the run tables, the scores, the win rule. */
export function memoryHorizonMarkdown(report) {
  const rows = [
    "| arm | run | valid | turns | cost USD | native compactions | built nodes | view bytes | probes | Lead prompt tokens first/last/max |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const arm of report.arms)
    for (const result of report.results[arm] ?? []) {
      const last = result.segments.at(-1);
      rows.push(
        `| ${arm} | ${result.run} | ${result.valid ? "yes" : "no"} | ${result.segments.reduce((total, segment) => total + segment.turns, 0)} | ${result.costUsd.toFixed(4)} | ${result.nativeCompactions} | ${last?.store ? last.store.builtShare.toFixed(3) : "n/a"} | ${last?.store?.viewBytes ?? "n/a"} | ${result.probeTotal}/${result.probeMax} | ${result.promptTokens.first}/${result.promptTokens.last}/${result.promptTokens.max} |`,
      );
    }
  rows.push("");
  rows.push(
    "| arm | run | segment | turns | cost USD | native compactions | built nodes | view bytes |",
  );
  rows.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const arm of report.arms)
    for (const result of report.results[arm] ?? [])
      for (const segment of result.segments)
        rows.push(
          `| ${arm} | ${result.run} | ${segment.index} | ${segment.turns} | ${segment.costUsd.toFixed(4)} | ${segment.nativeCompactions} | ${segment.store ? segment.store.builtShare.toFixed(3) : "n/a"} | ${segment.store?.viewBytes ?? "n/a"} |`,
        );
  rows.push("");
  // The phase 10 gate numbers, per arm-run.
  rows.push(
    "| arm | run | gated calls | blocked | blockedShare | verbatimBeforeAct | zoomShare | blockRecovered |",
  );
  rows.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const arm of report.arms)
    for (const result of report.results[arm] ?? [])
      rows.push(
        `| ${arm} | ${result.run} | ${result.gate.entries} | ${result.gate.blocks} | ${result.gate.blockedShare.toFixed(3)} | ${result.gate.verbatimBeforeAct} | ${result.gate.zoomShare.toFixed(3)} | ${result.gate.blockRecovered} |`,
      );
  rows.push("");
  // The score table: per category, the cross-session subtotal and the age.
  const categories = [
    ...new Set(
      Object.values(report.results)
        .flat()
        .flatMap((result) =>
          result.scores.byCategory.map((row) => row.category),
        ),
    ),
  ];
  rows.push(
    `| arm | run | probe total | ${categories.join(" | ")} | cross-session | mean age |`,
  );
  rows.push(
    `| --- | --- | --- | ${categories.map(() => "---").join(" | ")} | --- | --- |`,
  );
  for (const arm of report.arms)
    for (const result of report.results[arm] ?? []) {
      const score = (category) => {
        const row = result.scores.byCategory.find(
          (entry) => entry.category === category,
        );
        return row ? `${row.score}/${row.max}` : "0/0";
      };
      const passed = result.probes.filter((probe) => probe.score === 1);
      const meanAge = passed.length
        ? (
            passed.reduce((total, probe) => total + (probe.age ?? 0), 0) /
            passed.length
          ).toFixed(1)
        : "n/a";
      rows.push(
        `| ${arm} | ${result.run} | ${result.probeTotal}/${result.probeMax} | ${categories.map(score).join(" | ")} | ${result.scores.crossSession.score}/${result.scores.crossSession.max} | ${meanAge} |`,
      );
    }
  rows.push("");
  rows.push(
    "| arm | run | probe | category | fact segment | asked segment | age | score | note |",
  );
  rows.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const arm of report.arms)
    for (const result of report.results[arm] ?? [])
      for (const probe of result.probes)
        rows.push(
          `| ${arm} | ${result.run} | ${probe.name} | ${probe.category ?? "n/a"} | ${probe.factSegment ?? "n/a"} | ${probe.askSegment ?? "n/a"} | ${probe.age ?? "n/a"} | ${probe.score} | ${probe.note} |`,
        );
  rows.push("");
  rows.push(
    `win rule: ${report.scores.win.claim} (${report.scores.win.detail})`,
  );
  rows.push("");
  for (const arm of report.arms)
    for (const result of report.results[arm] ?? [])
      if (result.issues.length)
        rows.push(`- ${arm} run ${result.run}: ${result.issues.join("; ")}`);
  rows.push("");
  rows.push(
    `spent $${report.spentUsd.toFixed(2)} of the $${report.maxCostUsd.toFixed(2)} cap${report.incomplete ? " (incomplete)" : ""}`,
  );
  return rows.join("\n");
}

/**
 * The horizon arms and segments, the cost gate, the scored probe sets and the
 * report.
 */
async function runMemoryHorizonScenario(args) {
  const plan = horizonPlan(args);
  const model = args.model ?? MEMORY_LEAD_MODEL;
  const extensions = memorySmokeExtensions();
  if (!args.yes) return { estimate: memoryHorizonEstimate(plan) };

  const realAgentDir = join(homedir(), ".pi", "agent");
  const herdrIntegration = await requireHerdrWorkspace(realAgentDir);
  const root = await mkdtemp(
    join(tmpdir(), "pi-herdsman-memory-horizon-smoke-"),
  );
  memoryLiveRoots.add(root);
  installMemorySignalHandlers();
  const extension = join(repoRoot, "extension", "index.ts");
  const budget = horizonBudget(plan.maxCost);
  const results = {};
  try {
    outer: for (let run = 1; run <= plan.runs; run++)
      for (const arm of plan.arms) {
        const result = await runHorizonArm({
          arm,
          run,
          plan,
          root,
          extension,
          extensions,
          model,
          realAgentDir,
          herdrIntegration,
          budget,
        });
        (results[arm] ??= []).push(result);
        if (result.aborted) break outer;
      }

    const finished = Object.values(results).flat();
    const passed = finished.every((result) => result.valid);
    const report = {
      scenario: "memory-horizon",
      model,
      compactorModel: MEMORY_COMPACTOR_MODEL,
      agentModel: MEMORY_AGENT_MODEL,
      extensions,
      quick: plan.quick,
      arms: plan.arms,
      runs: plan.runs,
      runsReduced: plan.reduced,
      segmentsPerRun: plan.segments.length,
      turnsPerSegment: plan.segments.map((steps) => steps.length),
      turnsPerRun: plan.turns,
      nativeThresholdTokens: MEMORY_HORIZON_NATIVE_THRESHOLD,
      maxCostUsd: plan.maxCost,
      estimatedUsd: plan.estimateUsd,
      spentUsd: budget.spent,
      incomplete: finished.some((result) => result.aborted),
      passed,
      assumptions: horizonAssumptions(plan),
      notes: [
        "A segment is one Pi process, so the memory arm gets a new session file in the same project store, while native-continue keeps one session and compacts natively.",
        plan.quick
          ? "--quick: two four-turn segments and three probes; the native compaction check is skipped, so this run does not judge the A/B."
          : `native-continue must compact at least ${MEMORY_HORIZON_MIN_NATIVE_COMPACTIONS} times.`,
        `The memory arm must end every segment with at least ${MEMORY_HORIZON_BUILT_NODE_SHARE} of its view nodes built (the phase 11 drain), and with a store to check.`,
        "The cost gate covers Lead plus compactor-surfaced spend only; a delegated agent's usage is not surfaced, so the cap can be passed by the delegations' share.",
        plan.quick
          ? "Probe scores: the three --quick probes over the segment 1 facts."
          : `Probe scores: the mid-run set (${horizonMidProbes().length} segment 1 facts) at the end of segment 3 and the final set (${horizonFinalProbes().length} probes) at the end of segment 5.`,
        `The win rule needs at least ${MEMORY_HORIZON_WIN_MARGIN} probes of margin over native-continue in every paired run and in the mean; native-fresh is informational and never enters it.`,
      ],
      scores: horizonScoreSummary(results),
      results: Object.fromEntries(
        Object.entries(results).map(([arm, runs]) => [
          arm,
          runs.map(({ stderr: _stderr, ...rest }) => rest),
        ]),
      ),
      stepErrors: Object.fromEntries(
        Object.entries(results).map(([arm, runs]) => [
          arm,
          runs.map((result) => result.errors),
        ]),
      ),
      stderr: Object.fromEntries(
        Object.entries(results).map(([arm, runs]) => [
          arm,
          runs.map((result) => result.stderr),
        ]),
      ),
    };
    report.markdown = memoryHorizonMarkdown(report);
    const reportPath = join(
      tmpdir(),
      "pi-herdsman-memory-horizon-smoke-report.json",
    );
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    // The continued arm copies one session file per segment, so keep each
    // distinct file once: the copy happens at the end of the run, not at the
    // segment end.
    const seen = new Set();
    const keepRuns = [];
    for (const result of finished)
      for (const segment of result.segments) {
        if (!segment.sessionFile || seen.has(segment.sessionFile)) continue;
        seen.add(segment.sessionFile);
        keepRuns.push({
          arm: `${result.arm}-run${result.run}-seg${segment.index}`,
          storeRoot: result.storeRoot,
          sessionFile: segment.sessionFile,
        });
      }
    const keepPath = args.keep
      ? await keepMemoryArtifacts(
          args.keep,
          "memory-horizon",
          keepRuns,
          reportPath,
        )
      : undefined;
    return { report, reportPath, keepPath };
  } finally {
    memoryLiveRoots.delete(root);
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseSmokeArgs(process.argv.slice(2));
  if (
    args.scenario === "memory-cache" ||
    args.scenario === "memory-quality" ||
    args.scenario === "memory-horizon"
  ) {
    const result =
      args.scenario === "memory-cache"
        ? await runMemoryCacheScenario(args)
        : args.scenario === "memory-quality"
          ? await runMemoryScenario(args)
          : await runMemoryHorizonScenario(args);
    if (result.estimate) {
      console.log(result.estimate);
      return;
    }
    const { report, reportPath, keepPath } = result;
    console.log(
      `smoke ${args.scenario}: ${report.passed ? "PASS" : "FAIL"}\n${JSON.stringify(report, null, 2)}`,
    );
    console.log(report.markdown);
    console.log(`report: ${reportPath}`);
    if (keepPath) console.log(`kept: ${keepPath}`);
    if (!report.passed) process.exitCode = 1;
    return;
  }
  const pkg = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  );
  const preflightEvidence = await preflight(pkg);
  const model = await resolveSmokeModel(args.model);
  const scenario = args.scenario;
  await run("npm", ["run", "build"], { cwd: repoRoot });
  const paths = await createIsolation();
  const owned = {};
  const ctx = {
    repoRoot,
    candidateExtension: join(repoRoot, "dist", "index.js"),
    herdrStateExtension: paths.herdrStateExtension,
    ...(scenario === "chief-tree"
      ? {
          chiefTreeProbeExtension: join(
            paths.piAgent,
            "extensions",
            "chief-tree-tools.mjs",
          ),
          chiefTreeResultFile: join(paths.root, "chief-tree-tools.json"),
        }
      : {}),
    sessionName: undefined,
    paths,
    model,
    yes: args.yes,
    keep: args.keep,
    allowAnthropic: args.allowAnthropic,
    managerReadyTimeoutMs:
      args.managerReadyTimeoutMs ?? DEFAULT_MANAGER_READY_TIMEOUT_MS,
    managerRecoveryDiagnostics: args.managerRecoveryDiagnostics,
    expectedPackage: `${pkg.name}@${pkg.version}`,
    owned,
    preflight: preflightEvidence,
  };
  ctx.initialPrompt = initialPromptForScenario(scenario, ctx);
  let failure;
  try {
    ctx.rootCwd =
      scenario === "manager-recovery"
        ? await prepareManagerRepository(paths)
        : repoRoot;
    if (scenario === "manager-recovery") {
      ctx.primaryCheckoutPath = ctx.rootCwd;
    }
    ctx.authMechanism = await preparePi(paths, model);
    await prepareHerdr(paths);
    if (ctx.chiefTreeProbeExtension)
      await writeFile(
        ctx.chiefTreeProbeExtension,
        chiefTreeProbeSource(ctx.chiefTreeResultFile),
        { flag: "wx" },
      );
    await startNestedHerdr(
      paths,
      owned,
      ctx.rootCwd,
      ctx.managerRecoveryDiagnostics,
    );
    ctx.sessionName = owned.sessionName;
    await waitForNestedHerdr(ctx);
    ctx.rootPaneId = await startCandidate(ctx);
    await runScenario(ctx, scenario);
    console.log(`smoke ${scenario}: PASS`);
    console.log(`model: ${ctx.model}`);
    console.log(`candidate: ${ctx.candidateExtension}`);
    if (scenario === "core") {
      console.log(`descendant panes: ${ctx.descendantCount}`);
      console.log(
        `process evidence: ${JSON.stringify(ctx.coreProcessEvidence)}`,
      );
      console.log(`package result: ${ctx.expectedPackage}`);
    }
    if (scenario === "continuation")
      console.log(
        `continuation: ${JSON.stringify({
          sessionId: ctx.continuationSessionId,
          sessionPath: ctx.continuationSessionPath,
          firstPane: ctx.continuationFirstPaneId,
          secondPane: ctx.continuationSecondPaneId,
          secondPid: ctx.continuationGenerationPid,
          result: "one final remembered-context owner result",
        })}`,
      );
    if (scenario === "chief-tree")
      console.log(
        `chief-tree: ${JSON.stringify({
          snapshots: ctx.chiefTreeProbeDiagnostics,
          selectedBranch: ctx.chiefTreeBranchPlan,
        })}`,
      );
    if (scenario === "manager-recovery")
      console.log(`manager-recovery: ${JSON.stringify(ctx.managerRecovery)}`);
    console.log(`authentication: ${ctx.authMechanism}`);
  } catch (error) {
    failure = error;
    console.error(
      `smoke ${scenario}: FAIL\n${formatSmokeFailure(error, ctx.stage)}`,
    );
    try {
      await collectDiagnostics(ctx, owned, error);
    } catch (diagnosticError) {
      console.error(
        `diagnostics: collection failed: ${
          diagnosticError?.message ?? diagnosticError
        }`,
      );
    }
  } finally {
    const cleanupError = await cleanup(paths, owned, ctx);
    if (cleanupError) {
      console.error(`cleanup: FAIL ${cleanupEvidence(owned)}\n${cleanupError}`);
      process.exitCode = 1;
    } else {
      console.log(`cleanup: PASS ${cleanupEvidence(owned)}`);
    }
    if (failure) process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "--nested-host") nestedHost(process.argv.slice(3));
  else await main();
}
