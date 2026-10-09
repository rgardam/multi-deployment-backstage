import {
  Shard,
  constraintsFromFilterParams,
  constraintsFromPredicate,
  ownerOf,
  parseRef,
} from '@internal/catalog-sharding';
import { RequestContext } from './context';
import { decodeCursor, encodeCursor, isLocationsCursor } from './cursor';
import {
  HttpError,
  UpstreamResponseError,
  parseJson,
  responseHeaders,
  sendJson,
  sendRaw,
} from './http';
import { FacetsResponse, mergeFacets } from './merge';
import { ShardRequest, ShardResponse } from './shardClient';

const JSON_HEADERS = { 'content-type': 'application/json' };

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'InputError', `Malformed path segment ${segment}`);
  }
}

function ownerOfRef(ctx: RequestContext, ref: unknown): Shard | undefined {
  if (typeof ref !== 'string') {
    return undefined;
  }
  const { kind, namespace } = parseRef(ref);
  return kind ? ownerOf(ctx.topology, kind, namespace) : undefined;
}

/** Parses every response as JSON, relaying the first failure unchanged. */
function jsonBodies<T>(responses: readonly ShardResponse[]): T[] {
  const failed = responses.find(r => r.status < 200 || r.status >= 300);
  if (failed) {
    throw new UpstreamResponseError(
      failed.shard.name,
      failed.status,
      failed.headers,
      failed.body,
    );
  }
  return responses.map(r => parseJson(r.body) as T);
}

function relay(ctx: RequestContext, response: ShardResponse): void {
  sendRaw(
    ctx.res,
    response.status,
    responseHeaders(response.headers, ctx.routingHeaders()),
    response.body,
  );
}

/**
 * Plugin tokens issued by any shard must verify against the catalog's JWKS,
 * whichever shard a verifier's request lands on, so serve the union of keys.
 */
export async function jwks(ctx: RequestContext): Promise<void> {
  const shards = ctx.pinned ? [ctx.pinned] : [...ctx.topology.shards];
  ctx.served('fanout', shards);
  const results = await Promise.allSettled(
    shards.map(shard =>
      ctx.client.requestJson<{ keys?: Array<{ kid?: string }> }>(shard, {
        method: 'GET',
        path: '/.backstage/auth/v1/jwks.json',
        headers: ctx.upstreamHeaders(),
      }),
    ),
  );
  const keys = new Map<string, unknown>();
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      for (const key of result.value.json.keys ?? []) {
        keys.set(key.kid ?? JSON.stringify(key), key);
      }
    } else {
      ctx.deps.logger.warn('Could not read JWKS from catalog shard', {
        shard: shards[i].name,
        error: String(result.reason),
      });
    }
  });
  if (results.every(r => r.status === 'rejected')) {
    throw new HttpError(
      502,
      'BadGatewayError',
      'No catalog shard served its JWKS',
    );
  }
  sendJson(ctx.res, 200, { keys: [...keys.values()] }, ctx.routingHeaders());
}

export async function facetsGet(ctx: RequestContext): Promise<void> {
  const shards = ctx.candidates(
    constraintsFromFilterParams(ctx.params.getAll('filter')),
  );
  if (shards.length === 1) {
    await ctx.forward(shards[0]);
    return;
  }
  const responses = await ctx.fanOut(shards, () => ({
    method: 'GET',
    path: '/entity-facets',
    query: ctx.rawQuery,
    headers: ctx.upstreamHeaders(),
  }));
  sendJson(
    ctx.res,
    200,
    mergeFacets(jsonBodies<FacetsResponse>(responses)),
    ctx.routingHeaders(),
  );
}

