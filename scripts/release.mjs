#!/usr/bin/env node
/*
 * Independent releases: which services changed since their last release,
 * and building, versioning and releasing only those.
 *
 * Every deployable service (packages/<name>/Dockerfile, gateway/Dockerfile)
 * gets a fingerprint of exactly the inputs its image is built from:
 *
 *   source        its package and the local packages it bundles (plugins,
 *                 libraries, inline packages it imports), without tests,
 *                 docs and the plugin dev harness
 *   dependencies  its production dependencies: the lockfile pruned to them,
 *                 which is what its image installs (and what the frontend
 *                 bundles)
 *   toolchain     the Backstage CLI that builds every bundle
 *   image         its Dockerfile, every repository file its .dockerignore
 *                 lets into the image, and its build arguments
 *
 * deploy/releases.json records the version of each service and the
 * fingerprint it was released with. A service whose fingerprint differs from
 * its record needs a new release; nothing else does.
 *
 *   node scripts/release.mjs plan [--json]  what changed since the last release, and why
 *   node scripts/release.mjs build          build images for the changed services
 *   node scripts/release.mjs release        build, push (with REGISTRY) and record new versions
 *   node scripts/release.mjs tag            git tag <service>@<version> for recorded versions
 *   node scripts/release.mjs up             run the stack at the recorded versions
 *   node scripts/release.mjs env            <SERVICE>_TAG=<version> lines for docker compose
 *
 * Environment: BUMP (patch, minor or major; default patch), NODE_VERSION,
 * REGISTRY, IMAGE_NAMESPACE, EXTRA_CA_CERT, DOCKER_BUILD_FLAGS. Normally run
 * through the Taskfile (task plan, task release:changed, ...).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { prune } from './lib/prune.mjs';
import {
  buildPackages,
  findPackage,
  listPackages,
  localClosure,
  readJson,
  root,
} from './lib/workspace.mjs';

const MANIFEST = 'deploy/releases.json';
const PLAN_FILE = 'dist/release-plan.json';
const INITIAL_VERSION = '1.0.0';
const CONCURRENCY = 4;

const env = {
  bump: process.env.BUMP || 'patch',
  nodeVersion: process.env.NODE_VERSION || '24',
  registry: process.env.REGISTRY || '',
  namespace: process.env.IMAGE_NAMESPACE || 'backstage-poc',
  extraCaCert: process.env.EXTRA_CA_CERT || '',
  dockerBuildFlags: process.env.DOCKER_BUILD_FLAGS || '',
};
const imagePrefix = env.registry
  ? `${env.registry}/${env.namespace}`
  : env.namespace;

// ------------------------------------------------------------------ helpers

const sha256 = data => createHash('sha256').update(data).digest('hex');
const short = hex => hex.slice(0, 16);

function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitShow(commit, path) {
  try {
    return git('show', `${commit}:${path}`);
  } catch {
    return undefined;
  }
}

function commitExists(commit) {
  try {
    git('cat-file', '-e', `${commit}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** Tracked and untracked (not ignored) files under some paths, sorted */
function listFiles(paths) {
  const files = git(
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    ...paths,
  )
    .split('\0')
    .filter(Boolean)
    .filter(file => {
      const path = join(root, file);
      return existsSync(path) && statSync(path).isFile();
    });
  return [...new Set(files)].sort();
}

/** Files changed between a commit and the working tree, under some paths */
function changedSince(commit, paths) {
  if (!commit || !commitExists(commit)) {
    return undefined;
  }
  const split = text => text.split('\0').filter(Boolean);
  return [
    ...new Set([
      ...split(git('diff', '--name-only', '-z', commit, '--', ...paths)),
      ...split(
        git('ls-files', '-z', '--others', '--exclude-standard', '--', ...paths),
      ),
    ]),
  ].sort();
}

