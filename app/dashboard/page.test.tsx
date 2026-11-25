// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { useInstagramConnection } from "@/components/instagram-connection";

let instagramConnection: ReturnType<typeof useInstagramConnection> = {
  loading: false,
  connecting: false,
  configured: true,
  connected: true,
  unreachable: false,
  ig: { id: "ig1", username: "newsdesk", picture: null },
  scopes: [],
  pageId: "page1",
  reason: null,
  detail: null,
  connect: vi.fn(),
  refresh: vi.fn(),
};

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/app-frame", () => ({
  AppFrame: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/platform-mark", () => ({
  PlatformMark: () => null,
}));

vi.mock("@/components/facebook-connection", () => ({
  useFacebookConnection: () => ({
    loading: false,
    connecting: false,
    refreshing: false,
    unreachable: false,
    configured: true,
    connected: false,
    page: null,
    scopes: [],
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

vi.mock("@/components/instagram-connection", () => ({
  useInstagramConnection: () => instagramConnection,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: null }) },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

import DashboardPage from "./page";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  instagramConnection = {
    loading: false,
    connecting: false,
    configured: true,
    connected: true,
    unreachable: false,
    ig: { id: "ig1", username: "newsdesk", picture: null },
    scopes: [],
    pageId: "page1",
    reason: null,
    detail: null,
    connect: vi.fn(),
    refresh: vi.fn(),
  };
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/drafts")) {
      return { ok: true, json: async () => ({ drafts: [] }) };
    }
    if (url.startsWith("/api/items")) {
      return { ok: true, json: async () => ({ rows: [] }) };
    }
    if (url.startsWith("/api/activity")) {
      return {
        ok: true,
        json: async () => ({ rows: [], nextCursor: null, hasMore: false }),
      };
    }
    return { ok: true, json: async () => ({ platforms: [] }) };
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Dashboard Instagram channel", () => {
  it("shows Live when the Instagram account is connected", async () => {
    render(<DashboardPage />);
    await screen.findByText("No activity yet");

    const channels = screen.getByRole("heading", { name: "Channels" }).closest("section")!;
    const channel = within(channels).getByText("Instagram").parentElement!.parentElement!;
    expect(within(channel).getByText("Live")).toBeInTheDocument();
    expect(within(channel).queryByText("Designed")).not.toBeInTheDocument();
  });

  it("shows Checking while Instagram status is loading", async () => {
    instagramConnection.loading = true;

    render(<DashboardPage />);
    await screen.findByText("No activity yet");

    const channels = screen.getByRole("heading", { name: "Channels" }).closest("section")!;
    const channel = within(channels).getByText("Instagram").parentElement!.parentElement!;
    expect(within(channel).getByText("Checking")).toBeInTheDocument();
    expect(within(channel).queryByText("Live")).not.toBeInTheDocument();
  });

  it("shows Unavailable instead of Live after an Instagram status failure", async () => {
    instagramConnection.unreachable = true;

    render(<DashboardPage />);
    await screen.findByText("No activity yet");

    const channels = screen.getByRole("heading", { name: "Channels" }).closest("section")!;
    const channel = within(channels).getByText("Instagram").parentElement!.parentElement!;
    expect(within(channel).getByText("Unavailable")).toBeInTheDocument();
    expect(within(channel).queryByText("Live")).not.toBeInTheDocument();
  });

  it("shows Pending instead of Live when Instagram is disconnected", async () => {
    instagramConnection.connected = false;
    instagramConnection.ig = null;

    render(<DashboardPage />);
    await screen.findByText("No activity yet");

    const channels = screen.getByRole("heading", { name: "Channels" }).closest("section")!;
    const channel = within(channels).getByText("Instagram").parentElement!.parentElement!;
    expect(within(channel).getByText("Pending")).toBeInTheDocument();
    expect(within(channel).queryByText("Live")).not.toBeInTheDocument();
  });
});
