# Smoke testing

[Documentation index](../README.md)

These are maintainer acceptance checks for behavior that benefits from a real
Pi/herdr boundary.

Use disposable agents and exact-ID cleanup. Do not disturb unrelated user
workspaces or agents.

## Automated isolated smoke

Configure the smoke model once for the repository:

```sh
git config --local pi-herdsman.smoke-model \
  'provider/model:thinking'
```

Repository Git configuration is shared by linked worktrees by default, so the
same smoke profile applies when a Lead or managed Agent runs the harness from
another worktree. A user-wide fallback can instead be configured with
`git config --global`.

Override it for one invocation with:

```sh
npm run smoke -- chief-tree --model 'provider/model:thinking'
```

Run the live harness from a Pi session managed by Herdr:

```sh
npm run smoke
npm run smoke -- core
npm run smoke -- continuation
npm run smoke -- chief-tree
npm run smoke -- manager-recovery
npm run smoke -- memory-cache --yes
npm run smoke -- memory-quality --yes
npm run smoke -- memory-horizon --yes
```

`npm run smoke` runs the default `core` scenario. The harness creates a
disposable named Herdr session with isolated Herdr configuration/state, Pi
configuration, and Pi session storage. It launches the current worktree's
`dist/index.js` explicitly alongside Herdr's Pi integration. The invoking
development Agent remains outside that candidate session and owns observation
and cleanup. The harness removes only resources it created.

The candidate Pi uses `--approve` for this one invocation, trusting
project-local files so project Agent definitions can be discovered. This does
not change the user's project trust setting. Pi's normal extension, skill,
prompt-template, and context-file discovery is disabled; the Pi Agent directory,
session directory, and Herdr XDG configuration/state directories remain isolated.
`chief-tree` additionally loads a disposable, root-only Pi probe extension;
managed descendants do not load the probe.

The available scenarios are `core` (nested delegation and candidate-extension
propagation), `continuation` (persisted Pi-session continuation across managed
generations), `chief-tree` (current Chief/session_tree behavior), `memory-cache`
(the Anthropic view-mark cache measurement in an ordinary Lead session),
`memory-quality` (project memory against native Pi compaction in an ordinary
Lead session), `memory-horizon` (project memory against a continuing native Pi
session over five segments), and `manager-recovery`
(Manager delegation, review messaging, `stop_lead`, missing
worktree reconstruction with exact Pi-session continuity, retained project
messages across Manager turnover, and Herdr-driven project retirement).
`chief-tree` records ordinary Lead, Chief, and post-`session_tree` tool
snapshots and verifies Chief differs from Lead while selecting a pre-Chief
branch restores ordinary Lead tools. It does not
replace the broader manual Chief supervision checks below.

For runtime changes to settlement or tool selection, verify cancellation does
not deliver partial assistant text as a successful result and verify the
explicit tool allowlist excludes a disposable forbidden MCP probe. The
`tool-policy-diagnostic.mjs --provider-tools-check` diagnostic exercises the
provider-tool name extractor, while `--dispatch-check` runs Pi's native agent
loop with a forbidden tool call and verifies it cannot execute. For the full
runtime check, load the diagnostic extension with a disposable
`mcp__policy_probe__forbidden` tool as described in
[Customizing bundled agents](../guides/customizing-agents.md); verify it is
absent from the explicit allowlist's active and provider tool sets and remains
available only when the allowlist is omitted.

Each scenario is one acceptance invocation. Smoke reports immediate failures,
inactivity stalls, and hard timeouts separately. Provider-backed stages allow
longer silence because Pi persists ordinary messages at `message_end`; local
control transitions use a shorter inactivity budget. Read-only observations
may tolerate brief transient failures, but smoke never retries a mutation whose
delivery is ambiguous. Failure diagnostics and cleanup are bounded. A failed
scenario is never automatically rerun and converted into a pass: success means
one successful invocation.

The harness must run inside Herdr and requires a configured smoke model or an
explicit `--model` override. The smoke model is independent of the invoking Pi
session's active model and reasoning level. Live smoke uses real provider
credentials and usage. Live scenarios may fail; running one is not
evidence of a pass. It does not replace or reconfigure the installed
Herdsman, copy normal Pi settings or extensions, or run as part of
`npm run validate`. Run selected scenarios according to the change being
verified; `npm run smoke` defaults to `core`.

