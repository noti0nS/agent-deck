import { spawnSync } from 'node:child_process';

// Explicit dependency order also works on the very first build (no dist folders).
const workspaces = [
  'packages/core', 'packages/pricing', 'packages/protocol', 'packages/redact',
  'tools/doctor', 'apps/collector', 'apps/web'
];
function npm(args) {
  // npm_execpath avoids a shell and resolves npm.cmd correctly on Windows.
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
npm(['run', 'build:hooks']);
for (const workspace of workspaces) npm(['run', 'build', '--workspace', workspace]);
