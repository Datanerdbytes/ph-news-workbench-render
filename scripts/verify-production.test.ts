import { describe, expect, it } from "vitest";
import { isHealthy, retryDelayMs, waitForHealth } from "./verify-production.mjs";

function stubFetch(responses: Array<{ status?: number; throw?: Error }>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error("the test did not queue a response for this call");
    if (next.throw) throw next.throw;
    return new Response("", { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noSleep = async () => {};

describe("isHealthy", () => {
  it("accepts a 200 and a redirect", () => {
    expect(isHealthy(200)).toBe(true);
    expect(isHealthy(307)).toBe(true);
  });

  it("rejects an error and a missing status", () => {
    expect(isHealthy(502)).toBe(false);
    expect(isHealthy(503)).toBe(false);
    expect(isHealthy(undefined)).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("grows with the attempt number but stays bounded", () => {
    expect(retryDelayMs(1)).toBe(5_000);
    expect(retryDelayMs(3)).toBe(15_000);
    expect(retryDelayMs(100)).toBe(30_000);
  });
});

describe("waitForHealth", () => {
  it("returns as soon as the app answers", async () => {
    const { impl, calls } = stubFetch([{ status: 200 }]);

    const result = await waitForHealth({
      url: "https://example.test/login",
      timeoutMs: 60_000,
      fetchImpl: impl,
      sleep: noSleep,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(calls).toEqual(["https://example.test/login"]);
  });

  it("keeps retrying while the instance is starting", async () => {
    const { impl, calls } = stubFetch([
      { status: 502 },
      { status: 503 },
      { status: 200 },
    ]);

    const result = await waitForHealth({
      url: "https://example.test/login",
      timeoutMs: 60_000,
      fetchImpl: impl,
      sleep: noSleep,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("throws when the app never becomes healthy", async () => {
    const { impl } = stubFetch([{ status: 502 }, { status: 502 }]);

    await expect(
      waitForHealth({
        url: "https://example.test/login",
        timeoutMs: 0,
        fetchImpl: impl,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/did not become healthy/);
  });

  it("throws when the request itself keeps failing", async () => {
    const { impl } = stubFetch([{ throw: new Error("connection refused") }]);

    await expect(
      waitForHealth({
        url: "https://example.test/login",
        timeoutMs: 0,
        fetchImpl: impl,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/connection refused/);
  });
});