The `memory-cache`, `memory-quality` and `memory-horizon` scenarios do not
create their own nested Herdr session: the harness cannot drive a multi-turn
ordinary Lead session, so they drive Pi in RPC mode with the Lead
environment (an isolated
`PI_CODING_AGENT_DIR`, `HERDR_ENV=1`, and no managed-agent identity) and load
this worktree's `extension/index.ts` directly, so no build is needed. Delegation
steps use the invoking Herdr workspace, so the real Pi agent directory must
contain Herdr's `herdr-agent-state.ts` integration; the scenario copies it into
the temporary agent directory. In that workspace the harness closes the Herdr
tabs and panes those delegations create when a Lead child exits, whether it ends
normally, fails or is killed, and from its own Ctrl+C/SIGTERM guard; it closes
only topology that appeared after the run started and holds a pane whose cwd is
under the run's temporary root, so unrelated tabs are never touched. A hard kill
of the harness itself (`SIGKILL` of `node`) cannot sweep.
`memory-horizon` delegates real agents, so it is
the one scenario that refuses to start, with a clear message, when that
integration is missing. All three make real model calls and print a cost
estimate; all three refuse to start without `--yes`.

`memory-cache` measures the Anthropic-only view prefix mark by running the same
fixture twice, once with the mark and once with
`PI_HERDSMAN_MEMORY_DISABLE_VIEW_MARK=1`, in a randomized arm order. Each arm
runs eight no-tool prose turns. The default Lead model is
`opencode-go/claude-haiku-5-5`, which fronts the Anthropic Messages API through
the opencode-go proxy; `--model` overrides it. An `anthropic/*` model is refused
unless `--allow-anthropic` is passed. The compactor stays
`opencode-go/deepseek-v4.1-flash`. The scenario passes when the with-mark turn
cache ratio reaches 0.95; no gap between turns may exceed four minutes. The
report carries both arm ratios, the informational compaction ratio, the store
and session bytes per message, the model ids and the arm order.

`memory-quality` is the long orchestration A/B: two arms once each, in a random
order.

- `memory`: the throwaway project is listed in `memoryProjects`, so the Lead uses
  project memory.
- `native`: the project is not listed, so Pi compacts natively.

Both arms share the fixture, the fixed script of prompts, the Lead model
(`opencode-go/deepseek-v4.1-flash`), a `compactor` definition with a cheap model
and the bundled thinking level, and a
project `.pi/settings.json` whose `compaction.reserveTokens` puts Pi's native
threshold near 60k tokens. The script writes the exact early values the probes
score, then spends the bulk on large fixture reads, test runs, a second and
third delegation and a review, and ends with one cold recall probe per turn plus
one `continue_agent` action probe that exercises the zoom gate. The scenario
passes when the native arm records at least two compactions; the memory arm's
turn cache ratio stays in the report as information, because on DeepSeek it
tracks context size rather than a broken prefix. The report also carries the
recall probe scores, tokens, estimated cost, cache ratios, gate blocks and the
unprompted zoom-before-act rate, plus a Markdown table for the PR.

`memory-horizon` is the long-horizon A/B. UniiChat's claims show over days, not
in 32 turns, so the script is five segments of about sixteen turns each (98
turns with both probe sets). A segment is one `pi --mode rpc` process: that is
what `/new` and a restart do. The fixture gives the Lead a cheap
`scripts/emit.mjs <topic> <n>`
that prints about 7 KB of log lines, so most turns cost context without a large
file read, and it deliberately holds none of the facts the probes ask about:
the early decisions, the error line and the user's own phrase are planted in the
user's turns only. Three delegations (two scouts and a reviewer) run in the first
three segments.

- `memory`: the throwaway project is listed in `memoryProjects`, so every
  segment is a new session file in the same project store.
- `native-continue`: not listed, and every segment after the first passes
  `--continue`, so one session file grows across the whole run and native
  compaction handles it. This is the fair baseline, and the one the design has
  to beat: it is the strongest continuity a Pi user gets by restarting with
  `--continue`.
