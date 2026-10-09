#!/usr/bin/env node
/*
 * Smoke test for the running stack: gateway routing, catalog sharding and
 * fan-out, cross-backend auth (plugin tokens, permissions), search and the
 * frontend's runtime config. Zero dependencies; needs Node 22+.
 *
 *   node scripts/smoke.mjs [http://localhost:8080]
 */
const base = (process.argv[2] ?? 'http://localhost:8080').replace(/\/$/, '');
let token;
let failures = 0;

async function request(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    res,
    json,
    text,
    route: res.headers.get('x-catalog-route'),
    shards: res.headers.get('x-catalog-shards'),
  };
}

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ok    ${name}${detail ? `  (${detail})` : ''}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function eventually(fn, { timeoutMs = 90_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
}

const names = items =>
  items.map(
    e => `${e.kind.toLowerCase()}:${e.metadata.namespace}/${e.metadata.name}`,
  );

console.log(`Smoke testing ${base}\n`);

console.log('gateway and frontend');
await check('gateway answers /healthz', async () => {
  const { res } = await request('/healthz');
  expect(res.ok, `status ${res.status}`);
});
await check('frontend is served with runtime config injected', async () => {
  const { res, text } = await request('/catalog');
  expect(res.ok, `status ${res.status}`);
  expect(
    text.includes('type="backstage.io/config"'),
    'no runtime config script tag in index.html',
  );
  expect(
    text.includes(`"baseUrl":"${base}"`),
    `runtime config does not point at ${base}`,
  );
});

console.log(
  '\nauth (backend-core), resolving the user in the org catalog shard',
);
await check('guest sign-in issues a token for user:default/guest', async () => {
  const { res, json } = await request('/api/auth/guest/refresh', {
    method: 'POST',
  });
  expect(res.ok, `status ${res.status}: ${JSON.stringify(json)}`);
  token = json.backstageIdentity.token;
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString(),
  );
  expect(claims.sub === 'user:default/guest', `sub is ${claims.sub}`);
  // Group membership comes from the user entity's relations in the org shard
  const ownership = json.backstageIdentity.identity.ownershipEntityRefs;
  expect(ownership.includes('group:default/guests'), `ownership ${ownership}`);
  return `ownership=${ownership.join(',')}`;
});

console.log('\ncatalog: routed by the catalog router from the request itself');
await check('kind=group is answered by the org shard alone', async () => {
  const r = await request('/api/catalog/entities/by-query?filter=kind=group');
  expect(r.res.ok, `status ${r.res.status}: ${r.text}`);
  expect(
    r.route === 'single' && r.shards === 'org',
    `route=${r.route} shards=${r.shards}`,
  );
  expect(
    r.json.items.length === 3,
    `expected 3 groups, got ${r.json.items.length}`,
  );
  return `route=${r.route} shards=${r.shards}`;
});
await check(
  'a component in the payments namespace is fetched from that shard',
  async () => {
    const r = await request(
      '/api/catalog/entities/by-name/component/payments/ledger',
    );
    expect(r.res.ok, `status ${r.res.status}`);
    expect(r.shards === 'payments', `shards=${r.shards}`);
    return `shards=${r.shards}`;
  },
);
await check(
  'kind=component fans out and pages across shards with one cursor',
  async () => {
    const seen = [];
    let r = await request(
      '/api/catalog/entities/by-query?filter=kind=component&orderField=metadata.name,asc&limit=2',
    );
    expect(
      r.route === 'fanout' && r.shards === 'payments,default',
      `route=${r.route} shards=${r.shards}`,
    );
    const total = r.json.totalItems;
    seen.push(...names(r.json.items));
    while (r.json.pageInfo.nextCursor) {
      r = await request(
        `/api/catalog/entities/by-query?cursor=${encodeURIComponent(
          r.json.pageInfo.nextCursor,
        )}&limit=2`,
      );
      expect(r.res.ok, `status ${r.res.status}: ${r.text}`);
      seen.push(...names(r.json.items));
    }
    const sorted = [...seen].sort((a, b) =>
      a.split('/')[1].localeCompare(b.split('/')[1]),
    );
    expect(
      seen.length === total && new Set(seen).size === total,
      `saw ${seen.length} of ${total}`,
    );
    expect(
      JSON.stringify(seen) === JSON.stringify(sorted),
      `not globally sorted: ${seen}`,
    );
    return `${total} components from 2 shards, globally sorted`;
  },
);
await check(
  'the legacy list endpoint (GET /entities) merges every shard',
  async () => {
    const r = await request(
      '/api/catalog/entities?fields=kind,metadata.name,metadata.namespace',
    );
    expect(r.res.ok, `status ${r.res.status}`);
    const kinds = new Set(r.json.map(e => e.kind));
    for (const kind of ['User', 'Group', 'Component', 'API', 'Template']) {
      expect(kinds.has(kind), `missing kind ${kind}`);
    }
    return `${r.json.length} entities, shards=${r.shards}`;
  },
);
await check('facets are summed across shards', async () => {
  const r = await request('/api/catalog/entity-facets?facet=kind');
  const kinds = Object.fromEntries(
    r.json.facets.kind.map(f => [f.value, f.count]),
  );
  expect(kinds.Component === 6 && kinds.Group === 3, JSON.stringify(kinds));
  return JSON.stringify(kinds);
});
await check(
  'by-refs is split per owning shard and reassembled in order',
  async () => {
    const refs = [
      'group:default/team-payments',
      'component:payments/ledger',
      'component:default/service-gateway',
      'component:default/nope',
    ];
    const r = await request('/api/catalog/entities/by-refs', {
      method: 'POST',
      body: JSON.stringify({ entityRefs: refs }),
    });
    expect(r.res.ok, `status ${r.res.status}`);
    const got = r.json.items.map(e =>
      e
        ? `${e.kind.toLowerCase()}:${e.metadata.namespace}/${e.metadata.name}`
        : null,
    );
    expect(
      JSON.stringify(got) === JSON.stringify([...refs.slice(0, 3), null]),
      JSON.stringify(got),
    );
    return `shards=${r.shards}`;
  },
);
await check(
  'cross-shard ownership: team-payments owns entities in the payments shard',
  async () => {
    const r = await request(
      '/api/catalog/entities?filter=relations.ownedBy=group:default/team-payments&fields=kind,metadata.name',
    );
    expect(r.json.length >= 6, `owned entities: ${r.json.length}`);
    return `${r.json.length} entities, shards=${r.shards}`;
  },
);
await check('every shard signing key is published on one JWKS', async () => {
  // Unauthenticated, exactly like a verifying plugin fetches it
  const res = await fetch(`${base}/api/catalog/.backstage/auth/v1/jwks.json`);
  const shards = res.headers.get('x-catalog-shards');
  expect(
    res.ok && shards === 'org,payments,default',
    `status ${res.status} shards=${shards}`,
  );
  return `${(await res.json()).keys.length} keys from shards=${shards}`;
});

