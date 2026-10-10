#!/usr/bin/env node
/*
 * A stand-in for a CI platform's OIDC token service, shaped like the one in
 * GitHub Actions, so CI access to Backstage can be tried locally. A CI job
 * asks it for a short-lived token for an audience; Backstage checks those
 * tokens against the public keys published here. In GitHub Actions, GitHub
 * plays this part (https://token.actions.githubusercontent.com).
 *
 *   GET /token?audience=<aud>   Authorization: bearer <REQUEST_TOKEN>
 *       -> {"value": "<JWT>"}, like ACTIONS_ID_TOKEN_REQUEST_URL in a job
 *   GET /.well-known/jwks       the public keys
 *   GET /.well-known/openid-configuration
 *
 * The tokens describe one fixed CI job (REPOSITORY, REF), as GitHub's
 * describe the job that asked: the caller only picks the audience.
 * Zero dependencies; the signing key is kept in KEY_FILE across restarts.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const issuer = process.env.ISSUER ?? 'http://ci-oidc:8080';
const requestToken = process.env.REQUEST_TOKEN;
const repository = process.env.REPOSITORY ?? 'rgardam/rgardam';
const ref = process.env.REF ?? 'refs/heads/main';
const ttlSeconds = Number(process.env.TOKEN_TTL_SECONDS ?? 300);
const keyFile = process.env.KEY_FILE ?? '/home/node/signing-key.pem';
if (!requestToken) {
  throw new Error('REQUEST_TOKEN is not set');
}

function loadKey() {
  if (existsSync(keyFile)) {
    return createPrivateKey(readFileSync(keyFile));
  }
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  return privateKey;
}

const privateKey = loadKey();
const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' });
const kid = createHash('sha256').update(publicJwk.n).digest('base64url');
const jwks = { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] };
const owner = repository.split('/')[0];

const encode = value =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

function issueToken(audience) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'RS256', typ: 'JWT', kid });
  const payload = encode({
    iss: issuer,
    aud: audience,
    // The same claims GitHub puts in a job's token, for a push to REF
    sub: `repo:${repository}:ref:${ref}`,
    repository,
    repository_owner: owner,
    ref,
    jti: randomUUID(),
    iat: now,
    nbf: now,
    exp: now + ttlSeconds,
  });
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    privateKey,
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function isAuthorized(header = '') {
  const [scheme, value = ''] = header.split(' ');
  const given = Buffer.from(value);
  const expected = Buffer.from(requestToken);
  return (
    scheme.toLowerCase() === 'bearer' &&
    given.length === expected.length &&
    timingSafeEqual(given, expected)
  );
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'GET') {
    send(res, 405, { error: 'Method not allowed' });
    return;
  }
  switch (url.pathname) {
    case '/healthz':
      send(res, 200, { status: 'ok' });
      return;
    case '/.well-known/jwks':
      send(res, 200, jwks);
      return;
    case '/.well-known/openid-configuration':
      send(res, 200, {
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks`,
        subject_types_supported: ['public'],
        response_types_supported: ['id_token'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
      return;
    case '/token':
      if (!isAuthorized(req.headers.authorization)) {
        send(res, 401, { error: 'Missing or wrong request token' });
        return;
      }
      send(res, 200, {
        // GitHub's default audience, when the job does not ask for one
        value: issueToken(
          url.searchParams.get('audience') || `https://github.com/${owner}`,
        ),
      });
      return;
    default:
      send(res, 404, { error: 'Not found' });
  }
}).listen(8080, () => {
  console.log(`ci-oidc: issuer ${issuer}, signing key ${kid}`);
});
