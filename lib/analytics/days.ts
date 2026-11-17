export const ANALYTICS_RANGES = [7, 14, 30, 90] as const;

export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = 14;

export function isAnalyticsRange(value: number): value is AnalyticsRange {
  return (ANALYTICS_RANGES as readonly number[]).includes(value);
}

// en-CA formats as YYYY-MM-DD, the same key shape the API returns.
const dayKey = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar day in Manila (PHT, UTC+8) as YYYY-MM-DD. */
export function manilaDayKey(date: Date): string {
  return dayKey.format(date);
}

/** The last `count` Manila days, oldest first, ending today. */
export function lastNDays(count: number, now = new Date()): string[] {
  const keys: string[] = [];
  // Manila has no DST, so stepping back 24h never skips or repeats a day.
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    keys.push(manilaDayKey(new Date(now.getTime() - offset * 86_400_000)));
  }
  return keys;
}
