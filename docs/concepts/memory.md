# Project memory

[Documentation index](../README.md)

An ordinary Lead session normally carries its own Pi conversation, so a long
project spreads its history across many session files. In a project listed in
[`memoryProjects`](../reference/configuration.md#schema-and-defaults), every
ordinary Lead session instead shares one append-only project log. The log is
compressed into a tree of one-line summaries and shown to the Lead as a bounded
`<chat>` view.

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

## Opt-in

Memory is off unless the project's directory is listed in the user-wide
`memoryProjects` setting. The match is exact: a session's resolved working
directory must equal a listed directory, so parent and child directories do not
match. Moving a project directory starts a new memory, because the store is
keyed by the resolved path.

An empty list leaves every session on Pi's native history.

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
definition layers, so a project or the user can give it a cheaper model. See
[Customizing bundled Agents](../guides/customizing-agents.md#project-memory-compactor).

Compaction costs about two model calls per logged message.

Threshold compaction is cancelled in the owning session, because the view
already replaces the history Pi would summarize. Overflow recovery and a manual
`/compact` stay native, so Pi can still reduce context to make a request
possible.

## Roles and storage

Memory belongs to ordinary Leads only. Manager, Chief, and `managed-lead`
sessions never own, read, or write it, and managed Agents are unaffected.

The store lives under the Herdsman data root at
`<Pi agent directory>/pi-herdsman/memory/<project key>/`, one directory per
project. Its layout and record fields are in the
[memory tools reference](../reference/memory-tools.md#store-layout).
