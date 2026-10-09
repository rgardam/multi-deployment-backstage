/*
 * backend-catalog: the software catalog. One image, deployed once per catalog
 * shard. Which slice of the catalog a deployment owns is pure configuration
 * (`catalogSharding.self` plus its own `catalog.locations`).
 */
import { createBackend } from '@backstage/backend-defaults';
import { catalogModuleShardGuard } from './shardGuard';

const backend = createBackend();

backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);
backend.add(import('@backstage/plugin-catalog-backend-module-logs'));
backend.add(catalogModuleShardGuard);

backend.start();
