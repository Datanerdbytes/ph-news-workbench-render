// Meta rejects Page post schedules outside this window.
export const MIN_SCHEDULE_MS = 10 * 60 * 1000;
export const MAX_SCHEDULE_MS = 75 * 24 * 60 * 60 * 1000;
/**
 * Meta accepts a scheduled_publish_time at most 30 days out (29 for reels),
 * narrower than the workspace's own 75-day window. Rows Facebook holds must
 * stay inside it or the platform refuses the schedule.
 */
export const FACEBOOK_SCHEDULE_MAX_MS = 29 * 24 * 60 * 60 * 1000;

export const SCHEDULE_MISSING_ERROR = 'Pick a date and time to schedule.';
export const SCHEDULE_INVALID_ERROR = 'Pick a valid date and time to schedule.';
export const SCHEDULE_TOO_SOON_ERROR =
  'Scheduled time must be at least 10 minutes from now.';
export const SCHEDULE_TOO_FAR_ERROR =
  'Scheduling supports at most 75 days ahead.';

/**
 * The window check every caller shares. The message names the bound that was
 * broken: a time 9 minutes out is "too soon", not "pick a different day".
 */
export function scheduleWindowError(
  date: Date,
  now: number = Date.now()
): string | undefined {
  const delta = date.getTime() - now;
  if (delta < MIN_SCHEDULE_MS) return SCHEDULE_TOO_SOON_ERROR;
  if (delta > MAX_SCHEDULE_MS) return SCHEDULE_TOO_FAR_ERROR;
  return undefined;
}

function scheduledDate(
  value: unknown,
  now: number
): { date: Date | null; error?: string } {
  if (value === undefined || value === null || value === '') {
    return { date: null };
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return { date: null, error: SCHEDULE_INVALID_ERROR };
  }
  const error = scheduleWindowError(date, now);
  return error ? { date: null, error } : { date };
}

export function parseScheduledPublishTime(value: unknown): {
  unix: number | null;
  error?: string;
} {
  if (value === undefined || value === null || value === '') {
    return { unix: null };
  }

  const { date, error } = scheduledDate(value, Date.now());
  if (!date) {
    return { unix: null, error };
  }

  return { unix: Math.floor(date.getTime() / 1000) };
}

/**
 * `iso` is the discriminant: `null` means the value was refused and `error`
 * says why, a string means it resolved. Callers must test `iso === null`
 * (not `!iso`) — `string` includes `""`, so a truthiness check leaves the
 * union unnarrowed and `error` typed as `string | undefined`.
 */
export type ScheduleResolution =
  | { iso: string; error?: undefined }
  | { iso: null; error: string };

/**
 * The client-side counterpart of parseScheduledPublishTime: the composer's
 * datetime-local value in, the ISO string to post out — or the reason it was
 * refused, so the composer can say which bound was broken.
 */
export function resolveScheduledFor(
  value: unknown,
  now: Date = new Date()
): ScheduleResolution {
  if (value === undefined || value === null || value === '') {
    return { iso: null, error: SCHEDULE_MISSING_ERROR };
  }

  const { date, error } = scheduledDate(value, now.getTime());
  if (!date) {
    return { iso: null, error: error ?? SCHEDULE_INVALID_ERROR };
  }

  return { iso: date.toISOString() };
}

export function scheduledFields(
  unix: number | null
): Record<string, string> {
  if (unix === null) return {};
  return {
    published: 'false',
    scheduled_publish_time: String(unix),
  };
}
