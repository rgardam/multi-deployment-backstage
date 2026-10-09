/*
 * Cursors handed out by the router. Like the catalog's own cursors they are
 * base64-encoded JSON, and CatalogClient inspects them: if the decoded object
 * has a `query` key it sends the next page as POST /entities/by-query,
 * otherwise as GET. Router cursors therefore carry `query` exactly when the
 * original request was predicate based.
 */
import { OrderSpec } from './merge';

const VERSION = 'catalog-router/1';

/** A shard's own cursor, tagged with the shard it came from. */
export interface ShardCursor {
  v: typeof VERSION;
  shard: string;
  cursor: string;
  query?: true;
}

/** The state of a fan-out query: where each shard's next page starts. */
export interface FanoutCursor {
  v: typeof VERSION;
  shards: string[];
  /** Per shard: index of the first item of the page this cursor points at. */
  offsets: number[];
  /** `prev` cursors point at the end of the page to fetch. */
  dir: 'next' | 'prev';
  totalItems?: number;
  /** Raw GET query parameters to replay against every shard. */
  params?: Record<string, string[]>;
  /** POST request body fields to replay; `query` is the filter predicate. */
  query?: unknown;
  orderBy?: OrderSpec[];
  fullTextFilter?: { term?: string; fields?: string[] };
}

/** Sequential paging state for POST /locations/by-query. */
export interface LocationsCursor {
  v: typeof VERSION;
  locations: true;
  shards: string[];
  index: number;
  cursor?: string;
  body: Record<string, unknown>;
  totalItems: number;
}

export type RouterCursor = ShardCursor | FanoutCursor | LocationsCursor;

export function encodeCursor(cursor: Omit<RouterCursor, 'v'>): string {
  return Buffer.from(
    JSON.stringify({ v: VERSION, ...cursor }),
    'utf8',
  ).toString('base64');
}

function decodeJson(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Decodes a router cursor; undefined means it was not issued by the router. */
export function decodeCursor(cursor: string): RouterCursor | undefined {
  const value = decodeJson(cursor);
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { v?: unknown }).v === VERSION
  ) {
    return value as RouterCursor;
  }
  return undefined;
}

export function isShardCursor(cursor: RouterCursor): cursor is ShardCursor {
  return 'shard' in cursor;
}

export function isLocationsCursor(
  cursor: RouterCursor,
): cursor is LocationsCursor {
  return 'locations' in cursor;
}

/** Wraps a shard's native cursor, preserving its GET/POST flavour. */
export function wrapShardCursor(shard: string, native: string): string {
  const decoded = decodeJson(native);
  const hasQuery =
    typeof decoded === 'object' && decoded !== null && 'query' in decoded;
  return encodeCursor({
    shard,
    cursor: native,
    ...(hasQuery ? { query: true as const } : {}),
  });
}