// Line endings normalized, so a Windows checkout fingerprints like CI does
const normalize = buffer =>
  Buffer.from(buffer.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');

function hashFiles(entries) {
  return short(
    sha256(
      entries
        .map(([file, content]) => `${file}\0${sha256(normalize(content))}\n`)
        .join(''),
    ),
  );
}

/**
 * Runs fn over items, at most `limit` at a time. After a failure no new item
 * starts, the running ones finish, and then the first error is thrown.
 */
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  const errors = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length && !errors.length) {
        const index = next++;
        try {
          results[index] = await fn(items[index], index);
        } catch (error) {
          errors.push(error);
        }
      }
    },
  );
  await Promise.all(workers);
  if (errors.length) {
    throw errors[0];
  }
  return results;
}

function bumpVersion(version, level) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Recorded version "${version}" is not major.minor.patch`);
  }
  const [major, minor, patch] = version.split('.').map(Number);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  if (level === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`BUMP must be patch, minor or major, not "${level}"`);
}

const envName = service =>
  `${service.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TAG`;

const readManifest = () =>
  existsSync(join(root, MANIFEST)) ? readJson(join(root, MANIFEST)) : {};

function writeManifest(manifest) {
  const sorted = Object.fromEntries(
    Object.keys(manifest)
      .sort()
      .map(name => [name, manifest[name]]),
  );
  writeFileSync(join(root, MANIFEST), `${JSON.stringify(sorted, null, 2)}\n`);
}

// ----------------------------------------------------------------- services

/** Deployable services: every packages/<name>/Dockerfile, plus the gateway */
function listServices(packages) {
  const services = [];
  for (const entry of readdirSync(join(root, 'packages'), {
    withFileTypes: true,
  })) {
    const dockerfile = `packages/${entry.name}/Dockerfile`;
    if (entry.isDirectory() && existsSync(join(root, dockerfile))) {
      const pkg = findPackage(packages, `packages/${entry.name}`);
      services.push({ name: entry.name, dockerfile, pkg });
    }
  }
  if (existsSync(join(root, 'gateway/Dockerfile'))) {
    services.push({ name: 'gateway', dockerfile: 'gateway/Dockerfile' });
  }
  return services.sort((a, b) => a.name.localeCompare(b.name));
}

// Files in a package that never reach its build output
const NOT_BUILT = [
  /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)(__tests__|__mocks__|__fixtures__)\//,
  /(^|\/)setupTests\.[cm]?[jt]s$/,
  /\.stories\.[cm]?[jt]sx?$/,
  /\.md$/i,
  /^e2e-tests\//,
  /^dev\//, // the plugin dev harness, for `yarn start` only
  /^\.eslintrc/,
];

// Dependencies are fingerprinted from the pruned lockfile instead
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'peerDependenciesMeta',
  'dependenciesMeta',
];

/** What the source fingerprint of a service covers */
function sourceInputs(service, packages) {
  if (!service.pkg) {
    return { dirs: [], extra: [] };
  }
  const dirs = buildPackages(packages, service.pkg).map(node => node.dir);
  // The frontend embeds its configuration at build time
  const extra =
    service.pkg.pkg.backstage?.role === 'frontend' ? ['app-config.yaml'] : [];
  return { dirs, extra };
}

const under = (file, paths) =>
  paths.some(path => file === path || file.startsWith(`${path}/`));

/**
 * Whether a file in a service's source paths goes into its build. Files the
 * Dockerfile copies itself (the Dockerfile, packages/app/docker, ...) count
 * as image inputs instead.
 */
function isBuilt(file, dirs, imagePaths) {
  if (under(file, imagePaths)) return false;
  const dir = dirs.find(d => file.startsWith(`${d}/`));
  return !dir || !NOT_BUILT.some(re => re.test(file.slice(dir.length + 1)));
}

function sourceContent(file, dirs) {
  const buffer = readFileSync(join(root, file));
  if (dirs.some(dir => file === `${dir}/package.json`)) {
    const pkg = JSON.parse(buffer);
    for (const field of DEPENDENCY_FIELDS) delete pkg[field];
    return Buffer.from(JSON.stringify(pkg));
  }
  return buffer;
}

/**
 * What the image fingerprint covers: the Dockerfile, its ignore file, and
 * every repository path the ignore file lets into the build context, except
 * build outputs (dist), which stand for sources fingerprinted separately.
 */
function imageInputs(service) {
  const ignoreFile = `${service.dockerfile}.dockerignore`;
  if (!existsSync(join(root, ignoreFile))) {
    throw new Error(
      `${service.dockerfile} has no ${ignoreFile}, so there is no telling which files go into the image`,
    );
  }
  const paths = [service.dockerfile, ignoreFile];
  for (const line of readFileSync(join(root, ignoreFile), 'utf8').split('\n')) {
    const allowed = line.trim().match(/^!(.+)$/)?.[1];
    if (!allowed || /^packages\/[^/]+\/dist(\/|$)/.test(allowed)) {
      continue;
    }
    if (/[*?[]/.test(allowed)) {
      throw new Error(`${ignoreFile}: unsupported pattern "!${allowed}"`);
    }
    paths.push(allowed);
  }
  const dockerfile = readFileSync(join(root, service.dockerfile), 'utf8');
  const buildArgs = /^ARG NODE_VERSION\b/m.test(dockerfile)
    ? { NODE_VERSION: env.nodeVersion }
    : {};
  return { paths, buildArgs };
}

/** Resolved packages in a lockfile: name -> set of versions */
function resolutions(lockfile) {
  const result = new Map();
  for (const [, value] of lockfile.matchAll(/^ {2}resolution: "(.+)"$/gm)) {
    const match = value.match(/^(@?[^@]+)@(.+)$/);
    if (!match || match[2].startsWith('workspace:')) continue;
    const version = match[2]
      .replace(/^npm:/, '')
      .replace(/^patch:.*?npm%3A([^#]+)#.*$/, '$1 (patched)');
    if (!result.has(match[1])) result.set(match[1], new Set());
    result.get(match[1]).add(version);
  }
  return result;
}

function diffResolutions(before, after) {
  const changes = [];
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(name) ?? new Set();
    const is = after.get(name) ?? new Set();
    const removed = [...was].filter(v => !is.has(v));
    const added = [...is].filter(v => !was.has(v));
    if (removed.length === 1 && added.length === 1) {
      changes.push(`${name} ${removed[0]} → ${added[0]}`);
    } else {
      changes.push(...removed.map(v => `-${name}@${v}`));
      changes.push(...added.map(v => `+${name}@${v}`));
    }
  }
  return changes;
}

const toolchainManifest = rootManifest => ({
  name: 'toolchain',
  resolutions: rootManifest.resolutions,
  packageManager: rootManifest.packageManager,
  // The CLI loads its build modules from the root devDependencies
  dependencies: Object.fromEntries(
    Object.entries(rootManifest.devDependencies ?? {}).filter(([name]) =>
      name.startsWith('@backstage/cli'),
    ),
  ),
});

// ---------------------------------------------------------------- the plan

class Workspace {
  constructor() {
    this.packages = listPackages();
    this.services = listServices(this.packages);
    this.rootManifest = readJson(join(root, 'package.json'));
    this.lockfile = readFileSync(join(root, 'yarn.lock'), 'utf8');
    this.head = git('rev-parse', 'HEAD').trim();
  }

  dependencyClosure(service) {
    return localClosure(this.packages, service.pkg, { followBundled: true });
  }

  async fingerprint(service, toolchain) {
    const { dirs, extra } = sourceInputs(service, this.packages);
    const { paths: imagePaths, buildArgs } = imageInputs(service);
    const inputs = {};
    let dependencyLockfile;
    if (service.pkg) {
      const sourceFiles = listFiles([...dirs, ...extra]).filter(file =>
        isBuilt(file, dirs, imagePaths),
      );
      inputs.source = hashFiles(
        sourceFiles.map(file => [file, sourceContent(file, dirs)]),
      );
      const files = await prune({
        rootManifest: this.rootManifest,
        manifests: this.dependencyClosure(service),
        lockfile: this.lockfile,
      });
      dependencyLockfile = files['yarn.lock'];
      inputs.dependencies = hashFiles(
        Object.keys(files)
          .sort()
          .map(file => [file, Buffer.from(files[file])]),
      );
      inputs.toolchain = toolchain.hash;
    }
    inputs.image = short(
      sha256(
        hashFiles(
          listFiles(imagePaths).map(file => [
            file,
            readFileSync(join(root, file)),
          ]),
        ) + JSON.stringify(buildArgs),
      ),
    );
    return {
      service,
      inputs,
      buildArgs,
      fingerprint: short(sha256(JSON.stringify({ v: 1, ...inputs }))),
      sourcePaths: [...dirs, ...extra],
      sourceDirs: dirs,
      imagePaths,
      dependencyLockfile,
    };
  }

  async toolchain() {
    const files = await prune({
      rootManifest: toolchainManifest(this.rootManifest),
      manifests: [],
      lockfile: this.lockfile,
    });
    return {
      hash: hashFiles([['yarn.lock', Buffer.from(files['yarn.lock'])]]),
      lockfile: files['yarn.lock'],
    };
  }

  /** The dependency lockfile a service had at an earlier commit */
  async dependencyLockfileAt(commit, service) {
    const rootManifest = JSON.parse(gitShow(commit, 'package.json'));
    const manifests = this.dependencyClosure(service)
      .map(node => ({
        dir: node.dir,
        text: gitShow(commit, `${node.dir}/package.json`),
      }))
      .filter(({ text }) => text)
      .map(({ dir, text }) => ({ dir, pkg: JSON.parse(text) }));
    const files = await prune({
      rootManifest,
      manifests,
      lockfile: gitShow(commit, 'yarn.lock'),
    });
    return files['yarn.lock'];
  }

  async toolchainLockfileAt(commit) {
    const files = await prune({
      rootManifest: toolchainManifest(
        JSON.parse(gitShow(commit, 'package.json')),
      ),
      manifests: [],
      lockfile: gitShow(commit, 'yarn.lock'),
    });
    return files['yarn.lock'];
  }

  /** Why a service's inputs differ from its last release */
  async reasons(current, record, toolchain) {
    if (!record) {
      return [{ kind: 'new', summary: 'first release' }];
    }
    const commit = record.commit;
    const known = commit && commitExists(commit);
    const reasons = [];
    const describe = (label, list) => {
      if (!list?.length) return label;
      const shown = list.slice(0, 3).join(', ');
      return `${label}: ${shown}${
        list.length > 3 ? ` (+${list.length - 3} more)` : ''
      }`;
    };

    if (current.inputs.source !== record.inputs?.source) {
      const files = known
        ? changedSince(commit, current.sourcePaths).filter(file =>
            isBuilt(file, current.sourceDirs, current.imagePaths),
          )
        : undefined;
      reasons.push({
        kind: 'source',
        details: files ?? [],
        summary: describe('code', files),
      });
    }
    if (current.inputs.dependencies !== record.inputs?.dependencies) {
      let changes;
      if (known) {
        try {
          changes = diffResolutions(
            resolutions(
              await this.dependencyLockfileAt(commit, current.service),
            ),
            resolutions(current.dependencyLockfile),
          );
        } catch {
          changes = undefined;
        }
      }
      reasons.push({
        kind: 'dependencies',
        details: changes ?? [],
        summary:
          changes && !changes.length
            ? 'dependencies: lockfile entries changed, same versions'
            : describe('dependencies', changes),
      });
    }
    if (current.inputs.toolchain !== record.inputs?.toolchain) {
      let changes;
      if (known) {
        try {
          changes = diffResolutions(
            resolutions(await this.toolchainLockfileAt(commit)),
            resolutions(toolchain.lockfile),
          );
          const cli = changes.filter(c => /^[-+]?@backstage\/cli[ @]/.test(c));
          changes = cli.length
            ? [...cli, ...changes.filter(c => !cli.includes(c))]
            : changes;
        } catch {
          changes = undefined;
        }
      }
      reasons.push({
        kind: 'toolchain',
        details: changes ?? [],
        summary: describe('build toolchain', changes),
      });
    }
    if (current.inputs.image !== record.inputs?.image) {
      const details = [];
      for (const [arg, value] of Object.entries(current.buildArgs)) {
        const was = record.buildArgs?.[arg];
        if (was !== value)
          details.push(`${arg} ${was ?? '(unset)'} → ${value}`);
      }
      if (known) details.push(...changedSince(commit, current.imagePaths));
      reasons.push({
        kind: 'image',
        details,
        summary: describe('image', details),
      });
    }
    if (!reasons.length) {
      reasons.push({
        kind: 'fingerprint',
        summary: 'fingerprint format changed',
      });
    }
    return reasons;
  }

  async plan() {
    const manifest = readManifest();
    const toolchain = await this.toolchain();
    const fingerprints = await mapConcurrent(this.services, CONCURRENCY, s =>
      this.fingerprint(s, toolchain),
    );
    const services = await mapConcurrent(
      fingerprints,
      CONCURRENCY,
      async current => {
        const record = manifest[current.service.name];
        const changed = !record || record.fingerprint !== current.fingerprint;
        return {
          name: current.service.name,
          status: !record ? 'new' : changed ? 'changed' : 'unchanged',
          released: record?.version ?? null,
          next: !changed
            ? null
            : record
            ? bumpVersion(record.version, env.bump)
            : INITIAL_VERSION,
          fingerprint: current.fingerprint,
          inputs: current.inputs,
          buildArgs: current.buildArgs,
          reasons: changed
            ? await this.reasons(current, record, toolchain)
            : [],
        };
      },
    );
    return {
      commit: this.head,
      bump: env.bump,
      services,
      changed: services.filter(s => s.status !== 'unchanged').map(s => s.name),
    };
  }
}

function printPlan(plan) {
  const rows = plan.services.map(s => [
    s.name,
    s.released ?? '-',
    s.next ?? '-',
    s.status === 'unchanged'
      ? 'unchanged'
      : s.reasons.map(r => r.summary).join('; '),
  ]);
  const header = ['SERVICE', 'RELEASED', 'NEXT', 'CHANGES'];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map(row => row[i].length)),
  );
  const line = row =>
    `  ${row
      .map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]) : cell))
      .join('  ')}`;
  const n = plan.changed.length;
  console.log(
    `\nRelease plan: ${n} of ${plan.services.length} services ${
      n === 1 ? 'needs' : 'need'
    } a new release\n`,
  );
  console.log(line(header));
  for (const row of rows) console.log(line(row));
  console.log();
}

function githubOutputs(plan) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${JSON.stringify(plan.changed)}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = plan.services
      .filter(s => s.status !== 'unchanged')
      .map(
        s =>
          `| ${s.name} | ${s.released ?? '-'} | ${s.next} | ${s.reasons
            .map(r => r.summary)
            .join('<br>')} |`,
      );
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `### Release plan: ${plan.changed.length} of ${plan.services.length} services changed`,
        '',
        ...(rows.length
          ? [
              '| Service | Released | Next | Changes |',
              '| --- | --- | --- | --- |',
              ...rows,
            ]
          : ['Nothing to release.']),
        '',
      ].join('\n'),
    );
  }
}

