import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { requireWorkspace, unauthorized } from "@/lib/session";
import { recordScheduleEvent } from "@/lib/schedule-events";
import {
  facebookScheduleWindowError,
  scheduleWindowError,
} from "@/lib/publishing/schedule";
import {
  cancelFacebookScheduledPost,
  isFacebookStillScheduled,
  rescheduleFacebookScheduledPost,
} from "@/lib/facebook";
import { resolvePageToken } from "@/lib/facebook-page-token";

export const dynamic = "force-dynamic";

type TargetRow = {
  id: number;
  workspace_id: string;
  news_item_id: number | null;
  kind: string;
  source: string;
  status: string;
  scheduled_for: string;
  facebook_post_id: string | null;
  facebook_post_ids: unknown;
  page_id: string | null;
};

const PLATFORM_LABELS: Record<string, string> = {
  facebook: "Facebook",
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
};

type PageResult = {
  page: { id: string; name: string };
  ok: boolean;
  id?: string;
  permalink?: string | null;
  error?: string;
};

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  const { id } = await params;

  const existing = (await sql`
    SELECT id, workspace_id, news_item_id, kind, source, status,
           facebook_post_id, facebook_post_ids, page_id
    FROM scheduled_posts
    WHERE id = ${id} AND workspace_id = ${access.workspace.id}
  `) as unknown as TargetRow[];

  const row = existing[0];
  if (!row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (row.source === "facebook" && row.status === "scheduled") {
    // Facebook is holding this item in its own queue, so deleting the local
    // row would not stop it. Cancel it on Facebook first.
    const cancelled = await cancelOnFacebook(row);
    if (!cancelled.ok) {
      return NextResponse.json(
        {
          error:
            cancelled.error ??
            "This item is scheduled on Facebook itself and could not be canceled automatically. Cancel it in Meta Business Suite, then this entry clears on its own.",
        },
        { status: 409 }
      );
    }
  }

  const rows = (await sql`
    DELETE FROM scheduled_posts
    WHERE id = ${id}
      AND workspace_id = ${access.workspace.id}
    RETURNING id, news_item_id, scheduled_for`) as unknown as {
    id: number;
    news_item_id: number | null;
    scheduled_for: string;
  }[];

  if (!rows.length) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const canceled = rows[0];
  await recordScheduleEvent({
    workspaceId: access.workspace.id,
    scheduledPostId: canceled.id,
    newsItemId: canceled.news_item_id,
    event: "canceled",
    source: "calendar",
    actorUserId: access.user.id,
    metadata: { scheduledFor: canceled.scheduled_for },
  });

  return NextResponse.json({ deleted: true });
}

/**
 * Move a scheduled post to a new time. Workspace-queued rows (source
 * 'local') only need the local update; Facebook-held rows get their
 * `scheduled_publish_time` moved on Facebook first. Other platforms expose no
 * way to move an accepted schedule, so those can only be canceled and
 * scheduled again.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const scheduledFor = new Date(String(body?.scheduledFor ?? ""));
  if (Number.isNaN(scheduledFor.getTime())) {
    return NextResponse.json(
      { error: "Pick a date and time to reschedule to." },
      { status: 400 }
    );
  }
  const windowError = scheduleWindowError(scheduledFor);
  if (windowError) {
    return NextResponse.json({ error: windowError }, { status: 400 });
  }

  const rows = (await sql`
    SELECT id, workspace_id, news_item_id, kind, source, status, scheduled_for,
           facebook_post_id, facebook_post_ids, page_id
    FROM scheduled_posts
    WHERE id = ${id} AND workspace_id = ${access.workspace.id}
  `) as unknown as TargetRow[];

  const row = rows[0];
  if (!row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (row.status !== "scheduled") {
    return NextResponse.json(
      { error: "Only a scheduled post can be rescheduled." },
      { status: 409 }
    );
  }
  if (row.source === "facebook") {
    const facebookWindowError = facebookScheduleWindowError(scheduledFor);
    if (facebookWindowError) {
      return NextResponse.json({ error: facebookWindowError }, { status: 400 });
    }
  }

  let warning: string | undefined;
  if (row.source !== "local" && row.source !== "facebook") {
    const platform = PLATFORM_LABELS[row.source] ?? "the platform";
    return NextResponse.json(
      {
        error: `${platform} is holding this post in its own queue and the app cannot move an existing schedule there. Cancel it, then schedule it again at the new time.`,
      },
      { status: 409 }
    );
  }

  // Claim the row before touching Facebook. This conditional update is the
  // serialization point: an overlapping reschedule fails here instead of
  // moving Facebook after this one and leaving the row and Facebook apart.
  const claimed = (await sql`
    UPDATE scheduled_posts
    SET scheduled_for = ${scheduledFor.toISOString()}, updated_at = now()
    WHERE id = ${id}
      AND workspace_id = ${access.workspace.id}
      AND status = 'scheduled'
      AND scheduled_for = ${row.scheduled_for}
    RETURNING id, scheduled_for`) as unknown as {
    id: number;
    scheduled_for: string;
  }[];

  if (!claimed.length) {
    return NextResponse.json(
      {
        error:
          "The post changed while it was being rescheduled. Reload the calendar and try again.",
      },
      { status: 409 }
    );
  }

  if (row.source === "facebook") {
    const moved = await rescheduleOnFacebook(
      row,
      Math.floor(scheduledFor.getTime() / 1000)
    );
    if (!moved.ok) {
      // Nothing moved on Facebook, so the claimed time is undone. Once a Page
      // has accepted the new time, the row must keep it or the calendar would
      // show a time Facebook no longer holds.
      if (moved.moved === 0) {
        await sql`
          UPDATE scheduled_posts
          SET scheduled_for = ${row.scheduled_for}, updated_at = now()
          WHERE id = ${id}
            AND workspace_id = ${access.workspace.id}
            AND scheduled_for = ${scheduledFor.toISOString()}`;
        return NextResponse.json({ error: moved.error }, { status: 409 });
      }
      warning = moved.error;
    }
  }

  await recordScheduleEvent({
    workspaceId: access.workspace.id,
    scheduledPostId: row.id,
    newsItemId: row.news_item_id,
    event: "rescheduled",
    source: "calendar",
    actorUserId: access.user.id,
    metadata: { from: row.scheduled_for, to: scheduledFor.toISOString() },
  });

  return NextResponse.json(
    warning ? { ...claimed[0], warning } : claimed[0]
  );
}

/** Every Page that accepted this scheduled action, with the per-Page id. */
function facebookTargets(row: TargetRow) {
  const perPage = Array.isArray(row.facebook_post_ids)
    ? (row.facebook_post_ids as PageResult[]).filter(
        (entry) => entry?.ok && entry.id
      )
    : [];

  if (perPage.length) {
    return perPage.map((entry) => ({
      pageId: entry.page?.id ?? null,
      postId: entry.id!,
    }));
  }
  return row.facebook_post_id
    ? [{ pageId: row.page_id, postId: row.facebook_post_id }]
    : [];
}

