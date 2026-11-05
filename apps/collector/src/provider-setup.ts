import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import * as prompts from '@clack/prompts';
import type { CollectorStore } from './store.js';
import { setupClaudeHooks, uninstallClaudeHooks, removeAgentDeckHooksFromSettings } from './adapters/claude.js';
import { setupAgyHooks, uninstallAgyHooks, removeAgyHooks } from './adapters/agy-hooks.js';

export const PROVIDERS = [
  { id: 'opencode', label: 'OpenCode', hint: 'Existing server and local sessions', directory: '.local/share/opencode' },
  { id: 'claude', label: 'Claude Code', hint: 'Installs observer hooks; reads local sessions', directory: '.claude' },
  { id: 'codex', label: 'Codex', hint: 'Existing app-server and local sessions', directory: '.codex' },
  { id: 'agy', label: 'Antigravity', hint: 'Installs observer hooks; reads local sessions', directory: '.gemini/antigravity-cli' }
] as const;
export type Provider = typeof PROVIDERS[number]['id'];
export interface ProviderSetup { version: 1; providers: Provider[] }
export const PROVIDER_SETUP_KEY = 'provider_setup';

export function parseProviders(input: string): Provider[] {
  if (input === 'none') return [];
  const values = input.split(',');
  if (values.some(value => !PROVIDERS.some(p => p.id === value))) {
    throw new Error('Choose providers: opencode,claude,codex,agy (comma-separated), or none.');
  }
  return [...new Set(values)] as Provider[];
}

export function readProviderSetup(store: CollectorStore): ProviderSetup | undefined {
  const value = store.getSetting<ProviderSetup>(PROVIDER_SETUP_KEY);
  if (value == null) return undefined;
  if (value.version !== 1 || !Array.isArray(value.providers) || value.providers.some(id => !PROVIDERS.some(p => p.id === id))) {
    throw new Error('Invalid saved provider setup. Run agent-deck setup to repair it.');
  }
  return value;
}

export function detectProviders(home = homedir(), path = process.env.PATH ?? ''): Provider[] {
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return PROVIDERS.filter(p => existsSync(join(home, p.directory)) ||
    path.split(delimiter).filter(Boolean).some(dir => extensions.some(ext => existsSync(join(dir, p.id + ext)))))
    .map(p => p.id);
}

function hasOwnedHooks(path: string, remove: (value: Record<string, unknown>) => Record<string, unknown>): boolean {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    return JSON.stringify(value) !== JSON.stringify(remove(value));
  } catch { return false; } // An unselected provider's invalid configuration is not ours to repair.
}

/** Preflight every selected hook before writing; restore configs if any write fails. */
export function saveProviderSetup(store: CollectorStore, providers: Provider[], commandPath: string, home = homedir()): void {
  parseProviders(providers.length ? providers.join(',') : 'none');
  const claudePath = join(home, '.claude', 'settings.json');
  const agyPath = join(home, '.gemini', 'config', 'hooks.json');
  const needsHooks = providers.includes('claude') || providers.includes('agy');
  if (needsHooks && !existsSync(commandPath)) throw new Error('Hook shim missing. Run npm run build:hooks, then retry setup.');
  if (providers.includes('claude')) setupClaudeHooks({ settingsPath: claudePath, commandPath, dryRun: true });
  if (providers.includes('agy')) setupAgyHooks({ hooksPath: agyPath, commandPath, dryRun: true });
  const removeClaude = !providers.includes('claude') && hasOwnedHooks(claudePath, removeAgentDeckHooksFromSettings);
  const removeAgy = !providers.includes('agy') && hasOwnedHooks(agyPath, removeAgyHooks);
  const paths = [
    ...(providers.includes('claude') || removeClaude ? [claudePath] : []),
    ...(providers.includes('agy') || removeAgy ? [agyPath] : [])
  ];
  const snapshots = paths.map(path => ({ path, text: existsSync(path) ? readFileSync(path) : undefined }));
  try {
    if (providers.includes('claude')) setupClaudeHooks({ settingsPath: claudePath, commandPath });
    else if (removeClaude) uninstallClaudeHooks({ settingsPath: claudePath });
    if (providers.includes('agy')) setupAgyHooks({ hooksPath: agyPath, commandPath });
    else if (removeAgy) uninstallAgyHooks({ hooksPath: agyPath });
    store.setSetting(PROVIDER_SETUP_KEY, { version: 1, providers });
  } catch (error) {
    for (const { path, text } of snapshots) {
      if (text !== undefined) writeFileSync(path, text);
      else if (existsSync(path)) unlinkSync(path);
    }
    throw error;
  }
}

export async function setupProviders(store: CollectorStore, commandPath: string, explicit?: string, home = homedir()): Promise<boolean> {
  if (explicit !== undefined) {
    saveProviderSetup(store, parseProviders(explicit), commandPath, home);
    console.log('Provider selection saved. Restart the collector to apply changes.');
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Provider setup needs an interactive terminal. Run npm run agent-deck setup, or npm run agent-deck setup providers codex,opencode (use none for no providers).');
    return false;
  }
  let previous: ProviderSetup | undefined;
  try { previous = readProviderSetup(store); } catch { /* Explicit setup can repair an invalid selection. */ }
  const detected = detectProviders(home);
  prompts.intro('Agent Deck setup');
  prompts.log.info('Choose which providers Agent Deck may observe. Claude and Antigravity selections install local observer hooks.');
  const selected = await prompts.multiselect<Provider>({
    message: 'Which providers do you want to enable?',
    options: PROVIDERS.map(p => ({ value: p.id, label: p.label, hint: `${detected.includes(p.id) ? 'Detected · ' : ''}${p.hint}` })),
    initialValues: previous?.providers ?? detected,
    required: false
  });
  if (prompts.isCancel(selected)) { prompts.cancel('Setup cancelled. No changes saved.'); return false; }
  saveProviderSetup(store, selected, commandPath, home);
  prompts.outro(`Enabled: ${selected.length ? selected.map(id => PROVIDERS.find(p => p.id === id)!.label).join(', ') : 'none'}. Reopen Claude/agy after hook changes. Run setup again to change providers.`);
  return true;
}
