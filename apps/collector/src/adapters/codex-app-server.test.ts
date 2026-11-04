import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { CodexAppServerClient, CodexAppServerObserver, codexRuntimeStatus } from './codex-app-server.js';
import { CollectorEngine } from '../http.js';
import { CollectorStore } from '../store.js';
import { CodexAdapter } from './codex.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

async function server(handler: (method: string, params: any) => unknown) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanup.push(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  const methods: string[] = [];
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    methods.push(message.method);
    if (message.id !== undefined) {
      const result = handler(message.method, message.params);
      if (result !== undefined) socket.send(JSON.stringify({ id: message.id, result }));
    }
  }));
  return { server, methods, endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('Codex app-server read-only runtime integration', () => {
  it('initializes over WebSocket and refuses mutation/approval methods', async () => {
    const fixture = await server(method => method === 'thread/loaded/list' ? { data: ['thread'], nextCursor: null } : {});
    const client = new CodexAppServerClient(fixture);
    cleanup.push(() => client.close());
    await client.connect();
    expect(await client.request('thread/loaded/list', {})).toEqual({ data: ['thread'], nextCursor: null });
    for (const method of ['turn/start', 'thread/resume', 'thread/compact/start', 'item/commandExecution/requestApproval']) {
      await expect(client.request(method, {})).rejects.toThrow('non-read-only');
    }
    expect(fixture.methods).toEqual(['initialize', 'initialized', 'thread/loaded/list']);
  });

  it('maps only known runtime status and distinguishes loaded from active', () => {
    expect(codexRuntimeStatus({ type: 'idle' })).toBe('idle');
    expect(codexRuntimeStatus({ type: 'active', activeFlags: ['waitingOnApproval'] })).toBe('waiting');
    expect(codexRuntimeStatus({ type: 'active', activeFlags: [] })).toBe('running');
    expect(codexRuntimeStatus({ type: 'notLoaded' })).toBe('detached');
    expect(codexRuntimeStatus({ type: 'future-status' })).toBeUndefined();
  });

  it('reconciles runtime states, last messages, child metadata and disappearance without replaying usage', async () => {
    let loaded = true;
    let status = 'idle';
    const fixture = await server((method, params) => {
      if (method === 'thread/loaded/list') return { data: loaded ? ['thread'] : [], nextCursor: null };
      if (method === 'thread/read') return { thread: { id: params.threadId, cwd: 'P:/project', parentThreadId: 'parent', model: 'model', name: 'Work', status: { type: status }, createdAt: 100, updatedAt: 120 } };
      if (method === 'thread/turns/list') return { data: [{ items: [{ type: 'commandExecution', id: 'call' }] }, { items: [{ type: 'agentMessage', id: 'msg', text: 'Latest answer' }] }] };
      return {};
    });
    const store = new CollectorStore(':memory:');
    cleanup.push(() => store.close());
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const observer = new CodexAppServerObserver(fixture, event => engine.ingest(event));
    cleanup.push(() => observer.stop());
    await observer.start();
    expect(engine.state.runs['codex:thread'].status).toBe('idle');
    expect(engine.state.runs['codex:thread'].parentId).toBe('codex:parent');
    expect(engine.state.runs['codex:thread'].model).toBe('model');
    expect(engine.state.runs['codex:thread'].recentMessages?.[0].preview).toBe('Latest answer');
    expect(observer.sessionAlive('thread')).toBe(true);
    expect(observer.sessionAlive('another-server-thread')).toBeUndefined();
    await observer.poll();
    expect(engine.state.runs['codex:thread'].recentMessages).toHaveLength(1);
    expect(engine.state.runs['codex:thread'].lastActivityAt).toBe(120_000);
    status = 'active';
    await observer.poll();
    expect(engine.state.runs['codex:thread'].status).toBe('running');
    expect(engine.state.runs['codex:thread'].lastActivityAt).toBe(120_000);
    loaded = false;
    await observer.poll();
    expect(engine.state.runs['codex:thread'].status).toBe('detached');
    expect(observer.sessionAlive('thread')).toBe(false);
    expect(engine.state.runs['codex:thread'].usage.tokensIn).toBe(0);
    expect(fixture.methods.every(method => ['initialize', 'initialized', 'thread/loaded/list', 'thread/read', 'thread/turns/list'].includes(method))).toBe(true);
  });

  it('does not accept remote or credential-bearing endpoints', async () => {
    for (const endpoint of ['ws://example.com', 'ws://token@localhost', 'ws://localhost/?token=secret']) {
      await expect(new CodexAppServerClient({ endpoint }).connect()).rejects.toThrow('loopback');
    }
  });

  it('bounds requests which receive no reply', async () => {
    const fixture = await server(method => method === 'initialize' ? {} : undefined);
    const client = new CodexAppServerClient({ ...fixture, requestTimeoutMs: 30 });
    cleanup.push(() => client.close());
    await client.connect();
    await expect(client.request('thread/loaded/list', {})).rejects.toThrow('timed out');
  });

  it('drops runtime certainty on disconnect and reconnects without loading threads', async () => {
    const fixture = await server((method, params) => {
      if (method === 'thread/loaded/list') return { data: ['thread'], nextCursor: null };
      if (method === 'thread/read') return { thread: { id: params.threadId, cwd: 'P:/project', status: { type: 'active' }, updatedAt: 120 } };
      return {};
    });
    const observer = new CodexAppServerObserver(fixture, () => {});
    cleanup.push(() => observer.stop());
    await observer.start();
    expect(observer.sessionAlive('thread')).toBe(true);
    const socket = [...fixture.server.clients][0];
    const closed = new Promise<void>(resolve => socket.once('close', () => setTimeout(resolve, 10)));
    socket.close();
    await closed;
    expect(observer.sessionAlive('thread')).toBeUndefined();
    await observer.poll();
    expect(observer.sessionAlive('thread')).toBe(true);
    expect(fixture.methods.filter(method => method === 'initialize')).toHaveLength(2);
    expect(fixture.methods).not.toContain('thread/resume');
  });

  it('discovers a daemon opened after collector startup and bounds discovery retries', async () => {
    const fixture = await server(method => method === 'thread/loaded/list' ? { data: [], nextCursor: null } : {});
    const dir = mkdtempSync(join(tmpdir(), 'deck-codex-discovery-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const discover = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(fixture);
    const adapter = new CodexAdapter({ sessionsDir: dir, appServer: {}, discoverAppServer: discover, pollIntervalMs: 60_000 });
    vi.spyOn(adapter, 'probe').mockResolvedValue(adapter.health().capabilities);
    cleanup.push(() => { void adapter.stop(); });
    await adapter.start({ emit: () => {}, reportHealth: () => {}, getSetting: () => undefined, setSetting: () => {} });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(adapter.health().capabilities.liveEvents).toBe(false);
    await adapter['refreshRuntime']();
    expect(discover).toHaveBeenCalledTimes(1);
    await adapter['refreshRuntime'](Date.now() + 30_001);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(adapter.health().capabilities.liveEvents).toBe(true);
    expect(adapter.health().transport).toBe('socket');
  });

  it('reports disconnection truthfully and restores health after a successful reconnect', async () => {
    let respond = true;
    const fixture = await server(method => method === 'thread/loaded/list' ? respond ? { data: [], nextCursor: null } : undefined : {});
    const dir = mkdtempSync(join(tmpdir(), 'deck-codex-health-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const adapter = new CodexAdapter({ sessionsDir: dir, appServer: { ...fixture, requestTimeoutMs: 30 }, pollIntervalMs: 60_000 });
    vi.spyOn(adapter, 'probe').mockResolvedValue(adapter.health().capabilities);
    cleanup.push(() => { void adapter.stop(); });
    const reportHealth = vi.fn();
    await adapter.start({ emit: () => {}, reportHealth, getSetting: () => undefined, setSetting: () => {} });
    const socket = [...fixture.server.clients][0];
    const closed = new Promise<void>(resolve => socket.once('close', () => setTimeout(resolve, 10)));
    socket.close();
    await closed;
    expect(adapter.health().capabilities.liveEvents).toBe(false);
    expect(adapter.health().transport).toBe('poll');
    expect(adapter.health().status).toBe('degraded');
    expect(adapter.health().lastError).toBeDefined();
    await adapter['refreshRuntime']();
    expect(adapter.health().capabilities.liveEvents).toBe(true);
    expect(adapter.health().status).toBe('connected');
    expect(adapter.health().lastError).toBeUndefined();
    expect(reportHealth).toHaveBeenCalled();
    respond = false;
    await adapter['refreshRuntime']();
    expect(adapter.health().capabilities.liveEvents).toBe(false);
    expect(adapter.health().transport).toBe('poll');
    expect(adapter.health().status).toBe('degraded');
    respond = true;
    await adapter['refreshRuntime'](Date.now() + 30_001);
    expect(adapter.health().capabilities.liveEvents).toBe(true);
    expect(adapter.health().status).toBe('connected');
  });

  it('does not overlap discovery or connect after stop while discovery is pending', async () => {
    const fixture = await server(() => ({}));
    const dir = mkdtempSync(join(tmpdir(), 'deck-codex-stop-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    let resolve!: (value: typeof fixture) => void;
    const discover = vi.fn(() => new Promise<typeof fixture>(done => { resolve = done; }));
    const adapter = new CodexAdapter({ sessionsDir: dir, appServer: {}, discoverAppServer: discover });
    vi.spyOn(adapter, 'probe').mockResolvedValue(adapter.health().capabilities);
    const starting = adapter.start({ emit: () => {}, reportHealth: () => {}, getSetting: () => undefined, setSetting: () => {} });
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    const repeated = adapter['refreshRuntime'](Date.now() + 31_000);
    expect(discover).toHaveBeenCalledTimes(1);
    await adapter.stop();
    resolve(fixture);
    await Promise.all([starting, repeated]);
    expect(fixture.methods).toEqual([]);
    expect(adapter['pollTimer']).toBeNull();
  });
});
