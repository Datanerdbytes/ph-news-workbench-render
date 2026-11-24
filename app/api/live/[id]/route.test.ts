import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, requireWorkspaceMock, requirePublishingConnectionMock, managerMock, endLiveMock, resolveEndVideoIdMock } =
  vi.hoisted(() => ({
    sqlMock: vi.fn(),
    requireWorkspaceMock: vi.fn(),
    requirePublishingConnectionMock: vi.fn(),
    managerMock: { stop: vi.fn() },
    endLiveMock: vi.fn(),
    resolveEndVideoIdMock: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({ sql: sqlMock }));
vi.mock('@/lib/session', () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
}));
vi.mock('@/lib/publishing/connection', () => ({
  requirePublishingConnection: requirePublishingConnectionMock,
}));
vi.mock('@/lib/publishing/live', () => ({
  endPageLiveVideo: endLiveMock,
  resolveEndVideoId: resolveEndVideoIdMock,
}));
vi.mock('@/lib/live/pump', () => ({ getPumpManager: () => managerMock }));

import { FacebookApiError } from '@/lib/facebook';
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
  resolveEndVideoIdMock.mockResolvedValue(live.facebook_video_id);
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

  // The regression behind QUA-18: the end call must target the live video
  // node id the resolution yields, not the stream key that showed up in the
  // stored facebook_video_id (the Graph error quoted it, e.g.
  // "Object with ID '122152546167117522' does not exist").
  it('ends Facebook with the id the node re-read resolves, not the stored value', async () => {
    resolveEndVideoIdMock.mockResolvedValue('real-live-video-999');

    const response = await DELETE(
      new Request('http://localhost/api/live/37', { method: 'DELETE' }),
      { params: Promise.resolve({ id: '37' }) }
    );

    expect(response.status).toBe(200);
    expect(resolveEndVideoIdMock).toHaveBeenCalledWith({
      liveVideoId: 'fb-video-37',
      accessToken: 'page-token',
    });
    expect(endLiveMock).toHaveBeenCalledWith({
      liveVideoId: 'real-live-video-999',
      accessToken: 'page-token',
    });
  });

  it('returns an actionable error and leaves the pump and row alone when no usable id resolves', async () => {
    resolveEndVideoIdMock.mockResolvedValue(null);

    const response = await DELETE(
      new Request('http://localhost/api/live/37', { method: 'DELETE' }),
      { params: Promise.resolve({ id: '37' }) }
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(endLiveMock).not.toHaveBeenCalled();
    expect(managerMock.stop).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.error).toContain('Create a new live stream');
    expect(
      sqlMock.mock.calls.some((call) =>
        queryText(call).includes("SET status = 'ENDED'")
      )
    ).toBe(false);
  });

  it('replaces the raw Graph message in the response with an actionable line when ending fails', async () => {
    endLiveMock.mockRejectedValue(
      new FacebookApiError(
        "Unsupported post request. Object with ID '122152546167117522' does not exist, cannot be loaded due to missing permissions, or does not support this operation."
      )
    );

    const response = await DELETE(
      new Request('http://localhost/api/live/37', { method: 'DELETE' }),
      { params: Promise.resolve({ id: '37' }) }
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.json();
    expect(body.error).not.toContain('does not exist');
    expect(body.error).toContain('could not be ended');
  });
});
