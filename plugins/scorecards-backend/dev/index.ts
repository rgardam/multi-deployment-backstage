import { createBackend } from '@backstage/backend-defaults';
import { mockServices } from '@backstage/backend-test-utils';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';

// Standalone development backend for this plugin: `yarn start` in this
// directory, then for example
//
//   curl http://localhost:7007/api/scorecards/entities/component/default/sample
//   curl http://localhost:7007/api/scorecards/summary

const backend = createBackend();

// Mock auth, so the API can be called without signing in
backend.add(mockServices.auth.factory());
backend.add(mockServices.httpAuth.factory());

// A fixed catalog instead of a real one
backend.add(
  catalogServiceMock.factory({
    entities: [
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: { name: 'sample', description: 'A sample component' },
        spec: { type: 'service', owner: 'me', lifecycle: 'production' },
      },
    ],
  }),
);

backend.add(import('../src'));

backend.start();
