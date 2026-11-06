# Release procedure

1. Resolve local edits and review the final diff. Do not release a mixed or
   unreviewed worktree. Confirm the version and changelog.
2. Keep worktree validation targeted to the change. The manually dispatched release
   workflow runs the clean install, build, typecheck and full unit/Go/E2E tests.
3. The release workflow runs `npm audit --audit-level=moderate`. Review the redacted
   Gitleaks CI results for Git history, plus any uncommitted files before release.
   Review images and design assets manually. Secret
   scanning cannot certify the absence of every kind of confidential content.
4. The release workflow generates the runtime bundle and runs its smoke check.
   Staging uses an explicit file allowlist; it excludes Git, source fixtures,
   design research, local databases, environment files and node_modules.
5. Push the reviewed commit and tag. Run **Prepare draft release** with that
   existing tag. It validates each platform, builds runtime archives, computes
   SHA-256 checksums and creates an unpublished experimental draft.
6. Review archive contents, screenshots and the actual platform test results.
   Enable GitHub private vulnerability reporting, secret scanning and push
   protection where available as part of the public launch. Protect the
   default branch with the Validate checks after their first successful run.
7. Publish the reviewed draft and change repository visibility only when ready.

Do not present configured CI jobs as successful runs. Record native CLI versions
separately from the build/test matrix. Do not publish npm workspaces individually:
the npm CLI bundles the internal packages into one distribution.

## npm CLI package

The root remains a private development workspace. `release:npm` generates a
separate publishable manifest and a file-allowlisted tarball; do not run `npm publish`
at the repository root or remove its `private` flag.

The manual npm deployment workflow owns the full validation below. Run only
focused checks in a worktree; repeat this sequence locally when diagnosing a
release failure, rather than on every change:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run test:hooks
npm run release:npm
npm run release:npm:smoke
```

The result is `.release/npm/noti0ns-agent-deck-VERSION.tgz`, using the root package version.
It contains one bundled CLI (internal workspaces included), dashboard assets,
documentation/licenses, and Go hooks for Windows/Linux x64/ARM64. External runtime
dependencies, including native modules, are installed by npm. No install-time hook
download or Go compilation is performed. ARM64 binaries are cross-compiled, not
runtime-verified by the x64 matrix.

The smoke check installs the actual tarball into an isolated global npm prefix
outside the checkout, then exercises the generated command, version/help, provider
setup and hook removal, native PTY/SQLite, dashboard assets/API, status exit codes,
and npm uninstall. It uses a temporary home and database, leaving real agent
settings and the user's global npm installation alone.

### First publication

The package is published as `@noti0ns/agent-deck`; npm reserves the unscoped
`agent-deck` name because it is too similar to `agentdeck`. Authenticate
interactively (never put a token in the repository) and publish the tested tarball:

```sh
npm login
npm publish .release/npm/noti0ns-agent-deck-1.0.0.tgz --access public
```

Substitute the current version if it changed. npm may require browser/2FA
confirmation. Verify with `npm view @noti0ns/agent-deck version` and a fresh
`npm install -g @noti0ns/agent-deck`. A local tarball build does not mean it is published.

### Subsequent releases from GitHub Actions

Configure the npm package's **Trusted Publisher** for GitHub Actions:
owner `noti0nS`, repository `agent-deck`, workflow filename `npm.yml`.
This uses short-lived OIDC authentication, not a stored npm token. The repository
must be public for the workflow's `--provenance` publication.

Update the version/changelog and push the commit, then manually run
**Publish npm package** on `master` (for example
`gh workflow run npm.yml --ref master`). The version comes from `package.json`
at the selected workflow commit. You can also run on a `vVERSION` tag; when a
tag is selected, it must match the package version (for example `v1.1.0`).
The workflow builds, runs Playwright E2E checks, and smoke-tests on
Windows/Ubuntu with Node 22.22 and 24, and publishes the
tested Ubuntu/Node 24 tarball only after all four jobs pass. This workflow has only
a `workflow_dispatch` trigger: pushes (including to `master`), pull requests and
new tags do not run it. Each npm version can be published only once.

Sanitizing current files does not remove earlier Git versions. If prior history
contains information that must remain private, review a history rewrite or a
fresh public repository before changing visibility. Rotate exposed credentials
if any are discovered; deleting a file alone is insufficient.
