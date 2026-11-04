import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { connect as connectSocket } from 'node:net';
import { promisify } from 'node:util';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';
import type { RunStatus } from '@agent-deck/core';
import type { EmitEventInput } from '../adapter-spi.js';

const execFileAsync = promisify(execFile);
const READ_METHODS = new Set(['initialize', 'thread/loaded/list', 'thread/read', 'thread/turns/list']);

export interface CodexAppServerOptions {
  /** Existing daemon only. Never launches an app-server. */
  command?: string;
  socketPath?: string;
  /** Explicit unauthenticated loopback listener; remote listeners are not accepted. */
  endpoint?: string;
  requestTimeoutMs?: number;
}

export async function discoverCodexAppServer(options: CodexAppServerOptions = {}): Promise<CodexAppServerOptions | undefined> {
  if (options.endpoint || options.socketPath) return options;
  const managed = join(homedir(), '.codex', 'packages', 'app-server-daemon', 'current', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  const command = options.command ?? (existsSync(managed) ? managed : 'codex');
  try {
    const { stdout } = await execFileAsync(command, ['app-server', 'daemon', 'version'], { timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024 });
    const info = JSON.parse(stdout) as { status?: string; socketPath?: string };
    if (info.status === 'running' && typeof info.socketPath === 'string' && info.socketPath) {
      return { ...options, command, socketPath: info.socketPath };
    }
  } catch { /* An unavailable daemon leaves the rollout fallback enabled. */ }
  return undefined;
}

/** Read-only JSON-RPC client: the allowlist intentionally excludes resume/start and approval replies. */
export class CodexAppServerClient {
  private socket?: WebSocket;
  private proxy?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  public onNotification?: (method: string, params: any) => void;
  public onDisconnect?: () => void;

  constructor(private readonly options: CodexAppServerOptions) {}

  async connect(): Promise<void> {
    let endpoint = 'ws://localhost/';
    if (this.options.endpoint) {
      const url = new URL(this.options.endpoint);
      if (url.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
        throw new Error('Codex observer requires an existing local socket or loopback WebSocket endpoint');
      }
      endpoint = url.href;
    } else if (!this.options.socketPath) {
      throw new Error('No existing Codex app-server endpoint');
    }
    const socket = this.socket = new WebSocket(endpoint, this.options.socketPath ? {
      createConnection: () => {
        if (!this.options.command) return connectSocket({ path: this.options.socketPath! });
        // The official proxy forwards raw WebSocket bytes, not JSONL. It also
        // supports Windows AF_UNIX sockets that Node's pipe transport cannot open.
        const proxy = this.proxy = spawn(this.options.command, ['app-server', 'proxy', '--sock', this.options.socketPath!], { windowsHide: true });
        proxy.stderr.resume();
        const stream = Duplex.from({ readable: proxy.stdout, writable: proxy.stdin });
        let timer: NodeJS.Timeout | undefined;
        Object.assign(stream, { setTimeout: (ms: number) => {
          if (timer) clearTimeout(timer);
          timer = ms > 0 ? setTimeout(() => stream.emit('timeout'), ms) : undefined;
          return stream;
        } });
        proxy.on('error', () => stream.destroy(new Error('Codex proxy unavailable')));
        proxy.on('exit', () => stream.destroy());
        stream.on('close', () => { if (timer) clearTimeout(timer); proxy.kill(); });
        return stream;
      },
      handshakeTimeout: this.options.requestTimeoutMs ?? 3000,
      maxPayload: 16 * 1024 * 1024
    } : { handshakeTimeout: this.options.requestTimeoutMs ?? 3000, maxPayload: 16 * 1024 * 1024 });
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (typeof message.id === 'number' && !message.method) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(`Codex read request failed (${message.error.code ?? 'unknown'})`));
          else pending.resolve(message.result);
        } else if (message.method && message.id === undefined) {
          this.onNotification?.(message.method, message.params);
        }
        // Server requests (including approvals/auth refresh) are never answered.
      } catch { /* Ignore malformed or unrelated frames. */ }
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Codex observer disconnected'));
      }
      this.pending.clear();
      this.onDisconnect?.();
    });
    socket.on('error', () => { /* Connection/request promises report sanitized errors. */ });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', () => reject(new Error('Cannot connect to existing Codex app-server')));
    });
    await this.request('initialize', { clientInfo: { name: 'agent_deck_observer', title: 'Agent Deck', version: '1.0.0' } });
    socket.send(JSON.stringify({ method: 'initialized', params: {} }));
  }

  request(method: string, params: unknown): Promise<any> {
    if (!READ_METHODS.has(method)) return Promise.reject(new Error('Codex observer rejects non-read-only method'));
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex observer is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex read request timed out'));
      }, this.options.requestTimeoutMs ?? 3000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex observer disconnected'));
    }
    this.pending.clear();
    this.socket?.terminate();
    this.socket = undefined;
    this.proxy?.kill();
    this.proxy = undefined;
  }
}