async function makePlan() {
  const plan = await new Workspace().plan();
  mkdirSync(dirname(join(root, PLAN_FILE)), { recursive: true });
  writeFileSync(join(root, PLAN_FILE), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

// ------------------------------------------------------- building, release

function task(args, log) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('task', args, { cwd: root, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', data => (output += data));
    child.stderr.on('data', data => (output += data));
    child.on('error', reject);
    child.on('close', code => {
      if (log) {
        mkdirSync(dirname(log), { recursive: true });
        writeFileSync(log, output);
      }
      if (code === 0) {
        resolvePromise(output);
      } else {
        const tail = output.trim().split('\n').slice(-15).join('\n');
        reject(new Error(`task ${args[0]} failed:\n${tail}`));
      }
    });
  });
}

const taskVars = () => [
  `NODE_VERSION=${env.nodeVersion}`,
  `REGISTRY=${env.registry}`,
  `IMAGE_NAMESPACE=${env.namespace}`,
  `EXTRA_CA_CERT=${env.extraCaCert}`,
  `DOCKER_BUILD_FLAGS=${env.dockerBuildFlags}`,
];

async function buildImages(entries, revision) {
  // One install up front, so parallel builds do not race on it
  await task(['install']);
  const started = Date.now();
  await mapConcurrent(entries, 3, async ({ name, version, fingerprint }) => {
    const t = Date.now();
    await task(
      [
        `image:${name}`,
        `TAG=${version}`,
        `VERSION=${version}`,
        `REVISION=${revision}`,
        `FINGERPRINT=${fingerprint}`,
        ...taskVars(),
      ],
      join(root, 'dist', 'release-logs', `${name}.log`),
    );
    console.log(
      `  built   ${imagePrefix}/${name}:${version}  (${(
        (Date.now() - t) /
        1000
      ).toFixed(1)}s)`,
    );
  });
  return (Date.now() - started) / 1000;
}

async function pushImages(entries) {
  await mapConcurrent(entries, 3, async ({ name, version }) => {
    await task([`push:${name}`, `TAG=${version}`, ...taskVars()]);
    console.log(`  pushed  ${imagePrefix}/${name}:${version}`);
  });
}

function toBuild(plan) {
  return plan.services
    .filter(s => s.status !== 'unchanged')
    .map(s => ({ name: s.name, version: s.next, fingerprint: s.fingerprint }));
}

async function buildCommand() {
  const plan = await makePlan();
  printPlan(plan);
  const entries = toBuild(plan);
  if (!entries.length) {
    console.log('Nothing to build: every service matches its last release.');
    return;
  }
  const seconds = await buildImages(entries, plan.commit);
  console.log(
    `\nBuilt ${entries.length} image(s) in ${seconds.toFixed(
      1,
    )}s; unchanged services were not rebuilt.`,
  );
}

async function releaseCommand() {
  const plan = await makePlan();
  printPlan(plan);
  const entries = toBuild(plan);
  if (!entries.length) {
    console.log('Nothing to release: every service matches its last release.');
    return;
  }
  const seconds = await buildImages(entries, plan.commit);
  if (env.registry) {
    await pushImages(entries);
  } else {
    console.log(
      '  (REGISTRY is not set: images were built locally, not pushed)',
    );
  }

  // The inputs must not have changed while the images were being built
  const after = await new Workspace().plan();
  for (const entry of entries) {
    const now = after.services.find(s => s.name === entry.name);
    if (now.fingerprint !== entry.fingerprint) {
      throw new Error(
        `${entry.name} changed while it was being released; nothing was recorded`,
      );
    }
  }

  const manifest = readManifest();
  for (const s of plan.services.filter(s => s.status !== 'unchanged')) {
    manifest[s.name] = {
      version: s.next,
      fingerprint: s.fingerprint,
      inputs: s.inputs,
      ...(Object.keys(s.buildArgs).length ? { buildArgs: s.buildArgs } : {}),
      commit: plan.commit,
    };
  }
  writeManifest(manifest);

  const dirty = git('status', '--porcelain', '--untracked-files=no')
    .split('\n')
    .filter(line => line && !line.endsWith(MANIFEST));
  console.log(
    `\nReleased ${entries
      .map(e => `${e.name}@${e.version}`)
      .join(', ')} in ${seconds.toFixed(1)}s and recorded ${
      entries.length === 1 ? 'it' : 'them'
    } in ${MANIFEST}.`,
  );
  if (dirty.length) {
    console.log(
      'Note: the working tree has uncommitted changes; commit them with the release record.',
    );
  }
  console.log(
    `Next: commit ${MANIFEST}, then \`task release:tag\` to tag ${
      entries.length === 1 ? 'it' : 'them'
    } in git.`,
  );
}

function tagCommand() {
  const manifest = readManifest();
  if (git('status', '--porcelain', '--', MANIFEST).trim() !== '') {
    throw new Error(
      `Commit ${MANIFEST} first, so the tags point at the release record`,
    );
  }
  const existing = new Set(git('tag', '--list').split('\n'));
  let created = 0;
  for (const [name, record] of Object.entries(manifest)) {
    const tag = `${name}@${record.version}`;
    if (existing.has(tag)) continue;
    git(
      'tag',
      '-a',
      tag,
      '-m',
      `${name} ${record.version}\n\nfingerprint ${record.fingerprint}`,
    );
    console.log(`  tagged ${tag}`);
    created++;
  }
  console.log(
    created
      ? `Created ${created} tag(s). Push them with: git push origin --tags`
      : 'Every recorded version is already tagged.',
  );
}

function envLines(manifest) {
  return Object.entries(manifest).map(
    ([name, record]) => `${envName(name)}=${record.version}`,
  );
}

function imageExists(ref) {
  try {
    execFileSync('docker', ['image', 'inspect', ref], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function upCommand() {
  const manifest = readManifest();
  const missing = Object.entries(manifest)
    .map(([name, record]) => ({
      name,
      version: record.version,
      fingerprint: record.fingerprint,
    }))
    .filter(
      ({ name, version }) => !imageExists(`${imagePrefix}/${name}:${version}`),
    );
  if (missing.length && !env.registry) {
    // Rebuild released versions from source, when the source still matches
    const plan = await makePlan();
    const unbuildable = missing.filter(
      m => plan.services.find(s => s.name === m.name)?.status !== 'unchanged',
    );
    if (unbuildable.length) {
      throw new Error(
        `No local image for ${unbuildable
          .map(m => `${m.name}@${m.version}`)
          .join(
            ', ',
          )}, and the source has changed since that release. Set REGISTRY to pull it, or release the changes first.`,
      );
    }
    console.log(
      `Building released versions that are not available locally: ${missing
        .map(m => `${m.name}@${m.version}`)
        .join(', ')}`,
    );
    await buildImages(missing, plan.commit);
  }
  const composeEnv = { ...process.env, IMAGE_PREFIX: imagePrefix };
  for (const line of envLines(manifest)) {
    const [key, value] = line.split('=');
    composeEnv[key] = value;
  }
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      'docker',
      ['compose', 'up', '--detach', '--wait', '--remove-orphans'],
      { cwd: root, env: composeEnv, stdio: 'inherit' },
    );
    child.on('close', code =>
      code === 0
        ? resolvePromise()
        : reject(new Error('docker compose up failed')),
    );
  });
  execFileSync(
    process.execPath,
    [
      join(root, 'scripts', 'wait-for-gateway.mjs'),
      process.env.APP_BASE_URL || 'http://localhost:8080',
    ],
    { stdio: 'inherit' },
  );
  console.log(
    `Running released versions: ${Object.entries(manifest)
      .map(([name, r]) => `${name}@${r.version}`)
      .join(', ')}`,
  );
}

// ------------------------------------------------------------------- main

const [command = 'plan', ...flags] = process.argv.slice(2);
try {
  switch (command) {
    case 'plan': {
      const plan = await makePlan();
      if (flags.includes('--json')) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        printPlan(plan);
        if (plan.changed.length) {
          console.log(
            'Build them with `task build:changed`, or release them with `task release:changed`.',
          );
        }
      }
      githubOutputs(plan);
      break;
    }
    case 'build':
      await buildCommand();
      break;
    case 'release':
      await releaseCommand();
      break;
    case 'tag':
      tagCommand();
      break;
    case 'up':
      await upCommand();
      break;
    case 'env':
      console.log(envLines(readManifest()).join('\n'));
      break;
    default:
      console.error(`Unknown command "${command}"`);
      process.exit(1);
  }
} catch (error) {
  console.error(`\n${error.message}`);
  process.exit(1);
}
