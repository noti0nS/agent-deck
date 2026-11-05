# Changelog

## 1.0.0 — experimental release preparation

This version is being prepared for public preview; see GitHub Releases for
published artifacts and their platform validation status.

- Observe OpenCode, Claude Code, Codex and Antigravity through native evidence,
  with a PTY fallback for other CLIs.
- Mobile/tablet dashboard, usage estimates, detail views and local history.
- Dependency-ordered build and platform-specific runtime bundle preparation.
- Installable npm CLI distribution with bundled workspaces/dashboard, prebuilt
  Windows/Linux x64/ARM64 hooks, global `agent-deck` commands and `--version`.
- Isolated npm install/runtime/uninstall smoke checks and a trusted-publishing workflow.
- Explicit Tailscale setup that refuses to replace another service.
- Individually revocable LAN sessions; single-use pairing codes; minimal public health.
- Portable LAN configuration and diagnostics that honor the configured port.
- CI, release checks, privacy documentation and synthetic demo material.

### Upgrade notes

Old shared LAN session tokens are invalidated; pair each LAN browser again.
Tailscale authorization remains trusted. `start` no longer configures Tailscale
Serve automatically: run `setup tailscale` explicitly when needed. `status`
returns exit code 1 when the collector is offline.

### Known limits

Agent interfaces can change independently; synthetic fixtures do not prove
compatibility with every native version. Costs can be estimates. A runtime bundle
requires Node and installation of native Node dependencies. See
[compatibility](docs/compatibility.md).
