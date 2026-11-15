import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCHEDULE_INVALID_ERROR,
  SCHEDULE_MISSING_ERROR,
  SCHEDULE_TOO_FAR_ERROR,
  SCHEDULE_TOO_SOON_ERROR,
  parseScheduledPublishTime,
  resolveScheduledFor,
  scheduledFields,
} from "./schedule";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseScheduledPublishTime", () => {
  it("treats missing input as publish-immediately", () => {
    expect(parseScheduledPublishTime(undefined)).toEqual({ unix: null });
    expect(parseScheduledPublishTime(null)).toEqual({ unix: null });
    expect(parseScheduledPublishTime("")).toEqual({ unix: null });
  });

  it("rejects unparseable dates", () => {
    expect(parseScheduledPublishTime("next tuesdayish")).toEqual({
      unix: null,
      error: "Pick a valid date and time to schedule.",
    });
  });

  it("enforces Meta's 10-minute minimum", () => {
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    expect(parseScheduledPublishTime(soon)).toEqual({
      unix: null,
      error: "Scheduled time must be at least 10 minutes from now.",
    });
  });

  it("accepts exactly 10 minutes out", () => {
    const edge = new Date(Date.now() + 10 * 60_000);
    expect(parseScheduledPublishTime(edge.toISOString()).error).toBeUndefined();
  });

  it("enforces Meta's 75-day maximum", () => {
    const far = new Date(Date.now() + 76 * 24 * 60 * 60_000).toISOString();
    expect(parseScheduledPublishTime(far)).toEqual({
      unix: null,
      error: "Scheduling supports at most 75 days ahead.",
    });
  });

  it("returns a unix timestamp for valid windows", () => {
    const target = new Date(Date.now() + 10 * 24 * 60 * 60_000);
    expect(parseScheduledPublishTime(target.toISOString())).toEqual({
      unix: Math.floor(target.getTime() / 1000),
    });
  });
});

describe("resolveScheduledFor", () => {
  // Local time on purpose: a datetime-local value parses as local time, so
  // building both the clock and the expectations from local strings keeps
  // these assertions timezone-independent.
  const now = new Date("2026-11-13T09:00:00");

  beforeEach(() => {
    vi.setSystemTime(now);
  });

  it("resolves a value inside the window to an ISO string", () => {
    expect(resolveScheduledFor("2026-11-14T09:00", now)).toEqual({
      iso: new Date("2026-11-14T09:00").toISOString(),
    });
  });

  it("names a missing value instead of the window", () => {
    expect(resolveScheduledFor("", now)).toEqual({
      iso: null,
      error: SCHEDULE_MISSING_ERROR,
    });
    expect(resolveScheduledFor(undefined, now)).toEqual({
      iso: null,
      error: SCHEDULE_MISSING_ERROR,
    });
  });

  it("names an unparseable value", () => {
    expect(resolveScheduledFor("not-a-date", now)).toEqual({
      iso: null,
      error: SCHEDULE_INVALID_ERROR,
    });
  });

  it("says how close the time is when it is too soon", () => {
    // 5 minutes out — below the 10-minute floor.
    expect(resolveScheduledFor("2026-11-13T09:05", now)).toEqual({
      iso: null,
      error: SCHEDULE_TOO_SOON_ERROR,
    });
  });

  it("says the ceiling when the time is too far out", () => {
    // 80 days out — past the 75-day ceiling.
    expect(resolveScheduledFor("2027-02-01T09:00", now)).toEqual({
      iso: null,
      error: SCHEDULE_TOO_FAR_ERROR,
    });
  });

  it("accepts the exact 10-minute and 75-day edges", () => {
    expect(resolveScheduledFor("2026-11-13T09:10", now).iso).toBe(
      new Date("2026-11-13T09:10").toISOString()
    );
    expect(resolveScheduledFor("2027-01-27T09:00", now).iso).toBe(
      new Date("2027-01-27T09:00").toISOString()
    );
  });

  it("refuses exactly what the server refuses", () => {
    // Client and server share the window rules, so a value the composer
    // accepts has to survive the server's own check — and vice versa.
    expect(resolveScheduledFor("2026-11-14T09:00", now).iso).not.toBeNull();
    expect(parseScheduledPublishTime("2026-11-14T09:00").unix).not.toBeNull();

    expect(resolveScheduledFor("2026-11-13T09:05", now).iso).toBeNull();
    expect(parseScheduledPublishTime("2026-11-13T09:05").unix).toBeNull();
  });
});

describe("scheduledFields", () => {
  it("omits scheduling fields for immediate publishes", () => {
    expect(scheduledFields(null)).toEqual({});
  });

  it("marks the post unpublished with the requested time", () => {
    expect(scheduledFields(1_800_000_000)).toEqual({
      published: "false",
      scheduled_publish_time: "1800000000",
    });
  });
});
