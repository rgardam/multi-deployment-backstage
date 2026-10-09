import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { Shard } from '@internal/catalog-sharding';
import { UpstreamResponseError, parseJson, responseHeaders } from './http';

export interface ShardRequest {
  method: string;
  /** Path relative to the shard's catalog base URL, e.g. `/entities`. */
  path: string;
  /** Raw query string without the leading `?`. */
  query?: string;
  headers: http.OutgoingHttpHeaders;
  body?: Buffer;
}

export interface ShardResponse {
  shard: Shard;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** Failures while connecting: the request never left, so retrying is safe. */
const CONNECT_ERRORS = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/** The shard could not be reached or did not answer in time. */
export class ShardUnavailableError extends Error {
  constructor(
    readonly shard: string,
    message: string,
    readonly timedOut = false,
    readonly retryable = false,
  ) {
    super(`Catalog shard '${shard}' ${message}`);
  }
}

/**
 * Every address behind a hostname (one per replica of a scaled shard),
 * re-resolved every few seconds and handed out round-robin. Balancing per
 * request rather than per connection is what lets keep-alive connections and
 * newly added replicas coexist: with plain DNS, a long-lived connection pins
 * all traffic to whichever replica existed when it was opened.
 */
class AddressPool {
  #addresses: string[] = [];
  #next = 0;
  #expiresAt = 0;
  #refreshing?: Promise<void>;

  constructor(
    private readonly hostname: string,
    private readonly ttlMs: number,
  ) {}

  async next(): Promise<string> {
    if (Date.now() >= this.#expiresAt) {
      this.#refreshing ??= this.#refresh().finally(() => {
        this.#refreshing = undefined;
      });
      await this.#refreshing;
    }
    return this.#addresses[this.#next++ % this.#addresses.length];
  }

  /** Re-resolve before the next request, e.g. after a replica went away. */
  invalidate(): void {
    this.#expiresAt = 0;
  }

  async #refresh(): Promise<void> {
    try {
      const records = await dns.promises.lookup(this.hostname, { all: true });
      this.#addresses = records.map(r => r.address).sort();
      this.#expiresAt = Date.now() + this.ttlMs;
    } catch (error) {
      if (!this.#addresses.length) {
        throw error;
      }
      // Keep using the last known replicas while DNS is unhappy
      this.#expiresAt = Date.now() + 1000;
    }
  }
}

export interface ShardClientOptions {
  /** Upper bound for one shard request. */
  timeoutMs: number;
  /** How long resolved replica addresses are trusted. */
  dnsTtlMs?: number;
}

export class ShardClient {
  readonly #timeoutMs: number;
  readonly #dnsTtlMs: number;
  readonly #pools = new Map<string, AddressPool>();
  // Sockets are pooled per replica address, since requests connect by IP
  readonly #httpAgent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  readonly #httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256 });

  constructor(options: ShardClientOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#dnsTtlMs = options.dnsTtlMs ?? 5000;
  }

  #pool(hostname: string): AddressPool {
    let pool = this.#pools.get(hostname);
    if (!pool) {
      pool = new AddressPool(hostname, this.#dnsTtlMs);
      this.#pools.set(hostname, pool);
    }
    return pool;
  }

  /** Sends one request to one replica of the shard. */
  async #send(
    shard: Shard,
    request: ShardRequest,
    onResponse: (res: http.IncomingMessage, settle: () => void) => void,
  ): Promise<void> {
    if (!shard.target) {
      throw new Error(`Catalog shard '${shard.name}' has no target URL`);
    }
    const url = new URL(
      `${shard.target}${request.path}${
        request.query ? `?${request.query}` : ''
      }`,
    );
    const isHttps = url.protocol === 'https:';
    const pool = this.#pool(url.hostname);
    let address: string;
    try {
      address = await pool.next();
    } catch (error) {
      throw new ShardUnavailableError(
        shard.name,
        `could not be resolved: ${(error as Error).message}`,
        false,
        true,
      );
    }

    await new Promise<void>((resolve, reject) => {
      const req = (isHttps ? https : http).request({
        protocol: url.protocol,
        host: address,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: {
          ...request.headers,
          host: url.host,
          ...(request.body ? { 'content-length': request.body.length } : {}),
        },
        agent: isHttps ? this.#httpsAgent : this.#httpAgent,
        ...(isHttps ? { servername: url.hostname } : {}),
      });
      req.setTimeout(this.#timeoutMs, () => {
        req.destroy(
          new ShardUnavailableError(
            shard.name,
            `did not respond within ${this.#timeoutMs}ms`,
            true,
          ),
        );
      });
      req.on('response', res => onResponse(res, resolve));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err instanceof ShardUnavailableError) {
          reject(err);
          return;
        }
        const retryable = CONNECT_ERRORS.has(err.code ?? '');
        if (retryable) {
          pool.invalidate();
        }
        reject(
          new ShardUnavailableError(
            shard.name,
            `is unavailable (${address}): ${err.message}`,
            false,
            retryable,
          ),
        );
      });
      req.end(request.body);
    });
  }

  /** Retries once, on another replica, if the first attempt never connected. */
  async #withRetry(attempt: () => Promise<void>) {
    try {
      await attempt();
    } catch (error) {
      if (error instanceof ShardUnavailableError && error.retryable) {
        await attempt();
        return;
      }
      throw error;
    }
  }

  /** Sends a request and buffers the whole response. */
  async request(shard: Shard, request: ShardRequest): Promise<ShardResponse> {
    let response: ShardResponse | undefined;
    await this.#withRetry(() =>
      this.#send(shard, request, (res, settle) => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        // A response cut short leaves `response` unset and fails below
        res.on('close', settle);
        res.on('end', () => {
          response = {
            shard,
            status: res.statusCode ?? 502,
            headers: res.headers,
            body: Buffer.concat(chunks),
          };
          settle();
        });
      }),
    );
    if (!response) {
      throw new ShardUnavailableError(shard.name, 'closed the response early');
    }
    return response;
  }

  /** Sends a request and parses a 2xx JSON response; anything else throws. */
  async requestJson<T>(
    shard: Shard,
    request: ShardRequest,
  ): Promise<{ response: ShardResponse; json: T }> {
    const response = await this.request(shard, request);
    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamResponseError(
        shard.name,
        response.status,
        response.headers,
        response.body,
      );
    }
    return {
      response,
      json: parseJson(
        response.body,
        `response from shard '${shard.name}'`,
      ) as T,
    };
  }

  /** Streams a shard's response straight back to the client. */
  async forward(
    shard: Shard,
    request: ShardRequest,
    res: http.ServerResponse,
    extraHeaders: http.OutgoingHttpHeaders,
  ): Promise<void> {
    await this.#withRetry(() =>
      this.#send(shard, request, (upstream, settle) => {
        res.writeHead(
          upstream.statusCode ?? 502,
          responseHeaders(upstream.headers, extraHeaders),
        );
        upstream.pipe(res);
        upstream.on('close', settle);
        upstream.on('error', err => res.destroy(err));
      }),
    );
  }

  close(): void {
    this.#httpAgent.destroy();
    this.#httpsAgent.destroy();
  }
}