- `native-fresh` (opt-in with `--with-fresh`): not listed, a new session per
  segment. It is the floor for continuity and never enters a win rule.

Flags: `--runs <n>` (default 2, and automatically 1 when the estimate exceeds
the cap), `--arms <a,b>` (default `memory,native-continue`), `--max-cost <usd>`
(default 3.00), `--quick`, `--yes` and `--keep <dir>`. The scenario prints an
estimate built from per-turn cost constants recorded in
`plans/unii-memory/results/` (the phase 10 baseline Lead cost per turn and the
phase 12 `thinking: low` compactor cost per message), and starts nothing without
`--yes`. `--max-cost` is a hard stop, not advice: the harness checks the
cumulative cost between turns and reports the run as `incomplete` when it is
exceeded. The gate and the estimate cover the Lead's own usage plus the
compactor's surfaced usage; a delegated agent's usage is not surfaced, so the
real provider spend can pass the cap by the delegations' share. `--quick` runs
two four-turn segments plus three probes instead of the
full script, for harness debugging; it skips the compaction-count check and says
so in the report.

A run is valid only when no segment had a turn error or a stalled turn, no
segment process needed SIGKILL, the `native-continue` arm recorded at least
eight native compactions (the fixture sets `compaction.reserveTokens` for a
threshold near 24k tokens), and every `memory` segment ended with at least 95%
of its view nodes built, which is what the shutdown drain exists to keep. The
report carries, per arm and run: validity and the issues behind it, cost per
segment, Lead prompt tokens per call by turn index (to show the view stays
bounded), native compactions per segment, and the memory store's built-node
share and view bytes at each segment end.

Every probe is one turn asked cold, with no hint and no mention of project
memory, and is scored automatically: a probe passes only when every `must`
string is in the answer, a behavior probe only when the file the Lead wrote
holds the right values, and the action probe only when the last `continue_agent`
attempt used the exact session id and the gate did not block it. No probe prompt
names a value it scores, and the two corrections probes ask for the current
value only, with the superseded one forbidden. Each probe row carries its
category, the segment where its fact was stated, the segment where it is asked
and its age in turns. The mid-run set (the four segment 1 facts) is asked at the
end of segment 3, so native decay is visible; the final set of fourteen is asked
at the end of segment 5 and covers exact early facts, the user's own words,
the delegation identifiers, the corrections, the behavior file and the action.

The report scores each arm and run by category, cross-session subtotal (facts
from an earlier segment asked after a restart), and age in turns, and gives the
mean and the per-run values across runs. The win rule claims "memory better"
only when memory beats `native-continue` by at least two probes in every paired
run and in the mean, and "native better" under the symmetric rule; otherwise it
reports "no claim". `native-fresh` is informational: it measures what
continuity is worth and never enters the rule. The report also carries the phase
10 gate numbers per arm and run (`blockedShare`, `verbatimBeforeAct`,
`zoomShare`, `blockRecovered`), per-segment cost and compactions, and the store
numbers at each segment end.

The view's boundedness and the recovery claims are also checked without a model
by `extension/memory-scale.test.ts`. It feeds thousands of about 2 KB messages
through a real `MemoryStore` with a fake compactor that returns deterministic
512-byte lines, and asserts that the chat view stays under its bound after every
batch, that a batch returns the view to its target, that the tree grows one node
per message and merge, that a close and a fresh load keep the same view with no
rebuild, and that any message is still readable by its id through a seek to the
recorded offset rather than a read of the whole log.

By default a run deletes its temporary root, taking the project store, the Lead
session JSONL and per-node usage with it. Pass `--keep <dir>` to copy, per arm,
the project memory store (`tree/`, `main/`, `view.json`), the Lead session JSONL
and the report JSON into `<dir>/<scenario>-<arm>/` before cleanup and print the
directory. The path must be outside the repository; the default stays "delete".

