/*
 * Helpers for combining per-shard results into one catalog response.
 *
 * The comparators mirror how the catalog orders rows in SQL (lowercased
 * search values, entity id as tie-breaker), so a merged page is ordered the
 * same way a single catalog would order it.
 */

export type JsonObject = Record<string, unknown>;

export interface OrderSpec {
  field: string;
  order: 'asc' | 'desc';
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a dotted path the way the catalog's search table keys it: keys are
 * case-insensitive, and keys may themselves contain dots (annotations).
 */
export function readPath(value: unknown, path: string): unknown {
  const parts = path.split('.');
  let current = value;
  let i = 0;
  while (i < parts.length) {
    if (!isRecord(current)) {
      return undefined;
    }
    let matched = false;
    // Prefer the longest key that matches, e.g. "backstage.io/techdocs-ref"
    for (let j = parts.length; j > i; j--) {
      const candidate = parts.slice(i, j).join('.').toLocaleLowerCase('en-US');
      const key = Object.keys(current).find(
        k => k.toLocaleLowerCase('en-US') === candidate,
      );
      if (key !== undefined) {
        current = current[key];
        i = j;
        matched = true;
        break;
      }
    }
    if (!matched) {
      return undefined;
    }
  }
  return current;
}

function sortValue(entity: unknown, field: string): string | undefined {
  const value = readPath(entity, field);
  if (value === undefined || value === null || isRecord(value)) {
    return undefined;
  }
  const scalar = Array.isArray(value) ? value[0] : value;
  return scalar === undefined || scalar === null
    ? undefined
    : String(scalar).toLocaleLowerCase('en-US');
}

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

export function uidOf(entity: unknown): string {
  const uid = readPath(entity, 'metadata.uid');
  return typeof uid === 'string' ? uid : '';
}

function entityRefOf(entity: unknown): string {
  const kind = readPath(entity, 'kind');
  const namespace = readPath(entity, 'metadata.namespace') ?? 'default';
  const name = readPath(entity, 'metadata.name');
  return `${kind}:${namespace}/${name}`.toLocaleLowerCase('en-US');
}

export type Comparator = (a: unknown, b: unknown) => number;

/**
 * Ordering used by `/entities/by-query` (and unpaginated `GET /entities`):
 * only the first order field counts, and the entity id breaks ties in the
 * same direction. Entities lacking the field are excluded by the shards.
 */
export function queryComparator(order?: OrderSpec): Comparator {
  if (!order) {
    return (a, b) => compareStrings(uidOf(a), uidOf(b));
  }
  const direction = order.order === 'desc' ? -1 : 1;
  return (a, b) => {
    const byValue = compareStrings(
      sortValue(a, order.field) ?? '',
      sortValue(b, order.field) ?? '',
    );
    return (byValue || compareStrings(uidOf(a), uidOf(b))) * direction;
  };
}

/**
 * Ordering used by paginated `GET /entities`: every order field counts,
 * missing values sort last, ties break on entity id ascending, and without
 * any order the entity ref is used.
 */
export function legacyComparator(orders: readonly OrderSpec[]): Comparator {
  if (!orders.length) {
    return (a, b) => compareStrings(entityRefOf(a), entityRefOf(b));
  }
  return (a, b) => {
    for (const { field, order } of orders) {
      const va = sortValue(a, field);
      const vb = sortValue(b, field);
      if (va === undefined || vb === undefined) {
        if (va !== vb) {
          return va === undefined ? 1 : -1;
        }
        continue;
      }
      const result = compareStrings(va, vb);
      if (result) {
        return order === 'desc' ? -result : result;
      }
    }
    return compareStrings(uidOf(a), uidOf(b));
  };
}

export interface MergeResult<T> {
  items: T[];
  /** Index of the list each merged item came from. */
  sources: number[];
}

/**
 * k-way merge of individually sorted lists. Items are always taken from the
 * head of a list, so each list is consumed as a prefix even if the comparator
 * disagrees with a shard's own ordering (e.g. a different DB collation). That
 * is what keeps offset-based paging free of gaps and duplicates.
 */
export function mergeSorted<T>(
  lists: readonly (readonly T[])[],
  compare: (a: T, b: T) => number,
): MergeResult<T> {
  const positions = lists.map(() => 0);
  const items: T[] = [];
  const sources: number[] = [];
  for (;;) {
    let best = -1;
    for (let i = 0; i < lists.length; i++) {
      if (positions[i] >= lists[i].length) {
        continue;
      }
      if (
        best === -1 ||
        compare(lists[i][positions[i]], lists[best][positions[best]]) < 0
      ) {
        best = i;
      }
    }
    if (best === -1) {
      return { items, sources };
    }
    items.push(lists[best][positions[best]++]);
    sources.push(best);
  }
}

/** How many items each source contributed to `sources[from..to)`. */
export function countSources(
  sources: readonly number[],
  sourceCount: number,
  from: number,
  to: number,
): number[] {
  const counts = new Array<number>(sourceCount).fill(0);
  for (let i = from; i < Math.min(to, sources.length); i++) {
    counts[sources[i]]++;
  }
  return counts;
}

/** Splits `fields` query parameters the same way the catalog does. */
export function parseFields(values: readonly string[]): string[] | undefined {
  const fields = [
    ...new Set(
      values
        .flatMap(v => v.split(','))
        .map(s => s.trim())
        .filter(Boolean),
    ),
  ];
  return fields.length ? fields : undefined;
}

/**
 * Fields to request from shards: what the client asked for plus whatever the
 * merge needs to compare items. Undefined means full entities.
 */
export function fieldsForShards(
  clientFields: readonly string[] | undefined,
  needed: readonly string[],
): string[] | undefined {
  if (!clientFields) {
    return undefined;
  }
  return [...new Set([...clientFields, ...needed])];
}

/** Re-applies the client's field selection after the merge (catalog semantics). */
export function projectFields(entity: unknown, fields: readonly string[]) {
  const output: JsonObject = {};
  for (const field of fields) {
    const path: string[] = [];
    let node: unknown = entity;
    const parts = field.split('.');
    for (let i = 0; i < parts.length && node !== undefined; i++) {
      if (isRecord(node) && parts[i] in node) {
        path.push(parts[i]);
        node = node[parts[i]];
      } else if (i + 1 < parts.length) {
        parts[i + 1] = `${parts[i]}.${parts[i + 1]}`;
      } else {
        node = undefined;
      }
    }
    if (node === undefined || !path.length) {
      continue;
    }
    let target = output;
    path.slice(0, -1).forEach(key => {
      if (!isRecord(target[key])) {
        target[key] = {};
      }
      target = target[key] as JsonObject;
    });
    target[path[path.length - 1]] = node;
  }
  return output;
}

export interface FacetsResponse {
  facets: Record<string, Array<{ value: string; count: number }>>;
}

/** Sums facet counts per value across shards. */
export function mergeFacets(responses: readonly FacetsResponse[]) {
  const merged = new Map<string, Map<string, number>>();
  for (const { facets } of responses) {
    for (const [facet, values] of Object.entries(facets ?? {})) {
      const counts = merged.get(facet) ?? new Map<string, number>();
      for (const { value, count } of values) {
        counts.set(value, (counts.get(value) ?? 0) + count);
      }
      merged.set(facet, counts);
    }
  }
  const facets: FacetsResponse['facets'] = {};
  for (const [facet, counts] of merged) {
    facets[facet] = [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => compareStrings(a.value, b.value));
  }
  return { facets };
}
