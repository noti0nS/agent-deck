# Compatibility and validation boundaries

This is an experimental monitor, not a promise of support for all CLI versions.

The initial locally validated platform is **Windows x64 with Node 24.19.0**.
Ubuntu and Node 22 are validation targets, not certified support claims,
until their actual CI runs succeed. Do not advertise them as verified yet.
macOS is not included in CI or releases because it cannot currently be tested.

| Component | Target | Evidence / limitation |
| --- | --- | --- |
| Runtime | Node 22.22+ and 24, npm 10+ | CI matrix; native dependencies must install for the OS/CPU |
| Hook build | Go 1.22+ | Go unit tests and compiled-shim integration tests |
| Windows | x64 | Local development platform; npm package CI target on Node 22.22 and 24 |
| Ubuntu | x64 | CI target; native agent compatibility needs separate evidence |
| npm ARM64 | Windows/Linux ARM64 | Prebuilt Go hooks included; cross-compiled only, no ARM64 runtime CI; native Node dependencies may require compilation |
| OpenCode V2 only | Registered service discovery/authentication; `/api/session` and `/api/event`; API history import | Tested against V2 2.2.5 and synthetic API/SSE contracts |
| Claude Code | JSON inventory, lifecycle hooks, transcripts | Prior repository validation recorded 2.1.302; fixtures do not establish support for other releases |
| Codex | Existing app-server daemon; rollout fallback | Transport tests and synthetic fixtures; daemon interfaces can change |
| Antigravity | Observer hooks; summaries/transcripts | Hook schema/transport tests and synthetic fixtures; native version certification pending |
| Generic CLI | PTY heuristics | Best-effort; not authoritative lifecycle or cost accounting |

A configured CI target is not a completed successful CI run. Check the actual
workflow result attached to the release before relying on a platform claim.
Unit/E2E tests use dummy data and are separate from authenticated native-agent tests.

## Fixture provenance

`fixtures/manifest.json` identifies the existing fixtures as synthetic. Their
timestamps and models are examples, not capture dates or supported-version claims.
For a real compatibility record, add sanitized evidence with exact agent version,
OS/architecture, capture date, schema revision, expected events and limitations.
Include approvals, failure, cancellation, compaction, subagents and reconnection.
Never check in raw sessions or private prompts.

## Known behavior

Missing optional agents leave their adapter unavailable; the dashboard still runs.
Stale file evidence does not prove an agent exited. Silent runtime tasks require
authoritative runtime signals. Unknown models have no invented cost; estimates
can differ from provider billing. Offline catalog refresh retains cached prices.
Direct LAN HTTP cannot provide normal HTTPS PWA installation behavior.
