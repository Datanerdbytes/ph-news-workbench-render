import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedParser, resolveFeedUrl } from '@/lib/feeds';
import { GET } from './route';

vi.mock('@/lib/db', () => ({ sql: vi.fn() }));
vi.mock('@/lib/session', () => ({
  requireWorkspace: vi.fn(async () => ({ workspace: { id: 'ws1' } })),
  unauthorized: vi.fn(),
}));
vi.mock('@/lib/feeds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/feeds')>();
  return { ...actual, resolveFeedUrl: vi.fn(), feedParser: { parseURL: vi.fn() } };
});

function preview(url: string) {
  return GET(new Request(`https://app.example/api/sources/preview?${new URLSearchParams({ url })}`));
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('GET /api/sources/preview', () => {
  it('keeps the rest of the preview when a story date is invalid', async () => {
    vi.mocked(resolveFeedUrl).mockResolvedValue('https://news.example/feed');
    const media = { 'media:content': undefined, 'media:thumbnail': undefined, 'media:group': undefined };
    vi.mocked(feedParser.parseURL).mockResolvedValue({
      items: [
        { ...media, title: 'Invalid', pubDate: 'not a date' },
        { ...media, title: 'Valid', pubDate: 'Mon, 02 Nov 2026 10:00:00 GMT' },
        { ...media, title: 'Missing' },
      ],
    });
    const response = await preview('https://news.example/feed');
    expect(response.status).toBe(200);
    expect((await response.json()).items).toMatchObject([
      { title: 'Invalid', published_at: null },
      { title: 'Valid', published_at: '2026-11-02T10:00:00.000Z' },
      { title: 'Missing', published_at: null },
    ]);
  });

  it('logs only the URL origin and path on failure, even when the error echoes credentials', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const url = 'https://alice:secret@news.example/feed?access_token=signed-value#secret-fragment';
    vi.mocked(resolveFeedUrl).mockRejectedValue(new Error(`Failed to look up ${url}`));

    expect((await preview(url)).status).toBe(400);
    expect(log).toHaveBeenCalledOnce();
    const [logged] = log.mock.calls[0];
    expect(JSON.parse(logged)).toMatchObject({ url: 'https://news.example/feed' });
    expect(logged).not.toMatch(/alice|secret|signed-value/);
  });
});
