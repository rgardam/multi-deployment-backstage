/*
 * catalog-router: serves /api/catalog for a set of catalog shards.
 *
 *   CATALOG_SHARDS_FILE  shard topology (JSON, same file the shards read)
 *   PORT                 listen port (default 7007)
 *   CATALOG_BASE_PATH    path the catalog is served under (default /api/catalog)
 *   SHARD_TIMEOUT_MS     per shard request timeout (default 30000)
 *   LOG_LEVEL            debug | info | warn | error (default info)
 */
import { readFileSync } from 'node:fs';
import { readTopology } from '@internal/catalog-sharding';
import { createLogger } from './logger';
import { createServer } from './server';
import { ShardClient } from './shardClient';

const logger = createLogger(process.env.LOG_LEVEL);

function main() {
  const file = process.env.CATALOG_SHARDS_FILE ?? '/config/catalog-shards.json';
  const topology = readTopology(JSON.parse(readFileSync(file, 'utf8')));
  const missingTarget = topology.shards.find(shard => !shard.target);
  if (missingTarget) {
    throw new Error(
      `Catalog shard '${missingTarget.name}' in ${file} has no "target" URL`,
    );
  }

  const client = new ShardClient({
    timeoutMs: Number(process.env.SHARD_TIMEOUT_MS ?? 30_000),
  });
  const server = createServer({
    topology,
    client,
    logger,
    basePath: process.env.CATALOG_BASE_PATH ?? '/api/catalog',
  });

  const port = Number(process.env.PORT ?? 7007);
  server.listen(port, () => {
    logger.info(`Catalog router listening on :${port}`, {
      shards: topology.shards.map(s => `${s.name} -> ${s.target}`),
    });
  });

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}, draining connections`);
    server.close(() => {
      client.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (error) {
  logger.error('Catalog router failed to start', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
