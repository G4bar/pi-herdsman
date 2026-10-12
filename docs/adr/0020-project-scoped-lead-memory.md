# Use one never-ending project memory for opted-in projects

[Documentation index](../README.md)

## Status

Accepted.

## Context

An ordinary Lead session carries its own Pi conversation, so a long-lived
project spreads its history across many session files. Each new session starts
with a prompt and whatever the user repeats, and once a session is compacted or
deleted, its detail is gone. The UniiChat design describes the alternative: one
append-only log per project, compressed into a tree of one-line summaries that
the agent reads as a bounded view.

Herdsman already owns delegation, ownership, and lifecycle coordination for
Lead and Agent sessions. Project memory is a Lead-context capability, so the
decision is how much of it belongs in Herdsman and how it composes with the
existing context, compaction, definition, and role contracts.

Every compaction that builds the tree spends model calls, so memory cannot be
something that quietly turns itself on for every project.

## Decision

### Opt-in

Memory is enabled per project by the user-wide `memoryProjects` setting, a list
of absolute project directories. Nothing in a project enables it. Project files
cannot opt a project in, because enabling a project spends model calls on every
message and that cost decision belongs to the user, not to a checkout that the
user may have opened for the first time.

An empty list means Herdsman behaves exactly as it does today.

### Scope

There is one memory per project, keyed by the realpath of the session's cwd and
shared by every ordinary Lead session in that project. Exactly one session owns
it at a time under a lock. A session that cannot acquire ownership runs native,
with its normal Pi history and compaction, and shares nothing.

### Source of truth

Memory is a Herdsman-owned append-only project log under the Herdsman data root,
laid out as in the design's log section. Pi session files are not the source of
truth.

The log wins over a tree built from Pi entries across session files for three
reasons:

- Zoom latency: opening a line reads one local log, with no cross-file parsing
  of many session files.
- Survival: deleting, moving, or compacting a session file does not lose the
  project's memory.
- Order: interleaved sessions in one project get one recorded chronological
  order instead of an order that has to be reconstructed.

Images stay in the Pi session files that own them and memory refers to them by
pointer, because Herdsman does not own image storage.

Messages from abandoned branches and forks stay in memory. The log is
chronological and append-only: a line that was written stays, even when the
branch that produced it is no longer active.

### The view in the request

The view replaces history in each request through Pi's `context` event. This
departs on purpose from the preference in
[ADR 0009](0009-preserve-prompt-cache-continuity.md) for durable append-only
context over request-local transformations. It is an explicit semantic
replacement, in the same class as compaction. The byte-stable rule below limits
its cache cost, and correctness never depends on a cache hit.

The view is byte-stable within a turn. It grows only at the end of a turn,
between batch merges, and it is never rebuilt from the log. The Lead sees a
bounded view and opens detail with `zoom(id, n)` and `date(id)`.

### Native compaction

Threshold compaction is cancelled for the owning session, because the view
already replaces the history that Pi would summarize. Overflow recovery and
manual compaction stay native: when Pi needs context reduction to make another
request possible, or when the user asks for it, Herdsman does not interfere.

[ADR 0010](0010-retire-managed-agent-sessions-before-threshold-compaction.md)
governs managed Agent retirement and is unchanged by this decision.

### Roles

Memory belongs to ordinary Leads only. Manager, Chief, and `managed-lead`
sessions never own it, read it, or write to it. The threshold-compaction
cancellation in
[ADR 0010](0010-retire-managed-agent-sessions-before-threshold-compaction.md)
applies to managed Agents, and the memory owner is an ordinary Lead, so the two
never apply to the same session. The launch-policy boundary in
[ADR 0015](0015-use-reserved-definition-for-managed-project-leads.md) is
untouched. Ordinary Lead execution profiles from
[ADR 0018](0018-use-standalone-lead-execution-profiles.md) do not partition the
memory: both profiles in one project share the same log and view.

### The compactor

Summaries are written by a reserved non-Lead definition named `compactor`. It
extends the reserved-definition concept of
[ADR 0015](0015-use-reserved-definition-for-managed-project-leads.md): it is
excluded from the Agent roster, cannot be delegated to or referenced from an
`agents` allowlist, cannot be disabled, and resolves through
`bundled < project < global`.

It runs as direct model calls, not as a managed session, and it has its own
system prompt and no tools. Unlike the design's shared-prefix scheme,
compactions therefore never read the Lead's cache entry.

