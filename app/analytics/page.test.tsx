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
      granted: { currency: "USD", value: 200 },
      remaining: { currency: "USD", value: 197.71 },
      consumed: { currency: "USD", value: 2.29 },
      reportedThrough: "2026-11-26T00:00:00Z",
      expiresAt: "2026-12-26T06:20:20Z",
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
    expect(screen.getByText("OpenRouter")).toBeInTheDocument();
    expect(screen.getByText("USD 0.173827")).toBeInTheDocument();
    expect(
      screen.getByText("7 / 50 free requests used today")
    ).toBeInTheDocument();
    expect(screen.queryByText("Drafts created")).not.toBeInTheDocument();
    // Azure lives inside its own stat card now: remaining credit as the
    // headline, the grant total and expiry below, freshness caveat on hover.
    expect(screen.getByText("Azure free credit")).toBeInTheDocument();
    expect(screen.getByText("USD 197.71")).toBeInTheDocument();
    expect(
      screen.getByText("USD 200.00 granted · expires Dec 26")
    ).toBeInTheDocument();
    expect(
      screen.getByTitle(/posts usage up to a day late/)
    ).toBeInTheDocument();

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
        screen.getByText("Setup needed — OpenRouter usage is not configured")
      ).toBeInTheDocument()
    );
    expect(screen.getByText("OpenRouter")).toBeInTheDocument();
    expect(
      screen.getByText("USD 200.00 granted · expires Dec 26")
    ).toBeInTheDocument();
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
    expect(screen.getByText("Checking Azure credit…")).toBeInTheDocument();

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
