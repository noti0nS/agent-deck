# Adapter research — verified integration surface

Probe date: 2026-10-23. Host: Windows, user `developer`. All findings below were
produced by running the actual binaries and reading the actual data files, not
from documentation. Anything marked _(unverified)_ was inferred from a file
layout or help text but not confirmed by observing live data.

Legend: **CONFIRMED** = observed directly. **LIKELY** = structure observed, live
behaviour not yet exercised. **RISK** = undocumented, may change between
versions.

---

## 1. OpenCode

### Binary / CLI (CONFIRMED)

```
opencode serve        Start the v2 API and web server  (--hostname --port --cors --stdio)
opencode acp          Start an Agent Client Protocol server
opencode api          Make a request to the running server
opencode service      start | restart | status | stop | get
opencode session      Manage sessions
opencode run          Run OpenCode with a message (--session, --prompt, --continue)
opencode --server     Connect to a server URL instead of the background service
opencode --standalone Run with a private server instead of the background service
opencode debug paths|config|agents
```

Key finding: OpenCode already runs a **long-lived background service**. Probing it:

```
$ opencode service status
http://127.0.0.1:49374
```

So port discovery is a one-line command, and the app does not need to launch or
manage the server at all. `--server <url>` on any client attaches to it.

### State store (CONFIRMED)

`~/.local/share/opencode/opencode.db` — SQLite (WAL mode, `.db-shm`/`.db-wal`
present). 909 sessions, 29,346 messages at probe time.

Relevant tables and columns:

| table | columns of interest |
|---|---|
| `session` | `id, project_id, parent_id, slug, directory, title, version, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_compacting, time_archived, workspace_id, path, agent, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, metadata` |
| `message` | 29k rows, join to `session` |
| `part` | `id, message_id, session_id, time_created, time_updated, data` (JSON payload per streamed part) |
| `todo` | `session_id, content, status, priority, position` |
| `permission` | `id, project_id, action, resource, time_created` |
| `event` | `id, aggregate_id, seq, type, data, created` — **0 rows**, not a usable replay log |
| `project`, `project_directory`, `worktree`, `workspace`, `session_pending`, `session_inbox` | project + multi-session metadata |

Notes:
- `parent_id` on `session` gives the **subagent tree** for free.
- `time_compacting` gives an explicit "compacting context" state — rare and useful.
- `cost` + all 5 token counters are pre-aggregated per session. No estimating needed.
- `permission` table is a record, not necessarily the *pending* queue; the live
  pending set must come from the API.
- `event` being empty means: **do not build on the DB event log**. Use the HTTP
  event stream for liveness, the DB for history/richness.

### Read strategy

1. `opencode service status` → base URL (cache, re-probe every 30 s).
2. `GET {base}/event` server-sent events → live state transitions.
3. `GET {base}/session` → session list snapshot.
4. Read `opencode.db` **read-only** via `file:...?mode=ro&immutable=1` for
   titles, costs, todos, and history beyond the API window.

Never write to the DB. WAL + read-only URI avoids taking locks the TUI cares about.

---

## 2. Claude Code

### Binary (CONFIRMED)

Hooks are a first-class feature (`--bare` exists specifically to *skip* hooks,
which confirms they are the intended extension point). `--bg/--background`
creates background sessions that keep running detached from the terminal — these
must be surfaced by the monitor or the user loses track of them.

### Transcripts (CONFIRMED)

`~/.claude/projects/<project-slug>/<session-uuid>.jsonl`

Observed line `type` distribution in one recent session:

```
assistant 163, attachment 134, user 77, last-prompt 40, mode 39,
permission-mode 39, atis-latch 39, ai-title 38, system 12,
file-history-delta 11, file-history-snapshot 4, queue-operation 4
```

Notable:
- `ai-title` gives a human title for the session — use it for the card title.
- `last-prompt` lets you show "what the user asked" without parsing the transcript.
- `file-history-delta` / `file-history-snapshot` describe file edits.
- There is **no explicit running/idle flag**. Liveness must be inferred from
  hook events + file mtime. This is the main gap versus OpenCode.
- `~/.claude/sessions/` exists but was empty at probe time _(unverified)_.

### Read strategy

Dual source, deliberately:

