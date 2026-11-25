import { NextResponse } from 'next/server';
import { FacebookApiError, redactTokens } from '@/lib/facebook';
import { InstagramApiError } from '@/lib/instagram';
import { notifyPublishAttemptFailure } from '@/lib/notifications';

export async function facebookErrorResponse(
  error: unknown,
  code: string,
  fallback: string,
  notify?: { workspaceId: string; kind?: string | null },
  // Replaces the raw Graph message in the response while it stays in the
  // logs and the failure notification — for errors whose Graph text is not
  // actionable for the user.
  { userMessage }: { userMessage?: string } = {}
): Promise<NextResponse> {
  const permissionIssue =
    error instanceof FacebookApiError &&
    (error.code === 10 || error.code === 200 || error.code === 190);

  let message: string;
  let outCode = code;
  if (error instanceof FacebookApiError) {
    message = userMessage ?? redactTokens(error.message);
    if (permissionIssue) {
      message = `${message} Reconnect the Page to refresh its permissions.`;
      outCode = 'permission';
    }
  } else if (error instanceof Error && error.message) {
    message = userMessage ?? redactTokens(error.message);
  } else {
    message = userMessage ?? fallback;
  }

  // The bell keeps the failed attempt visible after the toast is gone.
  if (notify) {
    await notifyPublishAttemptFailure({ ...notify, reason: message });
  }

  return NextResponse.json(
    { error: message, code: outCode },
    {
      status:
        error instanceof FacebookApiError
          ? permissionIssue
            ? 403
            : 502
          : 500,
    }
  );
}
export async function instagramErrorResponse(
  error: unknown,
  code: string,
  fallback: string,
  notify?: { workspaceId: string; kind?: string | null }
): Promise<NextResponse> {
  const apiError =
    error instanceof FacebookApiError || error instanceof InstagramApiError;
  const permissionIssue =
    apiError && (error.code === 10 || error.code === 200 || error.code === 190);

  let message: string;
  let outCode = code;
  if (apiError) {
    message = redactTokens(error.message);
    if (permissionIssue) {
      message = `${message} Reconnect Instagram to refresh its permissions.`;
      outCode = 'permission';
    }
  } else if (error instanceof Error && error.message) {
    message = redactTokens(error.message);
  } else {
    message = fallback;
  }

  if (notify) {
    await notifyPublishAttemptFailure({ ...notify, reason: message });
  }

  return NextResponse.json(
    { error: message, code: outCode },
    {
      status: apiError ? (permissionIssue ? 403 : 502) : 500,
    }
  );
}

export async function youtubeErrorResponse(
  error: unknown,
  code: string,
  fallback: string,
  notify?: { workspaceId: string; kind?: string | null }
): Promise<NextResponse> {
  const message =
    error instanceof Error && error.message
      ? redactTokens(error.message)
      : fallback;

  let status = 502;
  let outCode = code;
  if (error instanceof Error) {
    if (/token|Reconnect/i.test(message)) {
      status = 403;
      outCode = 'permission';
    } else if (/quota/i.test(message)) {
      outCode = 'quota_exceeded';
    }
  }

  if (notify) {
    await notifyPublishAttemptFailure({ ...notify, reason: message });
  }

  return NextResponse.json({ error: message, code: outCode }, { status });
}

export async function tiktokErrorResponse(
  error: unknown,
  code: string,
  fallback: string,
  notify?: { workspaceId: string; kind?: string | null }
): Promise<NextResponse> {
  const message =
    error instanceof Error && error.message
      ? redactTokens(error.message)
      : fallback;

  let status = 502;
  let outCode = code;
  if (error instanceof Error) {
    if (/token|Reconnect/i.test(message)) {
      status = 403;
      outCode = 'permission';
    } else if (/access_denied|scopes|permission/i.test(message)) {
      status = 403;
      outCode = 'permission';
    }
  }

  if (notify) {
    await notifyPublishAttemptFailure({ ...notify, reason: message });
  }

  return NextResponse.json({ error: message, code: outCode }, { status });
}