`PI_HERDSMAN_SMOKE_EXTENSIONS` is a comma-separated list of extra `--extension`
paths for either scenario, for a `--model` override whose provider is not
visible to the isolated run. The direct Anthropic provider needs the user's
provider extension there (pi-black), because the isolated `--no-extensions` run
does not discover it; the extension's own identity file (`~/.claude.json`) is
read from the real home directory and never written. For example:

```sh
PI_HERDSMAN_SMOKE_EXTENSIONS="$HOME/.pi/agent/git/github.com/paoloanzn/pi-black/extensions/pi-black.ts" \
  npm run smoke -- memory-cache --yes --allow-anthropic --model anthropic/claude-haiku-4-5
```

Each report is also written to
`<tmp>/pi-herdsman-memory-cache-smoke-report.json`,
`<tmp>/pi-herdsman-memory-quality-smoke-report.json` or
`<tmp>/pi-herdsman-memory-horizon-smoke-report.json`.

## Runtime preflight

Before creating isolated smoke resources, the harness validates the current
checkout against the repository's `package.json` runtime contract: Node uses
`engines.node`, Pi uses `piHerdsman.runtime.pi`, and Herdr uses
`piHerdsman.runtime.herdr.version`. A mutable host Pi or Herdr installation may
be newer than its baseline. Smoke also requires a running Herdr server and a
compatible Herdr client/server session.

For troubleshooting, inspect the host runtime and integration status:

```sh
node --version
pi --version
herdr status --json
herdr integration status
```

These commands help diagnose the environment; integration status is not a
separate version contract.

Run focused tests and other intermediate checks before this smoke suite. Do
not format during smoke testing; complete smoke testing and review before the
final formatting and read-only verification sequence in
[Development validation](validation.md).

## Current mailbox contract

For a current managed run, inspect the persisted state, request, ask, and
result records and verify they use protocol version `5` and contain no lifetime
field. Control prompts use the `__PI_HERDSMAN_AGENT_V5__:` marker prefix.

## One-shot definition and session continuation

Delegate a small deterministic read-only task to the `scout` definition. Record
the returned agent, request, session, and pane identities.

Verify:

- one managed agent starts;
- the task is acknowledged;
- the agent completes with exactly one result reaching the owner;
- the terminal result identifies the exact session;
- cleanup removes the agent, pane, mailbox, and runtime;
- the exact Pi session remains available.

Use the exact returned session ID or path for a follow-up assignment:

```json
{
  "session": "<exact session>",
  "task": "Continue the investigation with one short follow-up."
}
```

Verify:

- the same Pi session and session file are used;
- a new agent generation, run ID, request ID, and pane are created;
- the saved logical label is reused exactly (there is no continuation label override);
- the saved conversation context is available;
- the current effective definition configuration is used, with omitted model and
  thinking fields restoring the saved session settings;
- exactly one result reaches the owner;
- cleanup removes the second agent, pane, mailbox, and runtime.

While the continuation assignment is active, submit another `continue` request
for the same exact session. Verify it fails with
`agent_busy`, creates no duplicate agent or pane, and leaves the active
assignment unchanged. After both assignments finish, `list_agents` must show
no completed idle agent.

## Historical session continuation

Use an exact saved session path or full UUID.

Verify:

- saved definition and cwd are respected;
- the saved logical label is reused exactly;
- session continuation uses the saved cwd;
- current effective agent override values are used for the new agent
  generation;
- the exact session continues.

## Managed-agent tool policy

Launch a delegating managed agent with an explicit ordinary execution-tool
allowlist and ask it to delegate one bounded scout task. Verify that it retains
those ordinary tools and can call all nine coordination tools plus
`ask_owner`, then verify that the spawned scout is a leaf with its normal tools
and `ask_owner` but no delegation tools. Also verify that role-required tools
are not removed by `excludeTools`.

For a definition with `tools` omitted, verify that launch does not add a
`--tools` option and Pi's configured/default selection remains in effect.
For an explicit `tools` list, verify that Pi receives the selected ordinary
tools augmented with the agent's required role tools. Use the existing
`scripts/tool-policy-diagnostic.mjs` with a disposable
`mcp__policy_probe__forbidden` tool that the explicit allowlist does not select.
Verify that the probe is not active or provider-visible, an attempted forbidden
dispatch cannot execute it, and an allowed control tool remains callable.
With `tools` omitted, verify that the configured probe remains ambient under
Pi's normal selection. The probe is disposable validation infrastructure only.
Confirm result delivery,
integration, and cleanup for all one-shot agents.

