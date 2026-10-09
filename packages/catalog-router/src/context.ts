import {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';
import {
  Constraint,
  Shard,
  Topology,
  candidateShards,
} from '@internal/catalog-sharding';
import { Logger } from './logger';
import { ShardClient, ShardRequest, ShardResponse } from './shardClient';
import { readBody, requestHeaders } from './http';

export type RouteKind = 'single' | 'fanout' | 'pinned' | 'default';

export interface RouterDeps {
  topology: Topology;
  client: ShardClient;
  logger: Logger;
}

/** Header that pins a request to one shard, bypassing query-based routing. */
export const SHARD_HEADER = 'x-catalog-shard';

export class RequestContext {
  /** Which shards served the request; surfaced in headers and logs. */
  route: RouteKind = 'default';
  shards: string[] = [];
  #body?: Promise<Buffer>;

  constructor(
    readonly deps: RouterDeps,
    readonly req: IncomingMessage,
    readonly res: ServerResponse,
    /** Catalog-relative path, still percent-encoded, e.g. `/entities/by-query`. */
    readonly path: string,
    /** Raw query string without the `?`. */
    readonly rawQuery: string,
    /** Set when the client pinned the request to a shard. */
    readonly pinned?: Shard,
  ) {}

  get method(): string {
    return this.req.method ?? 'GET';
  }

  get params(): URLSearchParams {
    return new URLSearchParams(this.rawQuery);
  }

  get topology(): Topology {
    return this.deps.topology;
  }

  get client(): ShardClient {
    return this.deps.client;
  }

  body(): Promise<Buffer> {
    this.#body ??= readBody(this.req);
    return this.#body;
  }

  /** Shards that may hold matching entities (just the pinned one if pinned). */
  candidates(constraints: readonly Constraint[]): Shard[] {
    if (this.pinned) {
      return [this.pinned];
    }
    const shards = candidateShards(this.topology, constraints);
    // A query that can't match anything still needs a well-formed answer
    return shards.length ? shards : [this.topology.catchAll];
  }

  /** The shard to use when there is no data dependency. */
  get defaultShard(): Shard {
    return this.pinned ?? this.topology.catchAll;
  }

  served(route: RouteKind, shards: readonly Shard[]): void {
    this.route = this.pinned ? 'pinned' : route;
    this.shards = shards.map(s => s.name);
  }

  routingHeaders(): OutgoingHttpHeaders {
    return {
      'x-catalog-route': this.route,
      'x-catalog-shards': this.shards.join(','),
    };
  }

  /** Headers for a buffered upstream request whose response we will parse. */
  upstreamHeaders(overrides: OutgoingHttpHeaders = {}): OutgoingHttpHeaders {
    return requestHeaders(this.req.headers, {
      'accept-encoding': 'identity',
      ...overrides,
    });
  }

  /** Streams the request to one shard and the response back. */
  async forward(
    shard: Shard,
    overrides: { path?: string; query?: string; body?: Buffer } = {},
    route: RouteKind = 'single',
  ): Promise<void> {
    this.served(route, [shard]);
    const body =
      overrides.body ??
      (['GET', 'HEAD'].includes(this.method) ? undefined : await this.body());
    await this.client.forward(
      shard,
      {
        method: this.method,
        path: overrides.path ?? this.path,
        query: overrides.query ?? this.rawQuery,
        headers: requestHeaders(this.req.headers),
        body,
      },
      this.res,
      this.routingHeaders(),
    );
  }

  /** Sends one request per shard in parallel and buffers the responses. */
  fanOut(
    shards: readonly Shard[],
    build: (shard: Shard, index: number) => ShardRequest,
  ): Promise<ShardResponse[]> {
    this.served(shards.length > 1 ? 'fanout' : 'single', shards);
    return Promise.all(
      shards.map((shard, i) => this.client.request(shard, build(shard, i))),
    );
  }
}
