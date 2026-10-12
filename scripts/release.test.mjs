/*
 * Which services does a change flag for release? Runs the release plan in a
 * temporary git worktree, records every service as released, then applies
 * one kind of change at a time and checks exactly which services the plan
 * flags. Runs offline; the working copy is never touched.
 *
 *   node --test 'scripts/*.test.mjs'
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const repo = resolve(import.meta.dirname, '..');
const BACKENDS = [
  'backend-catalog',
  'backend-core',
  'backend-scaffolder',
  'backend-scorecards',
  'backend-search',
  'backend-techdocs',
];
let work;

function plan(env = {}) {
  const output = execFileSync(
    process.execPath,
    ['scripts/release.mjs', 'plan', '--json'],
    {
      cwd: work,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        NODE_VERSION: '24',
        BUMP: 'patch',
        REGISTRY: '',
        GITHUB_OUTPUT: '',
        GITHUB_STEP_SUMMARY: '',
        ...env,
      },
    },
  );
  return JSON.parse(output);
}

// Changes made by a test case, undone after it
const originals = new Map();
function edit(file, change) {
  const path = join(work, file);
  if (!originals.has(file)) {
    originals.set(file, existsSync(path) ? readFileSync(path) : null);
  }
  if (typeof change === 'function') {
    const before = readFileSync(path, 'utf8');
    const after = change(before);
    assert.notEqual(after, before, `the test did not change ${file}`);
    writeFileSync(path, after);
  } else {
    appendFileSync(path, change);
  }
}
function undo() {
  for (const [file, content] of originals) {
    if (content === null) rmSync(join(work, file), { force: true });
    else writeFileSync(join(work, file), content);
  }
  originals.clear();
}

/** Changes the checksum of one lockfile entry: same version, new content */
const touchLockfileEntry = descriptor => text => {
  const escaped = descriptor.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return text.replace(
    new RegExp(`("${escaped}":\\n(?: {2}.*\\n)*? {2}checksum: [0-9a-z]+/)(.)`),
    (_, head, first) => head + (first === '0' ? '1' : '0'),
  );
};

before(() => {
  work = mkdtempSync(join(tmpdir(), 'release-test-'));
  execFileSync('git', ['worktree', 'add', '--detach', work, 'HEAD'], {
    cwd: repo,
    stdio: 'ignore',
  });
  // Test the scripts as they are now, committed or not
  cpSync(join(repo, 'scripts'), join(work, 'scripts'), { recursive: true });

  // Record every service as released from exactly this tree
  const baseline = plan();
  const manifest = Object.fromEntries(
    baseline.services.map(s => [
      s.name,
      {
        version: '1.0.0',
        fingerprint: s.fingerprint,
        inputs: s.inputs,
        ...(Object.keys(s.buildArgs).length ? { buildArgs: s.buildArgs } : {}),
        commit: baseline.commit,
      },
    ]),
  );
  writeFileSync(
    join(work, 'deploy', 'releases.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
});

after(() => {
  if (work) {
    execFileSync('git', ['worktree', 'remove', '--force', work], {
      cwd: repo,
      stdio: 'ignore',
    });
  }
});

const cases = [
  ['nothing changed', () => {}, []],
  [
    'code in a backend plugin',
    () => edit('plugins/noticeboard-backend/src/router.ts', '\n// change\n'),
    ['backend-core'],
  ],
  [
    'a new file in a backend plugin',
    () => edit('plugins/noticeboard-backend/src/extra.ts', 'export {};\n'),
    ['backend-core'],
  ],
  [
    'tests, docs and the dev harness only',
    () => {
      edit('plugins/noticeboard-backend/src/plugin.test.ts', '\n// change\n');
      edit('plugins/noticeboard-backend/README.md', '\nchange\n');
      edit('plugins/noticeboard/dev/index.tsx', '\n// change\n');
    },
    [],
  ],
  [
    'code in a frontend plugin',
    () =>
      edit(
        'plugins/scorecards/src/components/ScorecardCard/ScorecardCard.tsx',
        '\n// change\n',
      ),
    ['app'],
  ],
  [
    'a library shared by the frontend and a backend',
    () => edit('plugins/scorecards-common/src/index.ts', '\n// change\n'),
    ['app', 'backend-scorecards'],
  ],
  [
    'an inline package, only in the packages that import it',
    () => edit('packages/catalog-sharding/src/topology.ts', '\n// change\n'),
    ['backend-catalog', 'catalog-router'],
  ],
  [
    'config baked into the frontend and every backend',
    () => edit('app-config.yaml', '\n# change\n'),
    ['app', ...BACKENDS],
  ],
  [
    'config baked into the backends only',
    () => edit('app-config.production.yaml', '\n# change\n'),
    BACKENDS,
  ],
  [
    'the gateway configuration',
    () => edit('gateway/default.conf.template', '\n# change\n'),
    ['gateway'],
  ],
  [
    "one service's Dockerfile",
    () => edit('packages/backend-search/Dockerfile', '\n# change\n'),
    ['backend-search'],
  ],
  [
    'files copied into some images (examples/)',
    () => edit('examples/entities.yaml', '\n# change\n'),
    ['backend-catalog', 'backend-scaffolder', 'backend-techdocs'],
  ],
  [
    'a dependency of one backend',
    () =>
      edit(
        'yarn.lock',
        touchLockfileEntry(
          '@backstage/plugin-search-backend-module-pg@npm:^0.5.59',
        ),
      ),
    ['backend-search'],
  ],
  [
    'the build toolchain',
    () => edit('yarn.lock', touchLockfileEntry('@backstage/cli@npm:^0.36.6')),
    ['app', ...BACKENDS, 'catalog-router'],
  ],
];

for (const [name, change, expected] of cases) {
  test(`flags only what it must: ${name}`, () => {
    try {
      change();
      assert.deepEqual(plan().changed, expected);
    } finally {
      undo();
    }
  });
}

test('a different Node.js version flags every Node.js image', () => {
  assert.deepEqual(plan({ NODE_VERSION: '22' }).changed, [
    ...BACKENDS,
    'catalog-router',
  ]);
});

test('explains changes and proposes the next versions', () => {
  try {
    edit('plugins/noticeboard-backend/src/router.ts', '\n// change\n');
    const core = plan({ BUMP: 'minor' }).services.find(
      s => s.name === 'backend-core',
    );
    assert.equal(core.status, 'changed');
    assert.equal(core.released, '1.0.0');
    assert.equal(core.next, '1.1.0');
    assert.deepEqual(core.reasons, [
      {
        kind: 'source',
        details: ['plugins/noticeboard-backend/src/router.ts'],
        summary: 'code: plugins/noticeboard-backend/src/router.ts',
      },
    ]);
  } finally {
    undo();
  }
});
