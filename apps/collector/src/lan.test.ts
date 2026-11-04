import { expect, it } from 'vitest';
import { CollectorEngine, buildHttpServer } from './http.js';
import { CollectorStore } from './store.js';
import { PairingManager } from './pair.js';

it('requires pairing for LAN clients and accepts a newly generated CLI code', async () => {
  const store = new CollectorStore(':memory:');
  const engine = new CollectorEngine({ store });
  const app = await buildHttpServer(engine);
  try {
    const remoteAddress = '192.168.0.4';
    expect((await app.inject({ url: '/api/snapshot', remoteAddress })).statusCode).toBe(401);
    const { code } = new PairingManager(store).generatePairingCode();
    const paired = await app.inject({ method: 'POST', url: '/api/pair', remoteAddress, payload: { code } });
    expect(paired.statusCode).toBe(200);
    const cookie = paired.cookies.find(c => c.name === 'agent_deck_session')!;
    expect(cookie).toBeDefined();
    const result = await app.inject({ url: '/api/snapshot', remoteAddress, cookies: { agent_deck_session: cookie.value } });
    expect(result.statusCode).toBe(200);
  } finally { await app.close(); store.close(); }
});

