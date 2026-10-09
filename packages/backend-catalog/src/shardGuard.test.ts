import { Entity } from '@backstage/catalog-model';
import { readTopology } from '@internal/catalog-sharding';
import { ShardGuardProcessor } from './shardGuard';

const topology = readTopology({
  shards: [
    { name: 'org', match: { kinds: ['User', 'Group'] } },
    { name: 'payments', match: { namespaces: ['payments'] } },
    { name: 'default' },
  ],
});

const entity = (kind: string, namespace?: string): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind,
  metadata: { name: 'x', ...(namespace ? { namespace } : {}) },
});

describe('ShardGuardProcessor', () => {
  it('accepts entities the shard owns', async () => {
    const guard = new ShardGuardProcessor(topology, 'payments');
    await expect(
      guard.preProcessEntity(entity('Component', 'payments')),
    ).resolves.toBeDefined();
    await expect(
      guard.preProcessEntity(entity('API', 'Payments')),
    ).resolves.toBeDefined();
  });

  it('rejects entities owned by another shard, naming the owner', async () => {
    const guard = new ShardGuardProcessor(topology, 'payments');
    await expect(
      guard.preProcessEntity(entity('Group', 'payments')),
    ).rejects.toThrow(
      "group:payments/x belongs to catalog shard 'org', not 'payments'",
    );
    await expect(guard.preProcessEntity(entity('Component'))).rejects.toThrow(
      /shard 'default'/,
    );
  });

  it('lets every shard keep its own Location entities', async () => {
    for (const self of ['org', 'payments', 'default']) {
      await expect(
        new ShardGuardProcessor(topology, self).preProcessEntity(
          entity('Location'),
        ),
      ).resolves.toBeDefined();
    }
  });
});
