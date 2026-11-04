import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
const source = join(root, '.release', `agent-deck-${version}-${process.platform}-${process.arch}`);
const scratch = mkdtempSync(join(tmpdir(), 'agent-deck-release-'));
cpSync(source, scratch, { recursive: true });
if (!process.env.npm_execpath) throw new Error('Run through npm run release:smoke.');
const install = spawnSync(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--no-audit',
  '--cache', join(root, '.validation', 'npm-cache')], { cwd: scratch, stdio: 'inherit' });
if (install.status !== 0) process.exit(install.status ?? 1);

// This directory is outside the checkout: parent node_modules cannot hide a
// missing runtime dependency. No real adapter or user history is accessed.
writeFileSync(join(scratch, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { CollectorEngine, buildHttpServer } from './apps/collector/dist/http.js';
import { CollectorStore } from './apps/collector/dist/store.js';
const store = new CollectorStore(':memory:');
const engine = new CollectorEngine({ store });
const app = await buildHttpServer(engine, { staticDir: fileURLToPath(new URL('./apps/web/build', import.meta.url)) });
let collectorPort;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;
  collectorPort = port;
  const base = 'http://127.0.0.1:' + port;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/);
  assert.equal((await fetch(base + '/api/snapshot')).status, 200);
  assert.equal(existsSync('apps/collector/src'), false);
  const shim = process.platform === 'win32' ? 'tools/hook-shim/agent-deck-hook.exe' : 'tools/hook-shim/agent-deck-hook';
  const hook = spawnSync(fileURLToPath(new URL(shim, import.meta.url)), [], { input: '', timeout: 2000 });
  assert.equal(hook.status, 0);
  const cli = spawn(process.execPath, ['apps/collector/dist/cli.js', 'status'], {
    env: { ...process.env, AGENT_DECK_HOST: '127.0.0.1', AGENT_DECK_PORT: String(port) }, stdio: 'inherit'
  });
  const code = await new Promise((resolve, reject) => { cli.once('error', reject); cli.once('exit', resolve); });
  assert.equal(code, 0);
  console.log('Runtime bundle smoke passed: production install, CLI, HTTP, static dashboard.');
} finally {
  app.server.closeAllConnections();
  await app.close();
  store.close();
}
const offline = spawnSync(process.execPath, ['apps/collector/dist/cli.js', 'status'], {
  env: { ...process.env, AGENT_DECK_HOST: '127.0.0.1', AGENT_DECK_PORT: String(collectorPort) }, encoding: 'utf8', timeout: 5000
});
assert.equal(offline.status, 1, offline.stdout + offline.stderr);
console.log('Offline CLI exit status and native shim also passed.');
`);
const result = spawnSync(process.execPath, ['smoke.mjs'], { cwd: scratch, stdio: 'inherit', timeout: 30000 });
console.log(`Isolated runtime install: ${scratch}`);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
