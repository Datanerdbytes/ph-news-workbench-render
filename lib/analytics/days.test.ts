import { describe, expect, it } from "vitest";
import {
  ANALYTICS_RANGES,
  DEFAULT_ANALYTICS_RANGE,
  isAnalyticsRange,
  lastNDays,
  manilaDayKey,
} from "./days";

describe("manilaDayKey", () => {
  it("formats a UTC instant as the Manila calendar day", () => {
    // 15:00Z is 23:00 PHT — still the 17th locally.
    expect(manilaDayKey(new Date("2026-11-17T15:00:00Z"))).toBe("2026-11-17");
  });

  it("rolls over at 16:00Z (midnight PHT), not at UTC midnight", () => {
    // 16:30Z is 00:30 PHT on the 18th.
    expect(manilaDayKey(new Date("2026-11-17T16:30:00Z"))).toBe("2026-11-18");
  });
});

describe("lastNDays", () => {
  it("returns the range oldest first, ending today in Manila", () => {
    const days = lastNDays(7, new Date("2026-11-17T16:30:00Z"));

    expect(days).toHaveLength(7);
    expect(days.at(-1)).toBe("2026-11-18");
    expect(days[0]).toBe("2026-11-12");
    expect(days).toEqual([
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
    ]);
  });

  it("handles a single day", () => {
    expect(lastNDays(1, new Date("2026-11-17T03:00:00Z"))).toEqual([
      "2026-11-17",
    ]);
  });
});

describe("isAnalyticsRange", () => {
  it("accepts exactly the supported ranges", () => {
    for (const range of ANALYTICS_RANGES) {
      expect(isAnalyticsRange(range)).toBe(true);
    }
    expect(isAnalyticsRange(15)).toBe(false);
    expect(isAnalyticsRange(0)).toBe(false);
    expect(isAnalyticsRange(Number.NaN)).toBe(false);
  });

  it("defaults to 14 days", () => {
    expect(DEFAULT_ANALYTICS_RANGE).toBe(14);
  });
});