export async function facetsPost(ctx: RequestContext): Promise<void> {
  const raw = await ctx.body();
  const body = parseJson(raw) as { query?: unknown } | undefined;
  const shards = ctx.candidates(constraintsFromPredicate(body?.query));
  if (shards.length === 1) {
    await ctx.forward(shards[0], { body: raw });
    return;
  }
  const responses = await ctx.fanOut(shards, () => ({
    method: 'POST',
    path: '/entity-facets',
    headers: ctx.upstreamHeaders(JSON_HEADERS),
    body: raw,
  }));
  sendJson(
    ctx.res,
    200,
    mergeFacets(jsonBodies<FacetsResponse>(responses)),
    ctx.routingHeaders(),
  );
}

/**
 * Splits the refs by owning shard, asks each shard for its own refs, and puts
 * the answers back in request order. Refs without a single owner (local kinds)
 * are asked of every shard; the first hit wins.
 */
export async function entitiesByRefs(ctx: RequestContext): Promise<void> {
  const raw = await ctx.body();
  const body = parseJson(raw) as
    | { entityRefs?: unknown[]; [key: string]: unknown }
    | undefined;
  const refs = body?.entityRefs;
  if (ctx.pinned || !Array.isArray(refs) || !refs.length) {
    await ctx.forward(ctx.defaultShard, { body: raw });
    return;
  }

  const owners = refs.map(ref => ownerOfRef(ctx, ref));
  const shards = ctx.topology.shards.filter(shard =>
    owners.some(owner => owner === undefined || owner === shard),
  );
  if (shards.length === 1) {
    await ctx.forward(shards[0], { body: raw });
    return;
  }

  const indices = shards.map(shard =>
    owners.flatMap((owner, i) =>
      owner === undefined || owner === shard ? [i] : [],
    ),
  );
  const responses = await ctx.fanOut(shards, (_shard, k) => ({
    method: 'POST',
    path: '/entities/by-refs',
    query: ctx.rawQuery,
    headers: ctx.upstreamHeaders(JSON_HEADERS),
    body: Buffer.from(
      JSON.stringify({ ...body, entityRefs: indices[k].map(i => refs[i]) }),
    ),
  }));

  const items: unknown[] = refs.map(() => null);
  jsonBodies<{ items: unknown[] }>(responses).forEach((json, k) => {
    indices[k].forEach((refIndex, j) => {
      if (items[refIndex] === null && json.items?.[j]) {
        items[refIndex] = json.items[j];
      }
    });
  });
  sendJson(ctx.res, 200, { items }, ctx.routingHeaders());
}

/**
 * Sends the request to every shard and returns the first success, for lookups
 * by an id that does not say which shard owns it (uids, location ids).
 */
export async function firstFound(ctx: RequestContext): Promise<void> {
  if (ctx.pinned) {
    await ctx.forward(ctx.pinned);
    return;
  }
  const body = ['GET', 'HEAD', 'DELETE'].includes(ctx.method)
    ? undefined
    : await ctx.body();
  const shards = [...ctx.topology.shards];
  const responses = await ctx.fanOut(shards, () => ({
    method: ctx.method,
    path: ctx.path,
    query: ctx.rawQuery,
    headers: ctx.upstreamHeaders(body ? JSON_HEADERS : {}),
    body,
  }));
  const chosen =
    responses.find(r => r.status >= 200 && r.status < 300) ??
    responses.find(r => r.status !== 404) ??
    responses[responses.length - 1];
  ctx.served('fanout', [chosen.shard]);
  relay(ctx, chosen);
}

/** /entities/by-name/:kind/:namespace/:name(/ancestry) and /locations/by-entity/... */
export async function byName(
  ctx: RequestContext,
  match: RegExpExecArray,
): Promise<void> {
  const owner =
    ctx.pinned ?? ownerOf(ctx.topology, decode(match[1]), decode(match[2]));
  if (owner) {
    await ctx.forward(owner);
    return;
  }
  await firstFound(ctx);
}

export async function listLocations(ctx: RequestContext): Promise<void> {
  const shards = ctx.pinned ? [ctx.pinned] : [...ctx.topology.shards];
  const responses = await ctx.fanOut(shards, () => ({
    method: 'GET',
    path: '/locations',
    query: ctx.rawQuery,
    headers: ctx.upstreamHeaders(),
  }));
  sendJson(
    ctx.res,
    200,
    jsonBodies<unknown[]>(responses).flat(),
    ctx.routingHeaders(),
  );
}

