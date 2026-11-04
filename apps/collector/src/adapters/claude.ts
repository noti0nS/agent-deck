import { createSocket, type Socket } from 'node:dgram';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { AdapterHealth, Capabilities } from '@agent-deck/core';
import { estimateApiCostUsd } from '@agent-deck/pricing';
import type { Adapter, AdapterContext, EmitEventInput } from '../adapter-spi.js';
import { promisify } from 'node:util';
import { parseClaudeSessions, claudeSessionStatus } from './claude-sessions.js';

const execFileAsync = promisify(execFile);

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PreCompact',
  'PostCompact',
  'StopFailure',
  'SubagentStart',
  'MessageDisplay',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionEnd'
] as const;

export interface ClaudeHookEntry {
  matcher?: string;
  _source?: string;
  hooks: Array<{ type: 'command'; command: string; args?: string[]; timeout?: number; onFailure?: 'continue' }>;
}

export function buildClaudeSettingsWithHooks(
  existingSettings: Record<string, unknown>,
  commandPath = 'agent-deck-hook'
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(existingSettings || {})) as Record<string, unknown>;
  if (clone.hooks !== undefined && (!clone.hooks || typeof clone.hooks !== 'object' || Array.isArray(clone.hooks))) throw new Error('Invalid Claude hooks object');
  const hooksObj = ((clone.hooks as Record<string, unknown>) ?? {}) as Record<string, ClaudeHookEntry[]>;

  for (const ev of CLAUDE_HOOK_EVENTS) {
    if (hooksObj[ev] !== undefined && !Array.isArray(hooksObj[ev])) throw new Error(`Invalid Claude hook list: ${ev}`);
    const currentList = Array.isArray(hooksObj[ev]) ? [...hooksObj[ev]] : [];
    // Remove any existing agent-deck entries so install is idempotent
    const filtered = currentList.filter((item) => item?._source !== 'agent-deck');
    const entry: ClaudeHookEntry =
      ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'].includes(ev)
        ? {
            matcher: '*',
            _source: 'agent-deck',
            hooks: [{ type: 'command', command: commandPath, args: ['--source', 'claude', '--udp-addr', '127.0.0.1:4101'], timeout: 2, onFailure: 'continue' }]
          }
        : {
            _source: 'agent-deck',
            hooks: [{ type: 'command', command: commandPath, args: ['--source', 'claude', '--udp-addr', '127.0.0.1:4101'], timeout: 2, onFailure: 'continue' }]
          };
    filtered.push(entry);
    hooksObj[ev] = filtered;
  }

  clone.hooks = hooksObj;
  return clone;
}

export function removeAgentDeckHooksFromSettings(
  existingSettings: Record<string, unknown>
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(existingSettings || {})) as Record<string, unknown>;
  if (!clone.hooks || typeof clone.hooks !== 'object') return clone;

  const hooksObj = clone.hooks as Record<string, ClaudeHookEntry[]>;
  for (const key of Object.keys(hooksObj)) {
    if (Array.isArray(hooksObj[key])) {
      hooksObj[key] = hooksObj[key].filter((item) => item?._source !== 'agent-deck');
      if (hooksObj[key].length === 0) {
        delete hooksObj[key];
      }
    }
  }
  if (Object.keys(hooksObj).length === 0) {
    delete clone.hooks;
  }
  return clone;
}

export function generateUnifiedDiff(beforeText: string, afterText: string, filePath = '~/.claude/settings.json'): string {
  const beforeLines = beforeText.split(/\r?\n/);
  const afterLines = afterText.split(/\r?\n/);
  const lines: string[] = [];
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < maxLen; i++) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a) {
      if (b !== undefined) lines.push(` ${b}`);
    } else {
      if (b !== undefined) lines.push(`-${b}`);
      if (a !== undefined) lines.push(`+${a}`);
    }
  }
  return lines.join('\n');
}

