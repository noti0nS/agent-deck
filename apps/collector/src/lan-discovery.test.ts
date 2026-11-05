import { expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { selectLanHost } from './lan-discovery.js';

const address = (ip: string) => ({ address: ip, family: 'IPv4', internal: false } as NetworkInterfaceInfo);

it('chooses the default-route LAN address and excludes virtual interfaces', () => {
  const interfaces = { Ethernet: [address('192.168.0.3')], 'Ethernet 2': [address('192.168.56.1')],
    'vEthernet (WSL)': [address('172.29.0.1')], Tailscale: [address('100.87.0.1')] };
  expect(selectLanHost(undefined, interfaces, '192.168.0.3')).toBe('192.168.0.3');
  expect(() => selectLanHost(undefined, interfaces)).toThrow('Multiple LAN addresses');
  expect(() => selectLanHost(undefined, {})).toThrow('No private LAN address');
  expect(() => selectLanHost('0.0.0.0')).toThrow('specific private IPv4');
  expect(selectLanHost('192.168.0.3', {})).toBe('192.168.0.3');
});