## Body reference expansion

Create a temporary global definition with a whole-line body reference:

```markdown
---
name: generalist
bodyMode: append
---

@../temporary-policy.md
```

Use a distinctive instruction in the referenced file.

Verify the agent obeys that instruction through the expanded private prompt.

Afterward remove the temporary definition and referenced file, confirm discovery
no longer lists the temporary definition, and verify no repository file changed.

## `ask_owner` round trip

Owner ask/reply remains manual, unautomated coverage.

Give an agent a task whose correct continuation requires an owner choice.

Verify:

1. agent calls `ask_owner` alone;
2. owner receives one question;
3. agent becomes `blocked`;
4. owner replies with exact `reply_agent`;
5. reply continues the same assignment;
6. agent produces exactly one final result;
7. no agent/mailbox leak remains.

## Delegating-agent turn ending

Ask a delegation-enabled controller to delegate required reconnaissance when no
other concrete, necessary independent work is known.

Inspect the actual transcript and verify the delegating agent:

- ends its turn after the assignment when nothing else useful is independently actionable;
- does not repeat the delegated reconnaissance locally;
- does not manufacture adjacent analysis merely to remain active;
- does not delegate substantially overlapping reconnaissance to another agent;
- does not poll `list_agents`;
- does not use `inspect_agent`, `read_agent_transcript`, or `steer_agent` merely to check progress;
- does not send "finish", "status", or equivalent progress nudges to a healthy
  agent;
- does not sleep or use another mechanism to keep the turn alive;
- the agent result resumes the controller session;
- integrates the result into one final delegating agent outcome.

## Useful concurrency

Delegate bounded task A and give the controller concrete, necessary independent
local task B.

Verify:

- B proceeds while A is active;
- B does not repeat A's assigned scope;
- once B is sufficiently complete, the controller reassesses instead of
  manufacturing more work;
- if further useful progress depends on A, the controller ends its turn;
- A's result resumes the controller and is integrated.

Also verify a controller with two already-known independent delegated objectives
may delegate A and B before ending its turn. It must not create a third
assignment merely to increase concurrency.

## Lead command menus

In a lead session with UI:

### `/herdsman` and `/agents`

Verify both `/herdsman` and `/agents` open the same eight destinations
`Execution`, `Agents`, `Project manager`, `Project memory`, `Session stats`,
`Definitions`, `Settings`, and `Advanced…`.
Verify active role state is secondary metadata and selected-row contextual help
updates in the TUI. `/herdsman → Agents` opens only `Running`, `Layout`, and
`Stop all…`, with the running count and effective placement as secondary
metadata. `Execution` shows the current ordinary mode and opens the Flexible /
Orchestrate selector; an assigned Lead shows Managed with `managed-lead` help
and no ordinary mode choices. `/lead` opens the same selector, while
`/lead flexible` and `/lead orchestrate` select directly through that control.
Verify assigned Leads cannot switch out of Managed and that takeover starts
ordinary Orchestrate execution. Settings contains Default Lead execution,
Manager auto-start, Context retirement, and Message limits. Verify changing
the default affects a future ordinary session without changing the current
session.

Navigate to Project manager and Chief mode from the menus. Confirm their
Start, Overview, and Leave actions use the existing `/manager` and `/chief`
role behavior.

### `/herdsman definitions`

Verify the native Definitions list shows:

- actionable definitions in one flat list, with reserved
  `flexible-lead`, `orchestrator-lead`, `managed-lead`, and `compactor` first
  in that canonical order;
- contributing source words `bundled`, `project`, and `global`, including
  combinations where multiple sources contribute;
- unpadded definition-name labels, with model, thinking, and provenance as
  secondary metadata, including Unicode names;
- model, thinking, enabled, and details actions for a selected definition;
- `Inherit current session` for model and thinking;
- selected-row contextual help and width-safe layout in narrow panes.

