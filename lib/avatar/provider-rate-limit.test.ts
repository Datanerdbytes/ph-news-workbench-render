import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const START = Date.parse("2026-11-26T00:00:00.000Z");

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.stubEnv("AVATAR_API_REQUESTS_PER_MINUTE", "2");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("avatar provider rate limit", () => {
  it("serializes requests below Azure's default two-per-minute quota", async () => {
    const { waitForAvatarRequest } = await import("./provider-rate-limit");
    const starts: number[] = [];
    const requests = [0, 1, 2].map(() =>
      waitForAvatarRequest().then(() => starts.push(Date.now() - START)),
    );

    await vi.advanceTimersByTimeAsync(30_249);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 30_250]);
    await vi.advanceTimersByTimeAsync(30_249);
    expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(requests);
    expect(starts).toEqual([0, 30_250, 60_500]);
  });

  it("uses the configured quota after Azure approves an increase", async () => {
    vi.stubEnv("AVATAR_API_REQUESTS_PER_MINUTE", "4");
    const { waitForAvatarRequest } = await import("./provider-rate-limit");
    const starts: number[] = [];
    const first = waitForAvatarRequest().then(() => starts.push(Date.now() - START));
    const second = waitForAvatarRequest().then(() => starts.push(Date.now() - START));

    await vi.advanceTimersByTimeAsync(15_249);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(starts).toEqual([0, 15_250]);
  });

  it("honors Retry-After and applies a safe fallback when it is missing", async () => {
    const { deferAvatarRequests, waitForAvatarRequest } = await import(
      "./provider-rate-limit"
    );
    await waitForAvatarRequest();
    deferAvatarRequests(
      new Response(null, { status: 429, headers: { "retry-after": "120" } }),
    );
    const afterHeader = waitForAvatarRequest().then(() => Date.now() - START);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(afterHeader).resolves.toBe(120_000);

    deferAvatarRequests(new Response(null, { status: 429 }));
    const afterMissingHeader = waitForAvatarRequest().then(() => Date.now() - START);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(afterMissingHeader).resolves.toBe(180_000);
  });
});
