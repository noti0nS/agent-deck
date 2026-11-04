# Public-release preparation — 2026-11-04

## Implemented

- Dependency-ordered build, compatible Node requirements and locked dependencies.
- Runtime bundle with compiled CLI/packages, static frontend, platform hook shim,
  installation instructions, dependency license texts and SHA-256 manifest.
- Trusted loopback/Tailscale Serve access preserved; direct LAN requires pairing.
- Unique hashed device sessions, single-use pairing codes, individual/all-device
  revocation and closure of revoked LAN streams.
- Minimal unauthenticated health response; full diagnostics remain authorized.
- Portable LAN script; pairing reads the running collector's persisted LAN URL
  and never produces a localhost QR for a tablet.
- Actual reachability checks and configured port handling for diagnostics;
  offline CLI exits nonzero. Tailscale setup is explicit and conflict-checked.
- Neutral fixture/project/user examples, sanitized design export metadata and
  screenshots generated from synthetic E2E data.
- Installation/update/removal, data privacy, compatibility, contribution,
  vulnerability reporting, changelog and release documentation.
- Windows/Linux/macOS and Node 22/24 CI targets, dependency/secret scanning,
  Dependabot and a validated draft-release workflow.

## Evidence obtained locally

Windows x64, Node 24.19.0, Go 1.26.1:

- Clean source export outside the checkout: `npm ci`, full build, typecheck,
  104 TypeScript tests, Go tests and seven E2E tests passed.
- Final local E2E suite: eight tests passed, including offline shell caching with
  no session API responses in Cache Storage; mobile and tablet layouts exercised.
- Service worker has its own TypeScript check after the SvelteKit 3 migration.
- Runtime bundle installed with `npm ci --omit=dev` outside the checkout:
  CLI status, HTTP API, static dashboard, native shim and offline exit code passed.
- Gitleaks 8.30.1 (official archive checksum verified): nine Git commits scanned,
  no leaks detected. Working source export also scanned without findings.
- All seven design PNGs and the synthetic tablet screenshot visually reviewed.
- actionlint 1.7.12 (checksum verified): both GitHub workflows passed validation.
- `npm audit --omit=dev --audit-level=low`: zero vulnerabilities.
  One unfixed low-severity build dependency advisory remains, reported through
  four dependency entries; see [dependency review](dependency-review.md).

These are source/fixture/runtime-package checks. They do not certify current
native agent versions, actual remote tailnet behavior or unexecuted CI platforms.
Initial verified platform: Windows x64. Other targets remain experimental.

## Public launch actions

The repository is still private. No visibility change, commit, push or public
release was performed as part of these local changes. Publish the reviewed
changes and run the configured CI before claiming other platforms. The draft
release workflow requires an existing reviewed tag.

Enable GitHub private vulnerability reporting and available repository security
features as part of the public launch. Its API returned 404 while this repository
was private; no active private-reporting channel is claimed here.

Earlier commits still contain historical project/user references. Current files
were sanitized; Git history was not rewritten. The secret scan found no secrets,
but it does not remove those historical names. If keeping those names private is
a launch requirement, choose a reviewed history rewrite or a fresh public export
before changing visibility. Local databases and actual agent histories were not
deleted or altered.
