# Changelog

## 1.1.2

### Fixed

- Antigravity hook commands now leave Windows executable paths unquoted,
  including scoped npm installs such as `@noti0ns/agent-deck`. `agy` escapes
  embedded quotes as literal `\"` before handing the command to `cmd.exe`, so
  quoted paths failed with `'\"C:\...\"' is not recognized` and blocked every
  agent turn and tool call. Paths that genuinely need quotes, such as those
  containing spaces, keep them.

### Changed

- Added the repository release-preparation workflow under `.agents/skills/`.

## 1.1.1

### Fixed

- Manual npm publishing accepts branch refs; selected release tags must still
  match the version in `package.json`.

### Changed

- Validation, npm publishing checks, and draft runtime releases now run on
  Ubuntu with Node 24 only. Draft runtime releases produce a Linux archive;
  Windows and Node 22 are no longer CI-tested.
- Updated Fastify to `^5.12.8`, Tailwind CSS and its Vite plugin to `^4.3.4`,
  and `@types/better-sqlite3` to `^9.6.0`, with refreshed dependency locks.

## 1.1.0

### Added

- Command-specific help through `help <command>`, `--help`, and `-h`, with
  usage examples, setup guidance, and environment options.
- Richer doctor diagnostics with enabled-provider status, local detection,
  web/hook asset checks, and actionable repair steps.
- Machine-readable diagnostics through `agent-deck doctor --json`.

### Fixed

- Model usage displays “turns not reported” when turn metadata is unavailable,
  instead of a misleading zero. This does not add missing provider turn counts.
- Doctor continues reporting other providers when an individual probe fails,
  and reports invalid provider setup without opening the setup wizard.
- Help flags after the PTY wrapper's `--` separator reach the wrapped command.

### Changed

- Playwright E2E checks now gate the manual npm publishing workflow rather than
  running on every push or pull request. Manual draft releases retain E2E checks.
- Removed obsolete implementation-plan documents.

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
