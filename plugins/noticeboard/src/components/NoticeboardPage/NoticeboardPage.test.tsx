import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  registerMswTestHooks,
  renderInTestApp,
} from '@backstage/frontend-test-utils';
import { NoticeboardPage } from './NoticeboardPage';

const notice = {
  id: '1',
  title: 'Maintenance',
  body: 'Postgres upgrade on Friday',
  author: 'user:default/guest',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('NoticeboardPage', () => {
  const server = setupServer();
  registerMswTestHooks(server);

  it('lists notices from the backend', async () => {
    server.use(
      http.get('*/api/noticeboard/notices', () =>
        HttpResponse.json({ items: [notice] }),
      ),
    );

    await renderInTestApp(<NoticeboardPage />);

    expect(await screen.findByText('Maintenance')).toBeInTheDocument();
    expect(screen.getByText('user:default/guest')).toBeInTheDocument();
  });

  it('posts a notice and shows it', async () => {
    const posted: unknown[] = [];
    server.use(
      http.get('*/api/noticeboard/notices', () =>
        HttpResponse.json({ items: posted.length ? [notice] : [] }),
      ),
      http.post('*/api/noticeboard/notices', async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json(notice, { status: 201 });
      }),
    );

    await renderInTestApp(<NoticeboardPage />);
    expect(
      await screen.findByText('No notices yet. Post the first one.'),
    ).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Title'), 'Maintenance');
    await userEvent.type(
      screen.getByLabelText('Notice'),
      'Postgres upgrade on Friday',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Post' }));

    expect(await screen.findByText('Maintenance')).toBeInTheDocument();
    expect(posted).toEqual([
      { title: 'Maintenance', body: 'Postgres upgrade on Friday' },
    ]);
  });
});