console.log('\ncatalog: explicit shard selection at the gateway (?shard=)');
await check(
  '?shard=org goes straight to the org shard, bypassing the router',
  async () => {
    const r = await request(
      '/api/catalog/entities/by-query?filter=kind=component&shard=org',
    );
    expect(r.res.ok, `status ${r.res.status}: ${r.text}`);
    expect(r.route === null, `went through the router (route=${r.route})`);
    expect(
      r.json.totalItems === 0,
      `org shard returned ${r.json.totalItems} components`,
    );
    return `upstream=${r.res.headers.get('x-upstream-addr')}`;
  },
);
await check(
  'the shard guard rejects entities owned by another shard',
  async () => {
    const body = {
      entity: {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Group',
        metadata: { name: 'x' },
        spec: { type: 'team', children: [] },
      },
      location: 'url:https://example.com/catalog-info.yaml',
    };
    const r = await request('/api/catalog/validate-entity?shard=default', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(
      r.res.status === 400 && r.text.includes("belongs to catalog shard 'org'"),
      `status ${r.res.status}: ${r.text}`,
    );
  },
);

console.log('\nother backends, reached through the gateway');
await check(
  'search (backend-search) indexed entities from every shard',
  async () =>
    eventually(async () => {
      const r = await request('/api/search/query?term=payments');
      expect(r.res.ok, `status ${r.res.status}`);
      const locations = r.json.results.map(x => x.document.location);
      expect(
        locations.some(l => l.includes('/payments/')),
        `no payments-shard results yet: ${locations}`,
      );
      const all = await request('/api/search/query?term=platform');
      expect(
        all.json.results.some(x => x.document.location.includes('/default/')),
        'no default-shard results yet',
      );
      return `${r.json.results.length} hits for "payments"`;
    }),
);
await check(
  'templates (backend-scaffolder) are listed from the catalog',
  async () => {
    const r = await request(
      '/api/catalog/entities/by-query?filter=kind=template',
    );
    expect(
      r.json.items.some(t => t.metadata.name === 'example-nodejs-template'),
      'template missing',
    );
    const actions = await request('/api/scaffolder/v2/actions');
    expect(actions.res.ok, `actions status ${actions.res.status}`);
    return `${actions.json.length} scaffolder actions, template via shards=${r.shards}`;
  },
);
await check(
  'techdocs (backend-techdocs) builds docs for an entity in the default shard',
  async () => {
    await fetch(`${base}/api/techdocs/sync/default/component/platform-docs`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
      },
    }).then(r => r.text());
    return eventually(async () => {
      const r = await request(
        '/api/techdocs/static/docs/default/component/platform-docs/index.html',
      );
      expect(
        r.res.ok && r.text.includes('Developer platform'),
        `status ${r.res.status}`,
      );
      return 'generated with MkDocs';
    });
  },
);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
