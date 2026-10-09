import * as http from 'node:http';
import { Shard, Topology } from '@internal/catalog-sharding';
import { RequestContext, RouterDeps, SHARD_HEADER } from './context';
import { listEntities } from './entities';
import {
  applyConditions,
  byName,
  createLocation,
  entitiesByRefs,
  facetsGet,
  facetsPost,
  firstFound,
  jwks,
  listLocations,
  queryLocations,
  refresh,
  validateEntity,
} from './handlers';
import {
  HttpError,
  UpstreamResponseError,
  responseHeaders,
  sendError,
  sendJson,
  sendRaw,
} from './http';
import { queryEntitiesGet, queryEntitiesPost } from './queryEntities';
import { ShardUnavailableError } from './shardClient';

type Handler = (ctx: RequestContext, match: RegExpExecArray) => Promise<void>;

/**
 * Catalog routes that need shard-aware handling. Anything else (OpenAPI
 * spec, analyze-location, actions, ...) has no data dependency and goes to
 * the catch-all shard.
 */
const ROUTES: Array<[methods: string[], pattern: RegExp, handler: Handler]> = [
  [['GET'], /^\/\.backstage\/auth\/v1\/jwks\.json$/, jwks],
  [['GET'], /^\/entities$/, listEntities],
  [['GET'], /^\/entities\/by-query$/, queryEntitiesGet],
  [['POST'], /^\/entities\/by-query$/, queryEntitiesPost],
  [['POST'], /^\/entities\/by-refs$/, entitiesByRefs],
  [['GET'], /^\/entity-facets$/, facetsGet],
  [['POST'], /^\/entity-facets$/, facetsPost],
  [
    ['GET'],
    /^\/entities\/by-name\/([^/]+)\/([^/]+)\/([^/]+)(?:\/ancestry)?$/,
    byName,
  ],
  [['GET', 'DELETE'], /^\/entities\/by-uid\/[^/]+$/, firstFound],
  [['GET'], /^\/locations$/, listLocations],
  [['POST'], /^\/locations$/, createLocation],
  [['POST'], /^\/locations\/by-query$/, queryLocations],
  [['GET'], /^\/locations\/by-entity\/([^/]+)\/([^/]+)\/([^/]+)$/, byName],
  [['GET', 'PUT', 'DELETE'], /^\/locations\/[^/]+$/, firstFound],
  [['POST'], /^\/refresh$/, refresh],
  [['POST'], /^\/validate-entity$/, validateEntity],
  [
    ['POST'],
    /^\/\.well-known\/backstage\/permissions\/apply-conditions$/,
    applyConditions,
  ],
];

function describe(topology: Topology) {
  const list = (set?: ReadonlySet<string>) => (set ? [...set] : undefined);
  return {
    shards: topology.shards.map(shard => ({
      name: shard.name,
      target: shard.target,
      match:
        shard.kinds || shard.namespaces
          ? { kinds: list(shard.kinds), namespaces: list(shard.namespaces) }
          : 'catch-all',
    })),
    localKinds: list(topology.localKinds),
  };
}

function handleError(ctx: RequestContext, error: unknown): void {
  const { req, res } = ctx;
  if (error instanceof UpstreamResponseError) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendRaw(
      res,
      error.status,
      responseHeaders(error.headers, ctx.routingHeaders()),
      error.body,
    );
  } else if (error instanceof ShardUnavailableError) {
    ctx.deps.logger.warn(error.message, { shard: error.shard });
    sendError(
      req,
      res,
      error.timedOut ? 504 : 502,
      error.timedOut ? 'GatewayTimeoutError' : 'BadGatewayError',
      error.message,
      ctx.routingHeaders(),
    );
  } else if (error instanceof HttpError) {
    sendError(req, res, error.status, error.errorName, error.message);
  } else {
    ctx.deps.logger.error('Unexpected error in catalog router', {
      error: error instanceof Error ? error.stack : String(error),
    });
    sendError(req, res, 500, 'Error', 'Unexpected error in catalog router');
  }
}

export interface CatalogRouterOptions extends RouterDeps {
  /** Path prefix the catalog is served under, e.g. `/api/catalog`. */
  basePath: string;
}

export function createRequestListener(
  options: CatalogRouterOptions,
): http.RequestListener {
  const { basePath, topology, logger } = options;

  return (req, res) => {
    const startedAt = performance.now();
    const url = req.url ?? '/';
    const queryStart = url.indexOf('?');
    const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
    const rawQuery = queryStart === -1 ? '' : url.slice(queryStart + 1);

    if (pathname === '/healthz' || pathname === '/readyz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (pathname === '/topology') {
      sendJson(res, 200, describe(topology));
      return;
    }
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      sendError(req, res, 404, 'NotFoundError', `Not found: ${pathname}`);
      return;
    }

    let pinned: Shard | undefined;
    const pinnedName = req.headers[SHARD_HEADER];
    if (typeof pinnedName === 'string' && pinnedName) {
      pinned = topology.get(pinnedName);
      if (!pinned) {
        sendError(
          req,
          res,
          400,
          'InputError',
          `Unknown catalog shard '${pinnedName}' in ${SHARD_HEADER} header`,
        );
        return;
      }
    }

    const path = pathname.slice(basePath.length) || '/';
    const ctx = new RequestContext(options, req, res, path, rawQuery, pinned);
    const route = ROUTES.find(
      ([methods, pattern]) =>
        methods.includes(ctx.method) && pattern.test(path),
    );
    const handled = route
      ? route[2](ctx, route[1].exec(path)!)
      : ctx.forward(ctx.defaultShard, {}, 'default');

    handled
      .catch(error => handleError(ctx, error))
      .finally(() => {
        logger.info('request', {
          method: ctx.method,
          path,
          status: res.statusCode,
          route: ctx.route,
          shards: ctx.shards,
          durationMs: Math.round(performance.now() - startedAt),
        });
      });
  };
}

export function createServer(options: CatalogRouterOptions): http.Server {
  const server = http.createServer(createRequestListener(options));
  // Keep idle client connections (from the gateway) open longer than its
  // keepalive_timeout, so the gateway never reuses a socket we just closed.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}
