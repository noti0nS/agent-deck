import QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import type { CollectorStore } from './store.js';

const execFileAsync = promisify(execFile);

export interface PairingState {
  sessionToken: string;
  activeCode?: string;
  codeExpiresAt?: number;
}

export class PairingManager {
  private readonly store: CollectorStore;
  private state: PairingState;

  constructor(store: CollectorStore) {
    this.store = store;
    const saved = this.store.getSetting<PairingState>('pairing');
    if (saved?.sessionToken) {
      this.state = saved;
    } else {
      this.state = {
        sessionToken: randomBytes(32).toString('hex')
      };
      this.store.setSetting('pairing', this.state);
    }
  }

  public getSessionToken(): string {
    return this.state.sessionToken;
  }

  public generatePairingCode(ttlMs = 5 * 60_000): { code: string; expiresAt: number } {
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const bytes = randomBytes(8);
    let part1 = '';
    let part2 = '';
    for (let i = 0; i < 4; i++) {
      part1 += alphabet[bytes[i] % alphabet.length];
      part2 += alphabet[bytes[i + 4] % alphabet.length];
    }
    const code = `${part1}-${part2}`;
    const expiresAt = Date.now() + ttlMs;
    this.state.activeCode = code;
    this.state.codeExpiresAt = expiresAt;
    this.store.setSetting('pairing', this.state);
    return { code, expiresAt };
  }

  public verifyCode(inputCode: string, now = Date.now()): boolean {
    // The pair CLI writes through another connection while the server is running.
    this.state = this.store.getSetting<PairingState>('pairing') ?? this.state;
    if (!this.state.activeCode || !this.state.codeExpiresAt) return false;
    if (now > this.state.codeExpiresAt) return false;
    const normalizedInput = inputCode.trim().toUpperCase();
    const normalizedActive = this.state.activeCode.trim().toUpperCase();
    return normalizedInput === normalizedActive;
  }

  public verifyCookieToken(token: string | undefined): boolean {
    if (!token) return false;
    return token === this.state.sessionToken;
  }
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
  } catch { /* Fall back to device discovery when serve config is unavailable. */ }
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--json'], { timeout: 3000 });
    const data = JSON.parse(stdout) as { Self?: { DNSName?: string } };
    const dns = data?.Self?.DNSName?.replace(/\.$/, '');
    if (dns) {
      return `https://${dns}`;
    }
  } catch {
    // tailscale CLI not running or unavailable
  }
  const tsIp = findTailscaleAddress();
  return tsIp ? `https://${tsIp}:${port}` : undefined;
}

export async function configureTailscaleServe(
  port = 4100,
  httpsPort?: number
): Promise<{ ok: boolean; url?: string; message: string }> {
  try {
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
