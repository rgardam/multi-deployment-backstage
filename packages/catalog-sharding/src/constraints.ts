/*
 * Constraint extraction: turns a catalog request (legacy `filter` query
 * parameters, a filter predicate, or an entity ref) into the set of
 * (kind, namespace) combinations the matching entities can have.
 *
 * The result is a disjunction of constraints. It is always allowed to be
 * wider than the real answer (that only costs an extra shard in a fan-out),
 * but never narrower, so anything we cannot reason about becomes ANY.
 */
export const ANY = Symbol('any');

export type ValueSet = ReadonlySet<string> | typeof ANY;

/** Entities match when their kind is in `kinds` and namespace in `namespaces`. */
export interface Constraint {
  readonly kinds: ValueSet;
  readonly namespaces: ValueSet;
}

export const UNCONSTRAINED: readonly Constraint[] = [
  { kinds: ANY, namespaces: ANY },
];

/** Kinds, namespaces and filter values compare case-insensitively. */
export function normalize(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

/** Beyond this many alternatives we widen to a single, merged constraint. */
const MAX_ALTERNATIVES = 32;

function intersect(a: ValueSet, b: ValueSet): ValueSet {
  if (a === ANY) {
    return b;
  }
  if (b === ANY) {
    return a;
  }
  return new Set([...a].filter(v => b.has(v)));
}

function union(a: ValueSet, b: ValueSet): ValueSet {
  if (a === ANY || b === ANY) {
    return ANY;
  }
  return new Set([...a, ...b]);
}

function isSatisfiable(c: Constraint): boolean {
  return (
    (c.kinds === ANY || c.kinds.size > 0) &&
    (c.namespaces === ANY || c.namespaces.size > 0)
  );
}

function isUnconstrained(c: Constraint): boolean {
  return c.kinds === ANY && c.namespaces === ANY;
}

function and(a: Constraint, b: Constraint): Constraint {
  return {
    kinds: intersect(a.kinds, b.kinds),
    namespaces: intersect(a.namespaces, b.namespaces),
  };
}

/** Widens a list of alternatives into one constraint that covers them all. */
function widen(alternatives: readonly Constraint[]): Constraint[] {
  return [
    alternatives.reduce((acc, c) => ({
      kinds: union(acc.kinds, c.kinds),
      namespaces: union(acc.namespaces, c.namespaces),
    })),
  ];
}

function simplify(alternatives: Constraint[]): Constraint[] {
  const satisfiable = alternatives.filter(isSatisfiable);
  if (satisfiable.some(isUnconstrained)) {
    return [...UNCONSTRAINED];
  }
  return satisfiable.length > MAX_ALTERNATIVES
    ? widen(satisfiable)
    : satisfiable;
}

function constrain(
  constraint: Constraint,
  key: string,
  values: ValueSet,
): Constraint {
  switch (normalize(key)) {
    case 'kind':
      return { ...constraint, kinds: intersect(constraint.kinds, values) };
    case 'metadata.namespace':
      return {
        ...constraint,
        namespaces: intersect(constraint.namespaces, values),
      };
    default:
      return constraint;
  }
}

/**
 * Legacy `filter` query parameters, e.g.
 * `?filter=kind=component,metadata.namespace=payments&filter=kind=api`.
 * Filters are OR-ed; inside one filter, statements with the same key are
 * OR-ed and different keys AND-ed (mirroring the catalog's own parser).
 */
export function constraintsFromFilterParams(
  filters: readonly string[],
): Constraint[] {
  const alternatives: Constraint[] = [];

  for (const filter of filters) {
    const statements = filter
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (!statements.length) {
      continue;
    }

    const valuesByKey = new Map<string, string[] | undefined>();
    for (const statement of statements) {
      const eq = statement.indexOf('=');
      const key = (eq === -1 ? statement : statement.slice(0, eq)).trim();
      if (!valuesByKey.has(key)) {
        valuesByKey.set(key, undefined);
      }
      if (eq !== -1) {
        const value = statement.slice(eq + 1).trim();
        valuesByKey.set(key, [...(valuesByKey.get(key) ?? []), value]);
      }
    }

    let constraint: Constraint = UNCONSTRAINED[0];
    for (const [key, values] of valuesByKey) {
      if (values) {
        constraint = constrain(constraint, key, new Set(values.map(normalize)));
      }
    }
    alternatives.push(constraint);
  }

  return alternatives.length ? simplify(alternatives) : [...UNCONSTRAINED];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

/** Values a predicate value matcher can take, or ANY if we can't tell. */
function valuesOfMatcher(matcher: unknown): ValueSet {
  if (isPrimitive(matcher)) {
    return new Set([normalize(String(matcher))]);
  }
  if (
    isRecord(matcher) &&
    Object.keys(matcher).length === 1 &&
    Array.isArray(matcher.$in) &&
    matcher.$in.every(isPrimitive)
  ) {
    return new Set(matcher.$in.map(v => normalize(String(v))));
  }
  return ANY;
}

/**
 * Filter predicates, as accepted by the catalog's POST endpoints, e.g.
 * `{ "$all": [{ "kind": "component" }, { "metadata.namespace": { "$in": ["a", "b"] } }] }`.
 */
export function constraintsFromPredicate(predicate: unknown): Constraint[] {
  if (predicate === undefined || !isRecord(predicate)) {
    return [...UNCONSTRAINED];
  }
  const keys = Object.keys(predicate);

  if (keys.length === 1 && keys[0] === '$all') {
    const children = predicate.$all;
    if (!Array.isArray(children)) {
      return [...UNCONSTRAINED];
    }
    let acc: Constraint[] = [...UNCONSTRAINED];
    for (const child of children) {
      const next: Constraint[] = [];
      for (const left of acc) {
        for (const right of constraintsFromPredicate(child)) {
          next.push(and(left, right));
        }
      }
      acc = simplify(next);
      if (!acc.length) {
        return [];
      }
    }
    return acc;
  }

  if (keys.length === 1 && keys[0] === '$any') {
    const children = predicate.$any;
    if (!Array.isArray(children) || !children.length) {
      return [...UNCONSTRAINED];
    }
    return simplify(children.flatMap(constraintsFromPredicate));
  }

  // $not (and any operator we don't know) can match anything we can see.
  if (keys.some(key => key.startsWith('$'))) {
    return [...UNCONSTRAINED];
  }

  let constraint: Constraint = UNCONSTRAINED[0];
  for (const key of keys) {
    constraint = constrain(constraint, key, valuesOfMatcher(predicate[key]));
  }
  return simplify([constraint]);
}

export interface ParsedEntityRef {
  kind?: string;
  namespace: string;
  name: string;
}

/** Lenient `[kind:][namespace/]name` parser, matching `parseEntityRef`. */
export function parseRef(ref: string): ParsedEntityRef {
  const slash = ref.indexOf('/');
  let colon = ref.indexOf(':');
  if (slash !== -1 && slash < colon) {
    colon = -1;
  }
  return {
    kind: colon === -1 ? undefined : ref.slice(0, colon),
    namespace: slash === -1 ? 'default' : ref.slice(colon + 1, slash),
    name: ref.slice(Math.max(colon, slash) + 1),
  };
}

export function constraintFromRef(ref: string): Constraint {
  const { kind, namespace } = parseRef(ref);
  return {
    kinds: kind ? new Set([normalize(kind)]) : ANY,
    namespaces: new Set([normalize(namespace)]),
  };
}
