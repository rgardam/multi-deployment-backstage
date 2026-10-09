import { HttpAuthService } from '@backstage/backend-plugin-api';
import { NotFoundError } from '@backstage/errors';
import { CatalogService } from '@backstage/plugin-catalog-node';
import {
  ScorecardResult,
  evaluateScorecard,
  scorecardFields,
  summarizeScorecards,
} from '@internal/backstage-plugin-scorecards-common';
import express from 'express';
import Router from 'express-promise-router';

export async function createRouter(options: {
  catalog: CatalogService;
  httpAuth: HttpAuthService;
}): Promise<express.Router> {
  const { catalog, httpAuth } = options;
  const router = Router();

  router.get('/entities/:kind/:namespace/:name', async (req, res) => {
    const { kind, namespace, name } = req.params;
    // Read on behalf of the caller, so catalog permissions still apply
    const entity = await catalog.getEntityByRef(
      { kind, namespace, name },
      { credentials: await httpAuth.credentials(req) },
    );
    if (!entity) {
      throw new NotFoundError(`No entity ${kind}:${namespace}/${name}`);
    }
    res.json(evaluateScorecard(entity));
  });

  router.get('/summary', async (req, res) => {
    const kind =
      typeof req.query.kind === 'string' ? req.query.kind : 'component';
    const credentials = await httpAuth.credentials(req);
    const results: Array<ScorecardResult & { namespace: string }> = [];
    // One logical query over the whole catalog. With a sharded catalog, the
    // catalog router fans it out and pages through every shard behind one
    // cursor.
    for await (const page of catalog.streamEntities(
      { filter: { kind }, fields: scorecardFields, pageSize: 100 },
      { credentials },
    )) {
      for (const entity of page) {
        results.push({
          ...evaluateScorecard(entity),
          namespace: entity.metadata.namespace ?? 'default',
        });
      }
    }
    res.json(summarizeScorecards(kind, results));
  });

  return router;
}
