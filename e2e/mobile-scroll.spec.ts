import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { CollectorStore } from '../apps/collector/src/store.js';
import { CollectorEngine, buildHttpServer } from '../apps/collector/src/http.js';

test('phone touch scroll keeps navigation visible and reaches the last card', async ({ browser }) => {
  const store = new CollectorStore(':memory:');
  const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
  for (let i = 0; i < 6; i++) engine.ingest({ type: 'run.started', runId: `codex:${i}`, payload: {
    source: 'codex', nativeId: String(i), title: `Session ${i}`, projectName: 'Mobile test',
    projectPath: '/test/' + (i === 5 ? 0 : i), model: 'gpt-5', confidence: 'polled'
  } });
  const app = await buildHttpServer(engine, { staticDir: resolve('apps/web/build') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as { port: number };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect(page.getByTestId('run-card')).toHaveCount(5);
    const cdp = await context.newCDPSession(page);
    for (let swipe = 0; swipe < 4; swipe++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 680 }] });
      for (let y = 640; y >= 200; y -= 40) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y }] });
        await page.waitForTimeout(20);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    await expect(page.getByTestId('deck-view')).toBeVisible();
    const header = await page.locator('.dashboard-header').boundingBox();
    expect(header!.y).toBe(0);
    const last = await page.getByTestId('run-card').last().boundingBox();
    expect(last!.y + last!.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: 'test-results/mobile-scroll.png', fullPage: false });
    // Let Chromium finish inertial scrolling before the navigation tap.
    await page.waitForTimeout(700);
    await cdp.detach();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByTestId('nav-ledger').click();
    await expect(page.getByTestId('ledger-view')).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByTestId('nav-deck').click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByText('Ferramentas exibidas (5/5)', { exact: true }).click();
    await page.getByRole('checkbox', { name: 'Codex', exact: true }).uncheck();
    await expect(page.getByTestId('run-card')).toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByText('Ferramentas exibidas (4/5)', { exact: true })).toBeVisible();
    await expect(page.getByTestId('run-card')).toHaveCount(0);
    await page.getByText('Ferramentas exibidas (4/5)', { exact: true }).click();
    await page.getByRole('checkbox', { name: 'Codex', exact: true }).check();
    await expect(page.getByTestId('run-card')).toHaveCount(5);
    await page.screenshot({ path: 'test-results/source-selector.png' });
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(page.getByTestId('telemetry-card')).toBeVisible();
    const sessions = page.getByRole('combobox', { name: 'Session in Mobile test' });
    await expect(sessions.locator('option')).toHaveCount(2);
    await sessions.selectOption('codex:0');
    await expect(page.locator('[data-run-id="codex:0"]')).toBeVisible();
    await page.setViewportSize({width: 900, height: 1200});
    await page.evaluate(() => window.scrollTo(0,0));
    await page.screenshot({path:'test-results/reference-layout-tablet.png',fullPage:true});
  } finally {
    await context.close();
    await engine.stopAdapters();
    app.server.closeAllConnections();
    await app.close();
    store.close();
  }
});
