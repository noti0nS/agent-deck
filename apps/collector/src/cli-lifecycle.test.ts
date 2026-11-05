import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { CollectorStore } from './store.js';
import { discoverLanHost } from './lan-discovery.js';

it('keeps the foreground collector reachable and rejects a second start without stopping the first', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'deck-lifecycle-'));
  const dbPath = join(directory, 'collector.db');
  const store = new CollectorStore(dbPath);
  store.setSetting('provider_setup', { version: 1, providers: [] });
  store.setSetting('models_dev_last_attempt', Date.now());
  store.close();
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const env = { ...process.env, AGENT_DECK_DB_PATH: dbPath, AGENT_DECK_PORT: String(port),
    AGENT_DECK_HOST: '127.0.0.1', AGENT_DECK_LAN_HOST: '', AGENT_DECK_IMPORT_HISTORY: '0' };
  const args = ['--import', 'tsx', 'apps/collector/src/cli.ts', 'start'];
  const first = spawn(process.execPath, args, { env, windowsHide: true });
  const exited = once(first, 'exit');
  let output = '';
  first.stdout.on('data', data => { output += data; });
  first.stderr.on('data', data => { output += data; });
  try {
    await expect.poll(() => output, { timeout: 15000 }).toContain('Keep this terminal open');
    expect(first.exitCode).toBeNull();
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
    const second = spawn(process.execPath, args, { env, windowsHide: true });
    let error = '';
    second.stderr.on('data', data => { error += data; });
    second.stdout.resume();
    const timeout = setTimeout(() => second.kill(), 10000);
    const [code] = await once(second, 'exit');
    clearTimeout(timeout);
    expect(code, error).toBe(1);
    expect(error).toContain('already in use');
    expect(error).not.toContain('at Server.setupListenHandle');
    expect(first.exitCode).toBeNull();
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
  } finally {
    first.kill(); await exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);

it.for(['start', 'pair'])('handles pairing with initial command %s', { timeout: 35000 }, async (command, context) => {
  let host: string;
  try { host = await discoverLanHost(); }
  catch { context.skip(true, 'A private LAN interface is required for this socket integration test.'); return; }
  const directory = mkdtempSync(join(tmpdir(), 'deck-auto-lan-'));
  const dbPath = join(directory, 'collector.db');
  const store = new CollectorStore(dbPath);
  store.setSetting('provider_setup', { version: 1, providers: [] });
  store.setSetting('models_dev_last_attempt', Date.now());
  store.close();
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const env = { ...process.env, AGENT_DECK_DB_PATH: dbPath, AGENT_DECK_PORT: String(port),
    AGENT_DECK_HOST: '127.0.0.1', AGENT_DECK_LAN_HOST: '', AGENT_DECK_IMPORT_HISTORY: '0' };
  const base = ['--import', 'tsx', 'apps/collector/src/cli.ts'];
  const collector = spawn(process.execPath, [...base, command], { env, windowsHide: true });
  const exited = once(collector, 'exit');
  let output = '';
  collector.stdout.on('data', data => { output += data; });
  collector.stderr.on('data', data => { output += data; });
  try {
    await expect.poll(() => output, { timeout: 15000 }).toContain('Keep this terminal open');
    if (command === 'start') {
      const pair = spawn(process.execPath, [...base, 'pair'], { env, windowsHide: true });
      let pairOutput = '';
      pair.stdout.on('data', data => { pairOutput += data; });
      pair.stderr.on('data', data => { pairOutput += data; });
      const timeout = setTimeout(() => pair.kill(), 15000);
      const [code] = await once(pair, 'exit');
      clearTimeout(timeout);
      expect(code, pairOutput).toBe(1);
      expect(pairOutput).toContain('Press Ctrl+C');
      expect(pairOutput).not.toContain('Scan to open');
    } else {
      expect(output).toContain('Scan to open');
    }
    expect(collector.exitCode).toBeNull();
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
    if (command === 'pair') expect((await fetch(`http://${host}:${port}/api/snapshot`)).status).toBe(401);
  } finally {
    collector.kill(); await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
