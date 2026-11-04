import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { CollectorStore } from '../apps/collector/src/store.js';
import { CollectorEngine, buildHttpServer } from '../apps/collector/src/http.js';

test('ambient controls and logout/re-pair work even on localhost', async ({ page }) => {
  const store = new CollectorStore(':memory:');
  const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
  const app = await buildHttpServer(engine, { staticDir: resolve('apps/web/build') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(base);
    await expect(page.getByTestId('ambient-view')).toBeVisible();
    await page.getByText("Today's Tokens", { exact: true }).click();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('ambient-view')).toBeVisible();
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await expect(page.getByTestId('ambient-view')).toBeVisible();
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await page.screenshot({ path: 'test-results/ambient-controls.png', fullPage: true });
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await expect(page.getByTestId('deck-view')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('ambient-view')).toBeVisible();
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Pair Device with Agent Deck' })).toBeVisible();
    expect((await page.request.get(`${base}/api/snapshot`)).status()).toBe(401);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Pair Device with Agent Deck' })).toBeVisible();
    const { code } = engine.pairing.generatePairingCode();
    await page.getByLabel('Character 1 of 8', { exact: true }).fill(code);
    await page.getByRole('button', { name: 'Pair Device', exact: true }).click();
    await expect(page.getByTestId('ambient-view')).toBeVisible();
    expect((await page.request.get(`${base}/api/snapshot`)).status()).toBe(200);
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Pair Device with Agent Deck' })).toBeVisible();
    expect((await page.context().cookies()).some(c => c.name === 'agent_deck_session')).toBe(false);
  } finally {
    await page.close();
    await engine.stopAdapters();
    app.server.closeAllConnections();
    await app.close();
    store.close();
  }
});
