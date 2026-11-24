import {
  FacebookApiError,
  graphPostForm,
  graphRequest,
} from '@/lib/facebook';

type RawLiveVideo = {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  stream_url?: string;
  secure_stream_url?: string;
  permalink_url?: string;
  planned_start_time?: string;
};

export type LiveVideo = {
  id: string;
  title: string;
  description: string;
  status: string;
  streamUrl: string | null;
  secureStreamUrl: string | null;
  permalink: string | null;
  plannedStartTime: string | null;
};

function mapLiveVideo(
  body: RawLiveVideo,
  fallbackId = '',
  // The create response does not echo title/description/status, so the
  // values we just sent stand in for them.
  known: Partial<Pick<LiveVideo, 'title' | 'description' | 'status'>> = {}
): LiveVideo {
  return {
    id: body.id ?? fallbackId,
    title: body.title ?? known.title ?? 'Untitled live stream',
    description: body.description ?? known.description ?? '',
    status: body.status ?? known.status ?? 'UNKNOWN',
    streamUrl: body.stream_url ?? null,
    secureStreamUrl: body.secure_stream_url ?? null,
    permalink: body.permalink_url ?? null,
    plannedStartTime: body.planned_start_time ?? null,
  };
}

export async function createPageLiveVideo({
  pageId,
  accessToken,
  title,
  description = '',
  plannedStartTime = null,
}: {
  pageId: string;
  accessToken: string;
  title: string;
  description?: string;
  plannedStartTime?: number | null;
}): Promise<LiveVideo> {
  const fields: Record<string, string> = {
    title,
    status: plannedStartTime ? 'UNPUBLISHED' : 'LIVE_NOW',
  };
  if (description) fields.description = description;
  if (plannedStartTime) {
    fields.planned_start_time = String(plannedStartTime);
  }

  const body = await graphPostForm<RawLiveVideo>(
    `${pageId}/live_videos`,
    fields,
    accessToken
  );

  return mapLiveVideo(body, '', {
    title,
    description,
    status: plannedStartTime ? 'UNPUBLISHED' : 'LIVE_NOW',
  });
}

export async function updatePageLiveVideo({
  liveVideoId,
  accessToken,
  title,
  description,
  plannedStartTime = null,
}: {
  liveVideoId: string;
  accessToken: string;
  title: string;
  description: string;
  plannedStartTime?: number | null;
}): Promise<LiveVideo> {
  const fields: Record<string, string> = { title, description };
  if (plannedStartTime) {
    fields.planned_start_time = String(plannedStartTime);
  }

  const body = await graphPostForm<RawLiveVideo>(
    liveVideoId,
    fields,
    accessToken
  );

  return mapLiveVideo(body, liveVideoId);
}

export async function endPageLiveVideo({
  liveVideoId,
  accessToken,
}: {
  liveVideoId: string;
  accessToken: string;
}): Promise<void> {
  await graphPostForm(
    liveVideoId,
    { end_live_video: 'true' },
    accessToken
  );
}

/**
 * Whether a Graph failure means the broadcast is already gone from Facebook.
 *
 * The reported QUA-18 symptom was a card in STOPPED state whose end call
 * failed with "Unsupported post request. Object with ID '…' does not exist".
 * A finished broadcast is history on Facebook — the node is no longer
 * addressable — so the end request is expected to fail, and the local row
 * should be cleaned up instead of being treated as a live failure.
 */
export function isAlreadyEndedGraphError(
  error: unknown
): error is FacebookApiError {
  return (
    error instanceof FacebookApiError &&
    error.code === 100 &&
    /Unsupported (get|post) request\. Object with ID /i.test(error.message)
  );
}

/**
 * The id that `end_live_video` must target — the live video node id, not a
 * value Graph cannot resolve to a broadcast. When the row has a stored id,
 * the node is re-read from Facebook so the end goes to a real id; returns
 * null when the row stores none or Graph reports an unavailable node.
 */
export async function resolveEndVideoId({
  liveVideoId,
  accessToken,
}: {
  liveVideoId: string;
  accessToken: string;
}): Promise<string | null> {
  if (!liveVideoId) return null;
  try {
    const live = await fetchPageLiveVideo(liveVideoId, accessToken);
    return live.id || null;
  } catch (error) {
    if (
      error instanceof FacebookApiError &&
      error.code === 100 &&
      /^Unsupported get request\. Object with ID /i.test(error.message)
    ) {
      return null;
    }
    throw error;
  }
}

export async function fetchPageLiveVideo(
  liveVideoId: string,
  accessToken: string
): Promise<LiveVideo> {
  const body = await graphRequest<RawLiveVideo>(
    liveVideoId,
    {
      fields:
        'id,title,description,status,permalink_url,planned_start_time,stream_url,secure_stream_url',
    },
    accessToken
  );
  return mapLiveVideo(body, liveVideoId);
}

export type LiveComment = {
  id: string;
  message: string;
  author: string;
  createdTime: string | null;
};

export async function fetchLiveComments({
  liveVideoId,
  accessToken,
  after,
}: {
  liveVideoId: string;
  accessToken: string;
  after?: string | null;
}): Promise<{ comments: LiveComment[]; next: string | null }> {
  const params: Record<string, string> = {
    live_filter: 'no_filter',
    order: 'chronological',
    fields: 'id,message,created_time,from{id,name}',
    limit: '50',
  };
  if (after) params.after = after;

  const body = await graphRequest<{
    data?: {
      id: string;
      message?: string;
      created_time?: string;
      from?: { name?: string };
    }[];
    paging?: { cursors?: { after?: string } };
  }>(`${liveVideoId}/comments`, params, accessToken);

  return {
    comments: (body.data ?? []).map((comment) => ({
      id: comment.id,
      message: comment.message ?? '',
      author: comment.from?.name ?? 'Viewer',
      createdTime: comment.created_time ?? null,
    })),
    next: body.paging?.cursors?.after ?? null,
  };
}
