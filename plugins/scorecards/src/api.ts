import { FetchApi } from '@backstage/frontend-plugin-api';
import type {
  ScorecardResult,
  ScorecardSummary,
} from '@internal/backstage-plugin-scorecards-common';

async function getJson<T>(fetchApi: FetchApi, url: string): Promise<T> {
  const response = await fetchApi.fetch(url);
  if (!response.ok) {
    throw new Error(
      `Scorecards request failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

export function getScorecard(
  fetchApi: FetchApi,
  entity: { kind: string; namespace: string; name: string },
): Promise<ScorecardResult> {
  const path = [entity.kind, entity.namespace, entity.name]
    .map(part => encodeURIComponent(part.toLocaleLowerCase('en-US')))
    .join('/');
  return getJson(fetchApi, `plugin://scorecards/entities/${path}`);
}

export function getSummary(
  fetchApi: FetchApi,
  kind: string,
): Promise<ScorecardSummary> {
  return getJson(
    fetchApi,
    `plugin://scorecards/summary?kind=${encodeURIComponent(kind)}`,
  );
}
