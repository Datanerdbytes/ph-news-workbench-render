import { describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/db';
import { GET } from './route';

vi.mock('@/lib/db', () => ({ sql: vi.fn() }));
vi.mock('@/lib/session', () => ({
  requireWorkspace: vi.fn().mockResolvedValue({ workspace: { id: 'ws1' } }),
  unauthorized: vi.fn(),
}));

describe('GET /api/source-items', () => {
  it.each([[0.5, 1], [500, 50]])('paginates with a bounded limit when asked for %s', async (requested, limit) => {
    const rows = Array.from({ length: limit + 1 }, (_, i) => ({ id: 100 - i }));
    const query = vi.mocked(sql).mockResolvedValueOnce(rows);

    const res = await GET(new Request(`https://example.test/api/source-items?limit=${requested}`));

    expect(res.status).toBe(200);
    expect(query.mock.lastCall?.at(-1)).toBe(limit + 1);
    expect(await res.json()).toEqual({
      rows: rows.slice(0, limit),
      hasMore: true,
      nextCursor: rows[limit - 1].id,
    });
  });
});
