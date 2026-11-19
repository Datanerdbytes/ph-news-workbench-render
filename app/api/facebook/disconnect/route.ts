import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { sql } from '@/lib/db';
import { getPumpManager } from '@/lib/live/pump';
import { withWorkspaceLiveLock } from '@/lib/live/workspace-lock';
import { requireWorkspace, unauthorized } from '@/lib/session';

export async function POST(request: NextRequest) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  await withWorkspaceLiveLock(access.workspace.id, async () => {
    // Stop every row in the tenant, regardless of its stored Facebook status.
    // The in-memory manager also tracks starting/retrying pumps that a stale
    // or inconsistent DB status would otherwise miss.
    const streams = (await sql`
      SELECT id
      FROM live_streams
      WHERE workspace_id = ${access.workspace.id}
    `) as unknown as { id: number }[];

    const manager = getPumpManager();
    for (const stream of streams) manager.stop(stream.id);

    // Keep pump_started_at and pump_error as history while making every owned
    // row terminal. The workspace predicate prevents cross-tenant changes.
    await sql`
      UPDATE live_streams
      SET pump_status = 'stopped', updated_at = now()
      WHERE workspace_id = ${access.workspace.id}
    `;

    await sql`
      DELETE FROM facebook_connections
      WHERE workspace_id = ${access.workspace.id}
    `;
  });

  return NextResponse.json({ ok: true });
}
