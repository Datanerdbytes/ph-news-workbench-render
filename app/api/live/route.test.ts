import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sqlMock,
  requirePublishingConnectionMock,
  fetchPageLiveVideoMock,
  createPageLiveVideoMock,
  recordNativeScheduleMock,
} = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  requirePublishingConnectionMock: vi.fn(),
  fetchPageLiveVideoMock: vi.fn(),
  createPageLiveVideoMock: vi.fn(),
  recordNativeScheduleMock: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ sql: sqlMock }));
vi.mock('@/lib/facebook-token', () => ({
  decryptToken: (value: string) => value,
  encryptToken: (value: string) => value,
}));
vi.mock('@/lib/live/pump', () => ({
  getPumpManager: () => ({ status: () => undefined }),
  assembleRtmpsUrl: () => 'rtmps://example.test/live',
}));
vi.mock('@/lib/live/pump-state', () => ({
  mapPumpStatus: () => 'idle',
  parseSourceMode: (value: unknown) => value ?? null,
  pumpProcessRecord: () => undefined,
}));
vi.mock('@/lib/live/runner-config', () => ({ runnerMode: () => false }));
vi.mock('@/lib/publishing/connection', () => ({
  requirePublishingConnection: requirePublishingConnectionMock,
}));
vi.mock('@/lib/publishing/errors', () => ({
  facebookErrorResponse: (_error: unknown, code: string, message: string) =>
    new Response(JSON.stringify({ error: message, code }), { status: 400 }),
}));
vi.mock('@/lib/publishing/live', () => ({
  createPageLiveVideo: createPageLiveVideoMock,
  fetchPageLiveVideo: fetchPageLiveVideoMock,
}));
vi.mock('@/lib/schedule-mirror', () => ({
  recordNativeSchedule: recordNativeScheduleMock,
}));
vi.mock('@/lib/live/public-network', () => ({
  assertPublicSourceUrl: async () => undefined,
  MAX_SOURCE_URL_LENGTH: 2048,
  NetworkPolicyError: class NetworkPolicyError extends Error {},
}));

import { GET, isArchivedLiveStatus } from './route';

function queryText(call: unknown[]) {
  return (call[0] as string[]).join('?');
}

function row(id: number, status: string) {
  return {
    id,
    facebook_video_id: `fb-${id}`,
    title: `Stream ${id}`,
    description: null,
    status,
    stream_key: null,
    secure_stream_url: null,
    permalink_url: null,
    planned_start_time: null,
    created_at: '2026-11-23T10:00:00.000Z',
    source_url: null,
    source_mode: null,
    pump_status: 'idle',
    pump_started_at: null,
    pump_error: null,
  };
}

const rows = [
  row(1, 'LIVE_NOW'),
  row(2, 'SCHEDULED'),
  row(3, 'ENDED'),
  row(4, 'VOD'),
];

beforeEach(() => {
  vi.clearAllMocks();
  requirePublishingConnectionMock.mockResolvedValue({
    context: {
      access: { user: { id: 'user-1' }, workspace: { id: 'workspace-1' } },
      connection: { accessToken: 'page-token' },
    },
  });
  sqlMock.mockImplementation(async (...args: unknown[]) => {
    if (queryText(args).includes('FROM live_streams')) return rows;
    return [];
  });
  fetchPageLiveVideoMock.mockResolvedValue({
    status: 'LIVE_NOW',
    title: 'Fresh title',
    description: '',
    permalink: null,
  });
  createPageLiveVideoMock.mockResolvedValue({});
  recordNativeScheduleMock.mockResolvedValue(undefined);
});

describe('GET /api/live', () => {
  it('omits finished broadcasts by default while leaving them in the database', async () => {
    const response = await GET(new Request('http://localhost/api/live'));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.streams.map((stream: { id: number }) => stream.id)).toEqual([1, 2]);

    const select = sqlMock.mock.calls.find((call) =>
      queryText(call).includes('FROM live_streams')
    )!;
    expect(queryText(select)).toContain('FROM live_streams');
    expect(sqlMock.mock.calls.some((call) => queryText(call).includes('DELETE'))).toBe(
      false
    );
  });

  it('returns the full persisted history only with the explicit opt-in', async () => {
    const response = await GET(new Request('http://localhost/api/live?history=1'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.streams.map((stream: { id: number }) => stream.id)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('polls displayed IDs within the workspace and returns stored archive status', async () => {
    sqlMock.mockResolvedValueOnce([row(1, 'LIVE_NOW'), row(3, 'ENDED')]);
    const response = await GET(new Request('http://localhost/api/live?pollIds=1,3&refresh=1'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      streams: [{ id: 1, status: 'LIVE_NOW' }, { id: 3, status: 'ENDED' }],
    });
    const select = sqlMock.mock.calls[0];
    expect(queryText(select)).toContain('WHERE workspace_id = ?');
    expect(queryText(select)).toContain('id = ANY(?::integer[])');
    expect(select.slice(1)).toEqual(['workspace-1', false, [1, 3], 50]);
    expect(fetchPageLiveVideoMock).not.toHaveBeenCalled();
  });

  it.each(['', '1,abc', '2147483648', Array(51).fill('1').join(',')])(
    'rejects an invalid poll ID list before querying the database (%s)',
    async (pollIds) => {
      const response = await GET(new Request(`http://localhost/api/live?pollIds=${pollIds}`));
      expect(response.status).toBe(400);
      expect(sqlMock).not.toHaveBeenCalled();
    }
  );

  it('persists a newly ended stream from Facebook and hides it from the default read', async () => {
    fetchPageLiveVideoMock.mockImplementation(async (videoId: string) => ({
      status: videoId === 'fb-1' ? 'ENDED' : 'LIVE_NOW',
      title: 'Fresh title',
      description: '',
      permalink: null,
    }));

    const response = await GET(new Request('http://localhost/api/live?refresh=1'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.streams.map((stream: { id: number }) => stream.id)).toEqual([2]);

    const update = sqlMock.mock.calls.find((call) =>
      queryText(call).includes('UPDATE live_streams')
    )!;
    expect(update).toBeDefined();
    expect(update.slice(1)).toContain('ENDED');
    expect(update.slice(1)).toContain(1);
    expect(update.slice(1)).toContain('workspace-1');
  });
});

describe('isArchivedLiveStatus', () => {
  it('treats only ENDED and VOD as history', () => {
    expect(isArchivedLiveStatus('ENDED')).toBe(true);
    expect(isArchivedLiveStatus('VOD')).toBe(true);
    expect(isArchivedLiveStatus('LIVE_NOW')).toBe(false);
    expect(isArchivedLiveStatus('SCHEDULED')).toBe(false);
  });
});
