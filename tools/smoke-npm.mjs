import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tarballName = `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
const tarball = join(root, '.release', 'npm', tarballName);
if (!existsSync(tarball)) throw new Error('Run npm run release:npm first.');
if (!process.env.npm_execpath) throw new Error('Run through npm run release:npm:smoke.');
const temp = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
mkdirSync(temp, { recursive: true });
// Spaces exercise Windows command shims and installed resource paths.
const scratch = mkdtempSync(join(temp, 'agent-deck npm-'));
const prefix = join(scratch, 'prefix');
const home = join(scratch, 'home');
const cwd = join(scratch, 'unrelated directory');
for (const directory of [prefix, home, cwd]) mkdirSync(directory, { recursive: true });
console.log(`Isolated global npm install: ${scratch}`);

function npm(args) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args, '--prefix', prefix, '--global', '--no-audit', '--no-fund'], {
    cwd, stdio: 'inherit', timeout: 300_000
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `npm ${args[0]} failed`);
}
npm(['install', tarball]);
const installed = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', name);
const bin = process.platform === 'win32' ? prefix : join(prefix, 'bin');
const command = process.platform === 'win32' ? 'agent-deck.cmd' : 'agent-deck';
const cli = join(installed, 'apps/collector/dist/cli.js');
const db = join(home, '.agent-deck', 'collector.db');
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(AGENT_DECK_|OPENCODE_SERVER_URL$|NODE_OPTIONS$|NODE_PATH$|PATH$)/i.test(key)) delete env[key];
}
Object.assign(env, {
  PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
  HOME: home, USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
  XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
  XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'),
  AGENT_DECK_DB_PATH: db, AGENT_DECK_IMPORT_HISTORY: '0', AGENT_DECK_HOST: '127.0.0.1'
});
const options = { cwd, env, encoding: 'utf8', timeout: 30_000 };
function run(args, expected = 0) {
  // Use the real globally installed launcher, including npm's Unix symlink.
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command, ...args], options)
    : spawnSync(command, args, options);
  if (result.error) throw result.error;
  assert.equal(result.status, expected, `${command} ${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

assert.match(run(['help']), /Usage: agent-deck/);
assert.equal(run(['--version']).trim(), version);
assert.equal(existsSync(db), false, 'help/version must not start setup or create a database');
run(['unknown-command'], 1);
const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
assert.equal(manifest.private, undefined);
assert.equal(manifest.workspaces, undefined);
assert(!Object.keys(manifest.dependencies).some(dependency => dependency.startsWith('@agent-deck/')));
assert.equal(existsSync(join(installed, 'apps/collector/src')), false);

const hook = join(installed, 'tools/hook-shim/bin', `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'agent-deck-hook.exe' : 'agent-deck-hook');
const hookResult = spawnSync(hook, [], { ...options, input: '', timeout: 2000 });
assert.equal(hookResult.status, 0, String(hookResult.error ?? hookResult.stderr));
run(['setup', 'providers', 'claude,agy']);
const claude = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'));
assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, hook);
assert(existsSync(join(home, '.gemini/config/hooks.json')));
run(['setup', 'providers', 'none']);
assert.equal(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).hooks, undefined);

// Exercise the installed native PTY without sending telemetry to a real collector.
const pty = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import { createRequire } from 'node:module';
  const pty = createRequire(process.argv[1])('node-pty');
  const child = pty.spawn(process.execPath, ['-e', 'console.log("npm-pty-ok")'], {
    name: 'xterm-color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env
  });
  child.onData(data => process.stdout.write(data));
  child.onExit(({ exitCode }) => { process.exit(exitCode); });
`, cli], options);
assert.equal(pty.status, 0, pty.stdout + pty.stderr);
assert.match(pty.stdout, /npm-pty-ok/);

const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
env.AGENT_DECK_PORT = String(reservation.address().port);
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${env.AGENT_DECK_PORT}`;
// The launcher was checked above; spawn Node directly so cleanup owns one PID on Windows.
const collector = spawn(process.execPath, [cli, 'start'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
const closed = once(collector, 'close');
let output = '';
collector.stdout.on('data', chunk => { output = (output + chunk).slice(-64_000); });
collector.stderr.on('data', chunk => { output = (output + chunk).slice(-64_000); });
try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(collector.exitCode, null, output);
    try {
      response = await fetch(base, { signal: AbortSignal.timeout(1000) });
      break;
    } catch { await delay(100); }
  }
  assert(response, `Collector did not become ready: ${output}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html/);
  assert.equal((await fetch(`${base}/api/snapshot`)).status, 200);
  const asset = html.match(/(?:href|src)="([^"\s]*_app\/immutable\/[^"\s]+)"/);
  assert(asset, 'Dashboard must reference its compiled assets');
  assert.equal((await fetch(new URL(asset[1], `${base}/`))).status, 200);
  assert.match(run(['status']), /ONLINE/);
} finally {
  collector.kill();
  await closed;
}
assert.match(run(['status'], 1), /OFFLINE/);
npm(['uninstall', name]);
assert.equal(existsSync(join(bin, command)), false);
assert(existsSync(db), 'Uninstall must preserve user data');
console.log('npm smoke passed: global command, version, isolated setup/hooks, native PTY/SQLite, dashboard/assets/API, online/offline status, uninstall.');
