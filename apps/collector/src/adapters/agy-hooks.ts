import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { EmitEventInput } from '../adapter-spi.js';

export const AGY_HOOK_EVENTS = ['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'] as const;
export const AGY_HOOK_NAME = 'agent-deck-observer';
export const AGY_HOOKS_PATH = join(homedir(), '.gemini', 'config', 'hooks.json');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const owned = (value: unknown): boolean => record(value) && AGY_HOOK_EVENTS.every(event => {
  const entries = value[event];
  if (!Array.isArray(entries) || entries.length !== 1 || !record(entries[0])) return false;
  const handlers = event === 'PreToolUse' || event === 'PostToolUse' ? entries[0].hooks : entries;
  return Array.isArray(handlers) && handlers.length === 1 && record(handlers[0])
    && typeof handlers[0].command === 'string' && handlers[0].command.includes(` --source agy --event ${event} --udp-addr 127.0.0.1:`);
});

export function buildAgyHooks(existing: Record<string, unknown>, commandPath = 'agent-deck-hook', port = 4102): Record<string, unknown> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Antigravity hook UDP port');
  if (/["\r\n]/.test(commandPath)) throw new Error('Invalid hook executable path');
  if (existing[AGY_HOOK_NAME] !== undefined && !owned(existing[AGY_HOOK_NAME])) {
    throw new Error(`Hook name ${AGY_HOOK_NAME} belongs to another configuration; refusing to replace it`);
  }
  const observer: Record<string, unknown> = { ...(record(existing[AGY_HOOK_NAME]) ? existing[AGY_HOOK_NAME] : {}), enabled: true };
  // Avoid embedded quotes for simple Windows paths: command launchers that
  // apply Win32 argv escaping before cmd.exe turn them into literal \" characters.
  const executable = process.platform === 'win32' && /^[a-zA-Z0-9_:.\\/\-]+$/.test(commandPath)
    ? commandPath : `"${commandPath}"`;
  for (const event of AGY_HOOK_EVENTS) {
    const handler = { type: 'command', command: `${executable} --source agy --event ${event} --udp-addr 127.0.0.1:${port}`, timeout: 1 };
    observer[event] = event === 'PreToolUse' || event === 'PostToolUse'
      ? [{ matcher: '*', hooks: [handler] }] : [handler];
  }
  return { ...existing, [AGY_HOOK_NAME]: observer };
}

export function removeAgyHooks(existing: Record<string, unknown>): Record<string, unknown> {
  const result = { ...existing };
  if (owned(result[AGY_HOOK_NAME])) {
    const remainder = { ...(result[AGY_HOOK_NAME] as Record<string, unknown>) };
    for (const event of AGY_HOOK_EVENTS) delete remainder[event];
    delete remainder.enabled;
    if (Object.keys(remainder).length) result[AGY_HOOK_NAME] = remainder;
    else delete result[AGY_HOOK_NAME];
  }
  return result;
}

function readHooks(path: string): { text: string; parsed: Record<string, unknown> } {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '{}\n';
  const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!record(parsed)) throw new Error('Antigravity hooks must be a JSON object; refusing to overwrite');
  return { text, parsed };
}

export function agyHooksInstalled(path = AGY_HOOKS_PATH): boolean {
  try {
    const observer = readHooks(path).parsed[AGY_HOOK_NAME];
    return record(observer) && owned(observer) && observer.enabled !== false && AGY_HOOK_EVENTS.every(event => Array.isArray(observer[event]) && (observer[event] as unknown[]).length > 0);
  } catch { return false; }
}

export function setupAgyHooks(options: { hooksPath?: string; commandPath?: string; udpPort?: number; dryRun?: boolean } = {}): { modified: boolean; diff: string; backupPath?: string } {
  const path = options.hooksPath ?? AGY_HOOKS_PATH;
  const before = readHooks(path);
  const updated = buildAgyHooks(before.parsed, options.commandPath, options.udpPort);
  const after = JSON.stringify(updated, null, 2) + '\n';
  const changed = JSON.stringify(before.parsed) !== JSON.stringify(updated);
  const diff = changed ? `--- ${path}\n+++ ${path}\n${after}` : '';
  if (!changed || options.dryRun) return { modified: false, diff };
  mkdirSync(dirname(path), { recursive: true });
  let backupPath: string | undefined;
  if (existsSync(path)) { backupPath = `${path}.bak-agent-deck-${Date.now()}`; copyFileSync(path, backupPath); }
  writeFileSync(path, after, 'utf8');
  return { modified: true, diff, backupPath };
}

export function uninstallAgyHooks(options: { hooksPath?: string; dryRun?: boolean } = {}): { restored: boolean; diff: string } {
  const path = options.hooksPath ?? AGY_HOOKS_PATH;
  if (!existsSync(path)) return { restored: false, diff: '' };
  const before = readHooks(path);
  const updated = removeAgyHooks(before.parsed);
  if (JSON.stringify(before.parsed) === JSON.stringify(updated)) return { restored: false, diff: '' };
  const after = JSON.stringify(updated, null, 2) + '\n';
  const diff = `--- ${path}\n+++ ${path}\n${after}`;
  if (!options.dryRun) writeFileSync(path, after, 'utf8');
  return { restored: !options.dryRun, diff };
}

