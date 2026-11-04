# Release procedure

1. Resolve local edits and review the final diff. Do not release a mixed or
   unreviewed worktree. Confirm the version and changelog.
2. Validate a clean checkout with `npm ci`, build, typecheck, unit/Go/E2E tests.
3. Run `npm audit --audit-level=moderate` and a redacted Gitleaks scan of all Git history
   and the working directory. Review images and design assets manually. Secret
   scanning cannot certify the absence of every kind of confidential content.
4. Generate `npm run release:bundle` and run `npm run release:smoke`.
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
the supported distribution is the source tree or the assembled runtime archive.

Sanitizing current files does not remove earlier Git versions. If prior history
contains information that must remain private, review a history rewrite or a
fresh public repository before changing visibility. Rotate exposed credentials
if any are discovered; deleting a file alone is insufficient.