- **Hooks** (`~/.claude/settings.json`) → authoritative low-latency state
  transitions. Candidate events: `SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `PostToolUse`, `Notification` (permission requests / idle),
  `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd`.
- **JSONL tailer** → transcripts, token counts, titles, file history.

Hooks receive JSON on stdin. The shim must be fire-and-forget (UDP datagram) so a
bug in the monitor can never block or fail the CLI.

---

## 3. Codex

### Binary (CONFIRMED)

```
codex agents          Browse all agent sessions on the shared local app-server daemon
codex app-server      [experimental] Run the app server or related tooling   (--remote ws://host:port)
codex remote-control  start | stop | pair      (--json)
codex exec-server     [EXPERIMENTAL] standalone exec-server service
codex exec / e        non-interactive run
codex resume          --last / picker
```

Key finding: there is a **shared local app-server daemon that already
multiplexes every agent session**, and `codex agents` is a client for it. That is
the native equivalent of what this app wants to be, per-tool. Also
`remote-control pair` produces a short-lived pairing code — the same pattern this
app should use for tablet pairing.

`~/.codex/app-server-daemon/` and `~/.codex/app-server-control/` exist on disk.

### Rollouts (CONFIRMED)

`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`

Line `type` distribution: `event_msg 1895`, `response_item 1637`,
`token_usage_record 440`, `turn_context 23`, `world_state 3`, `compacted 2`,
`session_meta 1`.

`event_msg` payload types observed: `task_started`, `task_complete`,
`item_completed`, `token_count`, `thread_settings_applied`,
`thread_goal_updated`.

This is a genuinely good event stream: `task_started`/`task_complete` map directly
to run start/end, `token_usage_record` gives real cost inputs, `compacted` maps to
the compacting state, `thread_goal_updated` is a free "goal" field.

### Read strategy

1. `codex agents` / app-server JSON-RPC (experimental) → live multi-session state.
2. Rollout JSONL tailer → authoritative history, tokens, goals.
3. Optional `notify = [...]` in `~/.codex/config.toml` → push events on turn end
   (lowest latency, but writes to the user's config; must be opt-in).

---

## 4. agy (Antigravity CLI)

### Binary (CONFIRMED)

Global flags that matter enormously:

```
--output-format text|json|stream-json     print mode
--input-format  text|stream-json          NDJSON in, one turn per line
--remote-control                          create a remote connection for the session on startup
--mode accept-edits|auto|plan
--agent, --model, --effort, --project, --sandbox
--conversation <id>, --continue, --prompt-interactive
--dangerously-skip-permissions
```

Subcommands: `agent`, `models`, `mcp`, `plugin`, `remote-control`
(`start|status|stop`), `mic-serve`, `agentapi`.

`agentapi` is an undocumented RPC surface:

```
agentapi get-conversation-metadata <conversation_id>
agentapi new-conversation [--model] [--title] [--profile] <prompt>
agentapi send-message [--title] <recipient_id> <content>
```

`~/.gemini/antigravity-cli/bin/agentapi.bat` is just a shim to `agy agentapi`.

`agy remote-control status` at probe time:
```
Daemon status: not registered
Instance name: not assigned yet; the daemon generates one on its first start.
```
→ the remote-control daemon is opt-in and currently off. Enabling it is the
highest-fidelity path, but it changes machine state, so it must be an explicit,
reversible user choice.

### Data store (CONFIRMED)

`~/.gemini/antigravity-cli/`

| path | what |
|---|---|
| `conversations/<id>.db` | SQLite, **per conversation**. Tables: `trajectory_meta, steps, gen_metadata, executor_metadata, parent_references, trajectory_metadata_blob, battle_mode_infos` |
| `conversation_summaries.db` | SQLite index: table `conversation_summaries` |
| `history.jsonl` | prompt history (65 KB) |
| `cli.log` | CLI log (0 bytes at probe — rotated/truncated) |
| `presence/<id>.lock` | lock files, **stale-prone** (files dated Aug 2026 present) |
| `implicit/*.pb` | protobuf side data |
| `brain/<id>/` | per-conversation working dir |
| `annotations/*.pbtxt`, `knowledge/`, `skills/`, `mcp/` | supporting state |

`steps` columns are the important ones:

```
idx, step_type, status, has_subtrajectory, metadata, error_details,
permissions, task_details, render_info, step_payload, step_format
```

That is a **per-step status machine plus permission state plus subagent links** —
i.e. everything the UI needs, already structured. And `trajectory_meta`
(`trajectory_id, cascade_id, trajectory_type, source`) plus `parent_references`
gives the cascade/subagent graph.

`executor_metadata` (`idx, data`) and `gen_metadata` look like per-step executor
and generation telemetry _(unverified — needs a read pass to decode `data`)_.

**Correction to an easy mistake:** `presence/*.lock` must NOT be used as a
liveness signal. Files from August 2026 were still present, so locks outlive
sessions and are not cleaned on crash. Use `steps.status` + `cli.log` mtime +
process presence instead.

### Read strategy

Three tiers, best-effort in order:

1. `agy remote-control start` + `status --json` → live daemon state (opt-in).
2. Per-conversation SQLite read-only → steps/status/permissions/subagents
   (works with zero configuration, no side effects).
3. `agy --output-format stream-json` when launched through the monitor wrapper →
   full fidelity, universal fallback.
4. `agentapi` for control actions (send message / new conversation) in a later phase.

---

## 5. Cross-cutting notes

- **Windows process truth**: `Get-CimInstance Win32_Process` gives pid, name,
  command line. Command line is how you distinguish `claude --bg` from a normal
  run, and how you map an `agy` process to `--conversation <id>`. Getting a
  process's cwd on Windows is unreliable; prefer the session's own recorded
  `directory` field (all four tools record one).
- **Encoding**: SQLite/protobuf payloads contain cp1252-looking text
  (`Verificar tempor�rios` observed from a DB read). Treat everything as UTF-8
  with replacement, never fail on decode.
- **Concurrency**: all four tools write continuously. Read with immutable/RO
  connections, tail with byte offsets, and never hold handles open on Windows.
- **Volatility**: `codex app-server`, `agy agentapi`, `agy remote-control` are all
  experimental or undocumented. They must sit behind capability detection, and
  every adapter needs a working file/process fallback.
