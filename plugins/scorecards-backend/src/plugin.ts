import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { createRouter } from './router';

/**
 * Scores catalog entities against the checks in the scorecards common
 * package. A local plugin deployed as its own backend (backend-scorecards),
 * talking to the sharded catalog through the gateway.
 *
 * @public
 */
export const scorecardsPlugin = createBackendPlugin({
  pluginId: 'scorecards',
  register(env) {
    env.registerInit({
      deps: {
        catalog: catalogServiceRef,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
      },
      async init({ catalog, httpAuth, httpRouter }) {
        httpRouter.use(await createRouter({ catalog, httpAuth }));
      },
    });
  },
});
