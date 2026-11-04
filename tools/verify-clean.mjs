import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'agent-deck-clean-'));
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of files) {
  if (!existsSync(join(root, file))) continue; // deleted tracked files
  mkdirSync(dirname(join(scratch, file)), { recursive: true });
  cpSync(join(root, file), join(scratch, file));
}
if (!process.env.npm_execpath) throw new Error('Run through npm run verify:clean.');
console.log(`Clean source export (no node_modules, dist or Git): ${scratch}`);
for (const args of [
  ['ci', '--cache', join(root, '.validation', 'npm-cache')],
  ['run', 'build'], ['run', 'typecheck'], ['test'], ['run', 'test:hooks'], ['run', 'test:e2e']
]) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: scratch, stdio: 'inherit', timeout: 300000,
    env: { ...process.env, GOCACHE: join(root, '.validation', 'go-cache') }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Clean-source validation passed: ${scratch}`);
