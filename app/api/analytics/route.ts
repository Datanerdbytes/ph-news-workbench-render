import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { requireWorkspace, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

type TotalsRow = {
  drafts: number;
  published: number;
  scheduled: number;
  scheduled_published: number;
  /** Published posts that also flipped their draft — the double-counted overlap. */
  linked_published: number;
  failed: number;
  tokens: number;
  cost: number;
};

type DailyRow = {
  day: string;
  drafts: number;
  published: number;
  scheduled: number;
};

/** One row per platform in the grouped publish query below. */
type PlatformRow = {
  platform: string;
  total: number;
  post: number;
  reel: number;
  live: number;
  story: number;
  total_30d: number;
};

/** The platforms the Dashboard can show counts for, in pill order. */
const PLATFORMS = ["facebook", "instagram", "youtube", "tiktok"] as const;

type AnalyticsPlatform = (typeof PLATFORMS)[number];

type PlatformPublishStats = {
  platform: AnalyticsPlatform;
  published: {
    total: number;
    post: number;
    reel: number;
    live: number;
    story: number;
  };
  published30d: {
    total: number;
  };
};

/**
 * scheduled_posts has no platform column — the platform is derived from
 * source/kind, the same way the scheduler already branches:
 *
 * - facebook: source='facebook' (native publishes) or source='local' (the
 *   workbench executor) except the Instagram rows, which the local executor
 *   also owns.
 * - instagram: kind='instagram-post' — Instagram has no scheduling API, so
 *   its rows always come from the local executor.
 * - youtube / tiktok: their own source.
 */
async function platformPublishCounts(workspaceId: string) {
  const rows = (await sql`
    SELECT platform,
           count(*)::int AS total,
           count(*) FILTER (
             WHERE kind IN ('post', 'photo')
                OR (platform = 'instagram' AND kind = 'instagram-post')
           )::int AS post,
           count(*) FILTER (WHERE kind = 'reel')::int AS reel,
           count(*) FILTER (WHERE kind = 'live')::int AS live,
           count(*) FILTER (WHERE kind = 'story')::int AS story,
           count(*) FILTER (WHERE updated_at > now() - interval '30 days')::int AS total_30d
    FROM (
      SELECT
        CASE
          WHEN source = 'facebook' OR (source = 'local' AND kind <> 'instagram-post') THEN 'facebook'
          WHEN source = 'youtube' THEN 'youtube'
          WHEN source = 'tiktok' THEN 'tiktok'
          WHEN kind = 'instagram-post' THEN 'instagram'
          ELSE 'facebook'
        END AS platform,
        kind,
        updated_at
      FROM scheduled_posts
      WHERE workspace_id = ${workspaceId} AND status = 'published'
    ) rows
    GROUP BY platform
  `) as unknown as PlatformRow[];

  const byPlatform = new Map(rows.map((row) => [row.platform, row]));

  // Every platform is always present — a platform without publishes reads as
  // zeros, not as a missing card.
  return PLATFORMS.map((platform) => {
    const row = byPlatform.get(platform);
    return {
      platform,
      published: {
        total: row?.total ?? 0,
        post: row?.post ?? 0,
        reel: row?.reel ?? 0,
        live: row?.live ?? 0,
        story: row?.story ?? 0,
      },
      published30d: {
        total: row?.total_30d ?? 0,
      },
    } satisfies PlatformPublishStats;
  });
}

export async function GET(request: Request) {
  const access = await requireWorkspace(request);
  if (!access) return unauthorized();
  const workspaceId = access.workspace.id;

  // The three reads are independent — one round-trip each, in parallel.
  const [totals, daily, platforms] = await Promise.all([
    sql`
    SELECT
      (SELECT count(*)::int FROM drafts
        WHERE workspace_id = ${workspaceId}) AS drafts,
      (SELECT count(*)::int FROM drafts
        WHERE workspace_id = ${workspaceId} AND status = 'published') AS published,
      (SELECT count(*)::int FROM scheduled_posts
        WHERE workspace_id = ${workspaceId} AND status = 'scheduled') AS scheduled,
      (SELECT count(*)::int FROM scheduled_posts
        WHERE workspace_id = ${workspaceId} AND status = 'published') AS scheduled_published,
      -- A publish that flipped a draft is one publish written down twice:
      -- the draft and the scheduled post. Both the scheduled worker and
      -- POST /api/publish link the two, so the overlap is subtracted and
      -- the total counts publishes rather than rows. The overlap is counted
      -- in drafts, not in posts: a draft flipped by two publishes is still
      -- one draft, so counting post rows would subtract more than the draft
      -- side ever added.
      (SELECT count(DISTINCT sp.draft_id)::int FROM scheduled_posts sp
        WHERE sp.workspace_id = ${workspaceId}
          AND sp.status = 'published'
          AND sp.draft_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM drafts d
            WHERE d.id = sp.draft_id
              AND d.workspace_id = ${workspaceId}
              AND d.status = 'published'
          )) AS linked_published,
      (SELECT count(*)::int FROM scheduled_posts
        WHERE workspace_id = ${workspaceId} AND status = 'failed') AS failed,
      (SELECT coalesce(sum(input_tokens + output_tokens), 0)::int FROM drafts
        WHERE workspace_id = ${workspaceId}) AS tokens,
      (SELECT coalesce(sum(estimated_cost), 0)::float8 FROM drafts
        WHERE workspace_id = ${workspaceId}) AS cost
  ` as unknown as Promise<TotalsRow[]>,
    sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day,
           sum(drafts)::int AS drafts,
           sum(published)::int AS published,
           sum(scheduled)::int AS scheduled
    FROM (
      SELECT date_trunc('day', created_at)::date AS day,
             count(*) AS drafts, 0 AS published, 0 AS scheduled
      FROM drafts
      WHERE workspace_id = ${workspaceId}
        AND created_at >= now() - interval '14 days'
      GROUP BY 1
      UNION ALL
      SELECT date_trunc('day', created_at)::date,
             0, count(*), 0
      FROM drafts
      WHERE workspace_id = ${workspaceId}
        AND status = 'published'
        AND created_at >= now() - interval '14 days'
      GROUP BY 1
      UNION ALL
      SELECT date_trunc('day', scheduled_for)::date,
             0, 0, count(*)
      FROM scheduled_posts
      WHERE workspace_id = ${workspaceId}
        AND status = 'scheduled'
        AND scheduled_for >= now() - interval '14 days'
      GROUP BY 1
    ) buckets
    GROUP BY day
    ORDER BY day
  ` as unknown as Promise<DailyRow[]>,
    platformPublishCounts(workspaceId),
  ]);

  const row = totals[0];

  return NextResponse.json(
    {
      totals: {
        drafts: row?.drafts ?? 0,
        // A publish linked to a draft is counted once, not twice.
        published:
          (row?.published ?? 0) +
          (row?.scheduled_published ?? 0) -
          (row?.linked_published ?? 0),
        scheduled: row?.scheduled ?? 0,
        failed: row?.failed ?? 0,
        tokens: row?.tokens ?? 0,
        cost: row?.cost ?? 0,
      },
      daily,
      platforms,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
