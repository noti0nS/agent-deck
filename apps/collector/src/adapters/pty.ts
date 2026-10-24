import { createSocket } from 'node:dgram';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AdapterHealth, Capabilities } from '@agent-deck/core';
import type { Adapter, AdapterContext, EmitEventInput } from '../adapter-spi.js';

export interface HeuristicProfile {
  name: string;
  commandMatch: string;
  modelDefault?: string;
  turnStartRegex?: string;
  turnEndRegex?: string;
  toolStartRegex?: string;
  permissionPromptRegex?: string;
  usageTokensRegex?: string; // group 1 = tokensIn, group 2 = tokensOut
  streamJson?: boolean;
}

export const BUILTIN_PROFILES: HeuristicProfile[] = [
  {
    name: 'agy-stream',
    commandMatch: 'agy',
    modelDefault: 'gemini-2.5-pro',
    streamJson: true,
    permissionPromptRegex: '(?:Allow|Approve|Permission).*\\?'
  },
  {
    name: 'aider',
    commandMatch: 'aider',
    modelDefault: 'claude-sonnet-4',
    turnStartRegex: '^>\\s+(.+)$',
    toolStartRegex: '^Applied edit to\\s+(.+)$',
    permissionPromptRegex: '\\(Y\\)es/\\(N\\)o',
    usageTokensRegex: 'Tokens:\\s*([0-9.]+)k?\\s*sent,\\s*([0-9.]+)k?\\s*received'
  },
  {
    name: 'generic-cli',
    commandMatch: '*',
    modelDefault: 'cli-agent',
    turnStartRegex: '^(?:Thinking|Working|Running):\\s*(.+)$',
    toolStartRegex: '^(?:Tool|Exec|Bash|Edit):\\s*(.+)$',
    permissionPromptRegex: '(?:Allow|Approve|Confirm|Proceed).*\\[(?:y/n|Y/n)\\]',
    usageTokensRegex: 'tokens_in=([0-9]+)\\s+tokens_out=([0-9]+)'
  }
];

export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

export function loadProfilesFromDir(dirPath?: string): HeuristicProfile[] {
  const profiles = [...BUILTIN_PROFILES];
  if (!dirPath || !existsSync(dirPath)) return profiles;
  try {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const raw = readFileSync(join(dirPath, entry.name), 'utf8');
          const parsed = JSON.parse(raw) as HeuristicProfile;
          if (parsed.name && parsed.commandMatch) {
            profiles.unshift(parsed);
          }
        } catch {
          // ignore invalid profile JSON
        }
      }
    }
  } catch {
    // ignore
  }
  return profiles;
}

export function selectHeuristicProfile(command: string, profiles: HeuristicProfile[] = BUILTIN_PROFILES): HeuristicProfile {
  const base = basename(command.replace(/\\/g, '/')).toLowerCase();
  for (const p of profiles) {
    if (p.commandMatch !== '*' && base.includes(p.commandMatch.toLowerCase())) {
      return p;
    }
  }
  return profiles[profiles.length - 1] ?? BUILTIN_PROFILES[BUILTIN_PROFILES.length - 1];
}

export function parsePtyLineWithProfile(
  nativeId: string,
  rawLine: string,
  profile: HeuristicProfile,
  ts = Date.now()
): EmitEventInput[] {
  const events: EmitEventInput[] = [];
  const runId = `pty:${nativeId}`;
  const clean = stripAnsi(rawLine).trim();
  if (!clean) return events;

  // Support stream-json mode (e.g., agy --output-format stream-json)
  if (profile.streamJson && clean.startsWith('{') && clean.endsWith('}')) {
    try {
      const obj = JSON.parse(clean) as Record<string, unknown>;
      if (obj.type === 'tool_use' || obj.type === 'step_start') {
        events.push({
          type: 'tool.started',
          runId,
          ts,
          payload: {
            label: String(obj.tool || obj.name || 'step'),
            detail: String(obj.detail || obj.command || obj.path || '')
          }
        });
        return events;
      }
      if (obj.type === 'usage' || (obj.tokens_in !== undefined && obj.tokens_out !== undefined)) {
        events.push({
          type: 'usage.tick',
          runId,
          ts,
          payload: {
            sampleKey: `pty:${nativeId}:json:${ts}`,
            tokensInDelta: Number(obj.tokens_in || 0),
            tokensOutDelta: Number(obj.tokens_out || 0),
            costSource: 'none',
            precision: 'partial'
          }
        });
        return events;
      }
    } catch {
      // fall through to regex heuristics
    }
  }

  if (profile.permissionPromptRegex) {
    const m = clean.match(new RegExp(profile.permissionPromptRegex, 'i'));
    if (m) {
      events.push({
        type: 'attention.raised',
        runId,
        ts,
        payload: {
          attention: {
            id: `pty:${nativeId}:perm:${ts}`,
            kind: 'permission',
            summary: clean.slice(0, 120),
            requestedAt: ts
          }
        }
      });
      return events;
    }
  }

  if (profile.toolStartRegex) {
    const m = clean.match(new RegExp(profile.toolStartRegex, 'i'));
    if (m) {
      events.push({
        type: 'tool.started',
        runId,
        ts,
        payload: {
          label: profile.name,
          detail: (m[1] || clean).slice(0, 120)
        }
      });
      return events;
    }
  }

  if (profile.turnStartRegex) {
    const m = clean.match(new RegExp(profile.turnStartRegex, 'i'));
    if (m) {
      events.push({
        type: 'turn.started',
        runId,
        ts,
        payload: {
          turn: 1,
          promptPreview: (m[1] || clean).slice(0, 120)
        }
      });
      return events;
    }
  }

  if (profile.turnEndRegex) {
    const m = clean.match(new RegExp(profile.turnEndRegex, 'i'));
    if (m) {
      events.push({
        type: 'turn.completed',
        runId,
        ts,
        payload: { turn: 1 }
      });
      return events;
    }
  }

  if (profile.usageTokensRegex) {
    const m = clean.match(new RegExp(profile.usageTokensRegex, 'i'));
    if (m) {
      const parseNum = (s: string) => {
        const v = parseFloat(s);
        return s.toLowerCase().endsWith('k') ? Math.round(v * 1000) : Math.round(v);
      };
      const tokensIn = parseNum(m[1] || '0');
      const tokensOut = parseNum(m[2] || '0');
      if (tokensIn > 0 || tokensOut > 0) {
        events.push({
          type: 'usage.tick',
          runId,
          ts,
          payload: {
            sampleKey: `pty:${nativeId}:tok:${ts}:${tokensIn}:${tokensOut}`,
            tokensInDelta: tokensIn,
            tokensOutDelta: tokensOut,
            costSource: 'none',
            precision: 'partial'
          }
        });
      }
    }
  }

  return events;
}

