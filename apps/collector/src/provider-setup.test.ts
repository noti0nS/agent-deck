import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { CollectorStore } from './store.js';
import { CollectorEngine } from './http.js';
import { createProviderAdapters, runCli } from './cli.js';
import { runHistoryBackfill } from './import.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { AgyAdapter } from './adapters/agy.js';
import { CodexAdapter } from './adapters/codex.js';
import { OpenCodeAdapter } from './adapters/opencode.js';
import { PtyAdapter } from './adapters/pty.js';
import { detectProviders, parseProviders, readProviderSetup, saveProviderSetup, setupProviders } from './provider-setup.js';

vi.mock('@clack/prompts', async importOriginal => {
  const actual = await importOriginal<typeof prompts>();
  return { ...actual, multiselect: vi.fn(), isCancel: vi.fn(actual.isCancel) };
});
const directories: string[] = [];
const stores: CollectorStore[] = [];
const ttyDescriptors = [process.stdin, process.stdout].map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
function setTTY(value: boolean) {
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, 'isTTY', { configurable: true, value });
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'agent-deck-setup-'));
  directories.push(home);
  const dbPath = join(home, 'test.db');
  const store = new CollectorStore(dbPath);
  stores.push(store);
  return { home, store, dbPath };
}
afterEach(() => {
  [process.stdin, process.stdout].forEach((stream, i) => {
    if (ttyDescriptors[i]) Object.defineProperty(stream, 'isTTY', ttyDescriptors[i]!);
    else Reflect.deleteProperty(stream, 'isTTY');
  });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('provider setup', () => {
  it('detects local installations and validates explicit choices including none', () => {
    const { home } = fixture();
    mkdirSync(join(home, '.codex'));
    expect(detectProviders(home, '')).toEqual(['codex']);
    expect(parseProviders('codex,codex,agy')).toEqual(['codex', 'agy']);
    expect(parseProviders('none')).toEqual([]);
    expect(() => parseProviders('claude,typo')).toThrow();
    expect(() => parseProviders('')).toThrow();
  });

  it('installs selected hooks, persists selection, and removes only owned hooks on reconfiguration', () => {
    const { home, store } = fixture();
    const path = join(home, '.gemini', 'config', 'hooks.json');
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    const other = { custom: { Stop: [{ command: 'existing-observer' }] } };
    writeFileSync(path, JSON.stringify(other));
    saveProviderSetup(store, ['agy', 'codex'], process.execPath, home);
    expect(readProviderSetup(store)?.providers).toEqual(['agy', 'codex']);
    expect(JSON.parse(readFileSync(path, 'utf8')).custom).toEqual(other.custom);
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
    saveProviderSetup(store, [], process.execPath, home);
    expect(readProviderSetup(store)?.providers).toEqual([]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(other);
  });

  it('does not mark setup complete or install partial hooks if preflight fails', () => {
    const { home, store } = fixture();
    const path = join(home, '.gemini', 'config', 'hooks.json');
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(path, '{invalid');
    expect(() => saveProviderSetup(store, ['claude', 'agy'], process.execPath, home)).toThrow();
    expect(readProviderSetup(store)).toBeUndefined();
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('{invalid');
    expect(() => saveProviderSetup(store, ['claude'], join(home, 'missing'), home)).toThrow(/shim missing/);
  });

  it('rolls back hook changes if saving the selection fails', () => {
    const { home, store } = fixture();
    vi.spyOn(store, 'setSetting').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => saveProviderSetup(store, ['claude', 'agy'], process.execPath, home)).toThrow('disk full');
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(home, '.gemini', 'config', 'hooks.json'))).toBe(false);
  });

  it('cancellation leaves setup pending', async () => {
    const { store } = fixture();
    setTTY(true);
    vi.mocked(prompts.multiselect).mockResolvedValue(Symbol('cancel') as unknown as string[]);
    vi.mocked(prompts.isCancel).mockReturnValueOnce(true);
    expect(await setupProviders(store, process.execPath)).toBe(false);
    expect(readProviderSetup(store)).toBeUndefined();
  });

  it('saves interactive choices and does not prompt again on subsequent commands', async () => {
    const { home, store, dbPath } = fixture();
    vi.stubEnv('AGENT_DECK_DB_PATH', dbPath);
    setTTY(true);
    vi.mocked(prompts.multiselect).mockResolvedValue(['codex']);
    expect(await setupProviders(store, process.execPath, undefined, home)).toBe(true);
    expect(readProviderSetup(store)?.providers).toEqual(['codex']);
    vi.mocked(prompts.multiselect).mockClear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })));
    expect(await runCli(['status'])).toBe(0);
    expect(prompts.multiselect).not.toHaveBeenCalled();
  });

  it('constructs only enabled provider adapters and excludes disabled history sources', async () => {
    const { store } = fixture();
    expect(createProviderAdapters(['codex']).map(a => a.source)).toEqual(['codex']);
    const claude = vi.spyOn(ClaudeAdapter.prototype, 'scanTranscripts');
    const agy = vi.spyOn(AgyAdapter.prototype, 'pollConversations');
    const codex = vi.spyOn(CodexAdapter.prototype, 'scanRolloutFiles').mockReturnValue(0);
    await runHistoryBackfill(new CollectorEngine({ store }), { providers: ['codex'] });
    expect(codex).toHaveBeenCalled();
    expect(claude).not.toHaveBeenCalled(); expect(agy).not.toHaveBeenCalled();
    expect(store.getSetting<{ providers: string[] }>('last_history_import')?.providers).toEqual(['codex']);
  });

  it('help and doctor bypass setup, while unconfigured non-interactive commands fail with guidance', async () => {
    const { store, dbPath } = fixture();
    vi.stubEnv('AGENT_DECK_DB_PATH', dbPath);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const cls of [ClaudeAdapter, CodexAdapter, AgyAdapter, OpenCodeAdapter, PtyAdapter]) {
      vi.spyOn(cls.prototype, 'probe').mockResolvedValue({ liveEvents: false, usagePrecision: 'none', attention: false, subagents: false, notes: [] });
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })));
    setTTY(false);
    expect(await runCli(['help'])).toBe(0);
    expect(await runCli(['doctor'])).toBe(0);
    expect(readProviderSetup(store)).toBeUndefined();
    expect(await runCli(['start'])).toBe(1);
    expect(readProviderSetup(store)).toBeUndefined();
  });
});
