import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TTS_CHARACTERS } from "@/lib/tts/text";
import {
  MAX_AVATAR_JOB_SECONDS,
  avatarLimits,
  estimateAvatarSeconds,
  utcDay,
} from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("avatarLimits", () => {
  it("falls back to the built-in caps", () => {
    expect(avatarLimits()).toEqual({
      dailyJobs: 5,
      dailySeconds: 1_800,
      maxActive: 2,
      apiRequestsPerMinute: 2,
      maxCharacters: MAX_TTS_CHARACTERS,
      maxJobSeconds: MAX_AVATAR_JOB_SECONDS,
    });
  });

  it("reads the configured caps", () => {
    vi.stubEnv("AVATAR_DAILY_JOB_CAP", "7");
    vi.stubEnv("AVATAR_DAILY_SECONDS_CAP", "900");
    vi.stubEnv("AVATAR_MAX_ACTIVE_JOBS", "3");
    vi.stubEnv("AVATAR_API_REQUESTS_PER_MINUTE", "4");
    vi.stubEnv("AVATAR_MAX_CHARACTERS", "900");
    vi.stubEnv("AVATAR_MAX_JOB_SECONDS", "120");

    expect(avatarLimits()).toEqual({
      dailyJobs: 7,
      dailySeconds: 900,
      maxActive: 3,
      apiRequestsPerMinute: 4,
      maxCharacters: 900,
      maxJobSeconds: 120,
    });
  });

  it.each(["0", "-1", "abc", "2.5", ""])(
    "ignores an unusable cap: %s",
    (value) => {
      vi.stubEnv("AVATAR_DAILY_JOB_CAP", value);
      expect(avatarLimits().dailyJobs).toBe(5);
    },
  );

  it("never raises the character or duration ceiling", () => {
    vi.stubEnv("AVATAR_MAX_CHARACTERS", "999999");
    vi.stubEnv("AVATAR_MAX_JOB_SECONDS", "999999");

    const limits = avatarLimits();
    expect(limits.maxCharacters).toBe(MAX_TTS_CHARACTERS);
    expect(limits.maxJobSeconds).toBe(MAX_AVATAR_JOB_SECONDS);
  });
});

describe("estimateAvatarSeconds", () => {
  it("keeps a minimum of three seconds", () => {
    expect(estimateAvatarSeconds("Hi", 1)).toBe(3);
    expect(estimateAvatarSeconds("", 1)).toBe(3);
  });

  it("grows with the text length and shrinks with the speed", () => {
    const text = "a".repeat(220);
    expect(estimateAvatarSeconds(text, 1)).toBe(Math.ceil(220 / 11) + 2);
    expect(estimateAvatarSeconds(text, 1.25)).toBe(
      Math.ceil(220 / (11 * 1.25)) + 2,
    );
    expect(estimateAvatarSeconds(text, 1.25)).toBeLessThan(
      estimateAvatarSeconds(text, 1),
    );
  });
});

describe("utcDay", () => {
  it("reports the current UTC day", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-17T23:30:00.000Z"));
      expect(utcDay()).toBe("2026-11-17");
      // The day rolls over in UTC, not in the local timezone.
      vi.setSystemTime(new Date("2026-11-18T00:30:00.000Z"));
      expect(utcDay()).toBe("2026-11-18");
    } finally {
      vi.useRealTimers();
    }
  });
});
