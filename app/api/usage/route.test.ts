import { beforeEach, describe, expect, it, vi } from "vitest";

const { getOpenRouterUsageMock, getAzureUsageMock, requireWorkspaceMock } =
  vi.hoisted(() => ({
    getOpenRouterUsageMock: vi.fn(),
    getAzureUsageMock: vi.fn(),
    requireWorkspaceMock: vi.fn(),
  }));

vi.mock("@/lib/usage/openrouter", () => ({
  getOpenRouterUsage: getOpenRouterUsageMock,
}));
vi.mock("@/lib/usage/azure", () => ({
  getAzureUsage: getAzureUsageMock,
}));
vi.mock("@/lib/session", () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () =>
    new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
}));

import { GET } from "./route";

const openrouterUsage = {
  status: "available" as const,
  data: {
    creditsUsedUsd: 0.173826637,
    keyLimitUsd: null,
    keyRemainingUsd: null,
    dailyFreeRequests: { used: 7, limit: 50, remaining: 43 },
  },
};

const azureUsage = {
  status: "available" as const,
  data: {
    currentBalance: { currency: "USD", value: 200 },
    estimatedBalance: { currency: "USD", value: 190 },
    billingCurrency: "USD",
    creditCurrency: "USD",
    expiredCredit: { currency: "USD", value: 0 },
    pendingCreditAdjustments: null,
    pendingEligibleCharges: { currency: "USD", value: 12.5 },
    isEstimatedBalance: true,
    lots: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  requireWorkspaceMock.mockResolvedValue({
    user: { id: "u1" },
    workspace: { id: "ws1" },
  });
  getOpenRouterUsageMock.mockResolvedValue(openrouterUsage);
  getAzureUsageMock.mockResolvedValue(azureUsage);
});

function callRoute() {
  return GET(new Request("http://localhost/api/usage"));
}

describe("GET /api/usage", () => {
  it("requires a workspace before reading provider usage", async () => {
    requireWorkspaceMock.mockResolvedValue(null);

    const response = await callRoute();

    expect(response.status).toBe(401);
    expect(getOpenRouterUsageMock).not.toHaveBeenCalled();
    expect(getAzureUsageMock).not.toHaveBeenCalled();
  });

  it("returns both provider snapshots with no-store", async () => {
    const response = await callRoute();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      openrouter: openrouterUsage,
      azure: azureUsage,
    });
  });

  it("keeps Azure available when OpenRouter is unavailable", async () => {
    getOpenRouterUsageMock.mockResolvedValue({
      status: "unavailable",
      code: "not_configured",
      message: "OpenRouter usage is not configured.",
    });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.openrouter).toMatchObject({
      status: "unavailable",
      code: "not_configured",
    });
    expect(body.azure).toEqual(azureUsage);
  });

  it("keeps OpenRouter available when Azure is unavailable", async () => {
    getAzureUsageMock.mockResolvedValue({
      status: "unavailable",
      code: "unsupported",
      message: "Azure credit usage is not available for this billing profile.",
    });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.openrouter).toEqual(openrouterUsage);
    expect(body.azure).toMatchObject({
      status: "unavailable",
      code: "unsupported",
    });
  });

  it("isolates an unexpected provider rejection", async () => {
    getAzureUsageMock.mockRejectedValue(new Error("adapter failed"));

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.openrouter).toEqual(openrouterUsage);
    expect(body.azure).toMatchObject({
      status: "unavailable",
      code: "upstream_unavailable",
    });
  });
});
