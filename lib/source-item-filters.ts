export const SOURCE_ITEM_TIME_ZONE = 'Asia/Manila';

export const SOURCE_ITEM_RANGES = ['today', 'day', 'month', 'all'] as const;

export type SourceItemRange = (typeof SOURCE_ITEM_RANGES)[number];

export type SourceItemFilters = {
  range: SourceItemRange;
  date: string | null;
  month: string | null;
  query: string;
  start: string | null;
  end: string | null;
  searchTerms: string[];
  searchPatterns: string[];
};

type SearchParamsReader = Pick<URLSearchParams, 'get'>;

export class SourceItemFilterError extends Error {}

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SOURCE_ITEM_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const MAX_QUERY_LENGTH = 200;

export function manilaSourceDay(date: Date): string {
  return dayFormatter.format(date);
}

function isValidDay(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidMonth(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}-01T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 7) === value;
}

function nextDay(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function nextMonth(value: string): string {
  const date = new Date(`${value}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 7);
}

function manilaMidnightIso(value: string): string {
  return new Date(`${value}T00:00:00+08:00`).toISOString();
}

export function escapeLikePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

export function parseSourceItemFilters(
  params: SearchParamsReader,
  now = new Date(),
): SourceItemFilters {
  const requestedRange = params.get('range') ?? 'today';
  if (!SOURCE_ITEM_RANGES.includes(requestedRange as SourceItemRange)) {
    throw new SourceItemFilterError('Invalid date range');
  }

  const range = requestedRange as SourceItemRange;
  let date: string | null = null;
  let month: string | null = null;

  if (range === 'day') {
    date = params.get('date');
    if (!isValidDay(date)) throw new SourceItemFilterError('Invalid date');
  }

  if (range === 'month') {
    month = params.get('month');
    if (!isValidMonth(month)) throw new SourceItemFilterError('Invalid month');
  }

  const query = (params.get('q') ?? '').trim();
  if (query.length > MAX_QUERY_LENGTH) {
    throw new SourceItemFilterError('Search must be 200 characters or fewer');
  }
  const searchTerms = query ? query.split(/\s+/) : [];

  let start: string | null = null;
  let end: string | null = null;
  if (range === 'today') {
    const today = manilaSourceDay(now);
    start = manilaMidnightIso(today);
    end = manilaMidnightIso(nextDay(today));
  } else if (range === 'day' && date) {
    start = manilaMidnightIso(date);
    end = manilaMidnightIso(nextDay(date));
  } else if (range === 'month' && month) {
    start = manilaMidnightIso(`${month}-01`);
    end = manilaMidnightIso(`${nextMonth(month)}-01`);
  }

  return {
    range,
    date,
    month,
    query,
    start,
    end,
    searchTerms,
    searchPatterns: searchTerms.map(escapeLikePattern),
  };
}
