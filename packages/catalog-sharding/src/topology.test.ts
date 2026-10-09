import {
  ANY,
  Constraint,
  constraintFromRef,
  constraintsFromFilterParams,
  constraintsFromPredicate,
} from './constraints';
import { candidateShards, ownerOf, readTopology } from './topology';

const topology = readTopology({
  catalogSharding: {
    shards: [
      {
        name: 'org',
        target: 'http://org/',
        match: { kinds: ['User', 'Group'] },
      },
      { name: 'payments', match: { namespaces: ['payments'] } },
      { name: 'default' },
    ],
  },
});

const names = (constraints: readonly Constraint[]) =>
  candidateShards(topology, constraints).map(s => s.name);

describe('readTopology', () => {
  it('normalizes rules and targets', () => {
    expect(topology.shards.map(s => s.name)).toEqual([
      'org',
      'payments',
      'default',
    ]);
    expect(topology.get('org')?.target).toBe('http://org');
    expect([...topology.get('org')!.kinds!]).toEqual(['user', 'group']);
    expect(topology.catchAll.name).toBe('default');
    expect([...topology.localKinds]).toEqual(['location']);
  });

  it.each([
    [{}, /non-empty "shards"/],
    [{ shards: [{ name: 'Bad Name' }] }, /lowercase/],
    [
      { shards: [{ name: 'a', match: { kinds: ['user'] } }, { name: 'a' }] },
      /Duplicate/,
    ],
    [{ shards: [{ name: 'a' }, { name: 'b' }] }, /unreachable/],
    [
      { shards: [{ name: 'a', match: { kinds: ['user'] } }] },
      /must be a catch-all/,
    ],
    [
      { shards: [{ name: 'a', match: { kinds: [] } }, { name: 'b' }] },
      /non-empty list/,
    ],
  ])('rejects invalid topology %#', (input, error) => {
    expect(() => readTopology(input)).toThrow(error);
  });
});

describe('ownerOf', () => {
  it('uses the first matching rule', () => {
    expect(ownerOf(topology, 'User')?.name).toBe('org');
    expect(ownerOf(topology, 'group', 'payments')?.name).toBe('org');
    expect(ownerOf(topology, 'Component', 'Payments')?.name).toBe('payments');
    expect(ownerOf(topology, 'component', 'default')?.name).toBe('default');
    expect(ownerOf(topology, 'component')?.name).toBe('default');
  });

  it('has no single owner for local kinds', () => {
    expect(ownerOf(topology, 'Location')).toBeUndefined();
  });
});

describe('candidateShards', () => {
  it.each([
    [['kind=group'], ['org']],
    [['kind=user,metadata.namespace=payments'], ['org']],
    [['kind=component'], ['payments', 'default']],
    [['kind=component,metadata.namespace=payments'], ['payments']],
    [['kind=component,metadata.namespace=default'], ['default']],
    [['kind=user,kind=component'], ['org', 'payments', 'default']],
    [
      ['kind=group', 'kind=api,metadata.namespace=payments'],
      ['org', 'payments'],
    ],
    [['metadata.namespace=payments'], ['org', 'payments', 'default']],
    [['kind=location'], ['org', 'payments', 'default']],
    [['spec.type=service'], ['org', 'payments', 'default']],
    [[], ['org', 'payments', 'default']],
  ])('prunes filter %j to %j', (filters, expected) => {
    expect(names(constraintsFromFilterParams(filters))).toEqual(expected);
  });

  it('selects nothing for an unsatisfiable query', () => {
    expect(
      names(constraintsFromFilterParams(['Kind=user,kind=group'])),
    ).toEqual([]);
  });

  it('routes entity refs', () => {
    expect(names([constraintFromRef('group:default/team-a')])).toEqual(['org']);
    expect(names([constraintFromRef('component:payments/ledger')])).toEqual([
      'payments',
    ]);
    expect(names([constraintFromRef('component:website')])).toEqual([
      'default',
    ]);
  });
});

describe('constraintsFromFilterParams', () => {
  it('ORs filters and same-key values, ANDs different keys', () => {
    const [a, b] = constraintsFromFilterParams([
      'kind=Component,kind=API,metadata.namespace=payments',
      'kind=group',
    ]);
    expect(a.kinds).toEqual(new Set(['component', 'api']));
    expect(a.namespaces).toEqual(new Set(['payments']));
    expect(b.kinds).toEqual(new Set(['group']));
    expect(b.namespaces).toBe(ANY);
  });

  it('treats existence checks and other keys as unconstrained', () => {
    const [c] = constraintsFromFilterParams(['kind,spec.type=service']);
    expect(c.kinds).toBe(ANY);
    expect(c.namespaces).toBe(ANY);
  });
});

describe('constraintsFromPredicate', () => {
  it('reads equality and $in matchers', () => {
    const [c] = constraintsFromPredicate({
      kind: { $in: ['User', 'Group'] },
      'metadata.namespace': 'payments',
    });
    expect(c.kinds).toEqual(new Set(['user', 'group']));
    expect(c.namespaces).toEqual(new Set(['payments']));
  });

  it('distributes $all over $any', () => {
    const result = constraintsFromPredicate({
      $all: [
        { $any: [{ kind: 'component' }, { kind: 'api' }] },
        { 'metadata.namespace': 'payments' },
      ],
    });
    expect(result).toHaveLength(2);
    expect(names(result)).toEqual(['payments']);
  });

  it('drops contradictions', () => {
    expect(
      constraintsFromPredicate({ $all: [{ kind: 'user' }, { kind: 'group' }] }),
    ).toEqual([]);
  });

  it('widens what it cannot reason about', () => {
    for (const predicate of [
      { $not: { kind: 'user' } },
      { kind: { $hasPrefix: 'gr' } },
      { $future: true },
      undefined,
    ]) {
      expect(names(constraintsFromPredicate(predicate))).toEqual([
        'org',
        'payments',
        'default',
      ]);
    }
  });

  it('widens instead of exploding the number of alternatives', () => {
    const kinds = [
      'component',
      'api',
      'system',
      'resource',
      'domain',
      'template',
    ];
    const namespaces = ['payments', 'n1', 'n2', 'n3', 'n4', 'n5'];
    const result = constraintsFromPredicate({
      $all: [
        { $any: kinds.map(kind => ({ kind })) },
        { $any: namespaces.map(ns => ({ 'metadata.namespace': ns })) },
      ],
    });
    // 36 combinations is over the cap, so they collapse into one wider one
    expect(result).toEqual([
      { kinds: new Set(kinds), namespaces: new Set(namespaces) },
    ]);
    expect(names(result)).toEqual(['payments', 'default']);
  });
});
