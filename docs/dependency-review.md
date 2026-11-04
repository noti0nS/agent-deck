# Dependency security review

Review date: 2026-11-04. Re-run `npm audit` for current results; this note is not
a permanent assurance about future advisories.

The public-release preparation upgraded Fastify static serving, Zod, Vitest,
SvelteKit and its build toolchain to address the reported moderate/high/critical
advisories. SvelteKit 3 required Vite plugin configuration, subpath imports and
the new service-worker module layout. Node 22.17+ or 24 is required.

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
