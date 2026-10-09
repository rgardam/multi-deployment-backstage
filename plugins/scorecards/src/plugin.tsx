import {
  createFrontendPlugin,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';
import AssessmentIcon from '@material-ui/icons/Assessment';
import { rootRouteRef } from './routes';

export const scorecardsPage = PageBlueprint.make({
  params: {
    path: '/scorecards',
    routeRef: rootRouteRef,
    loader: () =>
      import('./components/ScorecardsPage').then(m => <m.ScorecardsPage />),
  },
});

/** A card on every component's overview page. */
export const scorecardCard = EntityCardBlueprint.make({
  name: 'scorecard',
  params: {
    filter: { kind: 'component' },
    loader: () =>
      import('./components/ScorecardCard').then(m => <m.ScorecardCard />),
  },
});

/**
 * Scorecards frontend: an entity card and a catalog-wide page. Local package,
 * shares its types and check definitions with the backend through
 * `@internal/backstage-plugin-scorecards-common`.
 *
 * @public
 */
export const scorecardsPlugin = createFrontendPlugin({
  pluginId: 'scorecards',
  title: 'Scorecards',
  icon: <AssessmentIcon />,
  extensions: [scorecardsPage, scorecardCard],
  routes: {
    root: rootRouteRef,
  },
});
