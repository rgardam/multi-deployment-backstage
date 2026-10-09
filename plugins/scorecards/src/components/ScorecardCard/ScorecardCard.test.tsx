import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  registerMswTestHooks,
  renderInTestApp,
} from '@backstage/frontend-test-utils';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { ScorecardCard } from './ScorecardCard';

describe('ScorecardCard', () => {
  const server = setupServer();
  registerMswTestHooks(server);

  it("shows the entity's score and checks", async () => {
    server.use(
      http.get('*/api/scorecards/entities/component/payments/ledger', () =>
        HttpResponse.json({
          entityRef: 'component:payments/ledger',
          score: 50,
          checks: [
            {
              id: 'owner',
              title: 'Has an owner',
              description: 'd',
              passed: true,
            },
            {
              id: 'docs',
              title: 'Has TechDocs',
              description: 'd',
              passed: false,
            },
          ],
        }),
      ),
    );

    await renderInTestApp(
      <EntityProvider
        entity={{
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Component',
          metadata: { name: 'ledger', namespace: 'payments' },
        }}
      >
        <ScorecardCard />
      </EntityProvider>,
    );

    expect(await screen.findByText('50%')).toBeInTheDocument();
    expect(screen.getByText('Has an owner')).toBeInTheDocument();
    expect(screen.getByText('Has TechDocs')).toBeInTheDocument();
  });
});
