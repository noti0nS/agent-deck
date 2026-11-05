# Installation and operation

Agent Deck is experimental. Begin on your own computer; enable network access
only after choosing Tailscale or private-LAN access as described below.

## From source

Install Git, Node.js 22.22+ or 24, npm 10+, and Go 1.22+.

```sh
git clone https://github.com/noti0nS/agent-deck.git
cd agent-deck
npm ci
npm run build
npm run agent-deck -- start
```

Open http://127.0.0.1:4100. Keep the terminal running; Ctrl+C stops the process.
On Windows, use `npm.cmd` if PowerShell execution policy blocks `npm`.
No paid API key is needed by Agent Deck; the agents you monitor have their own
installation, login and billing requirements.

Without Go, set `AGENT_DECK_SKIP_HOOKS=1` before building. This disables native
hook installation until you build the shim; transcript-based observation remains
available. In PowerShell use `$env:AGENT_DECK_SKIP_HOOKS = '1'`; in a POSIX shell
use `export AGENT_DECK_SKIP_HOOKS=1`.

### Native dependencies

`better-sqlite3` and `node-pty` contain native modules. If npm cannot download a
compatible prebuilt binary, it must compile them. Install Python 3 and:

- Windows: Visual Studio Build Tools with Desktop development with C++.
- Ubuntu: a C/C++ compiler and make (the `build-essential` package).

Use the documented Node major versions. After changing Node major or CPU
architecture, reinstall dependencies with `npm ci`; do not copy `node_modules`
between machines. Installation requires network access to dependency registries.

## Runtime release bundle

When a release is published, download its archive matching your OS and CPU from
[GitHub Releases](https://github.com/noti0nS/agent-deck/releases). Extract it, install
Node 22.22+ or 24, then run:

```sh
npm ci --omit=dev
node apps/collector/dist/cli.js start
```

The bundle includes compiled CLI/packages, static dashboard and the platform's
Go hook shim. It does not require Go or TypeScript. Native dependency installation
has the same possible C++ toolchain requirement described above. It is not a
single executable or an npm-registry package. Use `node apps/collector/dist/cli.js`
in place of `npm run agent-deck --` for the commands below when using a bundle.

## Tablet access: choose one

**Tailscale:** install and sign in to Tailscale on both devices. With the collector
running on its default loopback address, explicitly configure Serve once:

```sh
npm run agent-deck -- setup tailscale
```

Open the HTTPS URL printed by setup. No Agent Deck pairing is needed: tailnet
access controls are the authorization boundary. Setup refuses to replace a
different service on the selected port. Set `AGENT_DECK_SERVE_HTTPS_PORT` to another
port if needed. Starting the collector does not change Serve configuration.
Do not enable Funnel or another public proxy.

**Private LAN without Tailscale:** select the PC's private IPv4 address (shown by
`ipconfig` on Windows or your network settings). In PowerShell:

```powershell
./start-local-wifi.ps1 -LanAddress 192.168.1.23
```

On Ubuntu:

```sh
AGENT_DECK_LAN_HOST=192.168.1.23 npm run agent-deck -- start
```

Replace the example address with your own. Allow inbound TCP on the configured
port only from your private subnet. In another terminal in this checkout:

```sh
npm run agent-deck -- pair
```

The collector records its LAN address, so the second terminal does not need to
inherit its environment variables. Scan the QR; the code expires after five
minutes and is single-use. `pair` refuses to generate a tablet QR unless a LAN
listener is running; it never substitutes localhost. Set `AGENT_DECK_DB_PATH` in
both terminals if you use a custom database. Regenerate a code for each device.
If DHCP changes the PC's address, restart with the new address and open that URL.

LAN HTTP does not encrypt traffic and is for trusted networks. PWA installation
and service-worker functionality require HTTPS (or localhost on the PC).

## Device access and diagnostics

```sh
npm run agent-deck -- status
npm run agent-deck -- doctor
npm run agent-deck -- devices list
npm run agent-deck -- devices revoke DEVICE_ID
npm run agent-deck -- devices revoke-all
```

`status` uses the configured host/port and returns 1 when offline. `doctor` probes
the actual collector and reports adapter capabilities; missing optional agents
are not installation failures. Revocation affects LAN device sessions, including
open streams within five seconds. It does not revoke tailnet access; use Tailscale
access controls for that. Logging out only clears that browser's session.

To sign back in on the PC after an explicit browser logout, use `pair --local`
and enter the printed code. This mode intentionally prints no tablet QR.

## Update, uninstall and recovery

Stop the collector before updating. Back up `~/.agent-deck/collector.db` while it
is stopped (or your custom DB path). For source installs, update the checkout,
run `npm ci` and `npm run build`, then start again. For bundles, extract a new
directory and install its dependencies. Hook paths are absolute: uninstall old
hooks before moving/deleting the old install, then install hooks from the new one.

```sh
npm run agent-deck -- uninstall claude
npm run agent-deck -- uninstall agy
```

These commands remove only Agent Deck hook entries. Remove the installed Serve
mapping using Tailscale's UI/CLI for that port; do not reset other apps' mappings.
Remove your firewall rule if you created one. Delete the application directory
after stopping it. Data removal is separate: see [privacy](privacy.md).

If a port is busy, stop your existing collector or choose another
`AGENT_DECK_PORT`; do not terminate unrelated applications. A missing shim requires
`npm run build:hooks`. A blank dashboard or missing `index.html` requires a full
build. `AGENT_DECK_PORT` must match in commands and MCP clients.
