// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/analytics",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/app-frame", () => ({
  AppFrame: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/facebook-connection", () => ({
  useFacebookConnection: () => ({
    loading: false,
    connecting: false,
    refreshing: false,
    unreachable: false,
    configured: true,
    connected: true,
    page: { id: "p1", name: "Sandbox Page" },
    scopes: [],
    connect: () => {},
    disconnect: async () => {},
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { manilaDayKey } from "@/lib/analytics/days";
import type { UsageResponse } from "@/lib/usage/types";
import AnalyticsPage from "./page";

const fetchMock = vi.fn();

const analyticsCalls = () =>
  fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith("/api/analytics"));

const usageCalls = () =>
  fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url === "/api/usage");

const day = {
  day: manilaDayKey(new Date()),
  drafts: 0,
  published: 3,
  failed: 1,
  scheduled: 2,
};

const usageSnapshot: UsageResponse = {
  openrouter: {
    status: "available",
    data: {
      creditsUsedUsd: 0.173826637,
      keyLimitUsd: 10,
      keyRemainingUsd: 9.826173363,
      dailyFreeRequests: { used: 7, limit: 50, remaining: 43 },
    },
  },
  azure: {
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
          source: "Expired promotional credit",
          startDate: "2025-01-01T00:00:00Z",
          expirationDate: "2025-12-31T00:00:00Z",
          status: "Expired",
          originalAmount: { currency: "USD", value: 50 },
          closedBalance: { currency: "USD", value: 0 },
          isEstimatedBalance: false,
        },
        {
          source: "Azure sign-up credit",
          startDate: "2026-01-01T00:00:00Z",
          expirationDate: "2026-12-31T12:00:00Z",
          status: "Active",
          originalAmount: { currency: "USD", value: 200 },
          closedBalance: { currency: "USD", value: 10 },
          isEstimatedBalance: false,
        },
        {
          source: "Purchased credit",
          startDate: "2026-11-01T00:00:00Z",
          expirationDate: "2027-01-31T00:00:00Z",
          status: "Active",
          originalAmount: { currency: "USD", value: 100 },
          closedBalance: { currency: "USD", value: 100 },
          isEstimatedBalance: false,
        },
      ],
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/analytics")) {
      return {
        ok: true,
        json: async () => ({
          totals: {
            drafts: 0,
            published: 3,
            scheduled: 2,
            failed: 1,
            tokens: 0,
            cost: 0,
          },
          daily: [day],
          platforms: [],
        }),
      };
    }
    if (url.startsWith("/api/facebook/insights")) {
      return { ok: true, json: async () => ({ connected: false }) };
    }
    if (url.startsWith("/api/youtube/insights")) {
      return { ok: true, json: async () => ({ connected: false }) };
    }
    if (url === "/api/usage") {
      return { ok: true, json: async () => usageSnapshot };
    }
    return { ok: true, json: async () => ({}) };
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AnalyticsPage activity chart", () => {
  it("renders today's outcomes and the failed legend at the default range", async () => {
    render(<AnalyticsPage />);

    await waitFor(() => expect(analyticsCalls()).toEqual(["/api/analytics?days=14"]));

    expect(
      screen.queryByText(/Publishing activity from the last 14 days/)
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "14d" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();

    // The day column's tooltip carries every outcome, failed included.
    expect(
      screen.getByTitle(
        `${day.day}: 0 drafts · 3 published · 1 failed · 2 scheduled`
      )
    ).toBeInTheDocument();
  });

  it("refetches for the selected range", async () => {
    render(<AnalyticsPage />);
    await waitFor(() => expect(analyticsCalls()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "30d" }));

    await waitFor(() =>
      expect(analyticsCalls()).toContain("/api/analytics?days=30")
    );
    expect(screen.getByRole("button", { name: "30d" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(
      screen.queryByText(/Publishing activity from the last 30 days/)
    ).not.toBeInTheDocument();
  });
});

describe("AnalyticsPage provider usage", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-27T00:00:00Z"));
  });

  it("renders live provider data even when workspace analytics fails", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/analytics")) {
        return { ok: false, json: async () => ({}) };
      }
      if (url === "/api/usage") {
        return { ok: true, json: async () => usageSnapshot };
      }
      return { ok: true, json: async () => ({ connected: false }) };
    });

    render(<AnalyticsPage />);

    await waitFor(() =>
      expect(screen.getByText("Couldn't load activity")).toBeInTheDocument()
    );
    expect(
      screen.getByRole("heading", { name: "OpenRouter" })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Azure" })).toBeInTheDocument();
    expect(screen.getByText("USD 0.173827")).toBeInTheDocument();
    expect(screen.getByText("7 / 50")).toBeInTheDocument();
    expect(screen.getByText("USD 200.00")).toBeInTheDocument();
    expect(
      screen.getByText("Current credit balance (estimated)")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Azure marks these balance details as estimates/)
    ).toBeInTheDocument();
    expect(screen.getByText("Azure-estimated balance")).toBeInTheDocument();
    expect(screen.getByText("USD 190.00")).toBeInTheDocument();
    expect(screen.getByText("USD 12.50")).toBeInTheDocument();
    expect(screen.getByText("USD 0.00")).toBeInTheDocument();
    expect(screen.getByText("Dec 31, 2026")).toBeInTheDocument();
    expect(screen.getByText(/Azure sign-up credit · Active · 2 lots/)).toBeInTheDocument();
    expect(screen.queryByText(/Expired promotional credit/)).not.toBeInTheDocument();
    expect(screen.getByText("Estimated AI spend")).toBeInTheDocument();

    expect(usageCalls()).toEqual(["/api/usage"]);
    const usageCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/usage"
    );
    expect(usageCall?.[1]).toMatchObject({ cache: "no-store" });
  });

  it("shows a setup state without hiding the healthy provider", async () => {
    const partialUsage: UsageResponse = {
      openrouter: {
        status: "unavailable",
        code: "not_configured",
        message: "OpenRouter usage is not configured.",
      },
      azure: usageSnapshot.azure,
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/usage") {
        return { ok: true, json: async () => partialUsage };
      }
      if (url.startsWith("/api/analytics")) {
        return {
          ok: true,
          json: async () => ({
            totals: {
              drafts: 0,
              published: 3,
              scheduled: 2,
              failed: 1,
              tokens: 0,
              cost: 0,
            },
            daily: [day],
            platforms: [],
          }),
        };
      }
      return { ok: true, json: async () => ({ connected: false }) };
    });

    render(<AnalyticsPage />);

    await waitFor(() =>
      expect(
        screen.getByText("OpenRouter usage is not configured.")
      ).toBeInTheDocument()
    );
    expect(screen.getAllByText("Setup needed")).toHaveLength(2);
    expect(screen.getByText("USD 200.00")).toBeInTheDocument();
  });

  it("keeps provider loading independent from workspace activity", async () => {
    let resolveUsage!: (value: unknown) => void;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/usage") {
        return new Promise((resolve) => {
          resolveUsage = resolve;
        });
      }
      if (url.startsWith("/api/analytics")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            totals: {
              drafts: 0,
              published: 3,
              scheduled: 2,
              failed: 1,
              tokens: 0,
              cost: 0,
            },
            daily: [day],
            platforms: [],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ connected: false }),
      });
    });

    render(<AnalyticsPage />);

    await waitFor(() =>
      expect(
        screen.getByTitle(
          `${day.day}: 0 drafts · 3 published · 1 failed · 2 scheduled`
        )
      ).toBeInTheDocument()
    );
    expect(screen.getAllByText("Loading provider usage…")).toHaveLength(2);
    expect(
      screen.getByRole("heading", { name: "OpenRouter" })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Azure" })).toBeInTheDocument();

    await act(async () => {
      resolveUsage({ ok: true, json: async () => usageSnapshot });
    });
    await waitFor(() =>
      expect(screen.getByText("USD 0.173827")).toBeInTheDocument()
    );
  });

  it("refetches provider usage when Refresh is clicked", async () => {
    render(<AnalyticsPage />);
    await waitFor(() => expect(usageCalls()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(usageCalls()).toHaveLength(2));
  });
});
