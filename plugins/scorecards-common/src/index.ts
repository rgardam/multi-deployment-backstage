/**
 * Scorecard checks shared by the scorecards backend, which evaluates them,
 * and the frontend, which explains them. A local common package: the backend
 * bundle includes it as a built package and the app compiles it from source.
 *
 * @packageDocumentation
 */
import { Entity, stringifyEntityRef } from '@backstage/catalog-model';

/** @public */
export interface ScorecardCheck {
  id: string;
  title: string;
  description: string;
}

interface CheckDefinition extends ScorecardCheck {
  passes(entity: Entity): boolean;
}

const definitions: CheckDefinition[] = [
  {
    id: 'owner',
    title: 'Has an owner',
    description: 'spec.owner points at a team or a person',
    passes: entity => Boolean(entity.spec?.owner),
  },
  {
    id: 'description',
    title: 'Is described',
    description: 'metadata.description says what it is',
    passes: entity => Boolean(entity.metadata.description?.trim()),
  },
  {
    id: 'system',
    title: 'Belongs to a system',
    description: 'spec.system groups it with related software',
    passes: entity => Boolean(entity.spec?.system),
  },
  {
    id: 'docs',
    title: 'Has TechDocs',
    description: 'the backstage.io/techdocs-ref annotation is set',
    passes: entity =>
      Boolean(entity.metadata.annotations?.['backstage.io/techdocs-ref']),
  },
  {
    id: 'production',
    title: 'Is in production',
    description: 'spec.lifecycle is production',
    passes: entity => entity.spec?.lifecycle === 'production',
  },
  {
    id: 'tags',
    title: 'Is tagged',
    description: 'metadata.tags help people find it',
    passes: entity => Boolean(entity.metadata.tags?.length),
  },
];

/** All checks, in display order. @public */
export const scorecardChecks: ScorecardCheck[] = definitions.map(
  ({ id, title, description }) => ({ id, title, description }),
);

/** @public */
export interface ScorecardResult {
  entityRef: string;
  /** Percentage of checks that pass, 0 to 100 */
  score: number;
  checks: Array<ScorecardCheck & { passed: boolean }>;
}

/** Fields of an entity the checks read, for fetching as little as possible. @public */
export const scorecardFields = [
  'kind',
  'metadata.name',
  'metadata.namespace',
  'metadata.description',
  'metadata.annotations',
  'metadata.tags',
  'spec.owner',
  'spec.system',
  'spec.lifecycle',
];

const percent = (part: number, whole: number) =>
  whole ? Math.round((part / whole) * 100) : 0;

/** @public */
export function evaluateScorecard(entity: Entity): ScorecardResult {
  const checks = definitions.map(({ passes, ...check }) => ({
    ...check,
    passed: passes(entity),
  }));
  return {
    entityRef: stringifyEntityRef(entity),
    score: percent(checks.filter(c => c.passed).length, checks.length),
    checks,
  };
}

/** @public */
export interface ScorecardSummary {
  kind: string;
  entities: number;
  averageScore: number;
  checks: Array<ScorecardCheck & { passRate: number }>;
  namespaces: Array<{
    namespace: string;
    entities: number;
    averageScore: number;
  }>;
}

/** Aggregates scorecards, overall and per namespace. @public */
export function summarizeScorecards(
  kind: string,
  results: Array<ScorecardResult & { namespace: string }>,
): ScorecardSummary {
  const average = (items: ScorecardResult[]) =>
    items.length
      ? Math.round(items.reduce((sum, r) => sum + r.score, 0) / items.length)
      : 0;
  const byNamespace = new Map<string, ScorecardResult[]>();
  for (const result of results) {
    byNamespace.set(result.namespace, [
      ...(byNamespace.get(result.namespace) ?? []),
      result,
    ]);
  }
  return {
    kind,
    entities: results.length,
    averageScore: average(results),
    checks: scorecardChecks.map(check => ({
      ...check,
      passRate: percent(
        results.filter(r => r.checks.find(c => c.id === check.id)?.passed)
          .length,
        results.length,
      ),
    })),
    namespaces: [...byNamespace]
      .map(([namespace, items]) => ({
        namespace,
        entities: items.length,
        averageScore: average(items),
      }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace)),
  };
}
