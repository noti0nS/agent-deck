# Dependency security review

Review date: 2026-11-04. Re-run `npm audit` for current results; this note is not
a permanent assurance about future advisories.

The public-release preparation upgraded Fastify static serving, Zod, Vitest,
SvelteKit and its build toolchain to address the reported moderate/high/critical
advisories. SvelteKit 3 required Vite plugin configuration, subpath imports and
the new service-worker module layout. Node 22.22+ or 24 is required.

## November 5 dependency integration

The Dependabot updates were integrated together: SQLite 13, Chokidar 6,
Fastify cookie 11.1.5, Svelte 5.57.3, svelte-check 4.7.8, TypeScript 7,
and the GitHub Actions major-version updates.

Chokidar 6 raises the Node 22 minimum to 22.22. TypeScript 7 builds the
collector and shared packages. The web workspace keeps TypeScript 6.0.3
because SvelteKit 3.1.1 and svelte-check 4.7.8 require the TypeScript 6 API
and peer range. Do not force TypeScript 7 into that workspace until both
upstream tools support it.

## Remaining upstream advisory

`deepmerge` 4.3.1 has a low-severity prototype-poisoning advisory,
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).
At review time, 4.3.1 was the latest published version. npm reports four low
entries because Svelte build packages inherit the same transitive finding.

Here it is used by the development/build plugin, not the collector's HTTP
request processing or the shipped static dashboard. The build consumes trusted
repository configuration. Do not build untrusted pull requests with credentials
or privileged runners. This is an explicitly tracked build-time dependency risk,
not a demonstrated remote compromise of Agent Deck.

CI blocks moderate-or-higher advisories and continues reporting low ones. Do not
use `npm audit fix --force` to downgrade SvelteKit to the old versions npm suggests
as a workaround. Dependabot is configured; upgrade when the upstream fix ships.
