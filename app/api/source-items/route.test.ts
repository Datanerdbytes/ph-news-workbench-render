import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/db';
import { GET } from './route';

vi.mock('@/lib/db', () => ({ sql: vi.fn() }));
vi.mock('@/lib/session', () => ({
  requireWorkspace: vi.fn().mockResolvedValue({ workspace: { id: 'ws1' } }),
  unauthorized: vi.fn(),
}));

function story(id: number) {
  return {
    id,
    title: `Story ${id}`,
    summary: 'Summary',
    link: `https://example.test/${id}`,
    image_url: null,
    published_at: '2026-11-24T02:00:00.000Z',
    created_at: '2026-11-24T02:00:00.000Z',
    feed_id: 7,
    feed_title: 'Example Feed',
    status: 'pending',
  };
}

function queryResult(rows: ReturnType<typeof story>[], total = 75) {
  return [{ total, rows: JSON.stringify(rows) }];
}

function queryValues() {
  return vi.mocked(sql).mock.lastCall?.slice(1) ?? [];
}

beforeEach(() => {
  vi.mocked(sql).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/source-items', () => {
  it.each([[0.5, 1], [500, 50]])('paginates with a bounded limit when asked for %s', async (requested, limit) => {
    const rows = Array.from({ length: limit + 1 }, (_, i) => story(100 - i));
    vi.mocked(sql).mockResolvedValueOnce(queryResult(rows));

    const res = await GET(new Request(`https://example.test/api/source-items?limit=${requested}`));

    expect(res.status).toBe(200);
    expect(queryValues().at(-1)).toBe(limit + 1);
    expect(await res.json()).toEqual({
      rows: rows.slice(0, limit),
      total: 75,
      hasMore: true,
      nextCursor: rows[limit - 1].id,
    });
  });

  it('defaults to Today using the Manila day boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T16:30:00.000Z'));
    vi.mocked(sql).mockResolvedValueOnce(queryResult([story(1)], 1));

    const res = await GET(new Request('https://example.test/api/source-items'));

    expect(res.status).toBe(200);
    expect(queryValues()).toEqual(expect.arrayContaining([
      'ws1',
      '2026-11-24T16:00:00.000Z',
      '2026-11-25T16:00:00.000Z',
    ]));
    expect(vi.mocked(sql).mock.lastCall?.[0].join('')).toContain('n.published_at >=');
  });

  it('filters a specific day with an exclusive next-day end', async () => {
    vi.mocked(sql).mockResolvedValueOnce(queryResult([], 0));

    const res = await GET(new Request(
      'https://example.test/api/source-items?range=day&date=2026-11-24',
    ));

    expect(res.status).toBe(200);
    expect(queryValues()).toEqual(expect.arrayContaining([
      '2026-11-23T16:00:00.000Z',
      '2026-11-24T16:00:00.000Z',
    ]));
    expect(await res.json()).toEqual({ rows: [], total: 0, nextCursor: null, hasMore: false });
  });

  it('filters a specific month with an exclusive next-month start', async () => {
    vi.mocked(sql).mockResolvedValueOnce(queryResult([], 0));

    const res = await GET(new Request(
      'https://example.test/api/source-items?range=month&month=2024-02',
    ));

    expect(res.status).toBe(200);
    expect(queryValues()).toEqual(expect.arrayContaining([
      '2024-01-31T16:00:00.000Z',
      '2024-02-29T16:00:00.000Z',
    ]));
  });

  it('leaves All time unbounded', async () => {
    vi.mocked(sql).mockResolvedValueOnce(queryResult([], 0));

    const res = await GET(new Request('https://example.test/api/source-items?range=all'));

    expect(res.status).toBe(200);
    expect(queryValues()).toEqual(expect.arrayContaining([null, null]));
  });

  it('searches normalized text and RSS author/tag metadata with literal AND terms', async () => {
    vi.mocked(sql).mockResolvedValueOnce(queryResult([], 0));

    const res = await GET(new Request(
      'https://example.test/api/source-items?q=Maya%25%20Santos%20flood_',
    ));

    expect(res.status).toBe(200);
    expect(queryValues()).toContainEqual(['%Maya\\%%', '%Santos%', '%flood\\_%']);
    const queryText = vi.mocked(sql).mock.lastCall?.[0].join('');
    expect(queryText).toContain('unnest(');
    expect(queryText).toContain('n.title ILIKE');
    expect(queryText).toContain('n.summary ILIKE');
    expect(queryText).toContain('f.title ILIKE');
    expect(queryText).toContain("raw_payload->>'creator'");
    expect(queryText).toContain("COALESCE(n.raw_payload->>'categories', '')");
  });

  it('combines workspace, source, date, search, and cursor filters without losing totals', async () => {
    const rows = [story(100), story(99), story(98)];
    vi.mocked(sql).mockResolvedValueOnce(queryResult(rows, 77));

    const res = await GET(new Request(
      'https://example.test/api/source-items?feed=7&range=day&date=2026-11-24&q=flood&before=90&limit=2',
    ));

    expect(res.status).toBe(200);
    expect(queryValues()).toEqual(expect.arrayContaining([
      'ws1',
      7,
      '2026-11-23T16:00:00.000Z',
      '2026-11-24T16:00:00.000Z',
      ['%flood%'],
      90,
      3,
    ]));
    const payload = await res.json();
    expect(payload.total).toBe(77);
    expect(payload.rows.map((row: { id: number }) => row.id)).toEqual([100, 99]);
    expect(payload.nextCursor).toBe(99);
  });

  it('keeps the filtered total when a cursor page is empty', async () => {
    vi.mocked(sql).mockResolvedValueOnce(queryResult([], 12));

    const res = await GET(new Request(
      'https://example.test/api/source-items?range=all&before=1',
    ));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rows: [],
      total: 12,
      nextCursor: null,
      hasMore: false,
    });
    const queryText = vi.mocked(sql).mock.lastCall?.[0].join('');
    expect(queryText).toContain('SELECT COUNT(*)::int FROM stories');
    expect(queryText).toContain('json_agg(row_to_json(page)');
  });

  it.each([
    'range=week',
    'range=day',
    'range=day&date=2026-02-30',
    'range=month',
    'range=month&month=2026-13',
    `q=${'a'.repeat(201)}`,
  ])('returns 400 without querying for invalid filters: %s', async query => {
    const res = await GET(new Request(`https://example.test/api/source-items?${query}`));

    expect(res.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it('returns a controlled error when the database query fails', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('database unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(new Request('https://example.test/api/source-items?range=all'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load stories' });
    consoleError.mockRestore();
  });
});
