# agent-deck

A tablet-first observability deck for AI coding agents. Watch what your agents are
doing — from your desk or from the couch — without touching them.

agent-deck observes [OpenCode](https://opencode.ai), [Claude Code](https://claude.ai/code),
[Codex](https://openai.com/codex) and Antigravity sessions, normalises them into one
event stream, and renders it as a glanceable deck: what is running, what it is doing
right now, how much it costs, and what it touched.

```
 agent CLIs                     collector (:4100 http+sse, :4101 udp)
 ┌──────────┐                   ┌──────────────────────────────────────┐
 │ OpenCode │──┐                │ adapters ──▶ reducer ──▶ SQLite      │
 │ Claude   │──┼──▶ events ────▶│                 │                    │──▶ deck (browser)
 │ Codex    │──┤                │                 └──▶ SSE  ──────────▶│    tablet / phone
 │ Antigrav │──┘                └──────────────────────────────────────┘
 └──────────┘                            ▲
                                  hook shim (Go, UDP)
```

## Design constraints

- **Observe-only.** agent-deck never drives your agents. The single exception is
  installing Claude Code hooks, which shows a diff, backs up the original settings,
  tags every entry with `_source: "agent-deck"`, and reverses cleanly via
  `agent-deck uninstall`.
- **Never in the hot path.** Claude hooks fire on every tool call, so the shim is a
  small Go binary that sends one UDP datagram and exits 0 within a hard 10 ms
  deadline — fire-and-forget, fail-open, no retries.
- **No public bind.** The collector refuses to listen on `0.0.0.0`/`::`; it binds
  loopback or a Tailscale interface only.
- **Redaction is built in.** `@agent-deck/redact` scrubs credentials and sensitive
  paths (`~/.ssh`, `~/.aws`, `.codex/auth.json`, gcloud, kube config, …) before
  events are stored.

## Requirements

- Node.js 22+
- Go 1.22+ — only to build the Claude hook shim (`npm run build:hooks`). Set
  `AGENT_DECK_SKIP_HOOKS=1` to skip it.
- Optional: Tailscale, for the tablet pairing flow

## Quick start

```bash
npm install
npm run build
npm run agent-deck start
```

Open <http://127.0.0.1:4100>. To use it from a tablet:

```bash
npm run agent-deck pair   # prints a QR code + 5-minute pairing code
```

## CLI

Every command runs through `npm run agent-deck -- <cmd>`, or `agent-deck` once the
package is linked.

| Command | Does |
|---|---|
| `start` | Run the collector: adapters, HTTP + SSE, static deck |
| `status` | Report whether the collector is answering on `:4100` |
| `doctor` | Diagnose environment, adapters, DB size and reachability |
| `probe [--source <agent>] [--tail N]` | Replay an agent's recent events in-process without persisting |
| `setup claude [--dry-run]` | Install Claude Code hooks (diff + backup, reversible) |
| `setup agy [--dry-run]` | Install Antigravity observer hooks with backup |
| `uninstall [claude\|agy]` | Remove only the selected Agent Deck hooks (defaults to Claude) |
| `import` | Backfill up to 90 days of history into the local DB |
| `run -- <cli> [args...]` | Wrap any CLI in a PTY so a generic adapter can observe it |
| `pair` | Generate a pairing code and QR for the tablet |

## Adapters

| Adapter | Source |
|---|---|
| `opencode` | Existing server API (`/session/status`, session metadata/messages) + SSE; local DB fallback |
| `claude` | `claude agents --json --all` inventory + official lifecycle/message hooks; transcript enrichment |
| `codex` | Existing app-server daemon socket: runtime status, identity, latest messages; rollout fallback |
| `agy` | Official lifecycle hooks over loopback UDP; summaries/transcripts for enrichment |
| `pty` | Agent-agnostic PTY wrapper for anything else |

Each adapter is read-only against the agent's own files. See
[`docs/adapter-authoring.md`](docs/adapter-authoring.md) to add another.

The dashboard selects the latest top-level conversation per project and tool,
and displays its latest message. Tool calls and older conversations remain in
the detail/ledger views. Starting, running or compacting states without fresh
session evidence expire after the configured stall interval (120 seconds by
default) to "No activity signal"; this does not claim the agent process exited.
Authoritative OpenCode and Codex runtime responses keep silent long tasks active.
Local records alone never prove that an application is open. Existing stored
states are reconciled on startup.

OpenCode monitoring connects to an already running server. Set
`OPENCODE_SERVER_URL` for a different port, including a TUI server's assigned
port. The monitor never starts another OpenCode instance to infer activity.

Codex discovers an already running daemon using `codex app-server daemon version`
and uses the official `app-server proxy --sock` transport on Windows. It only
allows initialization and thread loaded-list/read/turn-history requests; it never
starts or resumes a thread, sends a prompt, or answers an approval request. Loaded
idle threads are distinguished from active threads. If the daemon is unavailable,
rollout evidence remains available with its normal expiry.

Install native hooks after building the shim:

```bash
npm run agent-deck -- setup claude
npm run agent-deck -- setup agy
```

Claude hooks live in `~/.claude/settings.json`; Antigravity hooks live under the
`agent-deck-observer` entry in `~/.gemini/config/hooks.json`. Setup preserves other
entries, creates backups and is idempotent. Malformed configuration is rejected
instead of overwritten. Claude command hooks use executable/argument form (no
shell), tested with Claude Code 2.1.302. Antigravity configuration is validated
against its CLI plugin schema. Existing Antigravity sessions may need to reload
their hook configuration; installation alone does not prove hot reload.

Claude also polls the supported `claude agents --json --all` interface. A row's
persisted task state is not enough to claim active execution: the CLI must report
a live process and `busy`. A successful inventory can confirm disappearance;
a failed command is treated as unknown. `AGENT_DECK_CLAUDE_COMMAND` can select
the installed executable when it is not on PATH. No supervisor, agent session or
prompt is started by the JSON inventory path.

The shim sends bounded valid JSON to loopback only (Claude port 4101,
Antigravity port 4102), emits no stdout decisions, and exits successfully even
if telemetry is unavailable, with a 100 ms self-timeout. Tool calls retain the native conversation identity.
Lifecycle hooks override delayed transcript/DB snapshots; transcripts can still
enrich usage and message previews. Hook events do not prove indefinite liveness
after a crash, so uncertain stale activity expires rather than remaining Running.

Contracts: [Codex app-server](https://developers.openai.com/codex/app-server),
[Claude hooks](https://code.claude.com/docs/en/hooks),
[Antigravity hooks](https://antigravity.google/docs/hooks?tab=cli).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_DECK_PORT` | `4100` | HTTP + SSE port |
| `AGENT_DECK_HOST` | `127.0.0.1` | Bind address; `0.0.0.0` is refused by design |
| `AGENT_DECK_DB_PATH` | `~/.agent-deck/collector.db` | SQLite location |
| `AGENT_DECK_UDP_ADDR` | `127.0.0.1:4101` | Hook shim ingest address |
| `AGENT_DECK_SKIP_HOOKS` | unset | `1` skips building the Go shim |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4096` | Existing OpenCode server to observe |
| `AGENT_DECK_CLAUDE_COMMAND` | `claude.exe` on Windows, `claude` elsewhere | Installed CLI used only for read-only session inventory |

## Repository layout

```
apps/
  collector/   Fastify server, adapters, SQLite store, CLI
  web/         SvelteKit + Tailwind deck (static build)
packages/
  core/        event reducer and status engine
  protocol/    shared event contracts
  pricing/     token cost tables
  redact/      sensitive-path and pattern scrubbing
tools/
  doctor/      environment diagnostics
  hook-shim/   Go ingest shim — compiled at build time, never committed
e2e/           Playwright tests for the deck
fixtures/      recorded session data, one folder per agent
docs/          implementation plan, adapter authoring and research notes
```

## Development

```bash
npm run build        # hook shim, then all workspaces
npm run build:hooks  # Go shim only (GOOS/GOARCH respected for cross-compiling)
npm test             # Vitest
npm run test:e2e     # Playwright
npm run typecheck    # tsc + svelte-check
```

The hook shim is a build artifact and is deliberately not in git; `npm run build`
produces it. The shim integration test skips until it has been built.

Further reading: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md),
[`docs/adapter-research.md`](docs/adapter-research.md).

## License

MIT — see [LICENSE](LICENSE).

Model catalog caching, MCP setup, and validation boundaries: [integration compatibility](docs/integration-compatibility.md).
