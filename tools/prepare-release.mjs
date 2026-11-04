import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const name = `agent-deck-${JSON.parse(readFileSync(join(root, 'package.json'))).version}-${process.platform}-${process.arch}`;
const output = join(root, '.release', name);
if (existsSync(output)) throw new Error(`Release staging already exists: ${output}. Move it aside before rebuilding.`);
const shim = `tools/hook-shim/agent-deck-hook${process.platform === 'win32' ? '.exe' : ''}`;
const workspaces = ['packages/core', 'packages/protocol', 'packages/pricing', 'packages/redact', 'tools/doctor', 'apps/collector', 'apps/web'];
const required = ['apps/web/build/index.html', 'apps/collector/dist/cli.js', shim];
for (const path of required) if (!existsSync(join(root, path))) throw new Error(`Missing ${path}. Run npm run build first (including Go).`);
mkdirSync(output, { recursive: true });
function copy(path, destination = path) {
  cpSync(join(root, path), join(output, destination), {
    recursive: true,
    filter: source => !/\.test\.(js|d\.ts)(\.map)?$/.test(source) && !source.endsWith('.map')
  });
}
for (const file of ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'start-local-wifi.ps1']) copy(file);
for (const file of ['installation.md', 'privacy.md', 'compatibility.md', 'dependency-review.md', 'integration-compatibility.md', 'adapter-authoring.md', 'releasing.md', 'release-notes.md']) copy(`docs/${file}`);
copy('docs/screenshots');
copy('fixtures/manifest.json');
for (const workspace of workspaces) {
  copy(`${workspace}/package.json`);
  if (workspace !== 'apps/web') copy(`${workspace}/dist`);
}
copy('apps/web/build');
copy(shim);
// Preserve dependency license texts with the compiled frontend distribution.
const notices = ['Third-party dependency notices\nGenerated from installed dependencies at bundle time.\n'];
const seen = new Set();
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
for (const path of Object.keys(lock.packages).sort()) {
  if (!path.includes('node_modules/') || lock.packages[path].link) continue;
  const directory = join(root, path);
  if (!existsSync(join(directory, 'package.json'))) continue;
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json')));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const licenses = readdirSync(directory).filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file));
  notices.push(`\n=== ${key} (${typeof pkg.license === 'string' ? pkg.license : 'see package license'}) ===\n`);
  for (const file of licenses) {
    try { notices.push(readFileSync(join(directory, file), 'utf8')); } catch { /* A license directory is not a text file. */ }
  }
}
writeFileSync(join(output, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
writeFileSync(join(output, 'INSTALL.txt'), `Agent Deck experimental release (${process.platform}/${process.arch})\n\nInstall Node.js 22.17+ or 24, then run in this directory:\n  npm ci --omit=dev\n  node apps/collector/dist/cli.js start\n\nOpen http://127.0.0.1:4100\nNo Go or TypeScript build is needed. Native Node modules may require a C++ toolchain if a prebuilt binary is unavailable.\nSee docs/installation.md and docs/privacy.md before enabling network access.\n`);
const hashes = [];
function walk(dir, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) walk(join(dir, entry.name), relative + '/');
    else hashes.push(`${createHash('sha256').update(readFileSync(join(dir, entry.name))).digest('hex')}  ${relative}`);
  }
}
walk(output);
writeFileSync(join(output, 'SHA256SUMS'), hashes.sort().join('\n') + '\n');
console.log(output);
