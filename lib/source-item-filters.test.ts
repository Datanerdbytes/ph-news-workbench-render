import { describe, expect, it } from 'vitest';
import {
  manilaSourceDay,
  parseSourceItemFilters,
  SourceItemFilterError,
} from './source-item-filters';

describe('source item filters', () => {
  it('defaults to the current Manila day before midnight', () => {
    const filters = parseSourceItemFilters(
      new URLSearchParams(),
      new Date('2026-11-24T15:59:59.000Z'),
    );

    expect(manilaSourceDay(new Date('2026-11-24T15:59:59.000Z'))).toBe('2026-11-24');
    expect(filters.range).toBe('today');
    expect(filters.start).toBe('2026-11-23T16:00:00.000Z');
    expect(filters.end).toBe('2026-11-24T16:00:00.000Z');
  });

  it('moves Today to the next Manila day at UTC+8 midnight', () => {
    const filters = parseSourceItemFilters(
      new URLSearchParams(),
      new Date('2026-11-24T16:00:00.000Z'),
    );

    expect(filters.start).toBe('2026-11-24T16:00:00.000Z');
    expect(filters.end).toBe('2026-11-25T16:00:00.000Z');
  });

  it('uses an inclusive Manila start and exclusive next-day end', () => {
    const filters = parseSourceItemFilters(
      new URLSearchParams('range=day&date=2026-11-24'),
      new Date('2026-11-25T00:00:00.000Z'),
    );

    expect(filters.date).toBe('2026-11-24');
    expect(filters.start).toBe('2026-11-23T16:00:00.000Z');
    expect(filters.end).toBe('2026-11-24T16:00:00.000Z');
  });

  it('handles leap-year and year-end month boundaries', () => {
    const february = parseSourceItemFilters(
      new URLSearchParams('range=month&month=2024-02'),
      new Date('2024-03-01T00:00:00.000Z'),
    );
    const december = parseSourceItemFilters(
      new URLSearchParams('range=month&month=2026-12'),
      new Date('2026-12-01T00:00:00.000Z'),
    );

    expect(february.start).toBe('2024-01-31T16:00:00.000Z');
    expect(february.end).toBe('2024-02-29T16:00:00.000Z');
    expect(december.start).toBe('2026-11-30T16:00:00.000Z');
    expect(december.end).toBe('2026-12-31T16:00:00.000Z');
  });

  it('leaves All time unbounded', () => {
    const filters = parseSourceItemFilters(
      new URLSearchParams('range=all'),
      new Date('2026-11-24T00:00:00.000Z'),
    );

    expect(filters.start).toBeNull();
    expect(filters.end).toBeNull();
  });

  it('splits search words and escapes LIKE wildcards literally', () => {
    const filters = parseSourceItemFilters(
      new URLSearchParams('q=  Maya%  flood_  \\  '),
      new Date('2026-11-24T00:00:00.000Z'),
    );

    expect(filters.query).toBe('Maya%  flood_  \\');
    expect(filters.searchTerms).toEqual(['Maya%', 'flood_', '\\']);
    expect(filters.searchPatterns).toEqual(['%Maya\\%%', '%flood\\_%', '%\\\\%']);
  });

  it.each([
    'range=week',
    'range=day',
    'range=day&date=2026-02-30',
    'range=day&date=11/24/2026',
    'range=month',
    'range=month&month=2026-13',
    'range=month&month=2026-11-01',
    `q=${'a'.repeat(201)}`,
  ])('rejects invalid filter input: %s', query => {
    expect(() => parseSourceItemFilters(new URLSearchParams(query))).toThrow(
      SourceItemFilterError,
    );
  });
});
