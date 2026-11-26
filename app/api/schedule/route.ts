import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { MAX_POST_IMAGES } from "@/lib/facebook";
import { requireWorkspace, unauthorized } from "@/lib/session";
import { stripMarkdown } from "@/lib/format";
import { recordScheduleEvent } from "@/lib/schedule-events";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  const rows = await sql`
    SELECT s.id, s.news_item_id, s.draft_id, s.text, s.image_url, s.image_urls,
           s.scheduled_for, s.status, s.kind, s.source, s.page_id,
           s.facebook_post_id, s.attempts, s.error_message,
           s.created_at, n.title AS news_title
    FROM scheduled_posts s
    LEFT JOIN news_items n ON n.id = s.news_item_id
    WHERE s.workspace_id = ${access.workspace.id}
    ORDER BY (s.status = 'scheduled') DESC, s.scheduled_for ASC
    LIMIT 500`;

  return NextResponse.json(rows, {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();

  const body = await request.json().catch(() => null);
  const text = typeof body?.text === "string" ? stripMarkdown(body.text) : "";
  if (!text.trim()) {
    return NextResponse.json(
      { error: "Write a post before scheduling it." },
      { status: 400 }
    );
  }

  const scheduledFor = new Date(String(body?.scheduledFor ?? ""));
  if (Number.isNaN(scheduledFor.getTime())) {
    return NextResponse.json(
      { error: "Pick a date and time to schedule." },
      { status: 400 }
    );
  }
  if (scheduledFor.getTime() < Date.now() + 60_000) {
    return NextResponse.json(
      { error: "Scheduled time must be at least a minute from now." },
      { status: 400 }
    );
  }

  const newsItemId = Number(body?.newsItemId);
  const draftId = Number(body?.draftId);
  // A video attachment changes the post kind — Facebook has no image-plus-
  // video feed post, so video wins and imageUrls are ignored.
  const videoUrl =
    typeof body?.videoUrl === "string" && body.videoUrl ? body.videoUrl : null;
  const avatarJobId =
    typeof body?.avatarJobId === "string" && body.avatarJobId.trim()
      ? body.avatarJobId.trim()
      : null;
  if (
    body?.avatarJobId !== undefined &&
    body.avatarJobId !== null &&
    !avatarJobId
  ) {
    return NextResponse.json(
      { error: "Choose a valid avatar video." },
      { status: 400 }
    );
  }
  if (avatarJobId && !videoUrl) {
    return NextResponse.json(
      { error: "An avatar video URL is required." },
      { status: 400 }
    );
  }
  const rawImages = Array.isArray(body?.imageUrls)
    ? body.imageUrls
    : typeof body?.imageUrl === "string"
      ? [body.imageUrl]
      : [];
  const imageUrls = videoUrl
    ? []
    : rawImages
        .filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
        .slice(0, MAX_POST_IMAGES);
  const kind = videoUrl ? "video" : "post";

  // Only identifiers this workspace owns may be linked to the schedule — the
  // Activity feed joins news_items without a workspace predicate, so a
  // foreign story or draft id would leak its headline into this workspace.
  let verifiedNewsItemId: number | null = null;
  if (Number.isInteger(newsItemId) && newsItemId > 0) {
    const owned = (await sql`
      SELECT id FROM news_items
      WHERE id = ${newsItemId} AND workspace_id = ${access.workspace.id}
    `) as unknown as { id: number }[];
    if (!owned.length) {
      return NextResponse.json(
        { error: "Story not found in this workspace." },
        { status: 404 }
      );
    }
    verifiedNewsItemId = newsItemId;
  }
  let verifiedDraftId: number | null = null;
  if (Number.isInteger(draftId) && draftId > 0) {
    const ownedDrafts = (await sql`
      SELECT id FROM drafts
      WHERE id = ${draftId} AND workspace_id = ${access.workspace.id}
    `) as unknown as { id: number }[];
    if (!ownedDrafts.length) {
      return NextResponse.json(
        { error: "Draft not found in this workspace." },
        { status: 404 }
      );
    }
    verifiedDraftId = draftId;
  }

  // Optional target page — validated against the workspace's connected pages;
  // null lets the executor fall back to the default (primary) page.
  const requestedPageId =
    typeof body?.pageId === "string" && body.pageId ? body.pageId : null;
  let scheduledPageId: string | null = null;
  if (requestedPageId) {
    const pageRows = (await sql`
      SELECT page_id FROM facebook_pages
      WHERE workspace_id = ${access.workspace.id} AND page_id = ${requestedPageId}
    `) as unknown as { page_id: string }[];
    if (!pageRows.length) {
      return NextResponse.json(
        { error: "That Page is not connected to this workspace." },
        { status: 404 }
      );
    }
    scheduledPageId = requestedPageId;
  }

  const rows = (await (avatarJobId
    ? sql`
        WITH claimed_avatar AS (
          UPDATE avatar_jobs
          SET publish_state = 'scheduled', updated_at = now()
          WHERE id = ${avatarJobId} AND workspace_id = ${access.workspace.id}
            AND status = 'completed' AND publish_state = 'ready'
            AND blob_url = ${videoUrl}
          RETURNING id, blob_url
        ), inserted AS (
          INSERT INTO scheduled_posts
            (workspace_id, news_item_id, draft_id, text, image_url, image_urls,
             scheduled_for, kind, page_id, created_by, avatar_job_id)
          SELECT
            ${access.workspace.id}, ${verifiedNewsItemId}, ${verifiedDraftId},
            ${text}, claimed_avatar.blob_url,
            ${imageUrls.length ? JSON.stringify(imageUrls) : null}::jsonb,
            ${scheduledFor.toISOString()}, ${kind}, ${scheduledPageId},
            ${access.user.id}, claimed_avatar.id
          FROM claimed_avatar
          RETURNING id, news_item_id, scheduled_for, status
        )
        SELECT * FROM inserted`
    : sql`
    INSERT INTO scheduled_posts
      (workspace_id, news_item_id, draft_id, text, image_url, image_urls, scheduled_for, kind, page_id, created_by)
    VALUES
      (${access.workspace.id},
       ${verifiedNewsItemId},
       ${verifiedDraftId},
       ${text},
       ${videoUrl ?? imageUrls[0] ?? null},
       ${imageUrls.length ? JSON.stringify(imageUrls) : null}::jsonb,
       ${scheduledFor.toISOString()}, ${kind}, ${scheduledPageId}, ${access.user.id})
    RETURNING id, news_item_id, scheduled_for, status`)) as unknown as {
    id: number;
    news_item_id: number | null;
    scheduled_for: string;
    status: string;
  }[];

  const created = rows[0];
  if (!created) {
    return NextResponse.json(
      {
        error: "This avatar video is not ready or has already been used.",
        code: "avatar_unavailable",
      },
      { status: 409 }
    );
  }

  await recordScheduleEvent({
    workspaceId: access.workspace.id,
    scheduledPostId: created.id,
    newsItemId: created.news_item_id,
    event: "scheduled",
    source: "composer",
    actorUserId: access.user.id,
    metadata: {
      scheduledFor: scheduledFor.toISOString(),
      imageCount: imageUrls.length,
      ...(avatarJobId ? { avatarJobId } : {}),
    },
  });

  return NextResponse.json(created, { status: 201 });
}
