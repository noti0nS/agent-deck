---
name: agent-deck-release
description: Prepare an agent-deck release by fetching and reviewing recent commits, writing versioned CHANGELOG.md entries, and incrementing package.json and package-lock.json together. Use whenever the user asks to update the changelog, bump the version, prepare a release, or review recent commits for release notes in this repository, including requests that also say commit and push.
---

# Agent Deck Release Preparation

## Outcome

Produce one consistent release update:

```text
fetch and review commits
        -> CHANGELOG.md: ## X.Y.Z
        -> package.json: X.Y.Z
        -> package-lock.json: X.Y.Z (root and packages[""])
        -> validate -> commit/push only if requested
```

Updating the changelog for a release includes incrementing the package version.
Do not stop at an `Unreleased` section: the user expects a concrete version in
the changelog matching both manifests.

## 1. Inspect and fetch

- Work from the repository root. Read current repository instructions and
  `docs/releasing.md` before editing; resolve paths below from that root.
- Inspect `git status --short --branch`, unstaged and staged diffs, and
  `git log --oneline -15`. Preserve unrelated edits and existing staged files.
- Read `CHANGELOG.md`, root `package.json`, and the root entries in
  `package-lock.json`. Do not assume the version from a previous conversation.
- Fetch the configured upstream remote (normally `git fetch origin`). Fetching
  refreshes remote refs; it does not authorize a pull, merge, rebase, or reset.
  If fetching fails, report that remote history could not be refreshed.
- Compare HEAD with the configured upstream. If upstream contains commits absent
  locally or history has diverged, clarify the target before preparing a release
  that would omit remote changes. Do not silently integrate them.

## 2. Determine the changes and next version

- Locate the commit establishing the current version using the histories of
  `package.json` and `CHANGELOG.md`, plus matching tags when available. Inspect
  the actual diffs to confirm the boundary; do not trust commit titles alone.
- Review all commits after that boundary through HEAD, not just the last fixed
  number of commits. Include earlier unversioned changelog additions if they
  belong to the pending release. Avoid repeating notes already released.
- If the boundary is ambiguous, investigate or ask rather than inventing it.
  If there are no unreleased changes and no explicit request for a version-only
  bump, report that and leave files unchanged.
- Honor an explicit target version or bump type. Otherwise use SemVer:
  patch for fixes, dependency updates, CI/build/docs-only maintenance; minor
  for backward-compatible features; major for breaking public behavior.
- State the selected version and why. Ask if breaking-change evidence or
  version intent is ambiguous. Never hardcode a version in this skill.
- Keep independent internal workspace versions unchanged: this project ships
  one bundled npm CLI using the root package version.

## 3. Update the release files together

- Prepend `## X.Y.Z` to `CHANGELOG.md`, following its existing English format.
  Consolidate pending `Unreleased` notes into that versioned section when present.
- Group concise, evidence-backed bullets under `Added`, `Fixed`, `Changed`,
  or other existing categories as appropriate; omit empty headings.
- Explain user-visible effects and important compatibility/validation changes.
  Do not claim a configured CI job passed, a vulnerability was fixed, or a
  package was published without evidence.
- Set root `package.json.version`, `package-lock.json.version`, and
  `package-lock.json.packages[""].version` to exactly the same new version.
  Preserve unrelated content and lockfile resolutions. Do not run a broad
  dependency update or use `npm version` with implicit commit/tag behavior.
- If these files already contain user edits, incorporate them without
  overwriting unrelated work; ask when release intent conflicts.

## 4. Verify

- Run `git diff --check` and inspect the complete release-file diff.
- Parse both JSON files and assert that all three version values are equal
  to the selected version. Verify the first release heading in `CHANGELOG.md`
  is `## X.Y.Z`, not `Unreleased`, and the previous release remains intact.
- Confirm only intended release metadata changed. For metadata-only changes,
  use these focused checks; do not run installs, full builds, or release
  packaging unnecessarily. Follow `docs/releasing.md` for broader changes.
- Report the commit range reviewed and the checks actually run.

## 5. Commit and push only when authorized

- A request to prepare a release or use this skill does not itself authorize
  committing, pushing, tagging, publishing npm, or running release workflows.
- If commit is requested, use the git-commit skill when available. Stage only
  the intended release files, inspect the staged diff, and create a new commit
  such as `chore(release): prepare vX.Y.Z`. Exclude unrelated staged changes.
- If push is also requested, push the intended branch to its verified upstream
  without force, then verify synchronization and worktree state. If it is
  rejected, report the blocker rather than rewriting history.
- Do not amend a previous release commit, create tags, publish a GitHub release,
  or publish to npm unless specifically requested. The root package is a
  private workspace; publishing is a separate documented workflow.

## Final response

Briefly report the old and new versions, summarized changes, and validation.
Include the commit hash/push result only when performed. Distinguish prepared
release metadata from a published release.
