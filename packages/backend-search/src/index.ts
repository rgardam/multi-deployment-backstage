/*
 * backend-search: search API plus the Postgres search engine and collators.
 * Collators read the catalog through the discovery service, so they index
 * every catalog shard through the catalog router.
 */
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage/plugin-search-backend-module-pg'));
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

backend.start();
