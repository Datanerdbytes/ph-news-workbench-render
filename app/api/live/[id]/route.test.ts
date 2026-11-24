import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, requireWorkspaceMock, requirePublishingConnectionMock, managerMock, graphPostFormMock, graphRequestMock } =
  vi.hoisted(() => ({
    sqlMock: vi.fn(),
    requireWorkspaceMock: vi.fn(),
    requirePublishingConnectionMock: vi.fn(),
    managerMock: { stop: vi.fn() },
    graphPostFormMock: vi.fn(),
    graphRequestMock: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({ sql: sqlMock }));
vi.mock('@/lib/session', () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
}));
vi.mock('@/lib/publishing/connection', () => ({
  requirePublishingConnection: requirePublishingConnectionMock,
}));
vi.mock('@/lib/facebook', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/facebook')>(),
  graphPostForm: graphPostFormMock,
  graphRequest: graphRequestMock,
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
  graphPostFormMock.mockResolvedValue(undefined);
  graphRequestMock.mockResolvedValue({ id: live.facebook_video_id });
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
    graphPostFormMock.mockImplementation(async () => events.push('facebook:ended'));
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
    graphPostFormMock.mockRejectedValue(new Error('Facebook failed'));
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
    graphRequestMock.mockResolvedValue({ id: 'real-live-video-999' });

    const response = await DELETE(
      new Request('http://localhost/api/live/37', { method: 'DELETE' }),
      { params: Promise.resolve({ id: '37' }) }
    );

    expect(response.status).toBe(200);
    expect(graphRequestMock).toHaveBeenCalledWith(
      'fb-video-37',
      expect.objectContaining({ fields: expect.stringContaining('id') }),
      'page-token'
    );
    expect(graphPostFormMock).toHaveBeenCalledWith(
      'real-live-video-999', { end_live_video: 'true' }, 'page-token'
    );
  });

  it('returns an actionable error and leaves the pump and row alone when no usable id resolves', async () => {
    graphRequestMock.mockRejectedValue(
      new FacebookApiError("Unsupported get request. Object with ID 'fb-video-37' does not exist.", 100)
    );

    const response = await DELETE(
      new Request('http://localhost/api/live/37', { method: 'DELETE' }),
      { params: Promise.resolve({ id: '37' }) }
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(graphPostFormMock).not.toHaveBeenCalled();
    expect(managerMock.stop).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.error).toContain('Create a new live stream');
    expect(
      sqlMock.mock.calls.some((call) =>
        queryText(call).includes("SET status = 'ENDED'")
      )
    ).toBe(false);
  });

  it('asks the user to reconnect when the live video lookup rejects an expired token', async () => {
    graphRequestMock.mockRejectedValue(new FacebookApiError('Session has expired.', 190));

    const response = await DELETE(
      new Request('http://localhost/api/live/37', { method: 'DELETE' }),
      { params: Promise.resolve({ id: '37' }) }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: 'permission',
      error: expect.stringContaining('Reconnect the Page to refresh its permissions.'),
    });
    expect(graphPostFormMock).not.toHaveBeenCalled();
    expect(managerMock.stop).not.toHaveBeenCalled();
    expect(sqlMock.mock.calls.some((call) => queryText(call).includes("SET status = 'ENDED'"))).toBe(false);
  });

  it('replaces the raw Graph message in the response with an actionable line when ending fails', async () => {
    graphPostFormMock.mockRejectedValue(
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

  // The QUA-18 symptom: the card was already STOPPED, so the broadcast had
  // already ended on Facebook and the node no longer exists. Ending again
  // is expected to fail with the same "does not exist" message — the right
  // outcome is to clean up the local row, not to surface a failure.
  it('cleans up the local row when Facebook reports the broadcast already ended', async () => {
    graphPostFormMock.mockRejectedValue(
      new FacebookApiError(
        "Unsupported post request. Object with ID '122152546167117522' does not exist.",
        100
      )
    );

    const response = await DELETE(
      new Request('http://localhost/api/live/37', { method: 'DELETE' }),
      { params: Promise.resolve({ id: '37' }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ended: true });
    expect(managerMock.stop).toHaveBeenCalledWith(37);
    expect(
      sqlMock.mock.calls.some((call) =>
        queryText(call).includes("SET status = 'ENDED'")
      )
    ).toBe(true);
  });
});