All three reserved Lead definitions remain non-Agent. `flexible-lead` and
`orchestrator-lead` have Details only; `managed-lead` has Model, Thinking, and
Details, but no Enabled action. The reserved `compactor` is non-Agent as well:
it has Model, Thinking, and Details, but no Enabled action, and its model and
thinking drive project memory compactions. Runtime-profile definitions reject
launch-only
fields such as model, thinking, extensions, skills, and context inheritance;
`compactor` rejects every field except `name`, `description`, `model`,
`thinking`, and `bodyMode` on a matching overlay.

Structured `list_agents` should still retain exact deterministic metadata.

Select a disposable bundled, project, or global definition and change its
model, thinking, and enabled state. Confirm that project discovery requires Pi
project trust and that these edits write global overrides only, not project
files.

Verify unrelated frontmatter and body remain unchanged, `Inherit current session`
removes only the selected field, fresh definition delegations inherit the
spawning controller's current value, continuations restore the saved session's
value, and running agents are not mutated.

### `/herdsman placement`

Open the native selector, change to the alternate value, verify, then restore
the original value.

### `/herdsman stop`

With disposable owned agents, verify the owned tree closes while an unrelated
herdr agent remains untouched.

## Failure diagnostics

Use a disposable invalid resource/launch configuration only when safe.

Verify startup failure:

- settles within the bounded budget;
- reports the stage and best available diagnostic;
- performs exact ownership-safe rollback;
- does not leave a false successful agent.

## Cleanup checklist

After every smoke:

- `list_agents` has no unintended managed agents;
- temporary global definitions are removed;
- temporary prompt/body files are removed;
- disposable herdr resources are closed by exact ID;
- no repository source file changed unless the smoke explicitly required it.

## Project Manager / Chief supervision live matrix

`manager-recovery` is the canonical automated live Manager lifecycle check. It
covers fresh delegation, project review messaging, pause/resume, missing
worktree recovery without an explicit Herdr removal event, exact Pi-session
continuity, pending project messages across Manager absence and delivery,
retirement after
successful Herdr worktree removal, and exact cleanup.

The broader matrix below remains optional exploratory acceptance for supervision
behavior not covered by the automated scenarios. A NOT RUN entry is not a claim
of failure.

The manual checks below are **NOT RUN**, not claims of failure or success.
Automated live scenario results are separate and do not replace these checks.

