import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  registerMswTestHooks,
  renderInTestApp,
} from '@backstage/frontend-test-utils';
import { ScorecardsPage } from './ScorecardsPage';

describe('ScorecardsPage', () => {
  const server = setupServer();
  registerMswTestHooks(server);

  it('shows the catalog-wide summary', async () => {
    server.use(
      http.get('*/api/scorecards/summary', () =>
        HttpResponse.json({
          kind: 'component',
          entities: 6,
          averageScore: 58,
          checks: [
            {
              id: 'owner',
              title: 'Has an owner',
              description: 'd',
              passRate: 100,
            },
          ],
          namespaces: [
            { namespace: 'payments', entities: 3, averageScore: 61 },
          ],
        }),
      ),
    );

    await renderInTestApp(<ScorecardsPage />);

    expect(
      await screen.findByText('6 components, average score 58%'),
    ).toBeInTheDocument();
    expect(screen.getByText('Has an owner')).toBeInTheDocument();
    expect(screen.getByText('payments')).toBeInTheDocument();
  });
});