export function setupClaudeHooks(options?: {
  settingsPath?: string;
  commandPath?: string;
  dryRun?: boolean;
}): { diff: string; backupPath?: string; modified: boolean } {
  const settingsPath = options?.settingsPath ?? join(homedir(), '.claude', 'settings.json');
  const commandPath = options?.commandPath ?? 'agent-deck-hook';
  const existed = existsSync(settingsPath);
  const beforeText = existed ? readFileSync(settingsPath, 'utf8') : '{}\n';
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(beforeText) as Record<string, unknown>;
  } catch {
    throw new Error('Claude settings are invalid JSON; refusing to overwrite them');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Claude settings must be an object');

  const updatedObj = buildClaudeSettingsWithHooks(parsed, commandPath);
  const afterText = JSON.stringify(updatedObj, null, 2) + '\n';
  const diff = generateUnifiedDiff(beforeText, afterText, settingsPath);

  if (beforeText === afterText) return { diff: '', modified: false };
  if (options?.dryRun) {
    return { diff, modified: false };
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  let backupPath: string | undefined;
  if (existed) {
    backupPath = `${settingsPath}.bak-${Date.now()}`;
    copyFileSync(settingsPath, backupPath);
    // Also store a canonical initial backup if not present so uninstall can restore byte-for-byte
    const canonicalBackup = `${settingsPath}.bak-agent-deck`;
    if (!existsSync(canonicalBackup)) {
      copyFileSync(settingsPath, canonicalBackup);
    }
  }
  writeFileSync(settingsPath, afterText, 'utf8');
  return { diff, backupPath, modified: true };
}

export function uninstallClaudeHooks(options?: { settingsPath?: string }): { restored: boolean } {
  const settingsPath = options?.settingsPath ?? join(homedir(), '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    return { restored: false };
  }
  const currentText = readFileSync(settingsPath, 'utf8');
  try {
    const parsed = JSON.parse(currentText) as Record<string, unknown>;
    const cleaned = removeAgentDeckHooksFromSettings(parsed);
    writeFileSync(settingsPath, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
    return { restored: true };
  } catch {
    return { restored: false };
  }
}

export function normalizeClaudeHookDatagram(raw: Record<string, unknown>, ts = Date.now()): EmitEventInput[] {
  const events: EmitEventInput[] = [];
  const hookEvent = String(raw.hook_event_name || raw.ev || raw.event || '');
  const sessionId = String(raw.session_id || raw.sid || '');
  if (!sessionId || !CLAUDE_HOOK_EVENTS.includes(hookEvent as typeof CLAUDE_HOOK_EVENTS[number])) return events;
  if (raw._agent_deck_source && raw._agent_deck_source !== 'claude') return events;
  const agentId = typeof raw.agent_id === 'string' ? raw.agent_id : '';
  const nativeId = agentId ? `${sessionId}:agent:${agentId}` : sessionId;
  const notificationType = String(raw.notification_type || raw.type || '');
  if (hookEvent === 'Notification' && notificationType && !['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'].includes(notificationType)) return events;

  const runId = `claude:${nativeId}`;
  const cwd = String(raw.cwd || raw.project_dir || '');
  const projectName = cwd ? basename(cwd.replace(/\\/g, '/')) : nativeId.slice(0, 8);

  // Any native hook can be the first observed event after collector startup.
  // Tool IDs never become sessions, and subagents remain linked to their parent.
  {
    events.push({
      type: 'run.started',
      runId,
      ts,
      payload: {
        source: 'claude',
        nativeId,
        parentId: agentId ? `claude:${sessionId}` : undefined,
        projectPath: cwd,
        projectName,
        title: agentId ? String(raw.agent_type || 'Subagent') : projectName,
        model: String(raw.model || ''),
        confidence: 'live',
        historical: false,
        resumed: hookEvent === 'SessionStart',
        startedAt: ts
      }
    });
  }
  const emit = (type: EmitEventInput['type'], payload: unknown) => events.push({ type, runId, ts, payload });
  const clearAttention = () => emit('attention.cleared', { reason: hookEvent });
  if (hookEvent === 'SessionStart') {
    clearAttention();
    emit('state.changed', { from: 'starting', to: 'idle', reason: 'session_started', confidence: 'live' });
  } else if (hookEvent === 'SubagentStart') {
    emit('turn.started', { turn: 1 });
  } else if (hookEvent === 'MessageDisplay') {
    const preview = String(raw.message_preview ?? raw.delta ?? '');
    if (preview) emit('message.completed', { messageId: String(raw.message_id || `${nativeId}:${ts}`), role: 'assistant', preview: preview.slice(0, 400) });
  } else if (hookEvent === 'UserPromptSubmit') {
    clearAttention();
    const prompt = String(raw.prompt || '');
    if (prompt) emit('message.completed', { messageId: `${nativeId}:prompt:${String(raw.prompt_id || ts)}`, role: 'user', preview: prompt.slice(0, 400) });
    events.push({
      type: 'turn.started',
      runId,
      ts,
      payload: {
        turn: 1,
        promptPreview: prompt.slice(0, 120)
      }
    });
    if (prompt) {
      events.push({
        type: 'run.updated',
        runId,
        ts,
        payload: {
          subtitle: prompt.slice(0, 120),
          confidence: 'live'
        }
      });
    }
  } else if (hookEvent === 'PreToolUse') {
    clearAttention();
    const toolName = String(raw.tool_name || raw.tool || 'tool');
    const toolInput = (raw.tool_input ?? raw.input ?? {}) as Record<string, unknown>;
    const detail = String(
      toolInput.command || toolInput.file_path || toolInput.path || toolInput.pattern || toolName
    ).slice(0, 120);
    events.push({
      type: 'tool.started',
      runId,
      ts,
      payload: {
        stepId: String(raw.tool_use_id || `${nativeId}:${ts}`),
        label: toolName.toLowerCase(),
        detail,
        tool: toolName
      }
    });
  } else if (hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure') {
    clearAttention();
    const toolName = String(raw.tool_name || raw.tool || 'tool');
    const toolInput = (raw.tool_input ?? raw.input ?? {}) as Record<string, unknown>;
    const detail = String(
      toolInput.command || toolInput.file_path || toolInput.path || toolInput.pattern || toolName
    ).slice(0, 120);
    events.push({
      type: 'tool.completed',
      runId,
      ts,
      payload: {
        stepId: String(raw.tool_use_id || `${nativeId}:${ts}`),
        label: toolName.toLowerCase(),
        detail,
        ok: hookEvent !== 'PostToolUseFailure' && !raw.error
      }
    });
  } else if (hookEvent === 'Notification' || hookEvent === 'PermissionRequest') {
    const msg = String(raw.message || raw.title || `Permission requested: ${raw.tool_name || 'tool'}`);
    const isIdlePrompt = notificationType === 'idle_prompt';
    events.push({
      type: 'attention.raised',
      runId,
      ts,
      payload: {
        attention: {
          id: `${nativeId}:notif:${ts}`,
          kind: isIdlePrompt ? 'idle_prompt' : 'permission',
          summary: msg,
          projectPath: cwd || undefined,
          requestedAt: ts
        }
      }
    });
  } else if (hookEvent === 'PreCompact' || hookEvent === 'PostCompact') {
    emit(hookEvent === 'PreCompact' ? 'compact.started' : 'compact.completed', {});
  } else if (hookEvent === 'Stop' || hookEvent === 'StopFailure' || hookEvent === 'SubagentStop') {
    clearAttention();
    if (typeof raw.last_assistant_message === 'string' && raw.last_assistant_message.trim()) {
      emit('message.completed', { messageId: `${nativeId}:stop:${String(raw.prompt_id || ts)}`, role: 'assistant', preview: raw.last_assistant_message.slice(0, 400) });
    }
    events.push({
      type: 'turn.completed',
      runId,
      ts,
      payload: { turn: 1 }
    });
    if (hookEvent === 'StopFailure') {
      emit('error.raised', { message: String(raw.error_details || raw.error || 'Claude turn failed'), recoverable: false });
    } else if (hookEvent === 'SubagentStop' && agentId) {
      emit('run.ended', { outcome: 'done', endedAt: ts });
    } else {
      emit('state.changed', { from: 'done', to: 'idle', reason: 'native_stop', confidence: 'live' });
    }
  } else if (hookEvent === 'SessionEnd') {
    clearAttention();
    events.push({
      type: 'run.ended',
      runId,
      ts,
      payload: {
        outcome: 'done',
        endedAt: ts
      }
    });
  }

  return events;
}

export function normalizeClaudeTranscriptLine(
  nativeId: string,
  projectName: string,
  projectPath: string,
  lineObj: Record<string, unknown>,
  lineIndex: number,
  defaultTs = Date.now()
): EmitEventInput[] {
  const events: EmitEventInput[] = [];
  const runId = `claude:${nativeId}`;
  const type = String(lineObj.type || '');
  const ts = lineObj.timestamp ? new Date(String(lineObj.timestamp)).getTime() || defaultTs : defaultTs;

  if (lineIndex === 0) {
    events.push({
      type: 'run.started',
      runId,
      ts,
      payload: {
        source: 'claude',
        nativeId,
        projectPath,
        projectName,
        title: projectName,
        model: 'claude-sonnet-4',
        confidence: 'polled',
        startedAt: ts
      }
    });
  }

  if (type === 'ai-title') {
    const title = String(lineObj.aiTitle || lineObj.title || lineObj.summary || '');
    if (title) {
      events.push({
        type: 'run.updated',
        runId,
        ts,
        payload: { title }
      });
    }
  } else if (type === 'last-prompt') {
    const prompt = String(lineObj.lastPrompt || lineObj.prompt || '');
    if (prompt) {
      events.push({
        type: 'run.updated',
        runId,
        ts,
        payload: { subtitle: prompt.slice(0, 120) }
      });
    }
  } else if (type === 'mode' || type === 'permission-mode') {
    const mode = String(lineObj.mode || lineObj.permissionMode || '');
    if (mode) {
      events.push({
        type: 'run.updated',
        runId,
        ts,
        payload: { agentMode: mode }
      });
    }
  } else if (type === 'file-history-delta' || type === 'file-history-snapshot') {
    const filePath = String(lineObj.filePath || lineObj.path || 'file');
    const additions = Number(lineObj.additions ?? lineObj.linesAdded ?? 1);
    const deletions = Number(lineObj.deletions ?? lineObj.linesRemoved ?? 0);
    events.push({
      type: 'file.changed',
      runId,
      ts,
      payload: {
        path: filePath,
        additions,
        deletions
      }
    });
  } else if (type === 'user') {
    const message = lineObj.message as { content?: Array<Record<string, unknown>> } | undefined;
    const results = Array.isArray(message?.content) ? message.content.filter(b => b.type === 'tool_result') : [];
    if (results.length) {
      return results.map(b => ({ type: 'tool.completed', runId, ts, payload: {
        stepId: String(b.tool_use_id || ''), label: 'tool', ok: typeof b.is_error === 'boolean' ? !b.is_error : undefined
      } }));
    }
    events.push({
      type: 'turn.started',
      runId,
      ts,
      payload: { turn: lineIndex + 1 }
    });
  } else if (type === 'assistant') {
    const message = (lineObj.message ?? {}) as Record<string, unknown>;
    const model = String(message.model || lineObj.model || 'claude-sonnet-4');
    const msgId = String(message.id || lineObj.uuid || `line_${lineIndex}`);
    const usage = (message.usage ?? lineObj.usage) as Record<string, unknown> | undefined;

    events.push({
      type: 'run.updated',
      runId,
      ts,
      payload: { model }
    });

    if (usage) {
      const tokensIn = Number(usage.input_tokens || 0);
      const tokensOut = Number(usage.output_tokens || 0);
      const cacheRead = Number(usage.cache_read_input_tokens || 0);
      const cacheWrite = Number(usage.cache_creation_input_tokens || 0);
      const estCost = estimateApiCostUsd(model, {
        tokensIn,
        tokensOut,
        cacheRead,
        cacheWrite
      });

      events.push({
        type: 'usage.tick',
        runId,
        ts,
        payload: {
          sampleKey: `claude:${nativeId}:msg:${msgId}`,
          tokensInDelta: tokensIn,
          tokensOutDelta: tokensOut,
          cacheReadDelta: cacheRead,
          cacheWriteDelta: cacheWrite,
          costUsdDelta: estCost,
          costSource: estCost === undefined ? 'none' : 'estimated',
          precision: 'derived'
        }
      });
    }

    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          events.push({
            type: 'message.completed',
            runId,
            ts,
            payload: {
              messageId: msgId,
              role: 'assistant',
              preview: block.text.slice(0, 400)
            }
          });
        } else if (block.type === 'tool_use') {
          const toolName = String(block.name || 'tool');
          const input = (block.input ?? {}) as Record<string, unknown>;
          const detail = String(
            input.command || input.file_path || input.path || input.pattern || toolName
          ).slice(0, 120);
          events.push({
            type: 'tool.started',
            runId,
            ts,
            payload: {
              stepId: String(block.id || msgId),
              label: toolName.toLowerCase(),
              detail,
              tool: toolName
            }
          });
        }
      }
    }
  }

  return events;
}

