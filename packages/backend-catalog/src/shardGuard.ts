/*
 * Keeps a catalog shard honest: an entity is only accepted by the shard that
 * owns it under the shared topology (first matching rule on kind/namespace).
 * The catalog router relies on that invariant when it prunes shards, so a
 * misrouted entity fails processing loudly instead of silently ending up in a
 * shard the router never asks.
 */
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { Entity, stringifyEntityRef } from '@backstage/catalog-model';
import { InputError } from '@backstage/errors';
import {
  CatalogProcessor,
  catalogProcessingExtensionPoint,
} from '@backstage/plugin-catalog-node';
import { Topology, ownerOf, readTopology } from '@internal/catalog-sharding';

export class ShardGuardProcessor implements CatalogProcessor {
  constructor(
    private readonly topology: Topology,
    private readonly self: string,
  ) {}

  getProcessorName(): string {
    return 'ShardGuardProcessor';
  }

  async preProcessEntity(entity: Entity): Promise<Entity> {
    const owner = ownerOf(
      this.topology,
      entity.kind,
      entity.metadata.namespace,
    );
    if (owner && owner.name !== this.self) {
      const ref = stringifyEntityRef(entity);
      const shard = owner.name;
      throw new InputError(
        `${ref} belongs to catalog shard '${shard}', not '${this.self}'; ` +
          `register it with the '${shard}' shard`,
      );
    }
    return entity;
  }
}

export const catalogModuleShardGuard = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'shard-guard',
  register(reg) {
    reg.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        processing: catalogProcessingExtensionPoint,
      },
      async init({ config, logger, processing }) {
        const sharding = config.getOptionalConfig('catalogSharding');
        const self = sharding?.getOptionalString('self');
        if (!sharding || !self) {
          logger.info('Catalog sharding is off (catalogSharding.self unset)');
          return;
        }
        const topology = readTopology(sharding.get());
        if (!topology.get(self)) {
          throw new Error(
            `catalogSharding.self is '${self}', which is not one of the configured shards`,
          );
        }
        logger.info(
          `Serving catalog shard '${self}' of [${topology.shards
            .map(s => s.name)
            .join(', ')}]`,
        );
        processing.addProcessor(new ShardGuardProcessor(topology, self));
      },
    });
  },
});
