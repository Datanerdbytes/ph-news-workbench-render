import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, requireWorkspaceMock, managerMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  requireWorkspaceMock: vi.fn(),
  managerMock: { stop: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ sql: sqlMock }));
vi.mock('@/lib/session', () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
}));
vi.mock('@/lib/live/pump', () => ({ getPumpManager: () => managerMock }));

import { POST } from './route';

function queryText(call: unknown[]) {
  return (call[0] as string[]).join('?');
}

const access = {
  user: { id: 'editor-1' },
  workspace: { id: 'workspace-1', role: 'editor' },
};

beforeEach(() => {
  vi.clearAllMocks();
  requireWorkspaceMock.mockResolvedValue(access);
  managerMock.stop.mockReturnValue({ ok: true, wasRunning: true });
  sqlMock.mockImplementation(async (...args: unknown[]) => {
    const text = queryText(args);
    if (text.includes('SELECT id') && text.includes('FROM live_streams')) {
      return [{ id: 3 }, { id: 7 }, { id: 11 }];
    }
    return [];
  });
});

describe('POST /api/facebook/disconnect', () => {
  it('stops every owned stream and persists stopped before deleting the connection', async () => {
    const response = await POST(new NextRequest('http://localhost/api/facebook/disconnect', { method: 'POST' }));

    expect(response.status).toBe(200);
    expect(managerMock.stop.mock.calls).toEqual([[3], [7], [11]]);
    const selectCall = sqlMock.mock.calls.find((call) => queryText(call).includes('SELECT id'))!;
    expect(queryText(selectCall)).toContain('workspace_id =');
    expect(selectCall.slice(1)).toEqual(['workspace-1']);

    const updateCall = sqlMock.mock.calls.find((call) => queryText(call).includes("SET pump_status = 'stopped'"))!;
    expect(queryText(updateCall)).toContain('WHERE workspace_id =');
    expect(updateCall.slice(1)).toEqual(['workspace-1']);

    const deleteCall = sqlMock.mock.calls.find((call) => queryText(call).includes('DELETE FROM facebook_connections'))!;
    expect(deleteCall.slice(1)).toEqual(['workspace-1']);
  });

  it('does not query or mutate streams when unauthenticated', async () => {
    requireWorkspaceMock.mockResolvedValue(null);
    const response = await POST(new NextRequest('http://localhost/api/facebook/disconnect', { method: 'POST' }));

    expect(response.status).toBe(401);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(managerMock.stop).not.toHaveBeenCalled();
  });
});
