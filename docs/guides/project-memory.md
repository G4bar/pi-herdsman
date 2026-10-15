# Project memory guide

[Documentation index](../README.md)

In an opted-in project, ordinary Lead sessions share one never-ending memory
instead of starting from an empty Pi history. This guide covers enabling it,
choosing the compactor model, checking that it is active, turning it off, and
where its data lives. [Project memory](../concepts/memory.md) explains what it
is and how it works.

Use it when a Lead works in the same project for weeks and its early decisions,
paths, and session ids must stay recoverable. Leave it off when sessions are
short or when Pi's native compaction is enough.

## Cost and limits

Compaction is direct model calls, roughly two per logged message, and the
compactor is the main cost of memory. The store is never pruned, so it grows
without bound. Summaries keep only part of the exact identifiers they cover, so
exact values need `zoom`. See
[Cost and trade-offs](../concepts/memory.md#cost-and-trade-offs).

## Enable memory for a project

Memory is user-wide only: nothing in a project can enable it, because an
enabled project spends model calls on compaction. Edit the Herdsman
configuration file directly and add the project's absolute directory to
`memoryProjects`:

```text
~/.pi/agent/pi-herdsman/config.json
```

```json
{
  "memoryProjects": ["/home/you/projects/my-app"]
}
```

The file holds only the settings you configure, so a file with just this field
is valid. When the file does not exist yet, create it with this content. The
default location follows Pi's agent directory; with `PI_CODING_AGENT_DIR` set,
the file is `$PI_CODING_AGENT_DIR/pi-herdsman/config.json`.

- Each entry must be an absolute path, and the list is stored resolved.
- A session matches an entry only when the realpath of its working directory is
  exactly that directory. Parent directories and subdirectories do not match, so
  open Pi in the listed directory itself.
- Duplicates are rejected, and malformed JSON, unknown fields, or a relative
  path make the whole configuration invalid.

See [Configuration](../reference/configuration.md#schema-and-defaults) for the
complete schema.

## Choose the compactor model

Memory cannot summarize without a model, and Herdsman never picks one for you.
Until a compactor model is set, every session in an opted-in project stays
native and prints one notice:

```text
Project memory is off: choose the compactor model in /herdsman definitions -> compactor -> Model
```

Choose it in the interactive menu:

1. Open `/herdsman definitions`.
2. Select `compactor`.
3. Select `Model` and pick a model.
4. Optionally select `Thinking`; its clear option is `Default (low)`.

The model runs on every logged message, so pick a cheap, fast model. Thinking
defaults to `low`; an overlay can replace it. Read
[Project memory compactor](customizing-agents.md#project-memory-compactor)
for the `compactor.md` overlay form, and
[the schema](../reference/agent-definition-schema.md#reserved-compactor-definition)
for the fields it accepts.

## Verify that it is active

Start a new Lead session in the listed project. Memory activates at session
start, and there is no success banner, so check any of these:

- The `Project memory is off: …` notice does not appear.
- The session's Lead has the `zoom` and `date` tools; ask it to zoom a message
  by its view id.
- The store directory for the project appears under
  `<Pi agent directory>/pi-herdsman/memory/`.

Only one session owns a project's memory at a time. A second concurrent session
in the same project runs with its normal Pi history and says
`Project memory is already open in process <pid>; this session runs without it.`
Manager, Chief, and `managed-lead` sessions never use memory.

## Turn memory off

- **For one project:** remove its directory from `memoryProjects`.
- **For all projects:** open `/herdsman definitions`, select `compactor`,
  select `Model`, and choose `Unset (project memory off)`. The row then reads
  `unset · memory off`.

Neither action deletes the stored log or the summary tree; it only stops new
summaries. Turning it back on re-reads the same store. Both actions take effect
at the next session start.

## The extension-provider notice

Some providers, such as pi-claude-bridge with Claude Code session reuse, keep
their own per-session conversation state. Project memory replaces the
conversation with the view each turn, so such a provider cannot reuse it and may
re-send the full view every turn. When the Lead's provider is one an extension
registered, Herdsman prints this notice once per session, on the first turn
memory prepares:

```text
Project memory replaces the conversation with the project view each turn, so a provider that keeps its own per-session conversation state (for example pi-claude-bridge with Claude Code session reuse) cannot reuse it and may re-send the full view every turn.
```

It is a cost warning, not an error: memory still works. It cannot be turned off
selectively; changing the Lead's provider avoids it.

## Where the data lives

One directory per project, under the Herdsman data root:

```text
<Pi agent directory>/pi-herdsman/memory/<project key>/
```

`<project key>` is a hash of the project's resolved path. The directory holds
the append-only message log, the summary tree, the saved view, and the process
lock. The
[store layout](../reference/memory-tools.md#store-layout) lists every file and
record field.

Delete the directory (with no session running in the project) to start the
project's memory over. The next session backfills the branch it resumes as
`note` messages, so only that branch is restored.

## Troubleshooting

| Symptom                                                                          | Cause                                                                                                               | Fix                                                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Project memory is off: choose the compactor model …`                            | No compactor model is set                                                                                           | Set `compactor` → `Model` in `/herdsman definitions`                                                                                         |
| `Project memory is already open in process <pid>; this session runs without it.` | Another session owns the project                                                                                    | Continue in that session, or close it and start a new one                                                                                    |
| `Project memory is inactive: …`                                                  | The compactor model is unavailable or has no credentials                                                            | Pick an available model, or configure its provider                                                                                           |
| `Project memory compaction is failing: …`                                        | Compaction model calls are failing                                                                                  | Check the compactor model, its credentials, and provider availability                                                                        |
| `Project memory log damage: N warning(s); first: …`                              | A store line is unreadable                                                                                          | The session continues with the records it can read; the damaged message's detail is lost. Delete the store directory to start over           |
| Nothing happens, and no notice appears                                           | The working directory is not exactly a listed path, the session is not persisted, or `config.json` fails validation | Open Pi in the listed absolute directory (watch for a symlink or a subdirectory); a config error is reported where the configuration is read |

## See also

- [Project memory](../concepts/memory.md)
- [Memory tools](../reference/memory-tools.md)
- [Customizing bundled Agents](customizing-agents.md#project-memory-compactor)
