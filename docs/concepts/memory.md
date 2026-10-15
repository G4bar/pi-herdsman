# Project memory

[Documentation index](../README.md)

An ordinary Lead session normally carries its own Pi conversation, so a long
project spreads its history across many session files. Pi's native threshold
compaction folds that history into one summary when the context fills, and the
detail it drops is gone.

Project memory is the alternative. In a project listed in
[`memoryProjects`](../reference/configuration.md#schema-and-defaults), every
ordinary Lead session shares one never-ending project log for that project. The
log survives `/new` and restarts, and nothing is deleted from it. The Lead never
reads the log directly: the log is compressed into a tree of one-line summaries,
and the Lead reads a bounded `<chat>` view of that tree.

## The shape of it

```text
messages ──▶ append-only log ──▶ summary tree ──▶ bounded view ──▶ each request
             main/*.jsonl         tree/*.jsonl     <chat> 128 → 64 KB
```

## Inspiration

The design comes from Victor Taelin's
[UniiChat: one chat that never ends](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).

Herdsman adopted:

- one append-only log as the source of truth, with the full original messages
  kept on disk;
- a binary tree of one-line summaries, each at most 512 bytes, built by model
  calls;
- a bounded view that shows recent messages in detail and older ones more
  compressed;
- `zoom(id, n)` to open a line back down to the original message and `date(id)`
  for its timestamp;
- provider prefix caching, so unchanged view blocks are read from cache across
  turns.

Herdsman changed:

- **Scope.** One memory per project, shared by every ordinary Lead session in
  it, instead of one chat. The log is keyed by the project's resolved path.
- **Opt-in.** A project file cannot enable memory, because every enabled project
  spends model calls on compaction. The user enables it in user-wide
  configuration.
- **The compactor.** Summaries are written by the reserved `compactor`
  definition as direct model calls, with the user's chosen model.
- **Exact-identifier safety.** Summaries that drop exact values end with
  `…[ids]`, and a `tool_call` gate blocks seven actions on identifiers seen only
  in a summary.
- **When the tree grows.** A view queues the merges it will need once it is
  within 90% of its bound, so the tree grows where a view asks for it.

## The view

The view is the Lead's memory: the whole project conversation, oldest first,
inside `<chat>` tags, as one-line summaries. Each line is named `id+n`, where
`id` is the first message it covers and `n` is how many messages it covers. The
Lead opens a line with [`zoom`](../reference/memory-tools.md#zoom) and reads a
message's time with [`date`](../reference/memory-tools.md#date).

Recent lines cover one message each. Older lines cover more, because adjacent
lines are merged in pairs into one shorter line. A message that has no summary
yet shows the placeholder `(not summarized yet: zoom it)`. A message too long
for one line is split over several messages in a row. A summary that dropped
exact values ends with the `…[ids]` marker, so the Lead knows to zoom before
using them.

The view is sent as 4-line blocks, and cross-turn view caching relies on
provider prefix caching: on Anthropic, Herdsman adds one cache mark at the last
fully built block of the view.

## The gate

A Pi `tool_call` gate requires the exact identifiers in seven actions
(`delegate_agent`, `continue_agent`, `reply_agent`, `steer_agent`,
`interrupt_agent`, `edit`, `write`) to have been seen verbatim in the current
turn, not only inside summary lines. A value that appears only in a summary is
blocked, and the Lead is told which line to zoom. The `…[ids]` marker on a
summary is what makes the omission visible, so a missing value cannot look like
a value that was never there.

## Pi's native compaction

Pi's threshold compaction summarizes a session's history into one summary when
the context fills, and the session continues from that summary. Project memory
replaces that history with the project view instead: the view is bounded and
grows only at its end, and its detail stays recoverable through `zoom`.

Threshold compaction is cancelled in the owning session, because the view
already replaces the history Pi would summarize. Overflow recovery and a manual
`/compact` stay native, so Pi can still reduce context to make a request
possible.

## Opt-in

Memory is off unless the project's directory is listed in the user-wide
`memoryProjects` setting. The match is exact: a session's resolved working
directory must equal a listed directory, so parent and child directories do not
match. Moving a project directory starts a new memory, because the store is
keyed by the resolved path.

An empty list leaves every session on Pi's native history. See the
[project memory guide](../guides/project-memory.md) for the exact setting, the
required compactor model, and how to turn memory off again.

A project also needs a compactor model before memory activates. There is no
default, so the session stays native and prints one notice until a model is
chosen in `/herdsman definitions` (see the
[compactor](../guides/customizing-agents.md#project-memory-compactor)).

## Project scope

There is one memory per project, shared by every ordinary Lead session in it.
The log is chronological and append-only, so `/tree` and `/fork` never rewind
it: messages from abandoned branches and forks stay in it.

Exactly one session owns the memory at a time, under a process lock. A second
concurrent session in the same project cannot acquire the lock, so it runs
native with its normal Pi history and is told why.

When a session opens, memory backfills the branch it is resuming as `note`
messages, one per unimported message. Backfill deduplicates entries by content
hash, so resuming or forking the same branch imports nothing twice. Backfilling
a long existing session costs about two compactor calls per imported message.

## Compaction

The reserved `compactor` definition builds the tree with direct model calls, not
as a managed session. It resolves model and thinking level through the normal
definition layers, so a project or the user can give it a cheaper model. The
compactor model is the user's choice: there is no default and it is never
inherited, so project memory stays off, with one notice, until a model is
chosen in `/herdsman definitions`. The bundled definition pins `thinking: low`:
the compactor runs on every message, so it starts cheap instead of inheriting an
expensive Lead's thinking level. An overlay can still replace it. See
[Customizing bundled Agents](../guides/customizing-agents.md#project-memory-compactor).

Known limitation: memory replaces the conversation with the project view each
turn, so a provider that keeps its own per-session conversation state (for
example pi-claude-bridge with Claude Code session reuse) cannot reuse it and may
re-send the full view every turn. A session whose Lead provider is
extension-registered is told this once when memory goes active.

Compaction costs about two model calls per logged message.

Quitting, reloading, or replacing a session waits up to 20 seconds for the
summaries still in flight, so the work already paid for is written instead of
repeated; a session with a UI says it is finishing them. Anything unfinished
after that is rebuilt on the next start.

## Cost and trade-offs

Memory costs several times more than Pi's native compaction, because the
compactor spends model calls summarizing every message; a cheap, fast compactor
model keeps that cost down. In the maintainers' long-session tests, run with
DeepSeek-family models only, memory recalled clearly more than a fresh session
but no more than continuing the same session, at several times the cost.
Summaries keep only part of the exact identifiers they cover, so exact values
need `zoom`, and the store grows without bound because nothing is deleted.

## Roles and storage

Memory belongs to ordinary Leads only. Manager, Chief, and `managed-lead`
sessions never own, read, or write it, and managed Agents are unaffected.

The store lives under the Herdsman data root at
`<Pi agent directory>/pi-herdsman/memory/<project key>/`, one directory per
project. Its layout and record fields are in the
[memory tools reference](../reference/memory-tools.md#store-layout).
