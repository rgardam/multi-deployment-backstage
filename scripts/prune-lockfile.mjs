#!/usr/bin/env node
/*
 * Writes packages/<pkg>/dist/deps/: everything a backend image needs to
 * install its production dependencies, and nothing else:
 *
 *   package.json                 root manifest, install-relevant fields only
 *   packages/<pkg>/package.json  the backend's manifest(s) from the skeleton,
 *                                without devDependencies
 *   yarn.lock                    the lockfile pruned to those dependencies
 *
 * Each backend image installs its dependencies in a cached layer keyed on
 * this directory. Keyed on the shared root yarn.lock instead, bumping a
 * dependency of any one backend (or any dev tool) would invalidate that slow
 * layer in every backend image; this way only images whose production
 * dependencies actually changed rebuild it.
 *
 *   node scripts/prune-lockfile.mjs backend-search
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const pkg = process.argv[2];
if (!pkg) {
  console.error('usage: prune-lockfile.mjs <package>');
  process.exit(1);
}
const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'packages', pkg, 'dist');
const work = mkdtempSync(join(tmpdir(), `prune-${pkg}-`));
const out = join(dist, 'deps');

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

try {
  const { name, workspaces, resolutions, packageManager } = readJson(
    join(root, 'package.json'),
  );
  writeJson(join(work, 'package.json'), {
    name,
    private: true,
    workspaces,
    resolutions,
    packageManager,
  });

  // The skeleton lists the workspace packages bundled with this backend
  const manifests = execFileSync('tar', ['-tzf', join(dist, 'skeleton.tar.gz')])
    .toString()
    .split('\n')
    .filter(file => file.endsWith('package.json'));
  execFileSync('tar', ['-xzf', join(dist, 'skeleton.tar.gz'), '-C', work]);
  for (const file of manifests) {
    const { devDependencies: _dev, ...manifest } = readJson(join(work, file));
    writeJson(join(work, file), manifest);
  }

  cpSync(join(root, '.yarnrc.yml'), join(work, '.yarnrc.yml'));
  cpSync(join(root, '.yarn', 'releases'), join(work, '.yarn', 'releases'), {
    recursive: true,
  });
  cpSync(join(root, 'yarn.lock'), join(work, 'yarn.lock'));

  // Resolves from the existing lockfile only: no downloads, no linking
  execFileSync('yarn', ['install', '--mode=update-lockfile'], {
    cwd: work,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' },
  });

  rmSync(out, { recursive: true, force: true });
  for (const file of ['package.json', 'yarn.lock', ...manifests]) {
    mkdirSync(dirname(join(out, file)), { recursive: true });
    cpSync(join(work, file), join(out, file));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
