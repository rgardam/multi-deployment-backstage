#!/usr/bin/env node
/*
 * Prints, comma separated, the directory of a workspace package and of every
 * local workspace package that goes into its build: its local dependencies,
 * transitively (local plugins, common libraries), plus the inline packages
 * it imports, which are compiled in without being declared.
 *
 * The Taskfile fingerprints each bundle on exactly these directories, so
 * editing a plugin rebuilds the bundles that contain it and nothing else.
 *
 *   node scripts/workspace-deps.mjs backend-core
 *   packages/backend-core,plugins/noticeboard-backend
 *
 * With --glob, prints them as a brace group for a glob pattern. Task only
 * expands groups with at least two entries, so a single directory is
 * repeated: {packages/backend-search,packages/backend-search}
 */
import { buildPackages, findPackage, listPackages } from './lib/workspace.mjs';

const args = process.argv.slice(2);
const glob = args.includes('--glob');
const target = args.find(arg => !arg.startsWith('--'));
if (!target) {
  console.error(
    'usage: workspace-deps.mjs [--glob] <package name or directory name>',
  );
  process.exit(1);
}

const packages = listPackages();
const start = findPackage(packages, target);
if (!start) {
  console.error(`No workspace package named ${target}`);
  process.exit(1);
}

const dirs = buildPackages(packages, start)
  .map(({ dir }) => dir)
  .sort();
if (glob) {
  console.log(`{${(dirs.length > 1 ? dirs : [dirs[0], dirs[0]]).join(',')}}`);
} else {
  console.log(dirs.join(','));
}