The cost of the separate prefix is accepted and small: every compaction prefix
is written once per prefix change, at 1.25x for the system prompt (about 1 to 2k
tokens) plus the compaction view (at most 32 KB, about 8k tokens). With 8
concurrent calls on one prefix, later calls read it at 0.1x.

Sharing the Lead's prefix instead would require an identical system prompt, tool
list, and model. Lead prompts and tool lists vary by profile and role, and the
user may deliberately give the compactor a cheaper model, which makes the shared
prefix impossible rather than merely inconvenient.

### Seeing identifiers before acting

A Pi `tool_call` gate requires the exact identifiers in seven actions
(delegate, continue, reply, steer, interrupt, edit, write) to have been seen
verbatim in the current turn, not only inside summary lines. A line is a summary
and an action needs a value: the gate is what turns "zoom before you act" from
advice into a rule.

### Lossy lines

The runtime marks a summary line that dropped an exact identifier from its input
with a fixed suffix, decided by a deterministic check rather than by the model's
judgement. The marker is a warning to the Lead that the line is incomplete, so a
missing value cannot look like a value that was never there.

### Fixed constants

512-byte lines, a 128 KB to 64 KB view, a 32 KB to 16 KB compaction view, 8
concurrent calls, and 5 retries. These are calibrated by the design's own
measurements and are defined once with the rest of the memory core in
`extension/memory.ts`, instead of being configurable knobs.

## Rationale

A project memory is the shape of context a long-lived Lead needs, and Herdsman
already owns the session lifecycle that must decide who owns it. Keeping the log
in Herdsman, rather than deriving it from Pi session files, is what makes zoom
cheap, makes the memory survive session churn, and gives interleaved sessions one
recorded order.

Opt-in through one user-wide list keeps the capability optional in the sense of
[Product philosophy](../development/product-philosophy.md): an unused
`memoryProjects` changes nothing, and no project can commit the user to spending
model calls. The store is per user and per project and never leaves the machine,
so nothing about a project's memory is shared with a provider beyond the view
and the compaction requests the user's own sessions send.

The compactor is a reserved definition rather than a hard-coded model choice for
the same reason as the managed Lead: the existing `bundled < project < global`
engine already expresses the launch settings, and the user keeps control of which
model pays for background summarization.

## Alternatives considered

- **Enable memory from project files.** Rejected because it spends model calls
  on a decision the user never made, and because a checkout cannot express a
  durable account-wide preference.
- **Build the tree over Pi entries across session files.** Rejected because zoom
  would need cross-file parsing, memory would be lost with deleted or moved
  session files, and interleaved sessions would have no recorded order.
- **Store images in the log.** Rejected because Herdsman does not own image
  storage; session files keep them and memory points at them.
- **Let Pi compact the owning session normally.** Rejected because Pi would
  summarize the same history the view already replaces, spending a model call to
  produce a second, competing summary.
- **Cancel overflow and manual compaction too.** Rejected because overflow
  recovery is what makes the next request possible, and manual compaction is a
  user request.
- **Share the Lead's cache prefix with compactions.** Rejected because it
  requires identical system prompt, tools, and model, which the Lead does not
  have across profiles and roles.
- **Run the compactor as a managed session.** Rejected because compaction is a
  bounded direct call with no tools, no ownership, and no result lifecycle, so a
  managed session would add coordination for no benefit.
- **Let the model decide when a line is lossy.** Rejected because a missing
  identifier is a deterministic property of the input and output, and the marker
  must not depend on model judgement.

## Consequences

An opted-in project has one memory shared by its ordinary Lead sessions, with
one owner at a time and native behavior for the others.

Project memory survives session deletion, moves, and compaction, and its
chronology reflects the project rather than one session file.

The memory-owning Lead session loses Pi's threshold compaction, so its request
context is the view plus the current turn. Overflow recovery remains available.

Compaction requests are billed separately from the Lead's own turns at 1.25x for
the first call on a prefix, which is the price of not sharing the Lead's cache
entry.

The `compactor` definition becomes a reserved name in the existing resolution
engine. A user override can change its model and thinking level, and project
overrides apply only when Pi considers the project trusted.

Identifier loss is visible in the model's view instead of silent, and actions on
identifiers that were only summarized fail closed at the `tool_call` gate.