/** Native lifecycle payloads are keyed by conversationId, never stepIdx/tool IDs. */
export class AgyHookNormalizer {
  private seen = new Map<string, number>();
  private loops = new Set<string>();
  private latestTimestamp = new Map<string, number>();

  normalize(raw: Record<string, unknown>, ts = Date.now()): EmitEventInput[] {
    if (raw._agent_deck_source !== 'agy') return [];
    const nativeId = typeof raw.conversationId === 'string' ? raw.conversationId : '';
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(nativeId)) return [];
    const event = String(raw.hook_event_name ?? '');
    if (!AGY_HOOK_EVENTS.includes(event as typeof AGY_HOOK_EVENTS[number])) return [];
    if (typeof raw.emitted_at_ms === 'number') {
      if (!Number.isFinite(raw.emitted_at_ms) || raw.emitted_at_ms > ts + 5000 || raw.emitted_at_ms < ts - 120_000) return [];
      ts = raw.emitted_at_ms;
    }
    if (ts < (this.latestTimestamp.get(nativeId) ?? 0)) return [];
    // Datagram IDs are generated by the shim; the bounded fallback only suppresses immediate retransmits.
    const fingerprint = `${nativeId}:${event}:${typeof raw.event_id === 'string' ? raw.event_id : JSON.stringify(raw)}`;
    const previous = this.seen.get(fingerprint);
    if (previous !== undefined && ts - previous < (raw.event_id ? 3_600_000 : 1000)) return [];
    this.seen.set(fingerprint, ts);
    this.latestTimestamp.set(nativeId, ts);
    if (this.seen.size > 2048) this.seen.delete(this.seen.keys().next().value!);
    const runId = `agy:${nativeId}`;
    const projectPath = Array.isArray(raw.workspacePaths) && typeof raw.workspacePaths[0] === 'string' ? raw.workspacePaths[0] : '';
    const projectName = projectPath ? basename(projectPath.replaceAll('\\', '/')) : nativeId.slice(0, 8);
    // Metadata accompanies every event so late attachment never creates an anonymous tool-call card.
    const events: EmitEventInput[] = [{ type: 'run.started', runId, ts, payload: {
      source: 'agy', nativeId, projectPath, projectName, title: '', historical: false,
      model: typeof raw.modelName === 'string' ? raw.modelName : 'unknown', confidence: 'live', startedAt: ts,
      ...(event === 'SessionStart' ? { resumed: true } : {})
    } }];
    if (event === 'SessionStart') {
      this.loops.delete(nativeId);
    } else if (event === 'PreInvocation') {
      if (!this.loops.has(nativeId)) {
        this.loops.add(nativeId);
        events.push({ type: 'turn.started', runId, ts, payload: {} });
      } else {
        events.push({ type: 'state.changed', runId, ts, payload: { from: 'running', to: 'running', reason: 'agy_invocation_activity', confidence: 'live' } });
      }
    } else if (event === 'PostInvocation') {
      events.push({ type: 'state.changed', runId, ts, payload: { from: 'running', to: 'running', reason: 'agy_invocation_activity', confidence: 'live' } });
    } else if (event === 'PreToolUse' || event === 'PostToolUse') {
      const tool = record(raw.toolCall) ? raw.toolCall : {};
      const args = record(tool.args) ? tool.args : {};
      const label = typeof tool.name === 'string' ? tool.name : 'tool';
      if (!Number.isInteger(raw.stepIdx) || Number(raw.stepIdx) < 0) return [];
      const detail = String(args.CommandLine ?? args.AbsolutePath ?? args.TargetFile ?? args.Query ?? label).slice(0, 120);
      events.push({ type: event === 'PreToolUse' ? 'tool.started' : 'tool.completed', runId, ts,
        payload: { stepId: `${nativeId}:step:${raw.stepIdx}`, label, tool: label, detail, ...(event === 'PostToolUse' ? { ok: !raw.error } : {}) } });
    } else if (event === 'Stop') {
      this.loops.delete(nativeId);
      if (typeof raw.error === 'string' && raw.error) {
        events.push({ type: 'error.raised', runId, ts, payload: { message: raw.error.slice(0, 400), recoverable: false } });
      } else if (raw.fullyIdle === true) {
        events.push({ type: 'attention.cleared', runId, ts, payload: { reason: 'agy_stop' } });
        events.push({ type: 'turn.completed', runId, ts, payload: {} });
        events.push({ type: 'state.changed', runId, ts, payload: { from: 'done', to: 'idle', reason: 'agy_fully_idle', confidence: 'live' } });
      } else if (raw.fullyIdle === false) {
        events.push({ type: 'state.changed', runId, ts, payload: { from: 'running', to: 'running', reason: 'agy_invocation_activity', confidence: 'live' } });
      }
    }
    return events;
  }
}
