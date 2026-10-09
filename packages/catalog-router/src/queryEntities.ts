/*
 * GET and POST /entities/by-query.
 *
 * Single shard: the request is relayed and the shard's cursors are wrapped so
 * follow-up pages find their way back to the same shard.
 *
 * Several shards: every page is a k-way merge of per-shard windows. The
 * cursor records, per shard, how many items earlier pages consumed, so the
 * next page asks each shard for `limit` items from its own offset. A previous
 * page is rebuilt by merging the `limit` items before each shard's offset and
 * keeping the last `limit` of them.
 */
import {
  Shard,
  constraintsFromFilterParams,
  constraintsFromPredicate,
} from '@internal/catalog-sharding';
import { RequestContext } from './context';
import {
  FanoutCursor,
  decodeCursor,
  encodeCursor,
  isShardCursor,
  wrapShardCursor,
} from './cursor';
import { HttpError, parseJson, sendJson } from './http';
import {
  OrderSpec,
  countSources,
  fieldsForShards,
  mergeSorted,
  parseFields,
  projectFields,
  queryComparator,
} from './merge';

/** The catalog's default page size for by-query. */
const DEFAULT_LIMIT = 200;

/** GET parameters that define the query itself and are replayed per page. */
const QUERY_PARAMS = [
  'filter',
  'orderField',
  'fullTextFilterTerm',
  'fullTextFilterFields',
];

interface QueryResponse {
  items: unknown[];
  totalItems?: number;
  pageInfo?: { nextCursor?: string; prevCursor?: string };
}

interface Window {
  items: unknown[];
  totalItems: number;
  hasMore: boolean;
}

/** How to fetch a slice of the query from one shard, in GET or POST form. */
interface Flavour {
  order?: OrderSpec;
  cursorState: Pick<
    FanoutCursor,
    'params' | 'query' | 'orderBy' | 'fullTextFilter'
  >;
  window(
    shard: Shard,
    offset: number,
    limit: number,
    withTotal: boolean,
  ): Promise<Window>;
}

function parseOrderField(value?: string): OrderSpec | undefined {
  if (!value) {
    return undefined;
  }
  const comma = value.lastIndexOf(',');
  const field = comma === -1 ? value : value.slice(0, comma);
  const order = comma === -1 ? 'asc' : value.slice(comma + 1).trim();
  return { field: field.trim(), order: order === 'desc' ? 'desc' : 'asc' };
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_LIMIT;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0) {
    throw new HttpError(400, 'InputError', `Invalid limit "${value}"`);
  }
  return limit;
}

function parseOffset(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return 0;
  }
  const offset = Number(value);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new HttpError(400, 'InputError', `Invalid offset "${value}"`);
  }
  return offset;
}

function neededFields(order?: OrderSpec): string[] {
  return order ? [order.field, 'metadata.uid'] : ['metadata.uid'];
}

function getFlavour(
  ctx: RequestContext,
  params: Record<string, string[]>,
  clientFields?: string[],
): Flavour {
  const order = parseOrderField(params.orderField?.[0]);
  const shardFields = fieldsForShards(clientFields, neededFields(order));
  return {
    order,
    cursorState: { params },
    async window(shard, offset, limit, withTotal) {
      const query = new URLSearchParams();
      for (const [key, values] of Object.entries(params)) {
        values.forEach(v => query.append(key, v));
      }
      if (shardFields) {
        query.set('fields', shardFields.join(','));
      }
      query.set('offset', String(offset));
      query.set('limit', String(limit));
      query.set('totalItems', withTotal ? 'include' : 'exclude');
      const { json } = await ctx.client.requestJson<QueryResponse>(shard, {
        method: 'GET',
        path: '/entities/by-query',
        query: query.toString(),
        headers: ctx.upstreamHeaders(),
      });
      return {
        items: json.items ?? [],
        totalItems: json.totalItems ?? 0,
        hasMore: Boolean(json.pageInfo?.nextCursor),
      };
    },
  };
}

function postFlavour(
  ctx: RequestContext,
  state: Pick<FanoutCursor, 'query' | 'orderBy' | 'fullTextFilter'>,
  clientFields?: string[],
): Flavour {
  const order = state.orderBy?.[0];
  const shardFields = fieldsForShards(clientFields, neededFields(order));
  return {
    order,
    // `query` must be present (even as null) so CatalogClient keeps using POST
    cursorState: { ...state, query: state.query ?? null },
    async window(shard, offset, limit, withTotal) {
      const body = {
        ...(state.query !== undefined && state.query !== null
          ? { query: state.query }
          : {}),
        ...(state.orderBy ? { orderBy: state.orderBy } : {}),
        ...(state.fullTextFilter
          ? { fullTextFilter: state.fullTextFilter }
          : {}),
        ...(shardFields ? { fields: shardFields } : {}),
        offset,
        limit,
        totalItems: withTotal ? 'include' : 'exclude',
      };
      const { json } = await ctx.client.requestJson<QueryResponse>(shard, {
        method: 'POST',
        path: '/entities/by-query',
        headers: ctx.upstreamHeaders({ 'content-type': 'application/json' }),
        body: Buffer.from(JSON.stringify(body)),
      });
      return {
        items: json.items ?? [],
        totalItems: json.totalItems ?? 0,
        hasMore: Boolean(json.pageInfo?.nextCursor),
      };
    },
  };
}

