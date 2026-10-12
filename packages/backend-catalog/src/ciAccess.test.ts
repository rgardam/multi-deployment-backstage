import { mockServices } from '@backstage/backend-test-utils';
import { exportJWK, generateKeyPair, KeyLike, SignJWT } from 'jose';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createJwksClaimsTokenHandler } from './ciAccess';

const ISSUER = 'https://token.ci.example';
const OWN_REPO = 'repo:rgardam/multi-deployment-backstage:ref:refs/heads/main';

describe('jwks-claims external access', () => {
  const logger = mockServices.rootLogger.mock();
  const handler = createJwksClaimsTokenHandler(logger);
  let server: Server;
  let jwksUrl: string;
  let issuerKey: KeyLike;
  let otherKey: KeyLike;

  beforeAll(async () => {
    const issuerPair = await generateKeyPair('RS256');
    issuerKey = issuerPair.privateKey;
    otherKey = (await generateKeyPair('RS256')).privateKey;
    const jwk = await exportJWK(issuerPair.publicKey);
    const body = JSON.stringify({
      keys: [{ ...jwk, kid: 'ci-key', alg: 'RS256', use: 'sig' }],
    });
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(body);
    });
    await new Promise<void>(resolve =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const { port } = server.address() as AddressInfo;
    jwksUrl = `http://127.0.0.1:${port}/.well-known/jwks`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => jest.clearAllMocks());

  const contextFor = (options: Record<string, unknown> = {}) =>
    handler.initialize({
      options: mockServices.rootConfig({
        data: {
          url: jwksUrl,
          issuer: ISSUER,
          audience: 'backstage-ci',
          subjectPrefix: 'ci',
          claims: { repository_owner_id: '857801' },
          ...options,
        } as any,
      }),
    });

  /** A token like the ones GitHub Actions issues a job in this repository */
  const tokenFor = (
    claims: Record<string, unknown> = {},
    sign: { issuer?: string; audience?: string; key?: KeyLike } = {},
  ) =>
    new SignJWT({
      repository: 'rgardam/multi-deployment-backstage',
      repository_owner: 'rgardam',
      repository_owner_id: '857801',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'ci-key' })
      .setIssuer(sign.issuer ?? ISSUER)
      .setAudience(sign.audience ?? 'backstage-ci')
      .setSubject(OWN_REPO)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(sign.key ?? issuerKey);

  it('accepts a token with the required claims, naming the caller by its subject', async () => {
    await expect(
      handler.verifyToken(await tokenFor(), contextFor()),
    ).resolves.toEqual({ subject: `external:ci:${OWN_REPO}` });
  });

  it("refuses a valid token from another owner's workflow, and logs why", async () => {
    const token = await tokenFor({
      repository: 'someone-else/their-repository',
      repository_owner: 'someone-else',
      repository_owner_id: '2',
    });
    await expect(
      handler.verifyToken(token, contextFor()),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      `Refused an external access token for ${OWN_REPO}: its repository_owner_id claim is not allowed`,
      { claim: 'repository_owner_id', value: '"2"' },
    );
  });

  it('checks the owner by ID, so a re-registered owner name does not pass', async () => {
    const token = await tokenFor({ repository_owner_id: '99999999' });
    await expect(
      handler.verifyToken(token, contextFor()),
    ).resolves.toBeUndefined();
  });

  it('refuses a token that lacks a required claim', async () => {
    const token = await tokenFor({ repository_owner_id: undefined });
    await expect(
      handler.verifyToken(token, contextFor()),
    ).resolves.toBeUndefined();
  });

  it('requires every listed claim, any one of its values', async () => {
    const context = contextFor({
      claims: {
        repository_owner_id: [857801, '123'],
        repository: ['rgardam/multi-deployment-backstage', 'rgardam/other'],
      },
    });
    await expect(
      handler.verifyToken(
        await tokenFor({ repository_owner_id: 123 }),
        context,
      ),
    ).resolves.toEqual({ subject: `external:ci:${OWN_REPO}` });
    await expect(
      handler.verifyToken(
        await tokenFor({ repository: 'rgardam/not-listed' }),
        context,
      ),
    ).resolves.toBeUndefined();
  });

  it('still checks the signature, issuer and audience', async () => {
    const context = contextFor();
    for (const token of [
      await tokenFor({}, { key: otherKey }),
      await tokenFor({}, { issuer: 'https://token.elsewhere.example' }),
      await tokenFor({}, { audience: 'another-service' }),
    ]) {
      await expect(
        handler.verifyToken(token, context),
      ).resolves.toBeUndefined();
    }
  });

  it('refuses to start without a claim to check, an issuer or an audience', () => {
    expect(() => contextFor({ claims: undefined })).toThrow(
      /needs at least one claim/,
    );
    expect(() => contextFor({ claims: { repository_owner_id: [] } })).toThrow(
      /lists no allowed values/,
    );
    expect(() => contextFor({ issuer: undefined })).toThrow(/options.issuer/);
    expect(() => contextFor({ audience: undefined })).toThrow(
      /options.audience/,
    );
  });
});
