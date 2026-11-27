import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAzureUsage } from "./azure";

const fetchMock = vi.fn();

const azureEnv = {
  AZURE_BILLING_TENANT_ID: "tenant/with space",
  AZURE_BILLING_CLIENT_ID: "test-client-id",
  AZURE_BILLING_CLIENT_SECRET: "test-client-secret",
  AZURE_BILLING_ACCOUNT_ID: "account:one",
  AZURE_BILLING_PROFILE_ID: "profile/two",
} as const;

const balanceResponse = {
  properties: {
    balanceSummary: {
      currentBalance: { currency: "USD", value: 200 },
      estimatedBalance: { currency: "USD", value: 190 },
    },
    billingCurrency: "USD",
    creditCurrency: "USD",
    expiredCredit: { currency: "USD", value: 0 },
    pendingCreditAdjustments: { currency: "USD", value: 5 },
    pendingEligibleCharges: { currency: "USD", value: 12.5 },
    isEstimatedBalance: true,
  },
};

const lotsResponse = {
  value: [
    {
      properties: {
        source: "Azure sign-up credit",
        startDate: "2026-01-01T00:00:00Z",
        expirationDate: "2026-12-31T00:00:00Z",
        status: "Active",
        originalAmount: { currency: "USD", value: 200 },
        closedBalance: { currency: "USD", value: 10 },
        isEstimatedBalance: false,
      },
    },
  ],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockAzureSuccess() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("login.microsoftonline.com")) {
      return jsonResponse({ access_token: "test-access-token" });
    }
    if (url.includes("/credits/balanceSummary")) {
      return jsonResponse(balanceResponse);
    }
    if (url.includes("/providers/Microsoft.Consumption/lots")) {
      return jsonResponse(lotsResponse);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  for (const [key, value] of Object.entries(azureEnv)) {
    vi.stubEnv(key, value);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getAzureUsage", () => {
  it("returns MCA balances and credit lots from the authoritative APIs", async () => {
    mockAzureSuccess();

    await expect(getAzureUsage()).resolves.toEqual({
      status: "available",
      data: {
        currentBalance: { currency: "USD", value: 200 },
        estimatedBalance: { currency: "USD", value: 190 },
        billingCurrency: "USD",
        creditCurrency: "USD",
        expiredCredit: { currency: "USD", value: 0 },
        pendingCreditAdjustments: { currency: "USD", value: 5 },
        pendingEligibleCharges: { currency: "USD", value: 12.5 },
        isEstimatedBalance: true,
        lots: [
          {
            source: "Azure sign-up credit",
            startDate: "2026-01-01T00:00:00Z",
            expirationDate: "2026-12-31T00:00:00Z",
            status: "Active",
            originalAmount: { currency: "USD", value: 200 },
            closedBalance: { currency: "USD", value: 10 },
            isEstimatedBalance: false,
          },
        ],
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(String(tokenUrl)).toBe(
      "https://login.microsoftonline.com/tenant%2Fwith%20space/oauth2/v2.0/token"
    );
    expect(tokenInit.method).toBe("POST");
    expect(tokenInit.cache).toBe("no-store");
    expect(tokenInit.signal).toBeInstanceOf(AbortSignal);
    expect(tokenInit.body).toBeInstanceOf(URLSearchParams);
    const tokenBody = tokenInit.body as URLSearchParams;
    expect(tokenBody.get("grant_type")).toBe("client_credentials");
    expect(tokenBody.get("scope")).toBe("https://management.azure.com/.default");
    expect(tokenBody.has("client_id")).toBe(true);
    expect(tokenBody.has("client_secret")).toBe(true);

    const consumptionCalls = fetchMock.mock.calls.slice(1);
    expect(consumptionCalls.map(([url]) => String(url))).toEqual([
      "https://management.azure.com/providers/Microsoft.Billing/billingAccounts/account%3Aone/billingProfiles/profile%2Ftwo/providers/Microsoft.Consumption/credits/balanceSummary?api-version=2026-06-01",
      "https://management.azure.com/providers/Microsoft.Billing/billingAccounts/account%3Aone/billingProfiles/profile%2Ftwo/providers/Microsoft.Consumption/lots?api-version=2026-06-01",
    ]);
    for (const [, init] of consumptionCalls) {
      expect(init.cache).toBe("no-store");
      expect(new Headers(init.headers).get("authorization")).toMatch(
        /^Bearer \S+$/
      );
    }
  });

  it("reports missing configuration without making a request", async () => {
    vi.stubEnv("AZURE_BILLING_CLIENT_SECRET", "");

    await expect(getAzureUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps token authorization failure to unauthorized", async () => {
    fetchMock.mockResolvedValue(new Response("upstream details", { status: 401 }));

    await expect(getAzureUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "unauthorized",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps invalid client credentials to unauthorized", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "invalid_client" }, 400)
    );

    await expect(getAzureUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "unauthorized",
    });
  });

  it("maps consumption authorization failure to forbidden", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(new Response("upstream details", { status: 403 }))
      .mockResolvedValueOnce(jsonResponse(lotsResponse));

    await expect(getAzureUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "forbidden",
    });
  });

  it("maps an unsupported agreement or profile 404 to unsupported", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(new Response("upstream details", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(lotsResponse));

    await expect(getAzureUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "unsupported",
    });
  });

  it("maps malformed token JSON to malformed_response", async () => {
    fetchMock.mockResolvedValue(new Response("not-json", { status: 200 }));

    await expect(getAzureUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "malformed_response",
    });
  });

  it("maps malformed balance data to malformed_response", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(jsonResponse({ properties: {} }))
      .mockResolvedValueOnce(jsonResponse(lotsResponse));

    await expect(getAzureUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "malformed_response",
    });
  });

  it("maps malformed lots data to malformed_response", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(jsonResponse(balanceResponse))
      .mockResolvedValueOnce(jsonResponse({ value: {} }));

    await expect(getAzureUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "malformed_response",
    });
  });

  it("maps a timed-out request to timeout", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeout);

    await expect(getAzureUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "timeout",
    });
  });
});
