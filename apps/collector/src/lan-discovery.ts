import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { privateLanUrl } from './config.js';

export function selectLanHost(explicit?: string, interfaces = networkInterfaces(), preferred?: string): string {
  if (explicit) {
    if (!privateLanUrl({ host: explicit, port: 4100 })) throw new Error('LAN host must be a specific private IPv4 address.');
    return explicit;
  }
  const candidates = [...new Set(Object.entries(interfaces)
    .filter(([name]) => !/tailscale|vethernet|virtual|vmware|vbox|docker|wsl|loopback|tun|tap/i.test(name))
    .flatMap(([, addresses]) => (addresses ?? []).filter(a => !a.internal && a.family === 'IPv4' &&
      privateLanUrl({ host: a.address, port: 4100 })).map(a => a.address)))];
  if (preferred && candidates.includes(preferred)) return preferred;
  if (candidates.length === 1) return candidates[0];
  throw new Error(candidates.length
    ? `Multiple LAN addresses found: ${candidates.join(', ')}. Run pair --host <PC-private-IPv4>.`
    : 'No private LAN address found. Connect to your local network or run pair --host <PC-private-IPv4>.');
}

export async function discoverLanHost(explicit?: string): Promise<string> {
  if (explicit) return selectLanHost(explicit);
  // UDP connect selects the OS route without sending a packet to this documentation address.
  const preferred = await new Promise<string | undefined>(resolve => {
    const socket = createSocket('udp4');
    let settled = false;
    const finish = (address?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); socket.close(); resolve(address);
    };
    const timeout = setTimeout(() => finish(), 1000);
    socket.once('error', () => finish());
    socket.connect(9, '192.0.2.1', () => finish(socket.address().address));
  });
  return selectLanHost(undefined, networkInterfaces(), preferred);
}