export function codexRuntimeStatus(status: { type?: string; activeFlags?: string[] } | undefined): RunStatus | undefined {
  if (status?.type === 'notLoaded') return 'detached';
  if (status?.type === 'idle') return 'idle';
  if (status?.type === 'systemError') return 'failed';
  if (status?.type === 'active') {
    if (status.activeFlags?.some(flag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')) return 'waiting';
    return 'running';
  }
  return undefined;
}

export class CodexAppServerObserver {
  private client: CodexAppServerClient;
  private observed = new Map<string, { status: RunStatus; at: number; metadata: string }>();
  private messages = new Map<string, string>();
  private polling = false;
  private connected = false;
  private stopped = false;
  public lastPolledAt?: number;

  constructor(options: CodexAppServerOptions, private readonly publish: (event: EmitEventInput) => void, private readonly disconnected?: () => void) {
    this.client = new CodexAppServerClient(options);
    this.client.onDisconnect = () => { this.connected = false; if (!this.stopped) this.disconnected?.(); };
    this.client.onNotification = (method, params) => {
      if (method === 'thread/status/changed' && this.observed.has(params?.threadId)) {
        const status = codexRuntimeStatus(params.status);
        if (status) this.updateStatus(params.threadId, status);
      }
      if (method === 'item/completed' && params?.item?.type === 'agentMessage') this.message(params.threadId, params.item);
    };
  }

  private emit(event: EmitEventInput): void { if (!this.stopped) this.publish(event); }

  async start(): Promise<void> { this.stopped = false; await this.poll(); }
  stop(): void { this.stopped = true; this.connected = false; this.client.close(); }
  status(id: string): RunStatus | undefined {
    const entry = this.observed.get(id);
    return !this.stopped && this.connected && entry && Date.now() - entry.at < 15_000 ? entry.status : undefined;
  }
  sessionAlive(id: string): boolean | undefined {
    const status = this.status(id);
    return status === undefined ? undefined : status !== 'detached';
  }
  restoreStatus(id: string): void {
    const status = this.status(id);
    if (status) this.emit({ type: 'state.changed', runId: `codex:${id}`, ts: Date.now(), payload: { from: status, to: status, reason: 'codex_runtime', confidence: 'live' } });
  }
  private updateStatus(id: string, status: RunStatus): void {
    const previous = this.observed.get(id);
    this.observed.set(id, { status, at: Date.now(), metadata: previous?.metadata ?? '' });
    if (previous?.status !== status) this.restoreStatus(id);
  }
  private message(id: string, item: any, ts = Date.now()): void {
    if (!id || typeof item.text !== 'string' || !item.text.trim() || this.messages.get(id) === item.id) return;
    this.messages.set(id, item.id);
    this.emit({ type: 'message.completed', runId: `codex:${id}`, ts, payload: { role: 'assistant', messageId: item.id, preview: item.text.slice(0, 400) } });
    this.restoreStatus(id);
  }
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      if (!this.connected) {
        try {
          await this.client.connect();
          if (this.stopped) { this.client.close(); return; }
          this.connected = true;
        }
        catch (error) { this.client.close(); throw error; }
      }
      const ids = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await this.client.request('thread/loaded/list', { limit: 100, cursor });
        for (const id of page.data ?? []) if (typeof id === 'string') ids.add(id);
        const next = page.nextCursor ?? null;
        if (next === cursor && next !== null) throw new Error('Codex pagination did not advance');
        cursor = next;
      } while (cursor);
      for (const id of ids) {
        const { thread } = await this.client.request('thread/read', { threadId: id });
        if (!thread || thread.id !== id) continue;
        const metadata = JSON.stringify([thread.cwd, thread.name, thread.model, thread.parentThreadId]);
        const previous = this.observed.get(id);
        if (previous?.metadata !== metadata) {
          const cwd = typeof thread.cwd === 'string' ? thread.cwd : '';
          this.emit({ type: previous ? 'run.updated' : 'run.started', runId: `codex:${id}`, ts: Number(thread.updatedAt || thread.createdAt) * 1000 || Date.now(), payload: {
            source: 'codex', nativeId: id, projectPath: cwd, projectName: cwd ? basename(cwd.replaceAll('\\', '/')) : 'Codex',
            historical: false,
            title: thread.name || (cwd ? basename(cwd.replaceAll('\\', '/')) : 'Codex'), model: thread.model || undefined, confidence: 'live',
            parentId: thread.parentThreadId ? `codex:${thread.parentThreadId}` : undefined,
            startedAt: Number(thread.createdAt) * 1000 || undefined
          } });
        }
        const status = codexRuntimeStatus(thread.status);
        if (status) {
          this.updateStatus(id, status);
          this.observed.get(id)!.metadata = metadata;
        }
        // This read does not load/resume the thread. Older servers can omit pagination support.
        try {
          const turns = await this.client.request('thread/turns/list', { threadId: id, limit: 5, sortDirection: 'desc', itemsView: 'full' });
          const items = (turns.data ?? []).flatMap((turn: any) => [...(turn.items ?? [])].reverse());
          const lastMessage = items.find((item: any) => item.type === 'agentMessage');
          if (lastMessage) this.message(id, lastMessage, Number(thread.updatedAt) * 1000 || Date.now());
        } catch { /* Rollout messages remain available as fallback. */ }
      }
      for (const [id] of this.observed) if (!ids.has(id)) this.updateStatus(id, 'detached');
      this.lastPolledAt = Date.now();
    } finally { this.polling = false; }
  }
}
