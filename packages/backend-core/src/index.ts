/*
 * backend-core: identity, access control and the small platform services that
 * every other backend depends on. Low traffic, but on the critical path, so it
 * is deployed and scaled on its own.
 */
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// Identity and access
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));
backend.add(import('@backstage/plugin-permission-backend'));
backend.add(
  import('@backstage/plugin-permission-backend-module-allow-all-policy'),
);

// Database-backed event bus, so events (and signals) reach every replica and
// every split backend instead of staying inside one process.
backend.add(import('@backstage/plugin-events-backend'));

// Platform services
backend.add(import('@backstage/plugin-proxy-backend'));
backend.add(import('@backstage/plugin-user-settings-backend'));
backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@backstage/plugin-signals-backend'));
backend.add(import('@backstage/plugin-kubernetes-backend'));
backend.add(import('@backstage/plugin-mcp-actions-backend'));

backend.start();
