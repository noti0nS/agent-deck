import QRCode from 'qrcode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import type { CollectorStore } from './store.js';

const execFileAsync = promisify(execFile);

export interface PairedDevice {
  id: string;
  label: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
}

export interface PairingState {
  devices: PairedDevice[];
  activeCode?: string;
  codeExpiresAt?: number;
}

export class PairingManager {
  constructor(private readonly store: CollectorStore) {}

  private read(): PairingState {
    const saved = this.store.getSetting<PairingState>('pairing');
    // Legacy shared tokens are deliberately not accepted after this upgrade.
    return { devices: saved?.devices ?? [], activeCode: saved?.activeCode, codeExpiresAt: saved?.codeExpiresAt };
  }

  public listDevices(): Omit<PairedDevice, 'tokenHash'>[] {
    return this.read().devices.filter(d => d.expiresAt > Date.now())
      .map(({ tokenHash: _hash, ...device }) => device);
  }

  public issueSession(label = 'LAN browser'): { id: string; token: string } {
    const state = this.read();
    const token = randomBytes(32).toString('hex');
    const id = randomUUID();
    state.devices = state.devices.filter(d => d.expiresAt > Date.now());
    state.devices.push({ id, label: label.slice(0, 100), tokenHash: this.hash(token),
      createdAt: Date.now(), expiresAt: Date.now() + 365 * 24 * 3600_000 });
    this.store.setSetting('pairing', state);
    return { id, token };
  }

  public getSessionToken(): string { return this.issueSession().token; }

  public revokeDevice(id: string): boolean {
    const state = this.read();
    const before = state.devices.length;
    state.devices = state.devices.filter(d => d.id !== id);
    this.store.setSetting('pairing', state);
    return state.devices.length !== before;
  }

  public revokeAll(): void {
    this.store.setSetting('pairing', { devices: [] });
  }

  public generatePairingCode(ttlMs = 5 * 60_000): { code: string; expiresAt: number } {
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const bytes = randomBytes(8);
    const letters = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
    const code = letters.slice(0, 4) + '-' + letters.slice(4);
    const expiresAt = Date.now() + ttlMs;
    const state = this.read();
    state.activeCode = code;
    state.codeExpiresAt = expiresAt;
    this.store.setSetting('pairing', state);
    return { code, expiresAt };
  }

  public verifyCode(inputCode: string, now = Date.now()): boolean {
    const state = this.read();
    return Boolean(state.activeCode && state.codeExpiresAt && now < state.codeExpiresAt &&
      inputCode.trim().toUpperCase() === state.activeCode.trim().toUpperCase());
  }

  public consumeCode(code: string): boolean {
    if (!this.verifyCode(code)) return false;
    const state = this.read();
    delete state.activeCode;
    delete state.codeExpiresAt;
    this.store.setSetting('pairing', state);
    return true;
  }

  public verifyCookieToken(token: string | undefined): boolean {
    if (!token) return false;
    const hash = this.hash(token);
    return this.read().devices.some(d => d.expiresAt > Date.now() && d.tokenHash === hash);
  }

  private hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
}

export function renderAsciiQr(text: string): string {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const margin = 4;
  const size = modules.size + margin * 2;
  const dark = (x: number, y: number) => x >= margin && y >= margin &&
    x < size - margin && y < size - margin &&
    modules.get(y - margin, x - margin);
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const top = dark(x, y);
      const bottom = dark(x, y + 1);
      line += top ? (bottom ? '\u2588' : '\u2580') : (bottom ? '\u2584' : ' ');
    }
    // Explicit black on white makes the code independent of terminal theme.
    lines.push('\x1b[30;47m' + line + '\x1b[0m');
  }
  return lines.join('\n');
}

/**
 * Discovers the local Tailscale IPv4 address (100.64.0.0/10 CGNAT range)
 * so the collector binds only to loopback or Tailscale, never 0.0.0.0.
 */
export function findTailscaleAddress(): string | undefined {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const net of entries) {
      if (net.family === 'IPv4' && !net.internal) {
        const parts = net.address.split('.').map(Number);
        if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) {
          return net.address;
        }
      }
    }
  }
  return undefined;
}

export async function getTailscaleMagicDnsUrl(port = 4100): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('tailscale', ['serve', 'status', '--json'], { timeout: 3000 });
    const config = JSON.parse(stdout) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
    for (const [address, site] of Object.entries(config.Web ?? {})) {
      if (site.Handlers?.['/']?.Proxy === `http://127.0.0.1:${port}`) {
        return `https://${address.replace(/:443$/, '')}`;
      }
    }
  } catch { /* Tailscale is optional. */ }
  return undefined;
}

export async function configureTailscaleServe(
  port = 4100,
  httpsPort?: number
): Promise<{ ok: boolean; url?: string; message: string }> {
  if (!Number.isInteger(httpsPort ?? 443) || (httpsPort ?? 443) < 1 || (httpsPort ?? 443) > 65535) {
    return { ok: false, message: 'HTTPS port must be an integer from 1 to 65535.' };
  }
  try {
    const { stdout: status } = await execFileAsync('tailscale', ['serve', 'status', '--json'], { timeout: 3000 });
    const conflict = tailscaleServeConflict(JSON.parse(status), port, httpsPort ?? 443);
    if (conflict) return { ok: false, message: conflict };
    // `tailscale serve --bg <port>` claims HTTPS :443. When something else already
    // serves the tailnet root, pass --https=<port> to publish on a dedicated port
    // instead of replacing that mapping.
    const args = ['serve', '--bg'];
    if (httpsPort) args.push(`--https=${httpsPort}`);
    args.push(String(port));
    const { stdout } = await execFileAsync('tailscale', args, { timeout: 5000 });
    const base = await getTailscaleMagicDnsUrl(port);
    const published = base ? new URL(base) : undefined;
    if (published && httpsPort) published.port = httpsPort === 443 ? '' : String(httpsPort);
    const url = published?.origin;
    return {
      ok: true,
      url,
      message: stdout.trim() || `tailscale serve active on port ${port}`
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

export function tailscaleServeConflict(config: {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  TCP?: Record<string, { HTTPS?: boolean }>;
}, port: number, httpsPort: number): string | undefined {
  const sites = Object.entries(config.Web ?? {}).filter(([address]) => address.endsWith(':' + httpsPort));
  for (const [, site] of sites) {
    const handlers = site.Handlers ?? {};
    if (Object.keys(handlers).some(path => path !== '/') ||
        (handlers['/'] && handlers['/'].Proxy !== 'http://127.0.0.1:' + port)) {
      return 'Tailscale HTTPS port is already used by another service. Choose AGENT_DECK_SERVE_HTTPS_PORT.';
    }
  }
  if (config.TCP?.[String(httpsPort)] && (!config.TCP[String(httpsPort)].HTTPS || sites.length === 0)) {
    return 'Tailscale port is already configured. Choose another AGENT_DECK_SERVE_HTTPS_PORT.';
  }
  return undefined;
}
