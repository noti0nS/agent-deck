# Contributing

Agent Deck is an experimental, local-first monitor. Keep adapters observe-only;
never start an agent, submit a prompt, or answer its approvals to infer activity.

## Development

Install Node.js 22.17+ or 24, npm 10+, and Go 1.22+. Then:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run test:hooks
npx playwright install chromium
npm run test:e2e
```

On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`. Native dependencies may
need Python and a C++ build toolchain; see [installation](docs/installation.md).
Build before testing: internal packages resolve their compiled `dist` exports.
For frontend work, run `npm run dev --workspace apps/web` with the collector running.

Use synthetic projects and prompts in tests and screenshots. Adapter fixtures
must include provenance and explicitly distinguish synthetic contracts from
sanitized recordings. See [compatibility](docs/compatibility.md) and
[adapter authoring](docs/adapter-authoring.md).

Changes to adapters need tests for identity, stale activity and recovery. Changes
to LAN authentication need tests for unauthenticated requests, paired devices
and revocation. Tailscale Serve is intentionally trusted; direct LAN is not.
UI changes need mobile/tablet checks and keyboard/accessibility consideration.

## Pull requests

Describe the behavior changed, why, and checks actually run. Report unavailable
platforms or native CLI versions explicitly. Do not upload real sessions, local
databases, tokens, device identifiers or private screenshots.

Use issues for reproducible bugs and proposals. Include OS, Node/agent versions,
expected behavior and sanitized reproduction steps. Use the private reporting
channel in [SECURITY.md](SECURITY.md) for security reports.

## Releases

See [release procedure](docs/releasing.md). Passing mocked adapter tests is not
proof of compatibility with a currently installed agent release.
