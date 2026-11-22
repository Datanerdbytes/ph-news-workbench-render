import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchArticleImage } from './article-image';

const { lookup, fetch, destroy } = vi.hoisted(() => ({
  lookup: vi.fn(),
  fetch: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({ lookup }));
vi.mock('undici', () => ({
  fetch,
  buildConnector: vi.fn(),
  Agent: class {
    close = vi.fn();
    destroy = destroy;
  },
}));

const article = 'https://old.example/story';

beforeEach(() => {
  vi.resetAllMocks();
  lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

function openResponse(status: number, headers: HeadersInit) {
  const cancel = vi.fn();
  return {
    response: new Response(new ReadableStream({ cancel }), { status, headers }),
    cancel,
  };
}

describe('fetchArticleImage', () => {
  it('checks each redirect through the pinned transport and uses the final URL as the image base', async () => {
    const { response, cancel } = openResponse(302, { location: 'https://news.example/posts/story' });
    fetch.mockResolvedValueOnce(response).mockResolvedValueOnce(
      new Response('<meta property="og:image" content="cover.jpg">', {
        headers: { 'content-type': 'text/html' },
      }),
    );

    await expect(fetchArticleImage(article)).resolves.toBe('https://news.example/posts/cover.jpg');
    expect(cancel).toHaveBeenCalledOnce();
    expect(lookup.mock.calls.map(([host]) => host)).toEqual(['old.example', 'news.example']);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, options] of fetch.mock.calls) {
      expect(options).toMatchObject({ redirect: 'manual', dispatcher: expect.any(Object) });
    }
  });

  it('rejects non-public destinations on the initial request and redirects before dispatch', async () => {
    lookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    await expect(fetchArticleImage(article)).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    const { response, cancel } = openResponse(301, { location: 'https://other.example/story' });
    lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    lookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    fetch.mockResolvedValueOnce(response);
    await expect(fetchArticleImage(article)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([[404, 'text/html'], [200, 'image/png']])('cancels a rejected body (%s, %s)', async (status, type) => {
    const { response, cancel } = openResponse(status, { 'content-type': type });
    fetch.mockResolvedValueOnce(response);

    await expect(fetchArticleImage(article)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
