// Shallow leaf: `lead-runtime.ts` imports it, so every import here costs depth.
import { existsSync, realpathSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.ts";
import { resolveCompactorDefinition } from "./agent-definitions.ts";
import { projectMemoryRoot } from "./memory.ts";

/** The latest activation's outcome, when it was not a clean success. */
export type MemoryActivationOutcome =
  | { kind: "locked"; pid: number | undefined }
  | { kind: "failed"; reason: string };

/** The read-only memory state the status report reads (DESIGN §4.4/§4.5). */
export type MemoryRuntimeSnapshot = {
  /** True while this session owns the project's memory. */
  active: boolean;
  /** The latest compaction failure, while any node is still failing. */
  failing: string | undefined;
  /** The latest activation's outcome; undefined after a clean activation. */
  outcome: MemoryActivationOutcome | undefined;
};

/** The session roles the status states distinguish (DESIGN §4.4 rows 3–5). */
export type ProjectMemoryRole = "lead" | "manager" | "chief" | "managed-lead";

export type ProjectMemoryInput = {
  role: ProjectMemoryRole;
  /** The memory runtime's snapshot, or undefined when none is registered. */
  runtime: MemoryRuntimeSnapshot | undefined;
};

/** The one state every row, help line and report derives from. */
export type ProjectMemoryStatus = {
  /** The state word the root row and the Status row show. */
  word: "on" | "off" | "next session" | "failing";
  /** The §4.4 reason sentence: the help line and report line 2. */
  reason: string;
  /** The report notice level. */
  level: "info" | "warning";
  /** The five-line report of §4.5. */
  report: string;
  /** The realpath of the cwd, or the cwd itself when realpath throws. */
  project: string;
  /** False when the cwd cannot be resolved, so the store path is unknown. */
  projectResolved: boolean;
  /** True when a listed project resolves to this cwd's realpath. */
  listed: boolean;
  /** The config read error, when `config.json` cannot be read. */
  configError: string | undefined;
  /** The configured compactor model token, or undefined when unset. */
  model: string | undefined;
};

/** How the cwd resolves against a project list, the way listing matches. */
export type ProjectMatch = {
  /** The realpath of the cwd, or the cwd itself when realpath throws. */
  project: string;
  /** False when the cwd cannot be resolved, so its store path is unknown. */
  resolved: boolean;
  /** True when a listed project resolves to the same realpath. */
  listed: boolean;
};

export function matchProject(
  cwd: string,
  projects: readonly string[],
): ProjectMatch {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return { project: cwd, resolved: false, listed: false };
  }
  for (const project of projects) {
    try {
      if (realpathSync(project) === real)
        return { project: real, resolved: true, listed: true };
    } catch {
      // A listed project that is gone cannot match.
    }
  }
  return { project: real, resolved: true, listed: false };
}

/** The word, reason sentence and notice level one status row shows. */
type StatusState = Pick<ProjectMemoryStatus, "word" | "reason" | "level">;

/**
 * The status states of DESIGN §4.4, applied top to bottom, first match wins.
 * The menu row, its help line and the report all derive from this one result.
 */
function firstMatch(status: {
  active: boolean;
  failing: string | undefined;
  outcome: MemoryActivationOutcome | undefined;
  role: ProjectMemoryRole;
  saved: boolean;
  configError: string | undefined;
  definitionsError: string | undefined;
  listed: boolean;
  model: string | undefined;
}): StatusState {
  const {
    active,
    failing,
    outcome,
    role,
    saved,
    configError,
    definitionsError,
    listed,
    model,
  } = status;
  let word: ProjectMemoryStatus["word"] = "off";
  let reason: string;
  let level: "info" | "warning" = "info";
  if (active && failing !== undefined) {
    word = "failing";
    reason = `This session uses project memory, but compaction is failing: ${failing}`;
    level = "warning";
  } else if (active) {
    word = "on";
    reason = "This session uses project memory.";
  } else if (role === "manager") {
    reason = "Manager sessions do not use project memory.";
  } else if (role === "chief") {
    reason = "Chief sessions do not use project memory.";
  } else if (role === "managed-lead") {
    reason = "managed-lead sessions do not use project memory.";
  } else if (!saved) {
    reason = "This session is not saved, so it cannot use project memory.";
  } else if (configError !== undefined) {
    reason = `config.json is invalid: ${configError}`;
    level = "warning";
  } else if (definitionsError !== undefined) {
    reason = `Agent definitions are invalid: ${definitionsError}`;
    level = "warning";
  } else if (!listed) {
    reason = "This project is not enabled.";
  } else if (model === undefined) {
    reason = "No compactor model is chosen.";
  } else if (outcome?.kind === "locked") {
    reason =
      outcome.pid === undefined
        ? "Another process already has this project's memory open."
        : `Process ${outcome.pid} already has this project's memory open.`;
  } else if (outcome?.kind === "failed") {
    reason = `The compactor could not start: ${outcome.reason}`;
    level = "warning";
  } else {
    word = "next session";
    reason = "Enabled. It turns on at the next session start.";
  }
  return { word, reason, level };
}

/** The status of this project's memory: one result for the row, help and report. */
export function projectMemoryStatus(
  ctx: ExtensionContext,
  input: ProjectMemoryInput,
): ProjectMemoryStatus {
  const runtime = input.runtime;
  const active = runtime?.active ?? false;
  const failing = runtime?.failing;
  const outcome = runtime?.outcome;
  let projects: string[] = [];
  let configError: string | undefined;
  try {
    projects = readConfig().memoryProjects;
  } catch (error) {
    configError = reason(error);
  }
  const match = matchProject(ctx.cwd, projects);
  // A malformed agent definition anywhere in the definitions directories makes
  // discovery throw. The status still has to render, so the model reads unset
  // and the reason names the definitions instead (DESIGN §4.4).
  let compactor: Pick<
    ReturnType<typeof resolveCompactorDefinition>,
    "model" | "thinking"
  > = {};
  let definitionsError: string | undefined;
  try {
    compactor = resolveCompactorDefinition(ctx);
  } catch (error) {
    definitionsError = reason(error);
  }

  const {
    word,
    reason: reasonText,
    level,
  } = firstMatch({
    active,
    failing,
    outcome,
    role: input.role,
    saved: ctx.sessionManager.getSessionFile() !== undefined,
    configError,
    definitionsError,
    listed: match.listed,
    model: compactor.model,
  });

  let store = "Store: unavailable";
  if (match.resolved) {
    const root = projectMemoryRoot(match.project);
    store = existsSync(root)
      ? `Store: ${root}`
      : `Store: ${root} · not created yet`;
  }
  const report = [
    `Project memory: ${word}`,
    reasonText,
    `Project: ${match.project} · ${match.listed ? "enabled" : "not enabled"}`,
    compactor.model === undefined
      ? "Compactor: unset"
      : `Compactor: ${compactor.model} · ${compactor.thinking ?? "low"}`,
    store,
  ].join("\n");

  return {
    word,
    reason: reasonText,
    level,
    report,
    project: match.project,
    projectResolved: match.resolved,
    listed: match.listed,
    configError,
    model: compactor.model,
  };
}

export function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error: /, "");
}
