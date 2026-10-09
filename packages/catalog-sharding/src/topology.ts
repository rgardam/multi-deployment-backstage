/*
 * A catalog shard topology is an ordered list of shards. Every entity belongs
 * to exactly one shard: the first one whose rule matches the entity's kind and
 * namespace. The last shard has no rule and catches everything else.
 *
 * "Local kinds" (Location by default) are the exception: every shard owns the
 * Location entities generated from its own registered locations, so those can
 * live in any shard.
 */
import { ANY, Constraint, normalize } from './constraints';

/** The rule a shard uses to claim entities. Both dimensions must match. */
export interface ShardRuleConfig {
  /** Entity kinds owned by the shard (case-insensitive). Omit for any kind. */
  kinds?: string[];
  /** Entity namespaces owned by the shard (case-insensitive). Omit for any. */
  namespaces?: string[];
}

export interface ShardConfig {
  name: string;
  /** Base URL of the shard's catalog API. Only the router needs this. */
  target?: string;
  /** Omitted for the final, catch-all shard. */
  match?: ShardRuleConfig;
}

export interface TopologyConfig {
  shards: ShardConfig[];
  localKinds?: string[];
}

export interface Shard {
  readonly name: string;
  readonly target?: string;
  readonly kinds?: ReadonlySet<string>;
  readonly namespaces?: ReadonlySet<string>;
}

export interface Topology {
  readonly shards: readonly Shard[];
  readonly localKinds: ReadonlySet<string>;
  /** The last shard, which owns everything no other rule claims. */
  readonly catchAll: Shard;
  get(name: string): Shard | undefined;
}

const SHARD_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const DEFAULT_LOCAL_KINDS = ['location'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringSet(
  value: unknown,
  what: string,
): ReadonlySet<string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(v => typeof v !== 'string' || !v.trim())
  ) {
    throw new Error(`${what} must be a non-empty list of strings`);
  }
  return new Set(value.map(v => normalize(v.trim())));
}

/**
 * Reads and validates a topology. Accepts either the bare topology or an
 * app-config shaped document with a top-level `catalogSharding` key, so the
 * router and the catalog backends can share one file.
 */
export function readTopology(input: unknown): Topology {
  const root =
    isRecord(input) && 'catalogSharding' in input
      ? input.catalogSharding
      : input;
  if (!isRecord(root) || !Array.isArray(root.shards) || !root.shards.length) {
    throw new Error(
      'Invalid catalog shard topology: expected a non-empty "shards" list',
    );
  }

  const shards: Shard[] = root.shards.map((raw: unknown, index: number) => {
    const where = `catalog shard #${index + 1}`;
    if (!isRecord(raw) || typeof raw.name !== 'string') {
      throw new Error(`Invalid ${where}: missing "name"`);
    }
    if (!SHARD_NAME.test(raw.name)) {
      throw new Error(
        `Invalid ${where}: name "${raw.name}" must be lowercase letters, digits and dashes`,
      );
    }
    if (raw.target !== undefined && typeof raw.target !== 'string') {
      throw new Error(`Invalid ${where}: "target" must be a URL string`);
    }
    if (raw.match !== undefined && !isRecord(raw.match)) {
      throw new Error(`Invalid ${where}: "match" must be an object`);
    }
    return {
      name: raw.name,
      target: raw.target?.replace(/\/+$/, ''),
      kinds: readStringSet(raw.match?.kinds, `${where} match.kinds`),
      namespaces: readStringSet(
        raw.match?.namespaces,
        `${where} match.namespaces`,
      ),
    };
  });

  const names = new Set<string>();
  shards.forEach((shard, index) => {
    if (names.has(shard.name)) {
      throw new Error(`Duplicate catalog shard name "${shard.name}"`);
    }
    names.add(shard.name);
    const isCatchAll = !shard.kinds && !shard.namespaces;
    const isLast = index === shards.length - 1;
    if (isCatchAll !== isLast) {
      throw new Error(
        isLast
          ? `The last catalog shard ("${shard.name}") must be a catch-all without a "match" rule`
          : `Catalog shard "${shard.name}" has no "match" rule, so every shard after it would be unreachable`,
      );
    }
  });

  const localKinds =
    readStringSet(root.localKinds, 'catalog sharding localKinds') ??
    new Set(DEFAULT_LOCAL_KINDS);
  const byName = new Map(shards.map(s => [s.name, s]));

  return {
    shards,
    localKinds,
    catchAll: shards[shards.length - 1],
    get: name => byName.get(name),
  };
}

function ruleMatches(shard: Shard, kind: string, namespace: string): boolean {
  return (
    (!shard.kinds || shard.kinds.has(kind)) &&
    (!shard.namespaces || shard.namespaces.has(namespace))
  );
}

/**
 * The shard that owns an entity, or undefined for local kinds, which may live
 * in any shard.
 */
export function ownerOf(
  topology: Topology,
  kind: string,
  namespace?: string,
): Shard | undefined {
  const k = normalize(kind);
  if (topology.localKinds.has(k)) {
    return undefined;
  }
  const ns = normalize(namespace || 'default');
  return (
    topology.shards.find(shard => ruleMatches(shard, k, ns)) ??
    topology.catchAll
  );
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) {
    if (b.has(value)) {
      return true;
    }
  }
  return false;
}

function isSubset(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

/**
 * The shards that may hold entities matching any of the given constraints,
 * in topology order. This is partition pruning: a shard is skipped when its
 * rule cannot match, and the scan stops at the first shard whose rule matches
 * every possible entity, because first-match ownership hides later shards.
 */
export function candidateShards(
  topology: Topology,
  constraints: readonly Constraint[],
): Shard[] {
  const selected = new Set<Shard>();

  for (const { kinds, namespaces } of constraints) {
    const mayBeLocalKind =
      kinds === ANY || [...kinds].some(k => topology.localKinds.has(k));
    if (mayBeLocalKind) {
      return [...topology.shards];
    }

    for (const shard of topology.shards) {
      const kindMay = !shard.kinds || intersects(kinds, shard.kinds);
      const nsMay =
        !shard.namespaces ||
        namespaces === ANY ||
        intersects(namespaces, shard.namespaces);
      if (kindMay && nsMay) {
        selected.add(shard);
      }

      const kindMust = !shard.kinds || isSubset(kinds, shard.kinds);
      const nsMust =
        !shard.namespaces ||
        (namespaces !== ANY && isSubset(namespaces, shard.namespaces));
      if (kindMust && nsMust) {
        break;
      }
    }
  }

  return topology.shards.filter(shard => selected.has(shard));
}
