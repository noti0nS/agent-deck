# Agent Deck

An experimental, local-first dashboard for AI coding agents. Follow OpenCode,
Claude Code, Codex and Antigravity sessions from your PC, tablet or phone: activity,
latest messages, attention requests, file changes and token usage.

![Synthetic tablet dashboard](docs/screenshots/tablet.png)

Agent Deck observes your agents; it does not submit prompts, answer approvals or
change their work. Native hook installation is explicit and reversible.

## Quick start

Requirements: Git, **Node.js 22.22+ or 24**, npm 10+, and Go 1.22+ for the hook shim.
Native Node modules may require a C++ toolchain if prebuilt binaries are unavailable.

```sh
git clone https://github.com/noti0nS/agent-deck.git
cd agent-deck
npm ci
npm run build
npm run agent-deck start
```

On first run, select the providers you want to enable (arrows to move, Space to
toggle, Enter to save). Detected providers are suggested; you can select none.
Claude Code and Antigravity selections install their observer hooks automatically;
reopen those agents afterward. Other providers need no hooks. Run
`npm run agent-deck setup` to change your selection later, then restart the collector.

Open <http://127.0.0.1:4100>. On Windows use `npm.cmd` if PowerShell blocks `npm`.
The first start imports up to 90 days of history from enabled providers into a local SQLite
DB. Set `AGENT_DECK_IMPORT_HISTORY=0` to skip bulk backfill. Current/recent agent
records may still be observed. Read [privacy](docs/privacy.md) before sharing access.

Runtime bundles, when published in [Releases](https://github.com/noti0nS/agent-deck/releases),
include the compiled app and Go shim. They need Node and `npm ci --omit=dev`,
but no Go/TypeScript build. See [installation](docs/installation.md).

## Tablet access

**Tailscale:** with Tailscale installed and signed in on both devices, run
`npm run agent-deck setup tailscale` and open the printed HTTPS URL. Your
Tailscale access rules authorize access; no Agent Deck pairing is required.
Setup refuses to replace a different service on the selected port. Starting the
collector does not modify Tailscale Serve.

**Private LAN without Tailscale:** start with `AGENT_DECK_LAN_HOST` set to the
PC's private IPv4 address. Windows example (replace the address):

```powershell
./start-local-wifi.ps1 -LanAddress 192.168.1.23
```

Then run `npm run agent-deck pair` in another terminal and scan the QR. It uses
the running collector's recorded LAN address, never localhost. Each code is
single-use and valid for five minutes. LAN HTTP is for trusted networks; HTTPS
is required for normal PWA installation. [Detailed setup](docs/installation.md).

Do not expose the collector through public proxies, port forwarding or Tailscale
Funnel.

## Commands

Use `npm run agent-deck COMMAND` from source, or
`node apps/collector/dist/cli.js COMMAND` from a runtime bundle.

| Command | Purpose |
| --- | --- |
| `start` | Run collector and dashboard |
| `status` | Check configured address/port; exit 1 if offline |
| `doctor` | Report actual collector reachability and adapter diagnostics |
| `help` | Show CLI usage without running setup |
| `setup` | Select enabled providers and install/remove their observer hooks |
| `setup providers codex,opencode` | Save an explicit selection without prompts; use `none` for no providers |
| `setup claude [--dry-run]` | Install reversible Claude observer hooks |
| `setup agy [--dry-run]` | Install reversible Antigravity observer hooks |
| `setup tailscale` | Explicitly configure trusted HTTPS access |
| `uninstall [claude\|agy]` | Remove only Agent Deck hooks |
| `pair` | Generate a single-use LAN pairing code and QR |
| `devices list` | List paired LAN browsers (no token values) |
| `devices revoke ID` | Revoke one LAN device |
| `devices revoke-all` | Revoke all LAN devices and outstanding code |
| `import` | Import up to 90 days of available history |
| `probe --source AGENT --tail N` | Inspect normalized recent evidence in memory |
| `run -- CLI [args...]` | Observe an explicitly launched CLI through a PTY |
| `mcp` | Read-only stdio bridge for an MCP client |

`doctor` and `help` work before setup. Running with no command starts the collector.
Plain commands need no npm separator: `npm run agent-deck doctor`. To forward
flags through npm, use `npm run agent-deck -- setup agy --dry-run`.
Non-interactive first runs require an explicit provider selection before starting.

Build the shim before hook setup. Setup preserves other hook entries, backs up
settings and rejects malformed configuration. Hooks emit no decisions and exit
successfully if telemetry is unavailable, with a 100 ms self-timeout. Existing
agent sessions may need to reload their configuration.

## Configuration

Environment variables are read from the launching process, not automatically
from a `.env` file. Set custom DB/port values consistently in CLI/MCP terminals.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_DECK_PORT` | `4100` | Collector HTTP/SSE port |
| `AGENT_DECK_HOST` | `127.0.0.1` | Primary bind; wildcard bind is refused |
| `AGENT_DECK_LAN_HOST` | unset | Additional explicit private IPv4 listener |
| `AGENT_DECK_SERVE_HTTPS_PORT` | `443` | HTTPS port for explicit Tailscale setup |
| `AGENT_DECK_DB_PATH` | `~/.agent-deck/collector.db` | Local data and device records |
| `AGENT_DECK_IMPORT_HISTORY` | enabled | `0` skips automatic bulk history import |
| `AGENT_DECK_UDP_ADDR` | `127.0.0.1:4101` | Claude shim ingest address |
| `AGENT_DECK_SKIP_HOOKS` | unset | `1` skips compiling the shim |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4096` | Existing OpenCode server to observe |
| `AGENT_DECK_CLAUDE_COMMAND` | platform CLI name | Installed Claude executable |

## Compatibility

Adapters use existing runtime evidence and file fallbacks. Missing optional agents
leave their adapters unavailable. Stale file records alone do not prove an agent
is running; silent long tasks need authoritative runtime evidence. Unknown model
prices are not invented, and estimated costs can differ from provider billing.

See the [platform/agent matrix](docs/compatibility.md),
[integration contracts and MCP](docs/integration-compatibility.md), and
[fixture provenance](fixtures/manifest.json). Test CI runs on Ubuntu; release packages target Windows and Ubuntu;
check actual results before treating a platform or native CLI version as verified.

## Development

```sh
npm run build
npm run typecheck
npm test
npm run test:hooks
npx playwright install chromium
npm run test:e2e
```

[Release procedure](docs/releasing.md) | [Changelog](CHANGELOG.md) |
[Dependency review](docs/dependency-review.md)

Code lives in `apps/collector` and `apps/web`; shared logic is in `packages`.
`tools/hook-shim` contains the Go hook, and `tools/doctor` the diagnostics formatter.
Tests and screenshots use synthetic data. Design research is not a compatibility claim.

MIT - see [LICENSE](LICENSE).
