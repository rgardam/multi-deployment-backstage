import { createBackend } from '@backstage/backend-defaults';
import { mockServices } from '@backstage/backend-test-utils';

// Standalone development backend for this plugin: `yarn start` in this
// directory, then for example
//
//   curl http://localhost:7007/api/noticeboard/notices -H 'Content-Type: application/json' \
//     -d '{"title": "Hello", "body": "First notice"}'
//   curl http://localhost:7007/api/noticeboard/notices

const backend = createBackend();

// Mock auth, so the API can be called without signing in
backend.add(mockServices.auth.factory());
backend.add(mockServices.httpAuth.factory());

backend.add(import('../src'));

backend.start();
