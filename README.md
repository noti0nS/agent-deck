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
| `uninstall` | Restore `~/.claude/settings.json` |
| `import` | Backfill up to 90 days of history into the local DB |
| `run -- <cli> [args...]` | Wrap any CLI in a PTY so a generic adapter can observe it |
| `pair` | Generate a pairing code and QR for the tablet |

## Adapters

| Adapter | Source |
|---|---|
| `opencode` | OpenCode session storage + event log |
| `claude` | Claude Code hooks (UDP shim) plus transcript tailer |
| `codex` | Codex rollout JSONL files |
| `agy` | Antigravity conversation summaries |
| `pty` | Agent-agnostic PTY wrapper for anything else |

Each adapter is read-only against the agent's own files. See
[`docs/adapter-authoring.md`](docs/adapter-authoring.md) to add another.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_DECK_PORT` | `4100` | HTTP + SSE port |
| `AGENT_DECK_HOST` | `127.0.0.1` | Bind address; `0.0.0.0` is refused by design |
| `AGENT_DECK_DB_PATH` | `~/.agent-deck/collector.db` | SQLite location |
| `AGENT_DECK_UDP_ADDR` | `127.0.0.1:4101` | Hook shim ingest address |
| `AGENT_DECK_SKIP_HOOKS` | unset | `1` skips building the Go shim |

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
