import { createInterface } from 'node:readline';
import type { AgentRun } from '@agent-deck/core';
import { defaultRedactor } from '@agent-deck/redact';

const names = ['list_sessions', 'pending_attention', 'recent_failures', 'execution_tree'] as const;
export async function handleMcp(message: unknown, readRuns: () => Promise<AgentRun[]>): Promise<unknown> {
  const request = message as { jsonrpc?: string; id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  const error = (code: number, text: string) => ({ jsonrpc: '2.0', id: request?.id ?? null, error: { code, message: text } });
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return error(-32600, 'Invalid request');
  if (request.id === undefined) return undefined;
  let result: unknown;
  if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agent-deck', version: '1.0.0' } };
  else if (request.method === 'ping') result = {};
  else if (request.method === 'tools/list') result = { tools: names.map(name => ({ name,
    description: `Read agent-deck ${name.replaceAll('_', ' ')}. Observe-only; never controls agents.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  })) };
  else if (request.method === 'tools/call') {
    const name = request.params?.name;
    if (!names.includes(name as typeof names[number]) || Object.keys(request.params?.arguments ?? {}).length) return error(-32602, 'Unknown tool or invalid arguments');
    try {
      const runs = (await readRuns()).sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, 200);
      const selected = name === 'pending_attention' ? runs.filter(r => r.attention) : name === 'recent_failures' ? runs.filter(r => r.status === 'failed' || r.recentSteps?.some(s => s.ok === false)) : runs;
      const data = selected.map(r => ({ id: r.id, parentId: r.parentId, source: r.source, title: r.title,
        project: r.projectName, status: r.status, model: r.model, lastActivityAt: r.lastActivityAt,
        attention: r.attention, activeTools: r.activeSteps ?? [],
        ...(name === 'execution_tree' ? { children: runs.filter(child => child.parentId === r.id).map(child => child.id), turns: r.usage.turns } : {}),
        ...(name === 'recent_failures' ? { failures: r.recentSteps?.filter(s => s.ok === false) } : {}) }));
      result = { content: [{ type: 'text', text: JSON.stringify(defaultRedactor.redactValue(data)) }] };
    } catch {
      result = { isError: true, content: [{ type: 'text', text: 'Collector unavailable. Start agent-deck first.' }] };
    }
  } else return error(-32601, 'Method not found');
  return { jsonrpc: '2.0', id: request.id, result };
}

export async function runMcp(): Promise<void> {
  const port = Number(process.env.AGENT_DECK_PORT || 4100);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let response: unknown;
    try {
      response = await handleMcp(JSON.parse(line), async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error('Collector unavailable');
        return ((await res.json()) as { runs: AgentRun[] }).runs;
      });
    } catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  }
}
