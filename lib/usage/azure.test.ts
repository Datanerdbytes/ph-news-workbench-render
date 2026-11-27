import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAzureUsage } from "./azure";

const fetchMock = vi.fn();

const azureEnv = {
  AZURE_BILLING_TENANT_ID: "tenant/with space",
  AZURE_BILLING_CLIENT_ID: "test-client-id",
  AZURE_BILLING_CLIENT_SECRET: "test-client-secret",
  AZURE_BILLING_SUBSCRIPTION_ID: "sub one",
  AZURE_BILLING_CREDIT_TOTAL: "200",
} as const;

const usagePage = "https://management.azure.com/subscriptions/sub%20one/providers/Microsoft.Consumption/usageDetails";
const nextPageUrl = `${usagePage}?api-version=2023-05-01&$top=1000&$skiptoken=next`;

function usageRecord(overrides: Record<string, unknown> = {}) {
  return {
    properties: {
      date: "2026-11-26T00:00:00Z",
      costInBillingCurrency: 0.5,
      billingCurrencyCode: "USD",
      isAzureCreditEligible: true,
      ...overrides,
    },
  };
}

const firstPage = {
  value: [
    usageRecord(),
    usageRecord({ date: "2026-11-27T00:00:00Z", costInBillingCurrency: 1.75 }),
  ],
  nextLink: nextPageUrl,
};

const lastPage = {
  value: [
    // A credit-ineligible charge never draws the grant down.
    usageRecord({ date: "2026-11-27T00:00:00Z", costInBillingCurrency: 3, isAzureCreditEligible: false }),
  ],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockAzure(pages: unknown[] = [firstPage, lastPage]) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("login.microsoftonline.com")) {
      return jsonResponse({ access_token: "test-access-token" });
    }
    if (url.includes("/Microsoft.Consumption/usageDetails")) {
      const page = pages.shift();
      if (page) return jsonResponse(page);
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
  it("derives the remaining credit from every page of subscription usage", async () => {
    mockAzure();

    await expect(getAzureUsage()).resolves.toEqual({
      status: "available",
      data: {
        granted: { currency: "USD", value: 200 },
        remaining: { currency: "USD", value: 197.75 },
        consumed: { currency: "USD", value: 2.25 },
        reportedThrough: "2026-11-27T00:00:00Z",
        expiresAt: null,
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

    const usageCalls = fetchMock.mock.calls.slice(1);
    expect(usageCalls.map(([url]) => String(url))).toEqual([
      `${usagePage}?api-version=2023-05-01&$top=1000`,
      nextPageUrl,
    ]);
    for (const [, init] of usageCalls) {
      expect(init.cache).toBe("no-store");
      expect(new Headers(init.headers).get("authorization")).toMatch(
        /^Bearer \S+$/
      );
    }
  });

  it("counts only usage since the grant's first day and reports its expiry", async () => {
    vi.stubEnv("AZURE_BILLING_CREDIT_START", "2026-11-26");
    vi.stubEnv("AZURE_BILLING_CREDIT_EXPIRES", "2026-12-26T06:20:20Z");
    mockAzure([
      {
        value: [
          usageRecord({ date: "2026-10-15T00:00:00Z", costInBillingCurrency: 40 }),
          usageRecord({ date: "2026-11-27T00:00:00Z", costInBillingCurrency: 0.5 }),
        ],
      },
    ]);

    const result = await getAzureUsage();

    expect(result).toMatchObject({
      status: "available",
      data: {
        granted: { currency: "USD", value: 200 },
        remaining: { currency: "USD", value: 199.5 },
        consumed: { currency: "USD", value: 0.5 },
        reportedThrough: "2026-11-27T00:00:00Z",
        expiresAt: "2026-12-26T06:20:20Z",
      },
    });
  });

  it("never reports a negative remainder", async () => {
    vi.stubEnv("AZURE_BILLING_CREDIT_TOTAL", "2");
    mockAzure();

    const result = await getAzureUsage();

    expect(result).toMatchObject({
      status: "available",
      data: {
        granted: { currency: "USD", value: 2 },
        remaining: { currency: "USD", value: 0 },
        consumed: { currency: "USD", value: 2.25 },
      },
    });
  });

  it("reports a subscription with no usage yet", async () => {
    mockAzure([{ value: [] }]);

    await expect(getAzureUsage()).resolves.toEqual({
      status: "available",
      data: {
        granted: { currency: null, value: 200 },
        remaining: { currency: null, value: 200 },
        consumed: { currency: null, value: 0 },
        reportedThrough: null,
        expiresAt: null,
      },
    });
  });

  it("does not follow a next link off Azure's management endpoint", async () => {
    mockAzure([{ ...firstPage, nextLink: "https://evil.example/usage?next" }]);

    await expect(getAzureUsage()).resolves.toMatchObject({
      status: "available",
      data: { consumed: { currency: "USD", value: 2.25 } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports missing configuration without making a request", async () => {
    vi.stubEnv("AZURE_BILLING_CLIENT_SECRET", "");

    await expect(getAzureUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-numeric credit total", "AZURE_BILLING_CREDIT_TOTAL", "two hundred"],
    ["a negative credit total", "AZURE_BILLING_CREDIT_TOTAL", "-5"],
    ["an unparseable credit start", "AZURE_BILLING_CREDIT_START", "yesterday"],
    ["an unparseable credit expiry", "AZURE_BILLING_CREDIT_EXPIRES", "soon"],
  ])("reports %s as missing configuration", async (_case, key, value) => {
    vi.stubEnv(key, value);

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

  it("maps usage authorization failure to forbidden", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(new Response("upstream details", { status: 403 }));

    await expect(getAzureUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "forbidden",
    });
  });

  it("maps an unknown subscription 404 to unsupported", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(new Response("upstream details", { status: 404 }));

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

  it("maps a usage page without records to malformed_response", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(jsonResponse({ value: {} }));

    await expect(getAzureUsage()).resolves.toMatchObject({
      status: "unavailable",
      code: "malformed_response",
    });
  });

  it("maps usage records mixing currencies to malformed_response", async () => {
    mockAzure([
      { value: [usageRecord(), usageRecord({ billingCurrencyCode: "PHP" })] },
    ]);

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
