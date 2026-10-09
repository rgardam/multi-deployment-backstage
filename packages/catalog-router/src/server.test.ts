import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { readTopology } from '@internal/catalog-sharding';
import { decodeCursor } from './cursor';
import { createLogger } from './logger';
import { projectFields, readPath } from './merge';
import { createServer } from './server';
import { ShardClient } from './shardClient';

type Entity = {
  kind: string;
  metadata: { name: string; namespace: string; uid: string; title?: string };
  spec?: { type?: string };
};

const entity = (
  kind: string,
  namespace: string,
  name: string,
  uid: string,
  type?: string,
): Entity => ({
  kind,
  metadata: { name, namespace, uid },
  ...(type ? { spec: { type } } : {}),
});

const lower = (v: unknown) => String(v ?? '').toLowerCase();

function matches(e: Entity, filter: string): boolean {
  return filter.split(',').every(statement => {
    const [key, value] = statement.split('=');
    return lower(readPath(e, key)) === lower(value);
  });
}

/**
 * A tiny stand-in for one catalog shard, with the ordering and paging
 * semantics of the real by-query endpoint (offset paging, uid tie-breaker,
 * entities lacking the order field excluded).
 */
function fakeShard(name: string, entities: Entity[]) {
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://shard');
    const path = url.pathname.replace(/^\/api\/catalog/, '');
    calls.push(`${req.method} ${path}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};
    const send = (status: number, json: unknown, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(json));
    };
    const filtered = (filters: string[]) =>
      filters.length
        ? entities.filter(e => filters.some(f => matches(e, f)))
        : entities;
    const sortBy = (list: Entity[], field?: string, order = 'asc') => {
      const dir = order === 'desc' ? -1 : 1;
      return list
        .filter(e => !field || readPath(e, field) !== undefined)
        .sort((a, b) => {
          const byValue = field
            ? lower(readPath(a, field)).localeCompare(lower(readPath(b, field)))
            : 0;
          return (
            (byValue || a.metadata.uid.localeCompare(b.metadata.uid)) * dir
          );
        });
    };
    const fields = (list: Entity[], raw: string[]) => {
      const f = raw.flatMap(v => v.split(',')).filter(Boolean);
      return f.length ? list.map(e => projectFields(e, f)) : list;
    };

    if (path === '/.backstage/auth/v1/jwks.json') {
      send(200, { keys: [{ kid: `key-${name}` }] });
    } else if (path === '/entities/by-query') {
      const q =
        req.method === 'POST'
          ? {
              filter: [] as string[],
              orderField: body.orderBy?.[0]
                ? [`${body.orderBy[0].field},${body.orderBy[0].order}`]
                : [],
              offset: body.offset,
              limit: body.limit,
              fields: body.fields ?? [],
              kinds: body.query?.kind?.$in as string[] | undefined,
            }
          : {
              filter: url.searchParams.getAll('filter'),
              orderField: url.searchParams.getAll('orderField'),
              offset: url.searchParams.get('offset'),
              limit: url.searchParams.get('limit'),
              fields: url.searchParams.getAll('fields'),
              kinds: undefined,
            };
      let list = filtered(q.filter);
      if (q.kinds) list = list.filter(e => q.kinds!.includes(lower(e.kind)));
      const [field, order] = (q.orderField[0] ?? '').split(',');
      const sorted = sortBy(list, field || undefined, order);
      const offset = Number(q.offset ?? 0);
      const limit = Number(q.limit ?? 200);
      const page = sorted.slice(offset, offset + limit);
      send(200, {
        items: fields(page, q.fields),
        totalItems: sorted.length,
        pageInfo:
          offset + limit < sorted.length ? { nextCursor: 'native' } : {},
      });
    } else if (path === '/entities') {
      const list = filtered(url.searchParams.getAll('filter'));
      const order = url.searchParams.getAll('order')[0]?.split(':');
      const sorted = sortBy(list, order?.[1], order?.[0]);
      send(200, fields(sorted, url.searchParams.getAll('fields')));
    } else if (path === '/entities/by-refs') {
      send(200, {
        items: body.entityRefs.map(
          (ref: string) =>
            entities.find(
              e =>
                lower(
                  `${e.kind}:${e.metadata.namespace}/${e.metadata.name}`,
                ) === lower(ref),
            ) ?? null,
        ),
      });
    } else if (path === '/entity-facets') {
      const counts: Record<string, number> = {};
      filtered(url.searchParams.getAll('filter')).forEach(e => {
        counts[e.kind] = (counts[e.kind] ?? 0) + 1;
      });
      send(200, {
        facets: {
          kind: Object.entries(counts).map(([value, count]) => ({
            value,
            count,
          })),
        },
      });
    } else if (path.startsWith('/entities/by-name/')) {
      const [kind, ns, n] = path.split('/').slice(3);
      const found = entities.find(
        e =>
          lower(e.kind) === kind &&
          e.metadata.namespace === ns &&
          e.metadata.name === n,
      );
      send(found ? 200 : 404, found ?? { error: { name: 'NotFoundError' } });
    } else {
      send(404, { error: { name: 'NotFoundError', message: path } });
    }
  });
  return { server, calls };
}

const org = [
  entity('Group', 'default', 'team-a', 'u03'),
  entity('Group', 'default', 'team-b', 'u11'),
  entity('User', 'default', 'alice', 'u07'),
];
const payments = [
  entity('Component', 'payments', 'billing', 'u02', 'service'),
  entity('Component', 'payments', 'ledger', 'u09', 'service'),
  entity('Component', 'payments', 'checkout', 'u13', 'website'),
  entity('API', 'payments', 'payments-api', 'u05'),
];
const fallback = [
  entity('Component', 'default', 'artist-lookup', 'u01', 'service'),
  entity('Component', 'default', 'catalog-ui', 'u04', 'website'),
  entity('Component', 'default', 'docs', 'u06', 'website'),
  entity('Component', 'default', 'gateway', 'u08', 'service'),
  entity('Component', 'default', 'search', 'u10', 'service'),
  entity('Component', 'default', 'zeta', 'u12', 'library'),
  entity('Template', 'default', 'new-service', 'u14'),
];
const components = [...payments, ...fallback].filter(
  e => e.kind === 'Component',
);

describe('catalog router', () => {
  const shards = [
    { name: 'org', ...fakeShard('org', org) },
    { name: 'payments', ...fakeShard('payments', payments) },
    { name: 'default', ...fakeShard('default', fallback) },
  ];
  let router: http.Server;
  let base: string;

  beforeAll(async () => {
    const targets: Record<string, string> = {};
    for (const s of shards) {
      await new Promise<void>(r => s.server.listen(0, '127.0.0.1', r));
      targets[s.name] = `http://127.0.0.1:${
        (s.server.address() as AddressInfo).port
      }/api/catalog`;
    }
    const topology = readTopology({
      shards: [
        {
          name: 'org',
          target: targets.org,
          match: { kinds: ['user', 'group'] },
        },
        {
          name: 'payments',
          target: targets.payments,
          match: { namespaces: ['payments'] },
        },
        { name: 'default', target: targets.default },
      ],
    });
    router = createServer({
      topology,
      client: new ShardClient({ timeoutMs: 2000 }),
      logger: createLogger('error'),
      basePath: '/api/catalog',
    });
    await new Promise<void>(r => router.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${
      (router.address() as AddressInfo).port
    }/api/catalog`;
  });

  afterAll(async () => {
    router.closeAllConnections();
    await new Promise(r => router.close(r));
    for (const s of shards) {
      s.server.closeAllConnections();
      await new Promise(r => s.server.close(r));
    }
  });

  beforeEach(() => shards.forEach(s => (s.calls.length = 0)));

  const get = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    return { res, json: await res.json() };
  };
  const names = (items: Entity[]) => items.map(e => e.metadata.name);

  it('routes a query that only one shard can answer to that shard', async () => {
    const { res, json } = await get('/entities/by-query?filter=kind=group');
    expect(res.headers.get('x-catalog-shards')).toBe('org');
    expect(res.headers.get('x-catalog-route')).toBe('single');
    expect(names(json.items)).toEqual(['team-a', 'team-b']);
    expect(shards.map(s => s.calls.length)).toEqual([1, 0, 0]);
  });

  it('pages through a fan-out query without gaps or duplicates, both ways', async () => {
    const query = 'filter=kind=component&orderField=metadata.name,asc&limit=4';
    const pages: string[][] = [];
    const first = await get(`/entities/by-query?${query}`);
    let json = first.json;
    expect(first.res.headers.get('x-catalog-shards')).toBe('payments,default');
    expect(json.totalItems).toBe(components.length);
    expect(json.pageInfo.prevCursor).toBeUndefined();
    pages.push(names(json.items));
    while (json.pageInfo.nextCursor) {
      const cursor = encodeURIComponent(json.pageInfo.nextCursor);
      ({ json } = await get(`/entities/by-query?cursor=${cursor}&limit=4`));
      pages.push(names(json.items));
    }
    const expected = names(components).sort();
    expect(pages.flat()).toEqual(expected);
    expect(pages.map(p => p.length)).toEqual([4, 4, 1]);

    // Walk back from the last page and expect the same pages in reverse
    const back: string[][] = [];
    while (json.pageInfo.prevCursor) {
      const cursor = encodeURIComponent(json.pageInfo.prevCursor);
      ({ json } = await get(`/entities/by-query?cursor=${cursor}&limit=4`));
      back.unshift(names(json.items));
    }
    expect(back).toEqual(pages.slice(0, -1));
  });

  it('honours a global offset and descending order', async () => {
    const { json } = await get(
      '/entities/by-query?filter=kind=component&orderField=metadata.name,desc&offset=2&limit=4',
    );
    const expected = names(components).sort().reverse().slice(2, 6);
    expect(names(json.items)).toEqual(expected);
    expect(json.pageInfo.prevCursor).toBeDefined();
  });

  it('returns only the requested fields after merging', async () => {
    const { json } = await get(
      '/entities/by-query?filter=kind=component&orderField=metadata.name,asc&fields=metadata.name&limit=2',
    );
    expect(json.items).toEqual([
      { metadata: { name: 'artist-lookup' } },
      { metadata: { name: 'billing' } },
    ]);
  });

  it('sums totals for count-only queries', async () => {
    const { json } = await get(
      '/entities/by-query?filter=kind=component&limit=0',
    );
    expect(json).toEqual({
      items: [],
      totalItems: components.length,
      pageInfo: {},
    });
  });

  it('keeps cursor follow-ups on POST for predicate queries', async () => {
    const post = (body: object) =>
      get('/entities/by-query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    let { json } = await post({
      query: { kind: { $in: ['component', 'api'] } },
      orderBy: [{ field: 'metadata.name', order: 'asc' }],
      limit: 4,
    });
    const seen = names(json.items);
    // CatalogClient switches to POST when the decoded cursor has `query`
    expect('query' in decodeCursor(json.pageInfo.nextCursor)!).toBe(true);
    while (json.pageInfo.nextCursor) {
      ({ json } = await post({ cursor: json.pageInfo.nextCursor, limit: 4 }));
      seen.push(...names(json.items));
    }
    expect(seen).toEqual(
      [...payments, ...fallback]
        .filter(e => ['Component', 'API'].includes(e.kind))
        .map(e => e.metadata.name)
        .sort(),
    );
  });

  it('merges the legacy list endpoint and paginates it', async () => {
    const all = await get('/entities?filter=kind=component');
    expect(names(all.json)).toEqual(
      components
        .sort((a, b) => a.metadata.uid.localeCompare(b.metadata.uid))
        .map(e => e.metadata.name),
    );
    const { res, json } = await get(
      '/entities?filter=kind=component&order=asc:metadata.name&offset=2&limit=3',
    );
    expect(names(json)).toEqual(names(components).sort().slice(2, 5));
    expect(res.headers.get('link')).toMatch(/after=.*rel="next"/);
  });

  it('splits by-refs per owning shard and keeps request order', async () => {
    const { res, json } = await get('/entities/by-refs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entityRefs: [
          'component:payments/ledger',
          'group:default/team-b',
          'component:default/missing',
          'component:default/docs',
        ],
      }),
    });
    expect(res.headers.get('x-catalog-shards')).toBe('org,payments,default');
    expect(
      json.items.map((e: Entity | null) => e?.metadata.name ?? null),
    ).toEqual(['ledger', 'team-b', null, 'docs']);
  });

  it('sums facet counts across shards', async () => {
    const { json } = await get('/entity-facets?facet=kind');
    expect(json.facets.kind).toEqual([
      { value: 'API', count: 1 },
      { value: 'Component', count: 9 },
      { value: 'Group', count: 2 },
      { value: 'Template', count: 1 },
      { value: 'User', count: 1 },
    ]);
  });

  it('serves the union of every shard signing key', async () => {
    const { json } = await get('/.backstage/auth/v1/jwks.json');
    expect(json.keys.map((k: { kid: string }) => k.kid).sort()).toEqual([
      'key-default',
      'key-org',
      'key-payments',
    ]);
  });

  it('sends entity lookups straight to the owning shard', async () => {
    const { res, json } = await get(
      '/entities/by-name/component/payments/ledger',
    );
    expect(res.headers.get('x-catalog-shards')).toBe('payments');
    expect(json.metadata.name).toBe('ledger');
  });

  it('lets a client pin a request to a shard', async () => {
    const { res, json } = await get('/entities?filter=kind=component', {
      headers: { 'x-catalog-shard': 'payments' },
    });
    expect(res.headers.get('x-catalog-route')).toBe('pinned');
    expect(json).toHaveLength(3);
    const bad = await fetch(`${base}/entities`, {
      headers: { 'x-catalog-shard': 'nope' },
    });
    expect(bad.status).toBe(400);
  });

  it('fails a fan-out with 502 when a shard is down', async () => {
    const topology = readTopology({
      shards: [
        {
          name: 'up',
          target: base.replace('/api/catalog', '/unused'),
          match: { kinds: ['group'] },
        },
        { name: 'down', target: 'http://127.0.0.1:1/api/catalog' },
      ],
    });
    const lonely = createServer({
      topology,
      client: new ShardClient({ timeoutMs: 1000 }),
      logger: createLogger('error'),
      basePath: '/api/catalog',
    });
    await new Promise<void>(r => lonely.listen(0, '127.0.0.1', r));
    const port = (lonely.address() as AddressInfo).port;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/catalog/entities/by-name/component/default/x`,
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error.name).toBe('BadGatewayError');
    lonely.closeAllConnections();
    await new Promise(r => lonely.close(r));
  });
});
