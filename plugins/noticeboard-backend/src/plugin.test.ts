import {
  mockCredentials,
  startTestBackend,
} from '@backstage/backend-test-utils';
import request from 'supertest';
import { noticeboardPlugin } from './plugin';

describe('noticeboard plugin', () => {
  it('stores notices with their author and lists the newest first', async () => {
    const { server } = await startTestBackend({
      features: [noticeboardPlugin],
    });

    await request(server)
      .get('/api/noticeboard/notices')
      .expect(200, { items: [] });

    const first = await request(server)
      .post('/api/noticeboard/notices')
      .send({ title: 'Maintenance', body: 'Postgres upgrade on Friday' });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      id: expect.any(String),
      title: 'Maintenance',
      body: 'Postgres upgrade on Friday',
      author: mockCredentials.user().principal.userEntityRef,
      createdAt: expect.any(String),
    });

    await new Promise(resolve => setTimeout(resolve, 5));
    await request(server)
      .post('/api/noticeboard/notices')
      .send({ title: 'Release', body: 'Version 2 is out' })
      .expect(201);

    const list = await request(server)
      .get('/api/noticeboard/notices')
      .expect(200);
    expect(list.body.items.map((n: { title: string }) => n.title)).toEqual([
      'Release',
      'Maintenance',
    ]);
  });

  it('rejects invalid notices and callers that are not people', async () => {
    const { server } = await startTestBackend({
      features: [noticeboardPlugin],
    });

    const invalid = await request(server)
      .post('/api/noticeboard/notices')
      .send({ title: '', body: 'x' });
    expect(invalid.status).toBe(400);

    const fromService = await request(server)
      .post('/api/noticeboard/notices')
      .set('authorization', mockCredentials.service.header())
      .send({ title: 'From a service', body: 'Not allowed' });
    expect(fromService.status).toBe(403);
  });
});
