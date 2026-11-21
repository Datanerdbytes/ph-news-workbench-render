// @vitest-environment jsdom
import {
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
import AnalyticsPage from "./page";

const fetchMock = vi.fn();

const analyticsCalls = () =>
  fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith("/api/analytics"));

const day = {
  day: manilaDayKey(new Date()),
  drafts: 0,
  published: 3,
  failed: 1,
  scheduled: 2,
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
