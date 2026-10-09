import {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

/** An error that maps to an HTTP response in the catalog's error format. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorName: string,
    message: string,
  ) {
    super(message);
  }
}

/** A shard answered with a non-2xx status that should be relayed as-is. */
export class UpstreamResponseError extends Error {
  constructor(
    readonly shard: string,
    readonly status: number,
    readonly headers: IncomingHttpHeaders,
    readonly body: Buffer,
  ) {
    super(`Catalog shard '${shard}' responded with ${status}`);
  }
}

export async function readBody(
  req: IncomingMessage,
  limitBytes = 16 * 1024 * 1024,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new HttpError(
        413,
        'PayloadTooLargeError',
        'Request body too large',
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function parseJson(body: Buffer, what = 'request body'): unknown {
  if (!body.length) {
    return undefined;
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'InputError', `Malformed ${what}, expected JSON`);
  }
}

/** Headers to send upstream: everything except hop-by-hop and framing. */
export function requestHeaders(
  incoming: IncomingHttpHeaders,
  overrides: OutgoingHttpHeaders = {},
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (
      value !== undefined &&
      !HOP_BY_HOP.has(name) &&
      name !== 'host' &&
      name !== 'content-length'
    ) {
      headers[name] = value;
    }
  }
  return { ...headers, ...overrides };
}

/** Headers to relay downstream from a shard response. */
export function responseHeaders(
  incoming: IncomingHttpHeaders,
  extra: OutgoingHttpHeaders = {},
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) {
      headers[name] = value;
    }
  }
  return { ...headers, ...extra };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
  });
  res.end(payload);
}

export function sendRaw(
  res: ServerResponse,
  status: number,
  headers: OutgoingHttpHeaders,
  body: Buffer,
): void {
  res.writeHead(status, {
    ...headers,
    'content-length': body.length,
  });
  res.end(body);
}

/** Writes an error using Backstage's standard error response body. */
export function sendError(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  name: string,
  message: string,
  headers: OutgoingHttpHeaders = {},
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(
    res,
    status,
    {
      error: { name, message },
      request: { method: req.method, url: req.url },
      response: { statusCode: status },
    },
    headers,
  );
}
