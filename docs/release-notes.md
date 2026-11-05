Agent Deck is an experimental local dashboard for AI coding sessions.

Download the archive for your OS/CPU, extract it, install Node.js 22.22+ or 24,
and run `npm ci --omit=dev` followed by `node apps/collector/dist/cli.js start`.
The bundle includes the dashboard and hook shim; Go and a TypeScript build are
not needed. Native Node dependencies may need a C++ toolchain.

Tailscale users are authorized through their tailnet. Direct LAN users pair each
device. See the included installation and privacy guides before enabling access.

This release invalidates older shared LAN tokens; pair LAN browsers again.
`start` no longer configures Tailscale Serve automatically. Run `setup tailscale`
explicitly when required.

Agent compatibility is best-effort. Passing fixture tests does not certify every
native CLI version. Cost estimates can differ from billing. Runtime archives
are platform-specific; they are not standalone executables.
