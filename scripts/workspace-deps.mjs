#!/usr/bin/env node
/*
 * Prints, comma separated, the directory of a workspace package and of every
 * local workspace package that goes into its build: its local dependencies,
 * transitively (local plugins, common libraries), plus inline packages, which
 * are compiled into whatever imports them without being declared.
 *
 * The Taskfile fingerprints each bundle on exactly these directories, so
 * editing a plugin rebuilds the bundles that contain it and nothing else.
 *
 *   node scripts/workspace-deps.mjs backend-core
 *   packages/backend-core,packages/catalog-sharding,plugins/noticeboard-backend
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('usage: workspace-deps.mjs <package name or directory name>');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

// Workspaces are one level deep ("packages/*", "plugins/*")
const packages = new Map();
for (const pattern of readJson(join(root, 'package.json')).workspaces) {
  const base = pattern.replace(/\/\*$/, '');
  for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
    const manifest = join(root, base, entry.name, 'package.json');
    if (entry.isDirectory() && existsSync(manifest)) {
      const pkg = readJson(manifest);
      packages.set(pkg.name, { dir: `${base}/${entry.name}`, pkg });
    }
  }
}

const start =
  packages.get(target) ??
  [...packages.values()].find(({ dir }) => dir.endsWith(`/${target}`));
if (!start) {
  console.error(`No workspace package named ${target}`);
  process.exit(1);
}

// Dependencies that ship with the package; devDependencies do not
const fields = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const dirs = new Set();
const queue = [start];
while (queue.length) {
  const { dir, pkg } = queue.shift();
  if (dirs.has(dir)) {
    continue;
  }
  dirs.add(dir);
  for (const field of fields) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      const local = packages.get(name);
      if (local) {
        queue.push(local);
      }
    }
  }
}
for (const { dir, pkg } of packages.values()) {
  if (pkg.backstage?.inline) {
    dirs.add(dir);
  }
}

console.log([...dirs].sort().join(','));
