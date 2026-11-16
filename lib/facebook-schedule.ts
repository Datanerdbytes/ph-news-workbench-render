/**
 * One scheduled action can cover several Pages: each Page that accepted the
 * schedule is stored in `facebook_post_ids` with its per-Page post id. Both
 * the API route and the schedule worker reconcile against the same target
 * list, so the shaping lives here.
 */

export type FacebookSchedulePageResult = {
  page: { id: string; name: string };
  ok: boolean;
  id?: string;
  permalink?: string | null;
  error?: string;
};

export type FacebookScheduleTargetRow = {
  facebook_post_id: string | null;
  facebook_post_ids: unknown;
  page_id: string | null;
};

export type FacebookScheduleTarget = {
  pageId: string | null;
  postId: string;
};

/** Every Page that accepted this scheduled action, with the per-Page id. */
export function facebookTargets(
  row: FacebookScheduleTargetRow
): FacebookScheduleTarget[] {
  const perPage = Array.isArray(row.facebook_post_ids)
    ? (row.facebook_post_ids as FacebookSchedulePageResult[]).filter(
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
