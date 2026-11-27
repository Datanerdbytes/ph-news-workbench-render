import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOpenRouterUsage } from "./openrouter";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getOpenRouterUsage", () => {
  it("returns authoritative key usage without estimating missing limits", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          usage: 0.173826637,
          limit: null,
          limit_remaining: null,
          free_model_daily_requests: { used: 7, limit: 50, remaining: 43 },
        },
      })
    );

    await expect(getOpenRouterUsage()).resolves.toEqual({
      status: "available",
      data: {
        creditsUsedUsd: 0.173826637,
        keyLimitUsd: null,
        keyRemainingUsd: null,
        dailyFreeRequests: { used: 7, limit: 50, remaining: 43 },
      },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://openrouter.ai/api/v1/key");
    expect(init.method).toBe("GET");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get("authorization")).toMatch(
      /^Bearer \S+$/
    );
  });

  it("keeps absent optional fields unavailable", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { usage: 0 } }));

    await expect(getOpenRouterUsage()).resolves.toEqual({
      status: "available",
      data: {
        creditsUsedUsd: 0,
        keyLimitUsd: null,
        keyRemainingUsd: null,
        dailyFreeRequests: null,
      },
    });
  });

  it("reports missing configuration without making a request", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    await expect(getOpenRouterUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403])("maps HTTP %i to an authorization state", async (status) => {
    fetchMock.mockResolvedValue(
      new Response("upstream details", { status })
    );

    await expect(getOpenRouterUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: status === 401 ? "unauthorized" : "forbidden",
    });
  });

  it("maps invalid JSON to malformed_response", async () => {
    fetchMock.mockResolvedValue(new Response("not-json", { status: 200 }));

    await expect(getOpenRouterUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "malformed_response",
    });
  });

  it("maps invalid usage fields to malformed_response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          usage: "0.17",
          free_model_daily_requests: { used: 7, limit: 50, remaining: 43 },
        },
      })
    );

    await expect(getOpenRouterUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "malformed_response",
    });
  });

  it("maps a timed-out request to timeout", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeout);

    await expect(getOpenRouterUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "timeout",
    });
  });

  it("maps other network failures to a safe unavailable state", async () => {
    fetchMock.mockRejectedValue(new Error("network failed"));

    const result = await getOpenRouterUsage();
    expect(result).toMatchObject({
      status: "unavailable",
      code: "upstream_unavailable",
    });
    if (result.status === "unavailable") {
      expect(result.message).not.toContain("network failed");
    }
  });
});
