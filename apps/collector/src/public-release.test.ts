import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollectorEngine, buildHttpServer } from './http.js';
import { CollectorStore } from './store.js';
import { PairingManager, tailscaleServeConflict } from './pair.js';
import { checkCollector, collectorPort, collectorUrl, privateLanUrl } from './config.js';
import { runCli } from './cli.js';

const stores: CollectorStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function store() { const s = new CollectorStore(':memory:'); stores.push(s); return s; }

it('never generates a tablet pairing URL pointing to loopback or a public interface', () => {
  expect(privateLanUrl({ host: '192.168.1.23', port: 4200 })).toBe('http://192.168.1.23:4200');
  for (const host of ['127.0.0.1', 'localhost', '0.0.0.0', '::1', '8.8.8.8', '192.168.1.999']) {
    expect(privateLanUrl({ host, port: 4100 })).toBeUndefined();
  }
  expect(privateLanUrl(undefined)).toBeUndefined();
});

it('uses the configured port and checks the actual health response', async () => {
  expect(collectorUrl({ AGENT_DECK_PORT: '4200' })).toBe('http://127.0.0.1:4200');
  expect(() => collectorPort({ AGENT_DECK_PORT: 'NaN' })).toThrow();
  expect(() => collectorPort({ AGENT_DECK_PORT: '0' })).toThrow();
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try { expect(await checkCollector(`http://127.0.0.1:${port}`)).toBe(true); }
  finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  expect(await checkCollector(`http://127.0.0.1:${port}`)).toBe(false);
});

it('trusts loopback/Tailscale proxy but requires pairing on direct LAN, including forged forwarding headers', async () => {
  const engine = new CollectorEngine({ store: store() });
  const app = await buildHttpServer(engine);
  try {
    for (const url of ['/api/snapshot', '/api/runs/missing/transcript', '/api/stream']) {
      expect((await app.inject({ url, remoteAddress: '192.168.1.20',
        headers: { 'x-forwarded-for': '127.0.0.1' } })).statusCode).toBe(401);
    }
    expect((await app.inject({ url: '/api/snapshot', remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '100.100.10.10' } })).statusCode).toBe(200);
    const health = await app.inject({ url: '/api/health', remoteAddress: '192.168.1.20' });
    expect(health.json()).toEqual({ status: 'ok' });
  } finally { await app.close(); }
});

it('issues unique hashed device tokens, consumes codes and propagates revocation to other managers', async () => {
  const db = store();
  const engine = new CollectorEngine({ store: db });
  const cli = new PairingManager(db);
  const app = await buildHttpServer(engine);
  const remoteAddress = '192.168.1.20';
  try {
    const pair = async () => {
      const { code } = cli.generatePairingCode();
      const res = await app.inject({ method: 'POST', url: '/api/pair', remoteAddress, payload: { code } });
      expect(res.statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/pair', remoteAddress, payload: { code } })).statusCode).toBe(403);
      return res.cookies.find(c => c.name === 'agent_deck_session')!.value;
    };
    const first = await pair(); const second = await pair();
    expect(first).not.toBe(second);
    expect(JSON.stringify(db.getSetting('pairing'))).not.toContain(first);
    expect(cli.listDevices()).toHaveLength(2);
    cli.revokeDevice(cli.listDevices()[0].id);
    expect(engine.pairing.verifyCookieToken(first)).toBe(false);
    expect(engine.pairing.verifyCookieToken(second)).toBe(true);
    cli.revokeAll();
    expect(engine.pairing.verifyCookieToken(second)).toBe(false);
  } finally { await app.close(); }
});

it('rejects legacy shared tokens and expired sessions', () => {
  const db = store();
  db.setSetting('pairing', { sessionToken: 'legacy' });
  const manager = new PairingManager(db);
  expect(manager.verifyCookieToken('legacy')).toBe(false);
  const token = manager.issueSession().token;
  const state = db.getSetting<{ devices: Array<{ expiresAt: number }> }>('pairing')!;
  state.devices[0].expiresAt = 0;
  db.setSetting('pairing', state);
  expect(manager.verifyCookieToken(token)).toBe(false);
});

it('revocation closes an already connected LAN event stream', async () => {
  const db = store();
  const engine = new CollectorEngine({ store: db });
  const app = await buildHttpServer(engine);
  const device = engine.pairing.issueSession();
  try {
    const response = app.inject({ url: '/api/stream', remoteAddress: '192.168.1.20',
      cookies: { agent_deck_session: device.token } });
    await vi.waitFor(() => expect(engine.getSseClientCount()).toBe(1));
    new PairingManager(db).revokeDevice(device.id);
    expect((await response).body).toContain(': connected');
    await vi.waitFor(() => expect(engine.getSseClientCount()).toBe(0));
    expect((await app.inject({ url: '/api/snapshot', remoteAddress: '192.168.1.20',
      cookies: { agent_deck_session: device.token } })).statusCode).toBe(401);
  } finally { await engine.stopAdapters(); await app.close(); }
});

it('pair in another terminal uses persisted LAN address and refuses a missing listener', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-deck-pair-test-'));
  const dbPath = join(scratch, 'test.db');
  const configured = new CollectorStore(dbPath);
  configured.setSetting('provider_setup', { version: 1, providers: [] });
  configured.close();
  vi.stubEnv('AGENT_DECK_DB_PATH', dbPath);
  vi.stubEnv('AGENT_DECK_LAN_HOST', '');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    expect(await runCli(['pair'])).toBe(1);
    expect(log).not.toHaveBeenCalled();
    const db = new CollectorStore(dbPath);
    db.setSetting('lan_listener', { host: '192.168.1.23', port: 4200 });
    db.close();
    expect(await runCli(['pair'])).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith('http://192.168.1.23:4200/api/health', expect.anything());
    expect(log).toHaveBeenCalledWith('http://192.168.1.23:4200');
    expect(log.mock.calls.flat().join('\n')).not.toContain('127.0.0.1');
  } finally {
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); log.mockRestore(); error.mockRestore();
    rmSync(scratch, { recursive: true, force: true });
  }
});

it('refuses to replace another Tailscale service or TCP mapping', () => {
  expect(tailscaleServeConflict({}, 4100, 443)).toBeUndefined();
  const Web = { 'example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4100' } } } };
  expect(tailscaleServeConflict({ Web }, 4100, 443)).toBeUndefined();
  expect(tailscaleServeConflict({ Web }, 4200, 443)).toMatch(/already used/);
  expect(tailscaleServeConflict({ TCP: { '443': { HTTPS: false } } }, 4100, 443)).toMatch(/already configured/);
  expect(tailscaleServeConflict({ Web }, 4200, 8444)).toBeUndefined();
});
