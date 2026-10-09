import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { NoticeStore } from './NoticeStore';
import { createRouter } from './router';

/**
 * A small database-backed plugin: people post notices and everyone reads
 * them. It is a local workspace package with its own migrations, hosted by
 * the backend-core deployment.
 *
 * @public
 */
export const noticeboardPlugin = createBackendPlugin({
  pluginId: 'noticeboard',
  register(env) {
    env.registerInit({
      deps: {
        database: coreServices.database,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
      },
      async init({ database, httpAuth, httpRouter, logger }) {
        const store = await NoticeStore.create(database);
        httpRouter.use(await createRouter({ httpAuth, logger, store }));
      },
    });
  },
});
