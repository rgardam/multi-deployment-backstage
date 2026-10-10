#!/usr/bin/env node
/*
 * What a CI job runs to read the catalog: it gets a short-lived OIDC token
 * from its CI platform (see lib/ci-token.mjs) and pages through the catalog
 * API with it. No stored secret. Zero dependencies; needs Node 20+.
 *
 *   node scripts/ci-catalog-read.mjs https://backstage.example.com [filter]
 *
 * filter defaults to kind=component; e.g. kind=api,metadata.namespace=payments
 */
import { ciToken } from './lib/ci-token.mjs';

const base = (process.argv[2] ?? 'http://localhost:8080').replace(/\/$/, '');
const filter = process.argv[3] ?? 'kind=component';
const fields = ['kind', 'metadata.namespace', 'metadata.name', 'spec.owner'];

const token = await ciToken();
const shards = new Set();
const entities = [];

let cursor;
do {
  const params = new URLSearchParams({ limit: '50' });
  for (const field of fields) params.append('fields', field);
  // The cursor carries the filter (and, through the router, every shard's
  // place), so only the first page names it
  params.set(...(cursor ? ['cursor', cursor] : ['filter', filter]));

  const res = await fetch(`${base}/api/catalog/entities/by-query?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`${res.status} ${res.statusText}: ${await res.text()}`);
    process.exit(1);
  }
  res.headers
    .get('x-catalog-shards')
    ?.split(',')
    .forEach(shard => shards.add(shard));
  const page = await res.json();
  entities.push(...page.items);
  cursor = page.pageInfo?.nextCursor;
} while (cursor);

const refs = entities.map(
  e => `${e.kind.toLowerCase()}:${e.metadata.namespace}/${e.metadata.name}`,
);
const width = Math.max(0, ...refs.map(ref => ref.length));
console.log(
  `${entities.length} entities matching ${filter}, read from ${base}${
    shards.size ? ` (catalog shards asked: ${[...shards].join(', ')})` : ''
  }\n`,
);
entities.forEach((entity, i) => {
  console.log(`  ${refs[i].padEnd(width)}  owner ${entity.spec?.owner ?? '-'}`);
});