/**
 * The owner of a new location isn't in the request: it depends on the
 * entities the location contains. Each shard's guard rejects entities it does
 * not own, so a dry run on every shard reveals the one that accepts them all.
 */
export async function createLocation(ctx: RequestContext): Promise<void> {
  const raw = await ctx.body();
  if (ctx.pinned || ctx.topology.shards.length === 1) {
    await ctx.forward(ctx.defaultShard, { body: raw });
    return;
  }
  const params = ctx.params;
  const isDryRun = /^(true|1|yes|y)$/i.test(params.get('dryRun') ?? '');
  params.set('dryRun', 'true');

  const shards = [...ctx.topology.shards];
  const trials = await ctx.fanOut(shards, () => ({
    method: 'POST',
    path: '/locations',
    query: params.toString(),
    headers: ctx.upstreamHeaders(JSON_HEADERS),
    body: raw,
  }));
  const accepted = trials.filter(r => r.status === 201);
  if (!accepted.length) {
    // Nobody accepts every entity: either the location is broken (all shards
    // agree) or it mixes entities owned by different shards. The catch-all's
    // error names the entities and their owning shards.
    ctx.served('fanout', shards);
    relay(ctx, trials[trials.length - 1]);
    return;
  }
  // Locations holding only local kinds are accepted everywhere: use the catch-all
  const owner =
    accepted.length === 1
      ? accepted[0]
      : accepted.find(r => r.shard === ctx.topology.catchAll) ?? accepted[0];
  if (isDryRun) {
    ctx.served('single', [owner.shard]);
    relay(ctx, owner);
    return;
  }
  await ctx.forward(owner.shard, { body: raw });
}

interface LocationsPage {
  items: unknown[];
  totalItems: number;
  pageInfo: { nextCursor?: string };
}

/** POST /locations/by-query: pages through the shards one after the other. */
export async function queryLocations(ctx: RequestContext): Promise<void> {
  const raw = await ctx.body();
  if (ctx.pinned || ctx.topology.shards.length === 1) {
    await ctx.forward(ctx.defaultShard, { body: raw });
    return;
  }
  const body = (parseJson(raw) ?? {}) as {
    cursor?: string;
    limit?: number;
    [key: string]: unknown;
  };
  const shards = [...ctx.topology.shards];
  const request = (payload: object): ShardRequest => ({
    method: 'POST',
    path: '/locations/by-query',
    headers: ctx.upstreamHeaders(JSON_HEADERS),
    body: Buffer.from(JSON.stringify(payload)),
  });

  let index = 0;
  let nativeCursor: string | undefined;
  let initial: Record<string, unknown>;
  let totalItems: number;
  let limit = body.limit;

  if (body.cursor) {
    const cursor = decodeCursor(body.cursor);
    if (!cursor || !isLocationsCursor(cursor)) {
      throw new HttpError(400, 'InputError', 'Malformed cursor');
    }
    ({ index, totalItems, body: initial } = cursor);
    nativeCursor = cursor.cursor;
    limit = limit ?? (initial.limit as number | undefined);
  } else {
    // Totals come from every shard up front; pages are then served in order
    initial = { ...body };
    delete initial.cursor;
    const counts = jsonBodies<LocationsPage>(
      await ctx.fanOut(shards, () => request({ ...initial, limit: 1 })),
    );
    totalItems = counts.reduce((sum, page) => sum + (page.totalItems ?? 0), 0);
  }

  const wanted = limit ?? 20;
  const items: unknown[] = [];
  let next: { index: number; cursor?: string } | undefined;
  while (index < shards.length && items.length < wanted) {
    const payload = nativeCursor
      ? { cursor: nativeCursor, limit: wanted - items.length }
      : { ...initial, limit: wanted - items.length };
    const [page] = jsonBodies<LocationsPage>([
      await ctx.client.request(shards[index], request(payload)),
    ]);
    items.push(...(page.items ?? []));
    nativeCursor = page.pageInfo?.nextCursor;
    if (!nativeCursor) {
      index++;
    }
    next =
      nativeCursor || index < shards.length
        ? { index, cursor: nativeCursor }
        : undefined;
  }
  ctx.served('fanout', shards);
  sendJson(
    ctx.res,
    200,
    {
      items,
      totalItems,
      pageInfo: next
        ? {
            nextCursor: encodeCursor({
              locations: true,
              shards: shards.map(s => s.name),
              ...next,
              body: { ...initial, limit: wanted },
              totalItems,
            }),
          }
        : {},
    },
    ctx.routingHeaders(),
  );
}

