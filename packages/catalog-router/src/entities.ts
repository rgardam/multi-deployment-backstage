/*
 * GET /entities: the legacy list endpoint, still used by UI cards such as
 * Ownership and by older clients. Without pagination parameters each shard
 * streams its full result and the router merges them. With
 * `limit`/`offset`/`after`, each shard returns its first `offset + limit`
 * items and the router slices the merged list.
 */
import { constraintsFromFilterParams } from '@internal/catalog-sharding';
import { RequestContext } from './context';
import { HttpError, UpstreamResponseError, parseJson, sendJson } from './http';
import {
  OrderSpec,
  fieldsForShards,
  legacyComparator,
  mergeSorted,
  parseFields,
  projectFields,
  queryComparator,
} from './merge';

function parseOrders(values: readonly string[]): OrderSpec[] {
  return values.map(value => {
    const match = value.match(/^(asc|desc):(.+)$/);
    if (!match) {
      throw new HttpError(
        400,
        'InputError',
        `Invalid order parameter "${value}", expected "<asc or desc>:<field name>"`,
      );
    }
    return { order: match[1] as OrderSpec['order'], field: match[2] };
  });
}

function parseInteger(name: string, value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new HttpError(400, 'InputError', `Invalid ${name} "${value}"`);
  }
  return number;
}

/** `after` cursors are just base64 `{ limit, offset }`, so any shard's work here. */
function readPagination(params: URLSearchParams) {
  let offset = parseInteger('offset', params.get('offset'));
  let limit = parseInteger('limit', params.get('limit'));
  const after = params.get('after');
  if (offset === undefined && limit === undefined && after === null) {
    return undefined;
  }
  if (after) {
    const cursor = parseJson(Buffer.from(after, 'base64'), 'after cursor') as {
      limit?: number;
      offset?: number;
    };
    limit = cursor?.limit ?? limit;
    offset = cursor?.offset ?? offset;
  }
  return { offset: offset ?? 0, limit };
}

export async function listEntities(ctx: RequestContext): Promise<void> {
  const params = ctx.params;
  const shards = ctx.candidates(
    constraintsFromFilterParams(params.getAll('filter')),
  );
  if (shards.length === 1) {
    await ctx.forward(shards[0]);
    return;
  }

  const orders = parseOrders(params.getAll('order'));
  const pagination = readPagination(params);
  const clientFields = parseFields(params.getAll('fields'));
  let needed = ['metadata.uid'];
  if (orders.length) {
    needed = [...orders.map(o => o.field), 'metadata.uid'];
  } else if (pagination) {
    needed = ['kind', 'metadata.namespace', 'metadata.name'];
  }
  const shardFields = fieldsForShards(clientFields, needed);

  const query = new URLSearchParams();
  params.getAll('filter').forEach(f => query.append('filter', f));
  params.getAll('order').forEach(o => query.append('order', o));
  if (shardFields) {
    query.set('fields', shardFields.join(','));
  }
  if (pagination) {
    query.set('offset', '0');
    if (pagination.limit !== undefined) {
      query.set('limit', String(pagination.offset + pagination.limit));
    }
  }

  const responses = await ctx.fanOut(shards, () => ({
    method: 'GET',
    path: '/entities',
    query: query.toString(),
    headers: ctx.upstreamHeaders(),
  }));
  const failed = responses.find(r => r.status < 200 || r.status >= 300);
  if (failed) {
    throw new UpstreamResponseError(
      failed.shard.name,
      failed.status,
      failed.headers,
      failed.body,
    );
  }

  const lists = responses.map(r => (parseJson(r.body) ?? []) as unknown[]);
  const compare = pagination
    ? legacyComparator(orders)
    : queryComparator(orders[0]);
  let page = mergeSorted(lists, compare).items;
  const headers = ctx.routingHeaders();

  if (pagination) {
    const { offset, limit } = pagination;
    const total = page.length;
    page =
      limit === undefined
        ? page.slice(offset)
        : page.slice(offset, offset + limit);
    const hasMore =
      limit !== undefined &&
      (total > offset + limit || responses.some(r => r.headers.link));
    if (hasMore) {
      const next = new URLSearchParams(ctx.rawQuery);
      next.delete('offset');
      next.set(
        'after',
        Buffer.from(JSON.stringify({ limit, offset: offset + limit })).toString(
          'base64',
        ),
      );
      headers.link = `</entities?${next}>; rel="next"`;
    }
  }

  sendJson(
    ctx.res,
    200,
    clientFields ? page.map(e => projectFields(e, clientFields)) : page,
    headers,
  );
}
