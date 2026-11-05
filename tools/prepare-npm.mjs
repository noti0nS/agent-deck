import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { create, list } from 'tar';

const root = resolve(import.meta.dirname, '..');
const readJson = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
const pkg = readJson('package.json');
if (!process.env.npm_execpath) throw new Error('Run through npm run release:npm.');
for (const path of ['apps/collector/dist/cli.js', 'apps/web/build/index.html']) {
  if (!existsSync(join(root, path))) throw new Error(`Missing ${path}. Run npm run build first.`);
}

const destination = join(root, '.release', 'npm');
mkdirSync(destination, { recursive: true });
const stage = mkdtempSync(join(destination, 'package-'));
const internal = ['packages/core', 'packages/protocol', 'packages/pricing', 'packages/redact', 'tools/doctor'];
const dependencies = {};
for (const workspace of ['apps/collector', ...internal]) {
  for (const [name, version] of Object.entries(readJson(`${workspace}/package.json`).dependencies ?? {})) {
    if (name.startsWith('@agent-deck/')) continue;
    assert(!dependencies[name] || dependencies[name] === version, `Conflicting dependency: ${name}`);
    dependencies[name] = version;
  }
}

try {
  const cli = join(stage, 'apps/collector/dist/cli.js');
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ['apps/collector/dist/cli.js'],
    outfile: cli,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: Object.keys(dependencies),
    metafile: true,
    sourcemap: false
  });
  // An unpublished workspace import must never escape into the consumer package.
  for (const output of Object.values(bundle.metafile.outputs)) {
    assert(!output.imports.some(item => item.path.startsWith('@agent-deck/')), 'Unbundled workspace import');
  }
  chmodSync(cli, 0o755);
  cpSync(join(root, 'apps/web/build'), join(stage, 'apps/web/build'), { recursive: true });

  // One portable npm tarball; no install-time download or Go toolchain required.
  for (const platform of ['win32', 'linux']) {
    for (const arch of ['x64', 'arm64']) {
      const binary = join(stage, 'tools/hook-shim/bin', `${platform}-${arch}`,
        platform === 'win32' ? 'agent-deck-hook.exe' : 'agent-deck-hook');
      mkdirSync(resolve(binary, '..'), { recursive: true });
      const result = spawnSync(process.platform === 'win32' ? 'go.exe' : 'go',
        ['build', '-trimpath', '-ldflags', '-s -w', '-o', binary, '.'], {
          cwd: join(root, 'tools/hook-shim'), stdio: 'inherit',
          env: { ...process.env, CGO_ENABLED: '0', GOOS: platform === 'win32' ? 'windows' : platform,
            GOARCH: arch === 'x64' ? 'amd64' : arch }
        });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Hook build failed: ${platform}-${arch}`);
      chmodSync(binary, 0o755);
    }
  }

  for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) cpSync(join(root, file), join(stage, file));
  cpSync(join(root, 'docs'), join(stage, 'docs'), {
    recursive: true,
    filter: source => source === join(root, 'docs') ||
      ['installation.md', 'privacy.md', 'compatibility.md', 'dependency-review.md', 'integration-compatibility.md', 'screenshots', 'tablet.png'].includes(source.split(/[\\/]/).pop())
  });
  const notices = ['Third-party dependency notices\nGenerated from installed dependencies at bundle time.\n'];
  const seen = new Set();
  for (const [path, metadata] of Object.entries(readJson('package-lock.json').packages)) {
    if (!path.includes('node_modules/') || metadata.link || !existsSync(join(root, path, 'package.json'))) continue;
    const dependency = readJson(`${path}/package.json`);
    const key = `${dependency.name}@${dependency.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notices.push(`\n=== ${key} (${typeof dependency.license === 'string' ? dependency.license : 'see package license'}) ===\n`);
    for (const file of readdirSync(join(root, path)).filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file))) {
      try { notices.push(readFileSync(join(root, path, file), 'utf8')); } catch { /* License directory. */ }
    }
  }
  writeFileSync(join(stage, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
  writeFileSync(join(stage, 'package.json'), JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    type: 'module',
    bin: pkg.bin,
    engines: pkg.engines,
    os: ['win32', 'linux'],
    cpu: ['x64', 'arm64'],
    repository: { type: 'git', url: 'git+https://github.com/noti0nS/agent-deck.git' },
    homepage: 'https://github.com/noti0nS/agent-deck#readme',
    bugs: { url: 'https://github.com/noti0nS/agent-deck/issues' },
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
    files: ['apps/collector/dist/cli.js', 'apps/web/build', 'tools/hook-shim/bin', 'docs', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.txt'],
    dependencies
  }, null, 2) + '\n');

  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: stage, encoding: 'utf8'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const [packed] = JSON.parse(result.stdout);
  for (const file of packed.files) {
    assert(/^(package\.json|README\.md|LICENSE|CHANGELOG\.md|THIRD_PARTY_NOTICES\.txt|docs\/|apps\/collector\/dist\/cli\.js$|apps\/web\/build\/|tools\/hook-shim\/bin\/)/.test(file.path), `Unexpected packed file: ${file.path}`);
    assert(!/(^|\/)(node_modules|src|\.git|\.env)(\/|$)|\.test\.|\.map$|\.db($|-)/.test(file.path), `Development or local data in package: ${file.path}`);
  }
  const archive = join(destination, packed.filename);
  const executable = path => /(^|\/)apps\/collector\/dist\/cli\.js$|(^|\/)tools\/hook-shim\/bin\//.test(path);
  // Windows chmod cannot set Unix execute bits. Preserve npm's file selection,
  // but write explicit modes so a Windows-built tarball also works on Linux.
  await create({
    file: archive, cwd: stage, prefix: 'package/', gzip: true, portable: true,
    mtime: new Date('1985-10-26T08:15:00Z'),
    onWriteEntry(entry) { entry.stat.mode = executable(entry.path) ? 0o755 : 0o644; }
  }, packed.files.map(file => file.path));
  let executableCount = 0;
  await list({ file: archive, onReadEntry(entry) {
    if (!executable(entry.path)) return;
    assert.equal(entry.mode & 0o777, 0o755, `Missing executable mode: ${entry.path}`);
    executableCount++;
  } });
  assert.equal(executableCount, 5, 'Package must contain the CLI and all four executable hooks');
  console.log(`npm package: ${archive} (${statSync(archive).size} bytes, ${packed.entryCount} files)`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
