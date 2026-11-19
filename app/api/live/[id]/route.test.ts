import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, requireWorkspaceMock, requirePublishingConnectionMock, managerMock, endLiveMock } =
  vi.hoisted(() => ({
    sqlMock: vi.fn(),
    requireWorkspaceMock: vi.fn(),
    requirePublishingConnectionMock: vi.fn(),
    managerMock: { stop: vi.fn() },
    endLiveMock: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({ sql: sqlMock }));
vi.mock('@/lib/session', () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
}));
vi.mock('@/lib/publishing/connection', () => ({
  requirePublishingConnection: requirePublishingConnectionMock,
}));
vi.mock('@/lib/publishing/live', () => ({ endPageLiveVideo: endLiveMock }));
vi.mock('@/lib/live/pump', () => ({ getPumpManager: () => managerMock }));

import { DELETE } from './route';

function queryText(call: unknown[]) {
  return (call[0] as string[]).join('?');
}

const access = {
  user: { id: 'editor-1' },
  workspace: { id: 'workspace-1', role: 'editor' },
};

const live = {
  id: 37,
  facebook_video_id: 'fb-video-37',
};

beforeEach(() => {
  vi.clearAllMocks();
  requireWorkspaceMock.mockResolvedValue(access);
  requirePublishingConnectionMock.mockResolvedValue({
    context: {
      access,
      connection: { accessToken: 'page-token' },
    },
  });
  endLiveMock.mockResolvedValue(undefined);
  managerMock.stop.mockReturnValue({ ok: true, wasRunning: true });
  sqlMock.mockImplementation(async (...args: unknown[]) => {
    const text = queryText(args);
    if (text.includes('SELECT id, facebook_video_id')) return [live];
    return [];
  });
});

describe('DELETE /api/live/[id]', () => {
  it('ends Facebook, stops the pump, then persists ENDED and stopped', async () => {
    const events: string[] = [];
    endLiveMock.mockImplementation(async () => events.push('facebook:ended'));
    managerMock.stop.mockImplementation(() => {
      events.push('pump:stopped');
      return { ok: true, wasRunning: true };
    });
    sqlMock.mockImplementation(async (...args: unknown[]) => {
      const text = queryText(args);
      if (text.includes('SELECT id, facebook_video_id')) return [live];
      if (text.includes("SET status = 'ENDED'")) events.push('db:ended');
      return [];
    });

    const response = await DELETE(
      new Request('http://localhost/api/live/37', { method: 'DELETE' }),
      { params: Promise.resolve({ id: '37' }) }
    );

    expect(response.status).toBe(200);
    expect(events).toEqual(['facebook:ended', 'pump:stopped', 'db:ended']);
    expect(managerMock.stop).toHaveBeenCalledWith(37);
    const update = sqlMock.mock.calls.find((call) => queryText(call).includes("SET status = 'ENDED'"))!;
    expect(queryText(update)).toContain('pump_status =');
    expect(queryText(update)).toContain('WHERE id =');
    expect(update.slice(1)).toEqual([37, 'workspace-1']);
  });

  it('leaves the pump and controls unchanged when Facebook end fails', async () => {
    endLiveMock.mockRejectedValue(new Error('Facebook failed'));
    const response = await DELETE(
      new Request('http://localhost/api/live/37', { method: 'DELETE' }),
      { params: Promise.resolve({ id: '37' }) }
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(managerMock.stop).not.toHaveBeenCalled();
    expect(sqlMock.mock.calls.some((call) => queryText(call).includes("SET status = 'ENDED'"))).toBe(false);
  });
});
