/*
 * Prunes the monorepo's yarn.lock to the production dependencies of a set
 * of workspace packages. Resolution comes from the existing lockfile only:
 * nothing is downloaded, linked or installed, and the network is off.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { root } from './workspace.mjs';

// The fields that decide what `yarn workspaces focus --production` installs.
// Anything else in a manifest (scripts, metadata) must not bust the image's
// dependency layer.
const ROOT_FIELDS = [
  'workspaces',
  'resolutions',
  // Which dependencies may run install scripts (.yarnrc.yml enableScripts)
  'dependenciesMeta',
  'dependencies',
  'packageManager',
];
const PACKAGE_FIELDS = [
  'name',
  'version',
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'dependenciesMeta',
];

const pick = (object, fields) =>
  Object.fromEntries(
    fields.filter(f => object[f] !== undefined).map(f => [f, object[f]]),
  );

const json = value => `${JSON.stringify(value, null, 2)}\n`;

function yarnPath() {
  const match = readFileSync(join(root, '.yarnrc.yml'), 'utf8').match(
    /^yarnPath:\s*(.+?)\s*$/m,
  );
  if (!match) {
    throw new Error('.yarnrc.yml has no yarnPath');
  }
  return match[1];
}

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', data => (output += data));
    child.stderr.on('data', data => (output += data));
    child.on('error', reject);
    child.on('close', code =>
      code === 0
        ? resolvePromise(output)
        : reject(new Error(`${args.join(' ')} failed:\n${output}`)),
    );
  });
}

// Pruning is a pure function of its inputs, so results are cached by them
const CACHE = join(tmpdir(), 'backstage-poc-prune-cache');

/**
 * Returns the files a dependency install needs, keyed by path:
 * package.json (root), <dir>/package.json for each package, and yarn.lock.
 *
 * @param rootManifest the root package.json, parsed
 * @param manifests    [{ dir, pkg }] for the workspace packages to keep
 * @param lockfile     the full yarn.lock, as text
 */
export async function prune({ rootManifest, manifests, lockfile }) {
  const files = {
    'package.json': json({
      name: rootManifest.name,
      private: true,
      ...pick(rootManifest, ROOT_FIELDS),
    }),
  };
  for (const { dir, pkg } of manifests) {
    files[`${dir}/package.json`] = json(pick(pkg, PACKAGE_FIELDS));
  }

  const yarnrc = readFileSync(join(root, '.yarnrc.yml'), 'utf8');
  const key = createHash('sha256')
    .update(JSON.stringify({ files, yarnrc, yarn: yarnPath() }))
    .update(lockfile)
    .digest('hex');
  const cached = join(CACHE, `${key}.lock`);
  if (existsSync(cached)) {
    return { ...files, 'yarn.lock': readFileSync(cached, 'utf8') };
  }

  const work = mkdtempSync(join(tmpdir(), 'prune-'));
  try {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      writeFileSync(join(work, file), content);
    }
    const yarn = yarnPath();
    // The lockfile is the same on every platform, but Yarn would still fetch
    // the platform-specific binaries (esbuild, swc, ...) for this one, since
    // the lockfile has no checksums for them. Targeting no platform skips
    // them, so pruning works offline and with an empty cache, e.g. in CI.
    writeFileSync(
      join(work, '.yarnrc.yml'),
      `${yarnrc}\n` +
        'supportedArchitectures:\n  os: [none]\n  cpu: [none]\n  libc: [none]\n',
    );
    cpSync(join(root, dirname(yarn)), join(work, dirname(yarn)), {
      recursive: true,
    });
    writeFileSync(join(work, 'yarn.lock'), lockfile);

    await run(
      process.execPath,
      [join(work, yarn), 'install', '--mode=update-lockfile'],
      {
        cwd: work,
        env: {
          ...process.env,
          YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
          YARN_ENABLE_NETWORK: 'false',
          YARN_ENABLE_TELEMETRY: 'false',
          YARN_ENABLE_PROGRESS_BARS: 'false',
        },
      },
    );
    files['yarn.lock'] = readFileSync(join(work, 'yarn.lock'), 'utf8');
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(`${cached}.${process.pid}`, files['yarn.lock']);
    renameSync(`${cached}.${process.pid}`, cached);
    return files;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Writes the result of prune() into a directory */
export function writeFiles(dir, files) {
  rmSync(dir, { recursive: true, force: true });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
}