/**
 * Cancel a Facebook-held scheduled item. One scheduled action can cover
 * several Pages, so every Page that took it is canceled in turn; the first
 * failure stops the loop and is reported back to the user.
 */
async function cancelOnFacebook(
  row: TargetRow
): Promise<{ ok: boolean; error?: string }> {
  const targets = facebookTargets(row);

  if (!targets.length) {
    return {
      ok: false,
      error:
        "This item is scheduled on Facebook but the app has no id for it, so it cannot be canceled here. Cancel it in Meta Business Suite.",
    };
  }

  for (const target of targets) {
    const token = await resolvePageToken(row.workspace_id, target.pageId);
    if (!token) {
      return {
        ok: false,
        error:
          "The stored Page token is unreadable, so this item cannot be canceled. Reconnect the Page, or cancel it in Meta Business Suite.",
      };
    }

    try {
      // Facebook may have already released this item — it published, or it
      // was removed in Meta Business Suite. Deleting then would be refused,
      // but there is nothing left to cancel, so clearing the local row is
      // the correct outcome. When the queue edge can't be read, still try
      // the delete (fail-safe).
      const held = target.pageId
        ? await isFacebookStillScheduled(target.pageId, target.postId, token)
        : null;
      if (held !== false) {
        await cancelFacebookScheduledPost(target.postId, token, target.pageId);
      }
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? `Facebook refused to cancel this item: ${error.message} You can cancel it in Meta Business Suite instead.`
            : "Facebook refused to cancel this item. You can cancel it in Meta Business Suite instead.",
      };
    }
  }

  return { ok: true };
}

/**
 * Move the schedule Facebook is holding, across every Page that accepted it.
 * Returns how many Pages the new time reached so the caller can decide
 * whether the local row should follow a partial move.
 */
async function rescheduleOnFacebook(
  row: TargetRow,
  scheduledPublishTime: number
): Promise<{ ok: boolean; moved: number; error?: string }> {
  const targets = facebookTargets(row);
  if (!targets.length) {
    return {
      ok: false,
      moved: 0,
      error:
        "This item is scheduled on Facebook but the app has no id for it, so it cannot be moved here. Move it in Meta Business Suite.",
    };
  }

  let moved = 0;
  for (const target of targets) {
    // The token lookup touches the database, so it can reject like any other
    // call. Return the Pages already moved instead of throwing, or PATCH would
    // keep the old local time while Facebook holds the new one.
    let token: string | null = null;
    try {
      token = await resolvePageToken(row.workspace_id, target.pageId);
    } catch {
      return {
        ok: false,
        moved,
        error: `The stored Page token could not be read, so this item may only have moved on some Pages.${partialMoveNote(moved, targets.length)} Reload the calendar to see where each Page stands.`,
      };
    }
    if (!token) {
      return {
        ok: false,
        moved,
        error: `The stored Page token is unreadable, so this item cannot be moved.${partialMoveNote(moved, targets.length)} Reconnect the Page, or move it in Meta Business Suite.`,
      };
    }

    try {
      // A row the sync has not caught up with may already be published;
      // moving then is refused by Facebook. Say so instead of guessing.
      const held = target.pageId
        ? await isFacebookStillScheduled(target.pageId, target.postId, token)
        : null;
      if (held === false) {
        return {
          ok: false,
          moved,
          error: `Facebook no longer holds this item in its scheduled queue — it may have already published.${partialMoveNote(moved, targets.length)} Reload the calendar to see where it stands.`,
        };
      }
      await rescheduleFacebookScheduledPost(
        target.postId,
        token,
        scheduledPublishTime,
        target.pageId
      );
      moved += 1;
    } catch (error) {
      const reason =
        error instanceof Error
          ? `Facebook refused to move this item: ${error.message}`
          : "Facebook refused to move this item.";
      return {
        ok: false,
        moved,
        error: `${reason}${partialMoveNote(moved, targets.length)} You can cancel it here and schedule it again.`,
      };
    }
  }

  return { ok: true, moved };
}

function partialMoveNote(moved: number, total: number) {
  return moved > 0
    ? ` It did move on ${moved} of ${total} Pages, so those are now at the new time.`
    : "";
}
