import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { CollectorStore } from '../apps/collector/src/store.js';
import { CollectorEngine, buildHttpServer } from '../apps/collector/src/http.js';

test('mobile dashboard shows latest conversation message and excludes stale work from Running', async ({ page }) => {
  const store = new CollectorStore(':memory:');
  const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
  const now = Date.now();
  const seed = (id: string, project: string, ts: number, parentId?: string) => {
    engine.ingest({ type: 'run.started', runId: `codex:${id}`, ts, payload: {
      source: 'codex', nativeId: id, title: id, projectName: project, projectPath: `/projects/${project}`,
      model: 'test', confidence: 'polled', parentId
    } });
  };
  seed('old', 'sample-chat', now - 138 * 3600_000);
  engine.ingest({ type: 'compact.started', runId: 'codex:old', ts: now - 138 * 3600_000, payload: {} });
  seed('new', 'sample-chat', now - 30_000);
  engine.ingest({ type: 'message.completed', runId: 'codex:new', ts: now - 2000,
    payload: { messageId: 'reply', role: 'assistant', preview: 'A última mensagem da conversa aparece aqui.' } });
  engine.ingest({ type: 'tool.started', runId: 'codex:new', ts: now - 1000,
    payload: { stepId: 'call_1', label: 'exec_command', detail: 'INTERNAL TOOL DETAILS' } });
  seed('child', 'sample-chat', now - 500, 'codex:new');
  seed('empty', 'closed-project', now - 273 * 3600_000);
  engine.tickTimers(now);
  const app = await buildHttpServer(engine, { staticDir: resolve('apps/web/build') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${(app.server.address() as { port: number }).port}`);
    await expect(page.getByTestId('ambient-view')).toBeVisible();
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    await expect(page.getByTestId('run-card')).toHaveCount(2);
    await expect(page.locator('.running-count')).toHaveText('1 active');
    await expect(page.getByText('A última mensagem da conversa aparece aqui.')).toBeVisible();
    await expect(page.getByText('INTERNAL TOOL DETAILS')).toHaveCount(0);
    await expect(page.locator('[data-run-id="codex:old"], [data-run-id="codex:child"]')).toHaveCount(0);
    await expect(page.locator('[data-run-id="codex:empty"]')).toHaveAttribute('data-run-status', 'detached');
    await page.getByRole('button', { name: 'Running (1)', exact: true }).click();
    await expect(page.getByTestId('run-card')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: 'test-results/session-detection-mobile.png', fullPage: true });
  } finally {
    await page.close();
    await engine.stopAdapters();
    app.server.closeAllConnections();
    await app.close();
    store.close();
  }
});
