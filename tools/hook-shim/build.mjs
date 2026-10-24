#!/usr/bin/env node
/**
 * Builds the Claude Code hook shim (tools/hook-shim/main.go).
 *
 * The resulting binary is intentionally NOT committed: it is a build artifact,
 * so it is produced here and ignored by git. The root `build` script runs this
 * before compiling the workspaces, which means every packaged/published copy of
 * the app carries a shim that matches the Go source it was built from.
 *
 * Cross-compile by setting GOOS/GOARCH (e.g. GOOS=linux npm run build:hooks).
 * Requires the Go toolchain (https://go.dev/dl/); set AGENT_DECK_SKIP_HOOKS=1 to
 * skip the shim entirely on machines without Go.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

if (process.env.AGENT_DECK_SKIP_HOOKS === '1') {
  console.log('[hook-shim] AGENT_DECK_SKIP_HOOKS=1, skipping build');
  process.exit(0);
}

const hostOs =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
const goos = process.env.GOOS || hostOs;
const goarch = process.env.GOARCH || (process.arch === 'arm64' ? 'arm64' : 'amd64');
const ext = goos === 'windows' ? '.exe' : '';
const outPath = join(here, `agent-deck-hook${ext}`);

// Windows resolves `go` through PATHEXT only when a shell is involved; calling
// go.exe directly avoids cmd.exe re-splitting args like `-ldflags '-s -w'`.
const goBin = process.platform === 'win32' ? 'go.exe' : 'go';

const probe = spawnSync(goBin, ['version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.error(
    '[hook-shim] Go toolchain not found.\n' +
      '  Install Go from https://go.dev/dl/ and re-run `npm run build:hooks`,\n' +
      '  or set AGENT_DECK_SKIP_HOOKS=1 to build everything except the hook shim.'
  );
  process.exit(1);
}

// -trimpath and -s -w keep the artifact small and free of local build paths.
const build = spawnSync(
  goBin,
  ['build', '-trimpath', '-ldflags', '-s -w', '-o', outPath, '.'],
  {
    cwd: here,
    encoding: 'utf8',
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch }
  }
);

if (build.error || build.status !== 0) {
  console.error(`[hook-shim] build failed (${goos}/${goarch})`);
  process.exit(build.status ?? 1);
}

console.log(`[hook-shim] built ${goos}/${goarch} -> ${outPath}`);
