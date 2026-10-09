/*
 * backend-techdocs: serves (and, in this POC, generates) documentation sites.
 * It is the only image that needs Python and MkDocs, which is exactly why it
 * gets its own Dockerfile.
 */
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-techdocs-backend'));

backend.start();