| Scenario                                                                                                                                                                            | Result  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Ordinary and managed Leads have `message_supervisor` and peer tools, not staff tools; Manager has staff/project tools; Chief has staff tools only                                   | NOT RUN |
| Selecting a pre-Chief Lead branch through `/tree` exits Chief mode and restores ordinary Lead lifecycle/tool state                                                                  | NOT RUN |
| Leaving Chief persists `role` plus exact `leadTools`; resume repairs stale restored Chief tools before another model turn                                                           | NOT RUN |
| A legitimate ordinary branch loadout is preserved instead of being overwritten by an older `leadTools` checkpoint                                                                   | NOT RUN |
| Persisted Chief resume collision becomes suspended                                                                                                                                  | NOT RUN |
| Ordinary losing `/chief` collision remains a lead with its tools and offers Focus/Cancel                                                                                            | NOT RUN |
| Delegating agent and agent retain their current role tools                                                                                                                          | NOT RUN |
| Activate one Chief with `/chief`                                                                                                                                                    | NOT RUN |
| Activation refuses a lead with owned or unresolved agent work                                                                                                                       | NOT RUN |
| Two exact simultaneous Chief claims have one winner                                                                                                                                 | NOT RUN |
| Stale exact lease recovery                                                                                                                                                          | NOT RUN |
| Malformed role, lead state, lease, or descriptor fails closed; coordination publication invalidates stale state and disables actions                                                | NOT RUN |
| Discover leads across multiple workspaces                                                                                                                                           | NOT RUN |
| Exclude managed agents and the active Chief from leads                                                                                                                              | NOT RUN |
| Agent exclusion uses the production validated snapshot and stale/ambiguous generations fail closed                                                                                  | NOT RUN |
| Herdr `agent_status` lifecycle normalization is reflected                                                                                                                           | NOT RUN |
| Nested agent aggregation attaches only to the proven lead                                                                                                                           | NOT RUN |
| A blocked agent does not mark its lead `needs you`                                                                                                                                  | NOT RUN |
| Duplicate live agents, coordination records, or agent evidence fail closed                                                                                                          | NOT RUN |
| Target disappearance or replacement between list and action is rejected                                                                                                             | NOT RUN |
| Inspect a lead and compare bounded peek evidence                                                                                                                                    | NOT RUN |
| Read `read_staff_transcript` when `transcript` is advertised; the action validates the persisted session header, version, and exact Pi session ID; content is bounded and read-only | NOT RUN |
| `inspect_staff` exposes live terminal/process evidence while `read_staff_transcript` exposes persisted conversation/tool evidence                                                   | NOT RUN |
| Focus a lead after exact revalidation                                                                                                                                               | NOT RUN |
| Chief `message` to idle, working, or blocked leads                                                                                                                                  | NOT RUN |
| Two Chief messages queue and arrive once and in order                                                                                                                               | NOT RUN |
| A quarantined message does not block a new message to the same lead                                                                                                                 | NOT RUN |
| Leads retain descendant ownership after a Chief `message`                                                                                                                           | NOT RUN |
| Ordinary Lead `message_supervisor` reaches the active Chief                                                                                                                         | NOT RUN |
| Managed Lead can use nonblocking `message_supervisor` for timely Manager coordination before its normal result handoff                                                              | NOT RUN |
| Routine information waits for the automatic result; timely messages and later results are not deduplicated                                                                          | NOT RUN |
| Metadata publication failure does not remove communication eligibility                                                                                                              | NOT RUN |
| Ordinary lead messages leave lead coordination state unchanged                                                                                                                      | NOT RUN |
| Downward message_staff to an active direct report uses Pi steering; non-supervisor inbox traffic remains deferred                                                                   | NOT RUN |
| Receiver restart delivers each queued message once                                                                                                                                  | NOT RUN |
| Accepted-before-delete crash deduplicates without reinjection                                                                                                                       | NOT RUN |
| Failed delivery/acceptance retains the queued record                                                                                                                                | NOT RUN |
| Transient authorization lookup failure retains the queued message                                                                                                                   | NOT RUN |
| Stale lease, wrong sender/generation, duplicate identity, and malformed records fail closed                                                                                         | NOT RUN |
| Lead/Chief messages show bounded direction-aware model-visible sender and target identity                                                                                           | NOT RUN |
| Queued inbox records are ordered by `createdAt`, then ID                                                                                                                            | NOT RUN |
| Resume with a free or occupied lease                                                                                                                                                | NOT RUN |
| Confirm `/chief leave` without mutating supervised leads                                                                                                                            | NOT RUN |
| Suspended Chief retains no Herdsman authority tools                                                                                                                                 | NOT RUN |
| Descendant `working`, `settling`, and `blocked` states remain exact; counts report `active`, `blocked`, and `total`                                                                 | NOT RUN |
| Chief rows separate `!` attention from lifecycle: `●` working, `◐` blocked, `?` unknown, and `◉` delegated active descendants                                                       | NOT RUN |
| Empty-roster Escape closes the native custom UI                                                                                                                                     | NOT RUN |
| Empty-roster Ctrl+C closes the native custom UI                                                                                                                                     | NOT RUN |
| Real terminal arrow sequences navigate the visual order                                                                                                                             | NOT RUN |
| Space switches overview to peek and Escape/Space returns without nested custom UI                                                                                                   | NOT RUN |
| Ctrl+C closes from peek                                                                                                                                                             | NOT RUN |
| Enter focuses the lead and closes the overview                                                                                                                                      | NOT RUN |
| Background refresh redraws the open overview                                                                                                                                        | NOT RUN |
| Ambient and overview rendering stay within the supplied width                                                                                                                       | NOT RUN |
| Named herdr sockets independently support one Chief each                                                                                                                            | NOT RUN |

Named herdr socket independence remains **NOT RUN** in this manual matrix.
See [Validation](validation.md) for the repository test gate.
