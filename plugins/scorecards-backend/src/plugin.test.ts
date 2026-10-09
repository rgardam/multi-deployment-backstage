import { startTestBackend } from '@backstage/backend-test-utils';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import request from 'supertest';
import { scorecardsPlugin } from './plugin';

const entities = [
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: 'ledger',
      namespace: 'payments',
      description: 'Double-entry ledger',
    },
    spec: {
      owner: 'team-payments',
      system: 'payments',
      lifecycle: 'production',
    },
  },
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name: 'website', namespace: 'default' },
    spec: { lifecycle: 'experimental' },
  },
];

describe('scorecards plugin', () => {
  const start = () =>
    startTestBackend({
      features: [scorecardsPlugin, catalogServiceMock.factory({ entities })],
    });

  it('scores one entity', async () => {
    const { server } = await start();
    const res = await request(server)
      .get('/api/scorecards/entities/component/payments/ledger')
      .expect(200);
    expect(res.body.entityRef).toBe('component:payments/ledger');
    expect(res.body.score).toBe(67);
    await request(server)
      .get('/api/scorecards/entities/component/default/missing')
      .expect(404);
  });

  it('summarizes every entity of a kind, per namespace', async () => {
    const { server } = await start();
    const res = await request(server)
      .get('/api/scorecards/summary?kind=component')
      .expect(200);
    expect(res.body).toMatchObject({
      kind: 'component',
      entities: 2,
      averageScore: 34,
      namespaces: [
        { namespace: 'default', entities: 1, averageScore: 0 },
        { namespace: 'payments', entities: 1, averageScore: 67 },
      ],
    });
  });
});
