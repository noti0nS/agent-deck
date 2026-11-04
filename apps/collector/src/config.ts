export function collectorPort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.AGENT_DECK_PORT ?? 4100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('AGENT_DECK_PORT must be an integer from 1 to 65535.');
  }
  return port;
}

export function collectorUrl(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.AGENT_DECK_HOST || '127.0.0.1';
  return `http://${host.includes(':') ? `[${host}]` : host}:${collectorPort(env)}`;
}

export async function checkCollector(url = collectorUrl()): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const body = await response.json() as { status?: string };
    return body.status === 'ok';
  } catch { return false; }
}

export interface LanListener { host: string; port: number }

export function privateLanUrl(listener: LanListener | undefined): string | undefined {
  if (!listener || !Number.isInteger(listener.port) || listener.port < 1 || listener.port > 65535) return undefined;
  const parts = listener.host.split('.').map(Number);
  const privateIp = /^\d+\.\d+\.\d+\.\d+$/.test(listener.host) &&
    parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168));
  return privateIp ? `http://${listener.host}:${listener.port}` : undefined;
}