export class PtyAdapter implements Adapter {
  public readonly source = 'pty' as const;
  private readonly profilesDir?: string;
  private profiles: HeuristicProfile[] = BUILTIN_PROFILES;
  private ctx?: AdapterContext;
  private currentHealth: AdapterHealth;

  constructor(options?: { profilesDir?: string }) {
    this.profilesDir = options?.profilesDir;
    this.profiles = loadProfilesFromDir(this.profilesDir);
    this.currentHealth = {
      source: 'pty',
      status: 'connected',
      capabilities: {
        liveEvents: true,
        usagePrecision: 'partial',
        attention: true,
        subagents: false,
        notes: [`profiles=${this.profiles.map((p) => p.name).join(',')}`]
      }
    };
  }

  public async probe(): Promise<Capabilities> {
    this.profiles = loadProfilesFromDir(this.profilesDir);
    this.currentHealth.capabilities.notes = [`profiles=${this.profiles.map((p) => p.name).join(',')}`];
    return this.currentHealth.capabilities;
  }

  public async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    await this.probe();
    ctx.reportHealth(this.currentHealth);
  }

  public async stop(): Promise<void> {
    // no-op
  }

  public health(): AdapterHealth {
    return this.currentHealth;
  }

  public ingestSessionOutput(
    nativeId: string,
    command: string,
    cwd: string,
    lines: string[],
    exitCode?: number
  ): void {
    if (!this.ctx) return;
    const profile = selectHeuristicProfile(command, this.profiles);
    const runId = `pty:${nativeId}`;
    const projectName = basename(cwd.replace(/\\/g, '/')) || 'pty-session';

    this.ctx.emit({
      type: 'run.started',
      runId,
      payload: {
        source: 'pty',
        nativeId,
        projectPath: cwd,
        projectName,
        title: `${profile.name}: ${command}`,
        model: profile.modelDefault ?? 'cli-agent',
        confidence: 'live'
      }
    });

    for (const line of lines) {
      const evs = parsePtyLineWithProfile(nativeId, line, profile, Date.now());
      for (const e of evs) {
        this.ctx.emit(e);
      }
    }

    if (exitCode !== undefined) {
      this.ctx.emit({
        type: 'run.ended',
        runId,
        payload: {
          outcome: exitCode === 0 ? 'done' : 'failed',
          endedAt: Date.now()
        }
      });
    }
  }
}

/**
 * Launches any CLI in a pseudo-terminal (`node-pty`) and streams normalized heuristic
 * events via UDP to the local collector (`agent-deck run -- <cli> [args]`, §5.6).
 */
export async function runCliInPtyWrapper(
  command: string,
  args: string[],
  options?: { cwd?: string; udpPort?: number; profilesDir?: string }
): Promise<number> {
  const cwd = options?.cwd ?? process.cwd();
  const udpPort = options?.udpPort ?? 4101;
  const nativeId = `pty_${Date.now()}`;
  const profiles = loadProfilesFromDir(options?.profilesDir);
  const profile = selectHeuristicProfile(command, profiles);

  const sendUdp = (payload: Record<string, unknown>) => {
    const client = createSocket('udp4');
    const buf = Buffer.from(JSON.stringify(payload), 'utf8');
    client.send(buf, udpPort, '127.0.0.1', () => {
      client.close();
    });
  };

  sendUdp({
    hook_event_name: 'SessionStart',
    session_id: nativeId,
    cwd,
    model: profile.modelDefault ?? 'cli-agent'
  });

  const pty = await import('node-pty');
  return new Promise<number>((resolve) => {
    const ptyProc = pty.spawn(command, args, {
      name: 'xterm-color',
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 30,
      cwd,
      env: process.env as Record<string, string>
    });

    let lineBuf = '';
    ptyProc.onData((data: string) => {
      process.stdout.write(data);
      lineBuf += data;
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() ?? '';
      for (const line of lines) {
        const events = parsePtyLineWithProfile(nativeId, line, profile, Date.now());
        for (const ev of events) {
          if (ev.type === 'tool.started') {
            const p = ev.payload as { label: string; detail: string };
            sendUdp({
              hook_event_name: 'PreToolUse',
              session_id: nativeId,
              tool_name: p.label,
              tool_input: { command: p.detail }
            });
          } else if (ev.type === 'attention.raised') {
            const p = ev.payload as { attention: { summary: string } };
            sendUdp({
              hook_event_name: 'Notification',
              session_id: nativeId,
              message: p.attention.summary
            });
          }
        }
      }
    });

    ptyProc.onExit(({ exitCode }) => {
      sendUdp({
        hook_event_name: 'SessionEnd',
        session_id: nativeId
      });
      resolve(exitCode);
    });
  });
}
