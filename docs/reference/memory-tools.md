# Memory tools

[Documentation index](../README.md)

The Lead's project memory is a bounded view of one-line summaries. The `zoom`
and `date` tools read it. They are registered for the Lead and active only while
[project memory](../concepts/memory.md) is active for the session.

## The view line format

A view line is:

```text
id+n|text
```

`id` is the first message the line covers and `n` is how many messages it
covers. `n` is a power of two. A line whose summary is not built yet shows the
placeholder `(not summarized yet: zoom it)`. A summary that dropped exact
values ends in the `…[ids]` marker.

## zoom

```text
zoom(id, n)
```

- `id`: integer, at least 0.
- `n`: integer, at least 1, a power of two. `id` must be a multiple of `n`.

`zoom` opens the line `id+n` into the two lines it was made from:
`id+n/2|text` and `(id+n/2)+n/2|text`. An unbuilt child shows the placeholder,
and a child at or past the project log count is omitted.

`zoom(id, 1)` returns message `id` whole, as `kind: text`, together with its
images. Images are loaded from the Pi session file that owns the message. When
that file is gone, the result says `[image unavailable: session file missing]`.

`id` must be below the project log count `T`, which includes the messages logged
so far in the current turn. Ids are project log indices, so the same id resolves
the same message in every session of the project.

A call that breaks a rule fails with one sentence naming the rule and a valid
form, for example `n must be a power of two: use zoom(id, 1), zoom(id, 2),
zoom(id, 4), …`.

## date

```text
date(id)
```

- `id`: integer, at least 0, below the project log count.

`date` returns the message's stored date as local `YYYY-MM-DD HH:MM:SS` plus the
UTC offset, for example `2026-01-02 03:04:05 +01:00`.

## Store layout

The store lives under the Herdsman data root at
`<Pi agent directory>/pi-herdsman/memory/<project key>/`, where the key is a
hash of the project's resolved path:

- `project.json`: `{version, key, path}`, the project the store belongs to.
- `main/YYYY-MM-DD.jsonl`: message records, one JSON object per line:
  - `i`: the message id
  - `kind`: `user`, `lead`, `tool`, `echo`, `work`, or `note`
  - `text`: the message body, read on demand
  - `size`: the body's UTF-8 byte length
  - `date`: the original timestamp
  - `src`: `{session, entry, part, images?}`, the Pi session file, entry id, and
    page index the message came from
  - `hash`: the dedupe key for backfill
- `tree/YYYY-MM-DD.jsonl`: built node lines, one JSON object per line:
  - `l`, `i`: the node's `node(l, i)` coordinates
  - `text`: the summary line
  - `size`: its UTF-8 byte length
- `view.json`: `{version, T, chat, compaction}`, the saved view.
- `lock/`: the process lock that gives one session ownership.