export async function refresh(ctx: RequestContext): Promise<void> {
  const raw = await ctx.body();
  const body = parseJson(raw) as { entityRef?: unknown } | undefined;
  const owner = ctx.pinned ?? ownerOfRef(ctx, body?.entityRef);
  if (owner) {
    await ctx.forward(owner, { body: raw });
    return;
  }
  await firstFound(ctx);
}

export async function validateEntity(ctx: RequestContext): Promise<void> {
  const raw = await ctx.body();
  const body = parseJson(raw) as
    | { entity?: { kind?: unknown; metadata?: { namespace?: unknown } } }
    | undefined;
  const kind = body?.entity?.kind;
  const namespace = body?.entity?.metadata?.namespace;
  const owner =
    ctx.pinned ??
    (typeof kind === 'string'
      ? ownerOf(
          ctx.topology,
          kind,
          typeof namespace === 'string' ? namespace : undefined,
        )
      : undefined) ??
    ctx.topology.catchAll;
  await ctx.forward(owner, { body: raw });
}

interface ConditionItem {
  id: string;
  resourceRef: string | string[];
  [key: string]: unknown;
}

/**
 * Permission conditions are evaluated where the resource lives. Items are
 * split into one ref each, sent to the owning shard, and reassembled.
 */
export async function applyConditions(ctx: RequestContext): Promise<void> {
  const raw = await ctx.body();
  const body = parseJson(raw) as { items?: ConditionItem[] } | undefined;
  if (ctx.pinned || !Array.isArray(body?.items)) {
    await ctx.forward(ctx.defaultShard, { body: raw });
    return;
  }
  const items = body!.items!;
  const parts = items.flatMap((item, i) =>
    [item.resourceRef].flat().map((ref, j) => ({
      id: `${i}:${j}`,
      item,
      ref,
      shard: ownerOfRef(ctx, ref) ?? ctx.topology.catchAll,
    })),
  );
  const shards = ctx.topology.shards.filter(s =>
    parts.some(p => p.shard === s),
  );
  if (shards.length === 1) {
    await ctx.forward(shards[0], { body: raw });
    return;
  }

  const responses = await ctx.fanOut(shards, shard => ({
    method: 'POST',
    path: ctx.path,
    headers: ctx.upstreamHeaders(JSON_HEADERS),
    body: Buffer.from(
      JSON.stringify({
        items: parts
          .filter(p => p.shard === shard)
          .map(({ id, item, ref }) => ({ ...item, id, resourceRef: ref })),
      }),
    ),
  }));
  const results = new Map<string, unknown>();
  for (const json of jsonBodies<{
    items: Array<{ id: string; result: unknown }>;
  }>(responses)) {
    json.items.forEach(({ id, result }) => results.set(id, result));
  }
  sendJson(
    ctx.res,
    200,
    {
      items: items.map((item, i) => ({
        id: item.id,
        result: Array.isArray(item.resourceRef)
          ? item.resourceRef.map((_, j) => results.get(`${i}:${j}`))
          : results.get(`${i}:0`),
      })),
    },
    ctx.routingHeaders(),
  );
}
