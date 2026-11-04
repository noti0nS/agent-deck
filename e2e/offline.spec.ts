import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { CollectorEngine, buildHttpServer } from '../apps/collector/src/http.js';
import { CollectorStore } from '../apps/collector/src/store.js';

test('caches the application shell for offline use without caching session APIs', async ({ page, context }) => {
  const store = new CollectorStore(':memory:');
  const engine = new CollectorEngine({ store });
  const app = await buildHttpServer(engine, { staticDir: resolve('apps/web/build') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;
  try {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByTestId('ambient-view')).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.reload();
    await page.evaluate(() => fetch('/api/snapshot'));
    const cachedPaths = await page.evaluate(async () => {
      const paths: string[] = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) paths.push(new URL(request.url).pathname);
      }
      return paths;
    });
    expect(cachedPaths).toContain('/');
    expect(cachedPaths.some(path => path.startsWith('/api/'))).toBe(false);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('ambient-view')).toBeVisible();
  } finally {
    await context.setOffline(false);
    await page.goto('about:blank');
    await engine.stopAdapters();
    app.server.closeAllConnections();
    await app.close();
    store.close();
  }
});
