'use client';

import { useEffect, useState } from 'react';
import { CalendarDays, ChevronDown, Search, X } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { SourceItemRange } from '@/lib/source-item-filters';

type ArchiveFiltersProps = {
  range: SourceItemRange;
  date: string;
  month: string;
  query: string;
  today: string;
  busy: boolean;
  onRangeChange: (range: SourceItemRange) => void;
  onDateChange: (date: string) => void;
  onMonthChange: (month: string) => void;
  onQueryChange: (query: string) => void;
  onReset: () => void;
};

const selectClassName =
  'h-10 w-full appearance-none rounded-lg border border-input bg-card px-3 pr-9 text-[13px] font-medium text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

export function ArchiveFilters({
  range,
  date,
  month,
  query,
  today,
  busy,
  onRangeChange,
  onDateChange,
  onMonthChange,
  onQueryChange,
  onReset,
}: ArchiveFiltersProps) {
  const [draft, setDraft] = useState({ source: query, value: query });
  if (draft.source !== query) {
    setDraft({ source: query, value: query });
  }
  const draftQuery = draft.value;
  const setDraftQuery = (value: string) => {
    setDraft(previous => ({ ...previous, value }));
  };

  useEffect(() => {
    const normalized = draftQuery.trim();
    if (normalized === query) return;
    const timer = window.setTimeout(() => onQueryChange(normalized), 350);
    return () => window.clearTimeout(timer);
  }, [draftQuery, query, onQueryChange]);

  const clearSearch = () => {
    setDraftQuery('');
    onQueryChange('');
  };

  return (
    <div className="shrink-0 border-b border-border/70 bg-card/30">
      <div className="mx-auto w-full max-w-[900px] px-4 py-3 sm:px-6">
        <form
          role="search"
          aria-busy={busy}
          onSubmit={event => {
            event.preventDefault();
            onQueryChange(draftQuery.trim());
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-0 flex-1 basis-full sm:min-w-[240px]">
            <Label htmlFor="source-story-search" className="mb-1.5 text-[11px] text-muted-foreground">
              Search stories
            </Label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint"
                aria-hidden
              />
              <Input
                id="source-story-search"
                type="search"
                value={draftQuery}
                onChange={event => setDraftQuery(event.target.value)}
                placeholder="Topic, person, source…"
                maxLength={200}
                aria-describedby="source-story-search-hint"
                className="h-10 bg-card pl-9 pr-9 text-[13px]"
              />
              {draftQuery && (
                <button
                  type="button"
                  onClick={clearSearch}
                  aria-label="Clear story search"
                  className="absolute right-1 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
          </div>

          <div className="w-[calc(50%-0.25rem)] sm:w-[170px]">
            <Label htmlFor="source-date-range" className="mb-1.5 text-[11px] text-muted-foreground">
              Date range
            </Label>
            <div className="relative">
              <select
                id="source-date-range"
                value={range}
                onChange={event => onRangeChange(event.target.value as SourceItemRange)}
                className={selectClassName}
              >
                <option value="today">Today</option>
                <option value="day">Specific day</option>
                <option value="month">Specific month</option>
                <option value="all">All time</option>
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-faint"
                aria-hidden
              />
            </div>
          </div>

          {range === 'day' && (
            <div className="w-[calc(50%-0.25rem)] sm:w-[160px]">
              <Label htmlFor="source-date" className="mb-1.5 text-[11px] text-muted-foreground">
                Day
              </Label>
              <Input
                id="source-date"
                type="date"
                value={date || today}
                max={today}
                onChange={event => onDateChange(event.target.value)}
                className="h-10 bg-card text-[13px]"
              />
            </div>
          )}

          {range === 'month' && (
            <div className="w-[calc(50%-0.25rem)] sm:w-[160px]">
              <Label htmlFor="source-month" className="mb-1.5 text-[11px] text-muted-foreground">
                Month
              </Label>
              <Input
                id="source-month"
                type="month"
                value={month || today.slice(0, 7)}
                max={today.slice(0, 7)}
                onChange={event => onMonthChange(event.target.value)}
                className="h-10 bg-card text-[13px]"
              />
            </div>
          )}

          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraftQuery('');
              onReset();
            }}
            disabled={range === 'today' && !draftQuery.trim()}
            className={cn('h-10 px-2.5 text-[12px]', range === 'day' || range === 'month' ? 'ml-auto' : '')}
          >
            Reset
          </Button>
        </form>
        <p id="source-story-search-hint" className="mt-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
          <CalendarDays className="mr-1 inline size-3 align-[-1px]" aria-hidden />
          Headlines, summaries, sources, authors and tags · Dates use Philippines time (PHT)
        </p>
      </div>
    </div>
  );
}
