/*
 * backend-scaffolder: software templates. Task execution is bursty and CPU
 * heavy, so it scales independently of the read-heavy catalog.
 */
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(
  import('@backstage/plugin-scaffolder-backend-module-notifications'),
);

backend.start();
