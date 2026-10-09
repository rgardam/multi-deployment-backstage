import { Entity } from '@backstage/catalog-model';
import { evaluateScorecard, summarizeScorecards } from './index';

const component = (spec: object, metadata: object = {}): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name: 'ledger', namespace: 'payments', ...metadata },
  spec,
});

describe('evaluateScorecard', () => {
  it('scores the share of passing checks', () => {
    const result = evaluateScorecard(
      component(
        { owner: 'team-payments', lifecycle: 'production', system: 'payments' },
        { description: 'Double-entry ledger' },
      ),
    );
    expect(result.entityRef).toBe('component:payments/ledger');
    expect(result.score).toBe(67);
    expect(result.checks.filter(c => !c.passed).map(c => c.id)).toEqual([
      'docs',
      'tags',
    ]);
  });

  it('gives an empty entity a zero', () => {
    expect(evaluateScorecard(component({})).score).toBe(0);
  });
});

describe('summarizeScorecards', () => {
  it('aggregates pass rates and namespaces', () => {
    const full = component(
      { owner: 'a', system: 'b', lifecycle: 'production' },
      {
        description: 'd',
        tags: ['t'],
        annotations: { 'backstage.io/techdocs-ref': 'dir:.' },
      },
    );
    const summary = summarizeScorecards('component', [
      { ...evaluateScorecard(full), namespace: 'payments' },
      { ...evaluateScorecard(component({})), namespace: 'default' },
    ]);
    expect(summary.entities).toBe(2);
    expect(summary.averageScore).toBe(50);
    expect(summary.checks.every(c => c.passRate === 50)).toBe(true);
    expect(summary.namespaces).toEqual([
      { namespace: 'default', entities: 1, averageScore: 0 },
      { namespace: 'payments', entities: 1, averageScore: 100 },
    ]);
  });
});
