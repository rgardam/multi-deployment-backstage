/*
 * Gets the token a CI job calls Backstage with: a short-lived OIDC token
 * from the CI platform itself, so the job needs no stored secret.
 *
 *   ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN
 *       GitHub Actions sets these when the job has `id-token: write`.
 *       Locally they point at the stand-in ci-oidc service.
 *   BACKSTAGE_TOKEN
 *       Otherwise, a token the CI platform already handed the job (GitLab
 *       id_tokens, Buildkite OIDC, ...).
 */
export const DEFAULT_AUDIENCE = 'backstage-ci';

export async function ciToken({
  audience = process.env.BACKSTAGE_AUDIENCE || DEFAULT_AUDIENCE,
  // The job's own, unless a test plays another job
  requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
} = {}) {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: requestUrl, BACKSTAGE_TOKEN: token } =
    process.env;

  if (requestUrl && requestToken) {
    const url = new URL(requestUrl);
    url.searchParams.set('audience', audience);
    const res = await fetch(url, {
      headers: { authorization: `bearer ${requestToken}` },
    });
    if (!res.ok) {
      throw new Error(
        `The CI platform refused an OIDC token: ${
          res.status
        } ${await res.text()}`,
      );
    }
    return (await res.json()).value;
  }
  if (token) {
    return token;
  }
  throw new Error(
    'No CI token: in GitHub Actions give the job `permissions: id-token: write`; elsewhere set BACKSTAGE_TOKEN',
  );
}
