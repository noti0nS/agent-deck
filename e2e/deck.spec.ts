import { expect, test, type Page } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CollectorEngine, buildHttpServer } from '../apps/collector/src/http.js';
import { CollectorStore } from '../apps/collector/src/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(__dirname, '..', 'apps', 'web', 'build');

/** Phone-sized layout must never scroll sideways or push chrome off-screen. */
async function expectNoHorizontalOverflow(page: Page) {
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    clippedNav: Array.from(document.querySelectorAll('nav[aria-label="Deck views"] button'))
      .map((b) => ({ label: (b.textContent ?? '').trim(), right: b.getBoundingClientRect().right }))
      .filter((b) => b.right > window.innerWidth + 1)
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
  expect(layout.clippedNav).toEqual([]);
}

test.describe('Agent Deck PWA E2E (phone 390x844 / 412x915 + tablet 1024x768 / 1280x800)', () => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 1024, height: 768 },
    { width: 1280, height: 800 }
  ]) {
    test(`renders Deck, Attention state, Ambient, Usage, Ledger, Detail, and Settings at ${viewport.width}x${viewport.height}`, async ({
      page
    }) => {
      const store = new CollectorStore(':memory:');
      const engine = new CollectorEngine({
        store,
        staticDir,
        batchIntervalMs: 0,
        requireAuthForNonLoopback: false
      });

      if (viewport.width >= 1200) engine.state.prefs.columns = 3;
      const now = Date.now();

      // Seed 4 sessions across sources, including 1 in `waiting` and 1 `running`
      engine.ingest({
        type: 'run.started',
        runId: 'opencode:ses_1',
        ts: now - 300_000,
        payload: {
          source: 'opencode',
          nativeId: 'ses_1',
          projectPath: 'T:\\R4\\sample-api',
          projectName: 'sample-api',
          title: 'Refactor MCP auth middleware',
          model: 'gpt-5.6-luna',
          confidence: 'live',
          startedAt: now - 300_000
        }
      });
      engine.ingest({
        type: 'tool.started',
        runId: 'opencode:ses_1',
        ts: now - 30_000,
        payload: {
          stepId: 'st_1',
          label: 'edit',
          detail: 'src/Mcp/OAuth/PkceFlow.cs +18 -4'
        }
      });
      engine.ingest({
        type: 'file.changed',
        runId: 'opencode:ses_1',
        ts: now - 25_000,
        payload: {
          path: 'src/Mcp/OAuth/PkceFlow.cs',
          additions: 18,
          deletions: 4
        }
      });
      engine.ingest({
        type: 'todo.updated',
        runId: 'opencode:ses_1',
        ts: now - 20_000,
        payload: {
          todos: [
            { position: 1, content: 'Audit PKCE verifier', status: 'completed' },
            { position: 2, content: 'Run unit tests', status: 'in_progress' }
          ]
        }
      });
      engine.ingest({
        type: 'usage.tick',
        runId: 'opencode:ses_1',
        ts: now - 10_000,
        payload: {
          sampleKey: 'opencode:ses_1:1:1',
          tokensInTotal: 412_000,
          tokensOutTotal: 18_000,
          costUsdTotal: 2.41,
          costSource: 'tool',
          precision: 'exact'
        }
      });

      // Second run in `waiting` state (must sort to top of Deck!)
      engine.ingest({
        type: 'run.started',
        runId: 'claude:ses_2',
        ts: now - 120_000,
        payload: {
          source: 'claude',
          nativeId: 'ses_2',
          projectPath: 'P:\\projects\\sample-chat',
          projectName: 'sample-chat',
          title: 'Fix SSE stream handler',
          model: 'claude-sonnet-4',
          confidence: 'live',
          startedAt: now - 120_000
        }
      });
      engine.ingest({
        type: 'attention.raised',
        runId: 'claude:ses_2',
        ts: now - 15_000,
        payload: {
          attention: {
            id: 'att_1',
            kind: 'permission',
            summary: 'dotnet test --filter PkceFlowTests',
            projectPath: 'P:\\projects\\sample-chat',
            requestedAt: now - 15_000
          }
        }
      });

      // Third run (Codex, inferred confidence)
      engine.ingest({
        type: 'run.started',
        runId: 'codex:ses_3',
        ts: now - 200_000,
        payload: {
          source: 'codex',
          nativeId: 'ses_3',
          projectPath: 'P:\\projects\\codex-app',
          projectName: 'codex-app',
          title: 'Optimize rollout parser',
          subtitle: 'Ensure zero-copy JSONL slicing',
          model: 'gpt-5',
          confidence: 'inferred',
          startedAt: now - 200_000
        }
      });
      engine.ingest({
        type: 'tool.started',
        runId: 'codex:ses_3',
        ts: now - 5_000,
        payload: { label: 'bash', detail: 'vitest run' }
      });

      const app = await buildHttpServer(engine, { staticDir });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 4100;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        await page.setViewportSize(viewport);
        await page.goto(baseUrl);
    await expect(page.getByTestId('ambient-view')).toBeVisible();
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();

        // 1. Ambient opens first; explicit navigation reveals the waiting card first
        await expect(page.getByTestId('deck-view')).toBeVisible();
        const cards = page.getByTestId('run-card');
        await expect(cards).toHaveCount(3);
        await expect(cards.first()).toHaveAttribute('data-run-status', 'waiting');
        await expect(cards.first()).toContainText('dotnet test --filter PkceFlowTests');
        await expect(cards.first()).toContainText('answer in the terminal');

        // 1b. Phone-first guard: no sideways scroll, no clipped nav tabs
        await expectNoHorizontalOverflow(page);

        await page.screenshot({ path: 'test-results/redesign-' + viewport.width + '.png', fullPage: true });
        await page.getByRole('button', { name: /Needs Attention/ }).click();
        await expect(cards).toHaveCount(1);
        await expect(cards.first()).toHaveAttribute('data-run-status', 'waiting');
        await page.getByRole('button', { name: /^Running/ }).click();
        await expect(cards).toHaveCount(2);
        await page.getByRole('button', { name: /All Projects/ }).click();
        await expect(cards).toHaveCount(3);

        // 2. Verify motion budget rule (§8.5): at most 2 animated elements on screen at rest
        const animatedCount = await page.locator('.animate-pulse-running, .animate-pulse-waiting, .animate-breathe-waiting').count();
        expect(animatedCount).toBeLessThanOrEqual(2);

        // 3. Tap into Detail view for opencode:ses_1 and verify todos, steps, file edits
        await page.locator('[data-run-id="opencode:ses_1"]').click();
        await expect(page.getByTestId('detail-view')).toBeVisible();
        await expect(page.getByTestId('detail-view')).toContainText('Audit PKCE verifier');
        await expect(page.getByTestId('detail-view')).toContainText('src/Mcp/OAuth/PkceFlow.cs');
        await expectNoHorizontalOverflow(page);

        // Back to Deck
        await page.getByRole('button', { name: /Back/i }).click();
        await expect(page.getByTestId('deck-view')).toBeVisible();

        // 4. Usage works; reopening the app always starts in ambient
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByTestId('nav-usage').click();
        await expect(page.getByTestId('usage-view')).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await page.reload();
        await expect(page.getByTestId('ambient-view')).toBeVisible();
        await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
        await expect(page.getByTestId('deck-view')).toBeVisible();
        await expectNoHorizontalOverflow(page);

        // 5. Switch to Ledger view
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByTestId('nav-ledger').click();
        await expect(page.getByTestId('ledger-view')).toBeVisible();
        await expect(page.getByTestId('ledger-view')).toContainText('sample-api');
        await expectNoHorizontalOverflow(page);

        // 6. Switch to Ambient view
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByTestId('nav-ambient').click();
        await expect(page.getByTestId('ambient-view')).toBeVisible();
        await expect(page.getByTestId('ambient-view')).toContainText("Today's Tokens");
        await expectNoHorizontalOverflow(page);

        // 7. Navigate to /settings desktop page
        await page.goto(`${baseUrl}/settings`);
        await expect(page.getByTestId('settings-view')).toBeVisible();
        await expect(page.getByTestId('settings-view')).toContainText('2026.10.1');
        await expectNoHorizontalOverflow(page);
      } finally {
        await engine.stopAdapters();
        app.server.closeAllConnections?.();
        await app.close();
        store.close();
      }
    });
  }
});
