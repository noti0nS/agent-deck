// Playwright's synchronous loader breaks CJS -> ESM imports in Node 22
// (@fastify/static -> content-disposition). Set this before loading its CLI
// so discovery and test workers both use the asynchronous loader.
if (process.versions.node.startsWith('22.')) {
  process.env.PLAYWRIGHT_FORCE_ASYNC_LOADER = '1';
}

await import('@playwright/test/cli');