interface PageState {
  shards: Shard[];
  limit: number;
  clientFields?: string[];
  totalItems?: number;
}

function respondWithPage(
  ctx: RequestContext,
  flavour: Flavour,
  state: PageState,
  items: unknown[],
  start: number[],
  end: number[] | undefined,
): void {
  const base = {
    shards: state.shards.map(s => s.name),
    ...(state.totalItems !== undefined ? { totalItems: state.totalItems } : {}),
    ...flavour.cursorState,
  };
  const pageInfo: QueryResponse['pageInfo'] = {};
  if (end) {
    pageInfo.nextCursor = encodeCursor({ ...base, offsets: end, dir: 'next' });
  }
  if (start.some(offset => offset > 0)) {
    pageInfo.prevCursor = encodeCursor({
      ...base,
      offsets: start,
      dir: 'prev',
    });
  }
  sendJson(
    ctx.res,
    200,
    {
      items: state.clientFields
        ? items.map(item => projectFields(item, state.clientFields!))
        : items,
      totalItems: state.totalItems ?? 0,
      pageInfo,
    },
    ctx.routingHeaders(),
  );
}

/** A page starting at the given per-shard offsets (or a global offset). */
async function forwardPage(
  ctx: RequestContext,
  flavour: Flavour,
  state: PageState,
  from: { offsets: number[] } | { globalOffset: number; withTotal: boolean },
): Promise<void> {
  const { shards, limit } = state;
  const compare = queryComparator(flavour.order);
  ctx.served('fanout', shards);

  const skip = 'globalOffset' in from ? from.globalOffset : 0;
  const withTotal = 'withTotal' in from && from.withTotal;
  const windows = await Promise.all(
    shards.map((shard, i) =>
      'offsets' in from
        ? flavour.window(shard, from.offsets[i], limit, false)
        : flavour.window(shard, 0, skip + limit, withTotal),
    ),
  );

  const base = 'offsets' in from ? from.offsets : shards.map(() => 0);
  const merged = mergeSorted(
    windows.map(w => w.items),
    compare,
  );
  const before = countSources(merged.sources, shards.length, 0, skip);
  const taken = countSources(merged.sources, shards.length, 0, skip + limit);
  const start = base.map((offset, i) => offset + before[i]);
  const end = base.map((offset, i) => offset + taken[i]);
  const hasMore = windows.some(
    (w, i) => taken[i] < w.items.length || w.hasMore,
  );

  if (withTotal) {
    state.totalItems = windows.reduce((sum, w) => sum + w.totalItems, 0);
  }
  respondWithPage(
    ctx,
    flavour,
    state,
    merged.items.slice(skip, skip + limit),
    start,
    hasMore && limit > 0 ? end : undefined,
  );
}

/** The page that ends where the given per-shard offsets begin. */
async function backwardPage(
  ctx: RequestContext,
  flavour: Flavour,
  state: PageState,
  end: number[],
): Promise<void> {
  const { shards, limit } = state;
  ctx.served('fanout', shards);

  const starts = end.map(offset => Math.max(0, offset - limit));
  const windows = await Promise.all(
    shards.map((shard, i) =>
      end[i] > starts[i]
        ? flavour.window(shard, starts[i], end[i] - starts[i], false)
        : Promise.resolve({ items: [], totalItems: 0, hasMore: true }),
    ),
  );
  const merged = mergeSorted(
    windows.map(w => w.items),
    queryComparator(flavour.order),
  );
  const from = Math.max(0, merged.items.length - limit);
  const taken = countSources(
    merged.sources,
    shards.length,
    from,
    merged.items.length,
  );
  const start = end.map((offset, i) => offset - taken[i]);

  if (start.every(offset => offset === 0)) {
    // Reached the beginning: serve a full first page, like a fresh query would
    await forwardPage(ctx, flavour, state, { offsets: start });
    return;
  }
  respondWithPage(ctx, flavour, state, merged.items.slice(from), start, end);
}

async function continueFanout(
  ctx: RequestContext,
  cursor: FanoutCursor,
  flavour: Flavour,
  limit: number,
  clientFields?: string[],
): Promise<void> {
  const shards = cursor.shards.map(name => {
    const shard = ctx.topology.get(name);
    if (!shard) {
      throw new HttpError(
        400,
        'InputError',
        `Cursor refers to unknown catalog shard '${name}'; the shard topology changed, restart the query`,
      );
    }
    return shard;
  });
  const state = { shards, limit, clientFields, totalItems: cursor.totalItems };
  if (cursor.dir === 'prev') {
    await backwardPage(ctx, flavour, state, cursor.offsets);
  } else {
    await forwardPage(ctx, flavour, state, { offsets: cursor.offsets });
  }
}

