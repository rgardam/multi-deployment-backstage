#!/usr/bin/env node
/*
 * Writes packages/<pkg>/dist/deps/: everything a backend image needs to
 * install its production dependencies, and nothing else:
 *
 *   package.json                 root manifest, install-relevant fields only
 *   <dir>/package.json           the backend's manifest and those of the
 *                                local packages bundled with it, with only
 *                                the fields that decide what gets installed
 *   yarn.lock                    the lockfile pruned to those dependencies
 *
 * Each backend image installs its dependencies in a cached layer keyed on
 * this directory. Keyed on the shared root yarn.lock instead, bumping a
 * dependency of any one backend (or any dev tool) would invalidate that slow
 * layer in every backend image; this way only images whose production
 * dependencies actually changed rebuild it. The same pruned lockfile is what
 * `scripts/release.mjs` fingerprints to tell whether a backend's
 * dependencies changed.
 *
 *   node scripts/prune-lockfile.mjs backend-search
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prune, writeFiles } from './lib/prune.mjs';
import {
  findPackage,
  listPackages,
  localClosure,
  readJson,
  root,
} from './lib/workspace.mjs';

const target = process.argv[2];
if (!target) {
  console.error('usage: prune-lockfile.mjs <package>');
  process.exit(1);
}
const packages = listPackages();
const start = findPackage(packages, target);
if (!start) {
  console.error(`No workspace package named ${target}`);
  process.exit(1);
}

const files = await prune({
  rootManifest: readJson(join(root, 'package.json')),
  manifests: localClosure(packages, start),
  lockfile: readFileSync(join(root, 'yarn.lock'), 'utf8'),
});
writeFiles(join(root, start.dir, 'dist', 'deps'), files);
