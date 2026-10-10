/*
 * The monorepo's workspace packages and how they depend on each other, read
 * straight from the package.json files, so it works without an install.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..', '..');

export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

/**
 * What `backstage-cli package build` packs into a backend bundle: the
 * package plus the local packages it reaches through these fields.
 */
export const BUNDLED_FIELDS = ['dependencies', 'optionalDependencies'];

/** Every local package whose source can end up in a package's build */
export const SOURCE_FIELDS = [...BUNDLED_FIELDS, 'peerDependencies'];

/** Workspace packages by name: { name, dir (relative to the root), pkg } */
export function listPackages() {
  const packages = new Map();
  // Workspaces are one level deep ("packages/*", "plugins/*")
  for (const pattern of readJson(join(root, 'package.json')).workspaces) {
    const base = pattern.replace(/\/\*$/, '');
    for (const entry of readdirSync(join(root, base), {
      withFileTypes: true,
    })) {
      const manifest = join(root, base, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(manifest)) {
        const pkg = readJson(manifest);
        packages.set(pkg.name, {
          name: pkg.name,
          dir: `${base}/${entry.name}`,
          pkg,
        });
      }
    }
  }
  return packages;
}

/** A package by name or by directory ("backend-core", "packages/app") */
export function findPackage(packages, nameOrDir) {
  return (
    packages.get(nameOrDir) ??
    [...packages.values()].find(
      ({ dir }) => dir === nameOrDir || dir.endsWith(`/${nameOrDir}`),
    )
  );
}

/**
 * A package and its local dependencies, transitively, through the given
 * dependency fields. By default, like backstage-cli when it packs a backend,
 * does not look into the dependencies of packages marked `bundled` (the app):
 * their dependencies are compiled in, not installed. With `followBundled`,
 * it does, which is what a bundled package's own build needs.
 */
export function localClosure(
  packages,
  start,
  { fields = BUNDLED_FIELDS, followBundled = false } = {},
) {
  const seen = new Map();
  const queue = [start];
  while (queue.length) {
    const node = queue.shift();
    if (seen.has(node.name)) {
      continue;
    }
    seen.set(node.name, node);
    if (node.pkg.bundled && !followBundled) {
      continue;
    }
    for (const field of fields) {
      for (const name of Object.keys(node.pkg[field] ?? {})) {
        const local = packages.get(name);
        if (local) {
          queue.push(local);
        }
      }
    }
  }
  return [...seen.values()];
}

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      yield* sourceFiles(path);
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
      yield path;
    }
  }
}

const importCache = new Map();

/** Whether any source file of a package imports the named package */
function importsPackage(dir, name) {
  const key = `${dir}\0${name}`;
  if (!importCache.has(key)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const pattern = new RegExp(`(['"\`])${escaped}(/[^'"\`]*)?\\1`);
    const src = join(root, dir, 'src');
    let found = false;
    if (existsSync(src)) {
      for (const file of sourceFiles(src)) {
        if (pattern.test(readFileSync(file, 'utf8'))) {
          found = true;
          break;
        }
      }
    }
    importCache.set(key, found);
  }
  return importCache.get(key);
}

/**
 * Adds the inline packages (backstage.inline) that a set of packages
 * imports. They are compiled into whatever imports them without being
 * declared as dependencies, so they can only be found by their imports.
 */
export function withInlinePackages(packages, nodes) {
  const result = new Map(nodes.map(node => [node.name, node]));
  const inline = [...packages.values()].filter(p => p.pkg.backstage?.inline);
  let added = true;
  while (added) {
    added = false;
    for (const candidate of inline) {
      if (
        !result.has(candidate.name) &&
        [...result.values()].some(node =>
          importsPackage(node.dir, candidate.name),
        )
      ) {
        result.set(candidate.name, candidate);
        added = true;
      }
    }
  }
  return [...result.values()];
}

/** The packages whose source goes into a package's build */
export function buildPackages(packages, start) {
  return withInlinePackages(
    packages,
    localClosure(packages, start, {
      fields: SOURCE_FIELDS,
      followBundled: true,
    }),
  );
}
