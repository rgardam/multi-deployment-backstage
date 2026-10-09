import { HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod/v3';
import { NoticeStore } from './NoticeStore';

const newNoticeSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2000),
});

export async function createRouter(options: {
  httpAuth: HttpAuthService;
  logger: LoggerService;
  store: NoticeStore;
}): Promise<express.Router> {
  const { httpAuth, logger, store } = options;
  const router = Router();
  router.use(express.json());

  router.get('/notices', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    res.json({ items: await store.list(limit) });
  });

  router.post('/notices', async (req, res) => {
    const parsed = newNoticeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new InputError(parsed.error.toString());
    }
    // Only people post notices, and the author is whoever the token says
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const notice = await store.add({
      ...parsed.data,
      author: credentials.principal.userEntityRef,
    });
    logger.info('Notice posted', { id: notice.id, author: notice.author });
    res.status(201).json(notice);
  });

  return router;
}
