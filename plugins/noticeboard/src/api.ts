import { FetchApi } from '@backstage/frontend-plugin-api';

/** A notice as served by the noticeboard backend. */
export type Notice = {
  id: string;
  title: string;
  body: string;
  author: string;
  createdAt: string;
};

// `plugin://` URLs are resolved through the discovery API, i.e. to the gateway
// path the noticeboard backend is served under.
const NOTICES = 'plugin://noticeboard/notices';

async function check(response: Response): Promise<Response> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Noticeboard request failed: ${response.status} ${text}`);
  }
  return response;
}

export async function listNotices(fetchApi: FetchApi): Promise<Notice[]> {
  const response = await check(await fetchApi.fetch(NOTICES));
  return (await response.json()).items;
}

export async function postNotice(
  fetchApi: FetchApi,
  notice: { title: string; body: string },
): Promise<Notice> {
  const response = await check(
    await fetchApi.fetch(NOTICES, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(notice),
    }),
  );
  return response.json();
}
