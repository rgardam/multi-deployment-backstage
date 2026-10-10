#!/usr/bin/env node
/*
 * Waits until the gateway reaches every deployment. When docker compose
 * replaces a container, the new one has a new address, and nginx keeps the
 * old one for up to its resolver TTL (5 s): requests in that window get a
 * 502 even though every container reports healthy. Called after `task up`,
 * `task deploy:*` and `task up:released`.
 *
 *   node scripts/wait-for-gateway.mjs http://localhost:8080
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const base = (process.argv[2] ?? 'http://localhost:8080').replace(/\/$/, '');
const root = resolve(import.meta.dirname, '..');

// One plugin per deployment: those the gateway routes explicitly, plus auth
// for backend-core, which serves everything else. Every plugin serves its
// public keys without authentication.
const gateway = readFileSync(
  join(root, 'gateway/default.conf.template'),
  'utf8',
);
const plugins = [
  'auth',
  ...[...gateway.matchAll(/location \/api\/([a-z0-9-]+)\//g)].map(m => m[1]),
];
const urls = [
  `${base}/`,
  ...plugins.map(p => `${base}/api/${p}/.backstage/auth/v1/jwks.json`),
];

const ok = async url => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const deadline = Date.now() + 120_000;
let streak = 0;
let failing = [];
// Two clean rounds in a row: one lucky request is not enough
while (streak < 2) {
  const results = await Promise.all(urls.map(ok));
  failing = urls.filter((_, i) => !results[i]);
  streak = failing.length ? 0 : streak + 1;
  if (streak < 2) {
    if (Date.now() > deadline) {
      console.error(
        `The gateway still cannot reach:\n  ${failing.join('\n  ')}`,
      );
      process.exit(1);
    }
    await sleep(1000);
  }
}
console.log(`The gateway reaches all ${urls.length} deployments.`);
