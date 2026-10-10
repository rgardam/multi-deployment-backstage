/*
 * External access for CI with an allowlist of claims: tokens of type
 * `jwks-claims` are checked like the built-in `jwks` type (signature against
 * the issuer's public keys, issuer, audience, algorithm, expiry), and must
 * also carry the claim values the config requires.
 *
 * The built-in check is not enough for a shared issuer such as GitHub
 * Actions': it signs tokens for every repository on GitHub, and a workflow
 * picks its own audience, so only claims like `repository_owner_id` tell
 * whose workflow is calling.
 *
 *   backend.auth.externalAccess:
 *     - type: jwks-claims
 *       options:
 *         url: https://token.actions.githubusercontent.com/.well-known/jwks
 *         issuer: https://token.actions.githubusercontent.com
 *         audience: backstage-ci
 *         subjectPrefix: ci
 *         claims:                          # every claim must match
 *           repository_owner_id: '857801'  # one value, or a list
 */
import {
  coreServices,
  createServiceFactory,
  LoggerService,
} from '@backstage/backend-plugin-api';
import {
  createExternalTokenHandler,
  ExternalTokenHandler,
  externalTokenHandlersServiceRef,
} from '@backstage/backend-defaults/auth';
import { createRemoteJWKSet, JWTPayload, jwtVerify } from 'jose';

export const JWKS_CLAIMS_TYPE = 'jwks-claims';

type Config = Parameters<
  ExternalTokenHandler<unknown>['initialize']
>[0]['options'];

/** A string, or a list of strings (also as one comma or space separated string) */
function readStrings(options: Config, key: string): string[] | undefined {
  if (!options.has(key)) {
    return undefined;
  }
  const raw = Array.isArray(options.get(key))
    ? options.getStringArray(key)
    : [options.getString(key)];
  const values = raw.flatMap(value => value.split(/[\s,]+/)).filter(Boolean);
  return values.length ? values : undefined;
}

function requireStrings(options: Config, key: string): string[] {
  const values = readStrings(options, key);
  if (!values) {
    throw new Error(
      `External access of type '${JWKS_CLAIMS_TYPE}' needs options.${key}`,
    );
  }
  return values;
}

/** claim name -> allowed values; values may be strings or numbers in config */
function readRequiredClaims(options: Config): Map<string, string[]> {
  const config = options.getOptionalConfig('claims');
  const claims = new Map<string, string[]>();
  for (const name of config?.keys() ?? []) {
    const raw = config!.get(name);
    const values = (Array.isArray(raw) ? raw : [raw]).map(value => {
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new Error(
          `options.claims.${name} must be a string, a number, or a list of them`,
        );
      }
      return String(value);
    });
    if (!values.length) {
      throw new Error(`options.claims.${name} lists no allowed values`);
    }
    claims.set(name, values);
  }
  if (!claims.size) {
    // Without a claim this is the plain jwks check, which is what this type
    // exists to tighten: refuse to start rather than accept every repository
    throw new Error(
      `External access of type '${JWKS_CLAIMS_TYPE}' needs at least one claim under options.claims`,
    );
  }
  return claims;
}

function claimMatches(value: unknown, allowed: string[]): boolean {
  return (Array.isArray(value) ? value : [value]).some(
    item =>
      (typeof item === 'string' || typeof item === 'number') &&
      allowed.includes(String(item)),
  );
}

export function createJwksClaimsTokenHandler(logger: LoggerService) {
  return createExternalTokenHandler({
    type: JWKS_CLAIMS_TYPE,
    initialize({ options }) {
      return {
        jwks: createRemoteJWKSet(new URL(options.getString('url'))),
        // Unlike the built-in type, issuer and audience are required: either
        // missing would accept tokens meant for any service
        issuers: requireStrings(options, 'issuer'),
        audiences: requireStrings(options, 'audience'),
        algorithms: readStrings(options, 'algorithm'),
        subjectPrefix: options.getOptionalString('subjectPrefix'),
        claims: readRequiredClaims(options),
      };
    },
    async verifyToken(token, context) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, context.jwks, {
          issuer: context.issuers,
          audience: context.audiences,
          algorithms: context.algorithms,
        }));
      } catch {
        // Not a valid token from this issuer: another handler may take it
        return undefined;
      }
      if (!payload.sub) {
        return undefined;
      }
      for (const [name, allowed] of context.claims) {
        if (!claimMatches(payload[name], allowed)) {
          logger.warn(
            `Refused an external access token for ${payload.sub}: its ${name} claim is not allowed`,
            { claim: name, value: JSON.stringify(payload[name] ?? null) },
          );
          return undefined;
        }
      }
      const prefix = context.subjectPrefix
        ? `external:${context.subjectPrefix}:`
        : 'external:';
      return { subject: `${prefix}${payload.sub}` };
    },
  });
}

/** Adds the `jwks-claims` type to backend.auth.externalAccess */
export const jwksClaimsTokenHandler = createServiceFactory({
  service: externalTokenHandlersServiceRef,
  deps: { logger: coreServices.logger },
  factory({ logger }) {
    return createJwksClaimsTokenHandler(logger);
  },
});
