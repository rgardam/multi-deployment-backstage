/*
 * backend-scorecards: a deployment for one local plugin
 * (plugins/scorecards-backend). It shows the whole path for a new service:
 * a package, a Dockerfile, a compose service and one gateway location. The
 * plugin reads the catalog through the gateway like every other backend.
 */
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@internal/backstage-plugin-scorecards-backend'));

backend.start();
