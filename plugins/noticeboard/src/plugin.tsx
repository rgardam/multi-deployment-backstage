import {
  createFrontendPlugin,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import AnnouncementIcon from '@material-ui/icons/Announcement';
import { rootRouteRef } from './routes';

export const noticeboardPage = PageBlueprint.make({
  params: {
    path: '/noticeboard',
    routeRef: rootRouteRef,
    loader: () =>
      import('./components/NoticeboardPage').then(m => <m.NoticeboardPage />),
  },
});

/**
 * Noticeboard frontend: one page, listed in the sidebar through the plugin's
 * title and icon. A local package the app picks up through feature discovery.
 *
 * @public
 */
export const noticeboardPlugin = createFrontendPlugin({
  pluginId: 'noticeboard',
  title: 'Noticeboard',
  icon: <AnnouncementIcon />,
  extensions: [noticeboardPage],
  routes: {
    root: rootRouteRef,
  },
});