/** Relays a single-shard request, rewriting cursors to point back at it. */
async function relaySingle(
  ctx: RequestContext,
  shard: Shard,
  request: { query?: string; body?: Buffer },
): Promise<void> {
  ctx.served('single', [shard]);
  const isPost = ctx.method === 'POST';
  const { json } = await ctx.client.requestJson<QueryResponse>(shard, {
    method: ctx.method,
    path: '/entities/by-query',
    query: request.query,
    headers: ctx.upstreamHeaders(
      isPost ? { 'content-type': 'application/json' } : {},
    ),
    body: request.body,
  });
  const { nextCursor, prevCursor } = json.pageInfo ?? {};
  sendJson(
    ctx.res,
    200,
    {
      ...json,
      pageInfo: {
        ...(nextCursor
          ? { nextCursor: wrapShardCursor(shard.name, nextCursor) }
          : {}),
        ...(prevCursor
          ? { prevCursor: wrapShardCursor(shard.name, prevCursor) }
          : {}),
      },
    },
    ctx.routingHeaders(),
  );
}

function shardOrThrow(ctx: RequestContext, name: string): Shard {
  const shard = ctx.topology.get(name);
  if (!shard) {
    throw new HttpError(400, 'InputError', `Unknown catalog shard '${name}'`);
  }
  return shard;
}

function routerCursorOrThrow(ctx: RequestContext, cursor: string) {
  const decoded = decodeCursor(cursor);
  if (!decoded) {
    if (ctx.pinned) {
      return undefined; // a native cursor for the pinned shard
    }
    throw new HttpError(
      400,
      'InputError',
      'Cursor was not issued by the catalog router; repeat the shard selection used for the first page',
    );
  }
  return decoded;
}

export async function queryEntitiesGet(ctx: RequestContext): Promise<void> {
  const params = ctx.params;
  const limit = parseLimit(params.get('limit') ?? undefined);
  const clientFields = parseFields(params.getAll('fields'));
  const cursorParam = params.get('cursor');

  if (cursorParam) {
    const cursor = routerCursorOrThrow(ctx, cursorParam);
    if (!cursor) {
      await relaySingle(ctx, ctx.pinned!, { query: ctx.rawQuery });
      return;
    }
    if (isShardCursor(cursor)) {
      params.set('cursor', cursor.cursor);
      await relaySingle(ctx, shardOrThrow(ctx, cursor.shard), {
        query: params.toString(),
      });
      return;
    }
    if (!('offsets' in cursor) || 'query' in cursor) {
      throw new HttpError(400, 'InputError', 'Malformed cursor');
    }
    await continueFanout(
      ctx,
      cursor,
      getFlavour(ctx, cursor.params ?? {}, clientFields),
      limit,
      clientFields,
    );
    return;
  }

  const shards = ctx.candidates(
    constraintsFromFilterParams(params.getAll('filter')),
  );
  if (shards.length === 1) {
    await relaySingle(ctx, shards[0], { query: ctx.rawQuery });
    return;
  }

  const replay: Record<string, string[]> = {};
  for (const key of QUERY_PARAMS) {
    if (params.has(key)) {
      replay[key] = params.getAll(key);
    }
  }
  await forwardPage(
    ctx,
    getFlavour(ctx, replay, clientFields),
    { shards, limit, clientFields },
    {
      globalOffset: parseOffset(params.get('offset') ?? undefined),
      withTotal: params.get('totalItems') !== 'exclude',
    },
  );
}

interface QueryBody {
  query?: unknown;
  orderBy?: OrderSpec[];
  fullTextFilter?: { term?: string; fields?: string[] };
  fields?: string[];
  limit?: number;
  offset?: number;
  totalItems?: string;
  cursor?: string;
}

export async function queryEntitiesPost(ctx: RequestContext): Promise<void> {
  const raw = await ctx.body();
  const body = (parseJson(raw) ?? {}) as QueryBody;
  const limit = parseLimit(body.limit);
  const clientFields = parseFields(body.fields ?? []);

  if (body.cursor) {
    const cursor = routerCursorOrThrow(ctx, body.cursor);
    if (!cursor) {
      await relaySingle(ctx, ctx.pinned!, { body: raw });
      return;
    }
    if (isShardCursor(cursor)) {
      const native = { ...body, cursor: cursor.cursor };
      await relaySingle(ctx, shardOrThrow(ctx, cursor.shard), {
        body: Buffer.from(JSON.stringify(native)),
      });
      return;
    }
    if (!('offsets' in cursor) || !('query' in cursor)) {
      throw new HttpError(400, 'InputError', 'Malformed cursor');
    }
    await continueFanout(
      ctx,
      cursor,
      postFlavour(ctx, cursor, clientFields),
      limit,
      clientFields,
    );
    return;
  }

  const shards = ctx.candidates(constraintsFromPredicate(body.query));
  if (shards.length === 1) {
    await relaySingle(ctx, shards[0], { body: raw });
    return;
  }
  await forwardPage(
    ctx,
    postFlavour(
      ctx,
      {
        query: body.query,
        orderBy: body.orderBy,
        fullTextFilter: body.fullTextFilter,
      },
      clientFields,
    ),
    { shards, limit, clientFields },
    {
      globalOffset: parseOffset(body.offset),
      withTotal: body.totalItems !== 'exclude',
    },
  );
}