export interface ClaudeAdapterOptions {
  projectsDir?: string;
  udpPort?: number;
  pollIntervalMs?: number;
  nativePollIntervalMs?: number;
  cliPath?: string;
  listSessions?: () => Promise<unknown>;
}

export class ClaudeAdapter implements Adapter {
  public readonly source = 'claude' as const;
  public readonly projectsDir: string;
  public readonly udpPort: number;
  private readonly pollIntervalMs: number;
  private ctx?: AdapterContext;
  private udpSocket: Socket | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private offsets: Record<string, number> = {};
  private currentHealth: AdapterHealth;
  private readonly nativeSessions = new Map<string, { ended: boolean; receivedAt: number }>();
  private readonly messageBatches = new Map<string, { text: string; index: number }>();
  private readonly hookEventIds = new Set<string>();
  private readonly nativePollIntervalMs: number;
  private readonly listSessions: () => Promise<unknown>;
  private nativeTimer: NodeJS.Timeout | null = null;
  private pollingNative = false;
  private nativeGeneration = 0;
  private readonly inventory = new Map<string, { busy: boolean; missing: boolean; checkedAt: number; fingerprint: string }>();

  constructor(options: ClaudeAdapterOptions = {}) {
    this.projectsDir = options.projectsDir ?? join(homedir(), '.claude', 'projects');
    this.udpPort = options.udpPort ?? 4101;
    this.pollIntervalMs = options.pollIntervalMs ?? 2500;
    this.nativePollIntervalMs = options.nativePollIntervalMs ?? 10_000;
    this.listSessions = options.listSessions ?? (async () => {
      const executable = options.cliPath ?? process.env.AGENT_DECK_CLAUDE_COMMAND ?? (process.platform === 'win32' ? 'claude.exe' : 'claude');
      const { stdout } = await execFileAsync(executable, ['agents', '--json', '--all'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      return JSON.parse(stdout);
    });
    this.currentHealth = {
      source: 'claude',
      status: 'off',
      capabilities: {
        liveEvents: false,
        usagePrecision: 'none',
        attention: false,
        subagents: false,
        notes: []
      }
    };
  }

  public async probe(): Promise<Capabilities> {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    let hooksInstalled = false;
    if (existsSync(settingsPath)) {
      try {
        const text = readFileSync(settingsPath, 'utf8');
        const settings = JSON.parse(text) as { hooks?: Record<string, ClaudeHookEntry[]> };
        hooksInstalled = !(settings as Record<string, unknown>).disableAllHooks && CLAUDE_HOOK_EVENTS.every(event => settings.hooks?.[event]?.some(entry =>
          entry._source === 'agent-deck' && entry.hooks?.some(hook => hook.type === 'command' && !!hook.command)));
      } catch {
        hooksInstalled = false;
      }
    }
    const hasProjectsDir = existsSync(this.projectsDir);
    const notes: string[] = [];
    if (hooksInstalled) notes.push(`hooks=installed (udp:${this.udpPort})`);
    else notes.push('hooks=not installed (run `agent-deck setup claude`)');
    if (hasProjectsDir) notes.push(`transcripts=${this.projectsDir}`);

    const caps: Capabilities = {
      liveEvents: hooksInstalled,
      usagePrecision: hasProjectsDir ? 'derived' : 'none',
      attention: hooksInstalled,
      subagents: true,
      notes
    };

    this.currentHealth = {
      source: 'claude',
      status: hasProjectsDir || hooksInstalled ? 'connected' : 'off',
      capabilities: caps,
      configured: hooksInstalled,
      transport: hooksInstalled ? 'udp' : 'poll'
    };
    return caps;
  }

  public async start(ctx: AdapterContext): Promise<void> {
    this.nativeGeneration += 1;
    this.ctx = ctx;
    this.offsets = ctx.getSetting<Record<string, number>>('claude_offsets') ?? {};
    await this.probe();
    ctx.reportHealth(this.currentHealth);

    // Start UDP ingest socket on 127.0.0.1:4101 (§3.1, §5.3)
    if (this.udpPort > 0) {
      await new Promise<void>((resolve) => {
        try {
          const sock = createSocket('udp4');
          sock.on('message', (msg) => {
            try {
              const str = msg.toString('utf8');
              const parsed = JSON.parse(str) as Record<string, unknown>;
              if (!this.ingestHook(parsed)) return;
              this.currentHealth.lastSeenAt = Date.now();
              this.currentHealth.lastEventAt = this.currentHealth.lastSeenAt;
              this.ctx?.reportHealth(this.currentHealth);
            } catch {
              // ignore malformed UDP packet
            }
          });
          sock.on('error', (error) => {
            this.currentHealth.status = 'degraded';
            this.currentHealth.capabilities.liveEvents = false;
            this.currentHealth.lastError = error.message;
            this.ctx?.reportHealth(this.currentHealth);
            try {
              sock.close();
            } catch {
              // ignore
            }
            resolve();
          });
          sock.bind(this.udpPort, '127.0.0.1', () => {
            this.udpSocket = sock;
            resolve();
          });
        } catch {
          resolve();
        }
      });
    }

    this.scanTranscripts();
    await this.reconcileNativeSessions();
    this.nativeTimer = setInterval(() => { void this.reconcileNativeSessions(); }, this.nativePollIntervalMs);
    this.nativeTimer.unref();
    this.pollTimer = setInterval(() => {
      this.scanTranscripts();
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  public async stop(): Promise<void> {
    this.nativeGeneration += 1;
    if (this.nativeTimer) clearInterval(this.nativeTimer);
    this.nativeTimer = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.udpSocket) {
      await new Promise<void>((resolve) => {
        try {
          this.udpSocket!.close(() => resolve());
        } catch {
          resolve();
        }
      });
      this.udpSocket = null;
    }
  }

  public health(): AdapterHealth {
    return this.currentHealth;
  }

  public sessionAlive(nativeId: string): boolean | undefined {
    const observed = this.inventory.get(nativeId);
    if (observed && Date.now() - observed.checkedAt <= this.nativePollIntervalMs * 2) {
      if (observed.missing) return false;
      if (observed.busy) return true;
    }
    // Hooks are events, not heartbeats. Never claim indefinite liveness from
    // SessionStart; an explicit SessionEnd does prove that the session closed.
    return this.nativeSessions.get(nativeId)?.ended ? false : undefined;
  }

  public ingestHook(raw: Record<string, unknown>, ts = Date.now()): boolean {
    if (raw._agent_deck_source && raw._agent_deck_source !== 'claude') return false;
    const eventId = typeof raw.event_id === 'string' ? raw.event_id : undefined;
    if (eventId && this.hookEventIds.has(eventId)) return false;
    const nativeIdForOrder = `${raw.session_id || raw.sid || ''}${raw.agent_id ? `:agent:${raw.agent_id}` : ''}`;
    if (typeof raw.emitted_at_ms === 'number') {
      if (raw.emitted_at_ms > ts + 30_000 || ts - raw.emitted_at_ms > 120_000 || raw.emitted_at_ms < (this.nativeSessions.get(nativeIdForOrder)?.receivedAt ?? 0)) return false;
      ts = raw.emitted_at_ms;
    }
    if (raw.hook_event_name === 'MessageDisplay') {
      if (!raw.session_id || !raw.message_id || !Number.isInteger(raw.index) || Number(raw.index) < 0 || typeof raw.delta !== 'string') return false;
      const key = `${raw.session_id}:${raw.agent_id || ''}:${raw.message_id}`;
      const previous = this.messageBatches.get(key);
      if (previous && Number(raw.index) <= previous.index) return false;
      const text = ((previous?.text ?? '') + raw.delta).slice(0, 400);
      this.messageBatches.set(key, { text, index: Number(raw.index) });
      if (this.messageBatches.size > 100) this.messageBatches.delete(this.messageBatches.keys().next().value!);
      raw = { ...raw, message_preview: text };
    }
    const events = normalizeClaudeHookDatagram(raw, ts);
    if (!events.length) return false;
    if (eventId) {
      this.hookEventIds.add(eventId);
      if (this.hookEventIds.size > 1000) this.hookEventIds.delete(this.hookEventIds.values().next().value!);
    }
    const nativeId = events[0].runId!.slice('claude:'.length);
    this.nativeSessions.set(nativeId, {
      ended: raw.hook_event_name === 'SessionEnd' || raw.hook_event_name === 'SubagentStop',
      receivedAt: ts
    });
    for (const event of events) this.ctx?.emit(event);
    return true;
  }

  public async reconcileNativeSessions(now = Date.now()): Promise<void> {
    if (!this.ctx || this.pollingNative) return;
    this.pollingNative = true;
    const generation = this.nativeGeneration;
    try {
      const rows = parseClaudeSessions(await this.listSessions());
      if (generation !== this.nativeGeneration) return;
      const seen = new Set<string>();
      for (const row of rows) {
        seen.add(row.sessionId);
        if ((this.nativeSessions.get(row.sessionId)?.receivedAt ?? 0) > now) continue;
        const status = claudeSessionStatus(row);
        const previous = this.inventory.get(row.sessionId);
        const fingerprint = JSON.stringify(row);
        const changed = previous?.fingerprint !== fingerprint || (this.nativeSessions.get(row.sessionId)?.receivedAt ?? 0) > (previous?.checkedAt ?? 0);
        this.inventory.set(row.sessionId, { busy: status === 'running', missing: false, checkedAt: now, fingerprint });
        const runId = `claude:${row.sessionId}`;
        if (changed) {
          const projectName = basename(row.cwd.replace(/\\/g, '/'));
          this.ctx.emit({ type: 'run.started', runId, ts: row.startedAt, payload: { source: 'claude', nativeId: row.sessionId,
            projectPath: row.cwd, projectName, title: row.name || projectName, model: '', agentMode: row.kind,
            confidence: 'polled', historical: false, resumed: !!row.pid && (!previous || previous.missing), startedAt: row.startedAt } });
          if (status === 'waiting') this.ctx.emit({ type: 'attention.raised', runId, ts: now, payload: { attention: {
            id: `${row.sessionId}:native-wait`, kind: row.waitingFor === 'permission prompt' ? 'permission' : 'question',
            summary: row.waitingFor || 'Claude reports that this session needs input', requestedAt: now
          } } });
          else this.ctx.emit({ type: 'attention.cleared', runId, ts: now, payload: { reason: 'native_session_inventory' } });
        }
        this.ctx.emit({ type: 'state.changed', runId, ts: now, payload: { from: 'idle', to: status,
          reason: status === 'detached' ? 'activity_unconfirmed' : 'native_session_inventory', confidence: 'polled' } });
      }
      for (const [id, previous] of this.inventory) {
        if (seen.has(id) || previous.missing || (this.nativeSessions.get(id)?.receivedAt ?? 0) > now) continue;
        this.inventory.set(id, { ...previous, busy: false, missing: true, checkedAt: now });
        this.ctx.emit({ type: 'state.changed', runId: `claude:${id}`, ts: now,
          payload: { from: 'idle', to: 'detached', reason: 'liveness_lost', confidence: 'polled' } });
      }
      this.currentHealth.lastPolledAt = now;
      this.currentHealth.status = 'connected';
      this.currentHealth.lastError = undefined;
      this.currentHealth.capabilities.notes = [...this.currentHealth.capabilities.notes.filter(note => !note.startsWith('native-inventory=')), 'native-inventory=claude agents --json --all'];
      this.ctx.reportHealth(this.currentHealth);
    } catch {
      if (generation !== this.nativeGeneration) return;
      // A failed read is unknown, not proof that every session exited.
      this.inventory.clear();
      this.currentHealth.capabilities.notes = [...this.currentHealth.capabilities.notes.filter(note => !note.startsWith('native-inventory=')), 'native-inventory=unavailable (hooks/transcript fallback)'];
      this.ctx.reportHealth(this.currentHealth);
    } finally { this.pollingNative = false; }
  }

  public scanTranscripts(maxFiles = 20): number {
    if (!existsSync(this.projectsDir) || !this.ctx) return 0;
    const files: Array<{ path: string; mtimeMs: number; projectSlug: string; sessionId: string }> = [];

    try {
      for (const projEntry of readdirSync(this.projectsDir, { withFileTypes: true })) {
        if (!projEntry.isDirectory()) continue;
        const projPath = join(this.projectsDir, projEntry.name);
        for (const fEntry of readdirSync(projPath, { withFileTypes: true })) {
          if (!fEntry.isFile() || !fEntry.name.endsWith('.jsonl')) continue;
          const fullPath = join(projPath, fEntry.name);
          try {
            const st = statSync(fullPath);
            files.push({
              path: fullPath,
              mtimeMs: st.mtimeMs,
              projectSlug: projEntry.name,
              sessionId: fEntry.name.replace(/\.jsonl$/, '')
            });
          } catch {
            // ignore
          }
        }
      }
    } catch {
      return 0;
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const selected = files.slice(0, maxFiles);
    let processedLines = 0;

    for (const file of selected) {
      processedLines += this.tailJsonlFile(file.path, file.sessionId, file.projectSlug, file.mtimeMs);
    }

    if (processedLines > 0) {
      this.ctx.setSetting('claude_offsets', this.offsets);
    }
    this.currentHealth.lastPolledAt = Date.now();
    this.ctx.reportHealth(this.currentHealth);
    return processedLines;
  }

  public tailJsonlFile(
    filePath: string,
    sessionId: string,
    projectSlug: string,
    mtimeMs = Date.now()
  ): number {
    if (!this.ctx) return 0;
    let st;
    try {
      st = statSync(filePath);
    } catch {
      return 0;
    }

    const prevOffset = this.offsets[filePath] ?? 0;
    const startOffset = st.size < prevOffset ? 0 : prevOffset;
    if (st.size <= startOffset) return 0;

    const lengthToRead = st.size - startOffset;
    const buf = Buffer.alloc(lengthToRead);
    const fd = openSync(filePath, 'r');
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buf, 0, lengthToRead, startOffset);
    } finally {
      closeSync(fd);
    }

    const text = buf.subarray(0, bytesRead).toString('utf8');
    const lastNewlineIdx = text.lastIndexOf('\n');
    if (lastNewlineIdx === -1) {
      // Partial line mid-write; wait for newline on next poll (§13 failure injection)
      return 0;
    }

    const completeChunk = text.slice(0, lastNewlineIdx + 1);
    const consumedBytes = Buffer.byteLength(completeChunk, 'utf8');
    this.offsets[filePath] = startOffset + consumedBytes;

    const lines = completeChunk.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const projectName = projectSlug.split(/[-_]/).filter(Boolean).pop() || projectSlug;
    let count = 0;

    for (let i = 0; i < lines.length; i++) {
      try {
        const obj = JSON.parse(lines[i]) as Record<string, unknown>;
        const events = normalizeClaudeTranscriptLine(
          sessionId,
          projectName,
          projectSlug,
          obj,
          startOffset === 0 ? i : i + 1,
          mtimeMs
        );
        for (const ev of events) {
          // Transcript writes can lag a native Stop. After hooks take ownership,
          // retain enrichment without replaying lifecycle or old messages.
          if ((this.nativeSessions.has(sessionId) || this.inventory.has(sessionId)) && !['usage.tick', 'file.changed', 'run.updated'].includes(ev.type)) continue;
          this.ctx.emit(ev);
          this.currentHealth.lastEventAt = Math.max(this.currentHealth.lastEventAt ?? 0, ev.ts ?? mtimeMs);
        }
        if (!events.length) this.currentHealth.ignoredEvents = (this.currentHealth.ignoredEvents ?? 0) + 1;
        count += 1;
      } catch {
        this.currentHealth.parseErrors = (this.currentHealth.parseErrors ?? 0) + 1;
      }
    }

    return count;
  }

}
import { execFile } from 'node:child_process';
