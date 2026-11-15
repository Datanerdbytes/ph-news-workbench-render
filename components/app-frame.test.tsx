// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mockReplace = vi.fn();
const mockRefresh = vi.fn();
const { pathnameRef } = vi.hoisted(() => ({
  pathnameRef: { current: "/" },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, refresh: mockRefresh, push: vi.fn() }),
  usePathname: () => pathnameRef.current,
}));

const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { name: "Roel Somido", email: "roel@example.com" } },
    }),
    signOut: signOutMock,
  },
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
  FacebookConnectionProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/notifications", () => ({
  NotificationBell: () => null,
}));

vi.mock("@/components/facebook-mark", () => ({
  FacebookMark: () => <span data-testid="fb-mark" />,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { toast } from "sonner";
import { AppFrame } from "./app-frame";

async function flush() {
  await act(async () => {});
}

async function openAccountMenu() {
  fireEvent.click(screen.getByRole("button", { name: /Roel Somido/ }));
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  }
  // /api/workspace — the frame tolerates a failed load and falls back.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) }))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AppFrame sign out", () => {
  it("signs out once, then redirects to login", async () => {
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();
    await openAccountMenu();

    let release!: (value: unknown) => void;
    signOutMock.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; })
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await flush();

    const pending = screen.getByRole("button", { name: "Signing out…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    await flush();

    release(undefined);
    await flush();

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/login");
  });

  it("stays put with a toast when signing out fails", async () => {
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();
    await openAccountMenu();

    signOutMock.mockRejectedValueOnce(new Error("Network down"));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Could not sign out", {
      description: "Please try again.",
    });
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });
});

describe("AppFrame publishing card", () => {
  function stubFetchWith(payloads: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        for (const [needle, payload] of Object.entries(payloads)) {
          if (url.includes(needle)) {
            return { ok: true, json: async () => payload };
          }
        }
        return { ok: false, json: async () => ({}) };
      })
    );
  }

  it("reports the platform state instead of the Facebook Page on /youtube", async () => {
    pathnameRef.current = "/youtube";
    stubFetchWith({
      "/api/youtube/status": {
        configured: true,
        connected: false,
        account: null,
        scopes: [],
      },
    });
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    expect(screen.getByText("Publishing · YouTube")).toBeInTheDocument();
    expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
  });

  it("names the connected channel when YouTube is live", async () => {
    pathnameRef.current = "/youtube";
    stubFetchWith({
      "/api/youtube/status": {
        configured: true,
        connected: true,
        account: { id: "uc-1", name: "Roel's Channel" },
        scopes: [],
      },
    });
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    expect(screen.getByText("Publishing · YouTube")).toBeInTheDocument();
    expect(screen.getAllByText("Roel's Channel").length).toBeGreaterThan(0);
    expect(screen.queryByText("The Daily Buzz")).not.toBeInTheDocument();
  });

  it("does the same for TikTok on /tiktok", async () => {
    pathnameRef.current = "/tiktok";
    stubFetchWith({
      "/api/tiktok/status": {
        configured: true,
        connected: false,
        account: null,
        scopes: [],
      },
    });
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    expect(screen.getByText("Publishing · TikTok")).toBeInTheDocument();
    expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
  });

  it("reports the linked IG account on /instagram", async () => {
    pathnameRef.current = "/instagram";
    stubFetchWith({
      "/api/instagram/status": {
        configured: true,
        connected: true,
        ig: { id: "ig-1", username: "iamwowie_", picture: null },
      },
    });
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    expect(screen.getByText("Publishing · Instagram")).toBeInTheDocument();
    expect(screen.getAllByText("@iamwowie_").length).toBeGreaterThan(0);
    expect(screen.queryByText("The Daily Buzz")).not.toBeInTheDocument();
  });

  it("says when the Page has no Instagram linked", async () => {
    pathnameRef.current = "/instagram";
    stubFetchWith({
      "/api/instagram/status": {
        configured: true,
        connected: false,
        ig: null,
        reason: "no_ig_account",
      },
    });
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    expect(screen.getByText("Publishing · Instagram")).toBeInTheDocument();
    expect(
      screen.getAllByText("No IG linked to the Page").length
    ).toBeGreaterThan(0);
  });

  it("keeps the Facebook Page card on Facebook-family routes", async () => {
    pathnameRef.current = "/post";
    stubFetchWith({});
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    expect(screen.queryByText("Publishing · YouTube")).not.toBeInTheDocument();
    expect(screen.queryByText("Publishing · TikTok")).not.toBeInTheDocument();
    // The workspace fallback name shows while no Page is selected.
    expect(screen.getAllByText(/News Workbench/).length).toBeGreaterThan(0);
  });
});

describe("AppFrame platform nav", () => {
  function stubFetchWith(payloads: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        for (const [needle, payload] of Object.entries(payloads)) {
          if (url.includes(needle)) {
            return { ok: true, json: async () => payload };
          }
        }
        return { ok: false, json: async () => ({}) };
      })
    );
  }

  // The sidebar renders one <div> per group: the heading <p> followed by that
  // group's links. Scope every query to it — the header duplicates some of
  // these links (Post, Photos, …) outside the sidebar.
  function sidebarGroups() {
    const sidebar = screen.getByRole("complementary", {
      name: "Workspace navigation",
    });
    const groups = new Map<string, HTMLElement>();
    for (const group of Array.from(
      sidebar.querySelector("nav")?.children ?? []
    )) {
      const title = group.querySelector("p")?.textContent?.trim();
      if (title) groups.set(title, group as HTMLElement);
    }
    return groups;
  }

  it("lists the platform studios in the sidebar on Facebook routes too", async () => {
    pathnameRef.current = "/post";
    stubFetchWith({});
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    const channels = sidebarGroups().get("Channels")!;
    expect(within(channels).getByRole("link", { name: "Instagram" })).toHaveAttribute(
      "href",
      "/instagram"
    );
    expect(within(channels).getByRole("link", { name: "YouTube" })).toHaveAttribute(
      "href",
      "/youtube"
    );
    expect(within(channels).getByRole("link", { name: "TikTok" })).toHaveAttribute(
      "href",
      "/tiktok"
    );
  });

  it("keeps the Page tools under Facebook Page and the studios under Channels", async () => {
    pathnameRef.current = "/post";
    stubFetchWith({});
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    const groups = sidebarGroups();
    expect([...groups.keys()]).toEqual([
      "Workspace",
      "Facebook Page",
      "Channels",
      "Grow",
      "Manage",
    ]);

    const facebook = groups.get("Facebook Page")!;
    for (const [label, href] of [
      ["Story Queue", "/"],
      ["Post", "/post"],
      ["Photos", "/photos"],
      ["Videos", "/videos"],
      ["Reels", "/reels"],
      ["Live", "/live"],
      ["Stories", "/stories"],
    ]) {
      expect(within(facebook).getByRole("link", { name: label })).toHaveAttribute(
        "href",
        href
      );
    }

    const channels = groups.get("Channels")!;
    for (const label of ["Facebook", "Instagram", "YouTube", "TikTok"]) {
      expect(
        within(channels).getByRole("link", { name: label })
      ).toBeInTheDocument();
    }
    // The Page tools must not leak into the channels group.
    expect(
      within(channels).queryByRole("link", { name: "Post" })
    ).not.toBeInTheDocument();
  });

  it("keeps the Facebook channel entry a shortcut that never highlights", async () => {
    pathnameRef.current = "/post";
    stubFetchWith({});
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    const channels = sidebarGroups().get("Channels")!;
    const facebook = within(channels).getByRole("link", { name: "Facebook" });
    expect(facebook).toHaveAttribute("href", "/post");
    // The Page group's own "Post" item is the one that marks the current
    // page — two highlighted links to the same place would be a bug.
    expect(facebook).not.toHaveAttribute("aria-current");
    expect(
      within(sidebarGroups().get("Facebook Page")!).getByRole("link", {
        name: "Post",
      })
    ).toHaveAttribute("aria-current", "page");
  });

  it("drops the whole Facebook Page group on a platform studio route", async () => {
    pathnameRef.current = "/youtube";
    stubFetchWith({});
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    // The heading goes with its items — no stranded "FACEBOOK PAGE" label.
    const groups = sidebarGroups();
    expect(groups.has("Facebook Page")).toBe(false);
    expect([...groups.keys()]).not.toContain("Facebook Page");
    expect(
      within(groups.get("Channels")!).queryByRole("link", { name: "Reels" })
    ).not.toBeInTheDocument();
    // Facebook stays reachable as a channel from the studios.
    expect(
      within(groups.get("Channels")!).getByRole("link", { name: "Facebook" })
    ).toHaveAttribute("href", "/post");
  });

  it("lists Facebook as a channel on the Platforms hub", async () => {
    pathnameRef.current = "/platforms";
    stubFetchWith({});
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    const groups = sidebarGroups();
    // The hub lists Facebook as a platform, so the sidebar mirrors that list.
    const channels = groups.get("Channels")!;
    expect(within(channels).getByRole("link", { name: "Facebook" })).toHaveAttribute(
      "href",
      "/post"
    );
    for (const label of ["Instagram", "YouTube", "TikTok"]) {
      expect(
        within(channels).getByRole("link", { name: label })
      ).toBeInTheDocument();
    }
    // The Page tools themselves stay out of the hub.
    expect(groups.has("Facebook Page")).toBe(false);
    expect(
      within(channels).queryByRole("link", { name: "Post" })
    ).not.toBeInTheDocument();
  });

  it("keeps Drafts with the cross-platform workspace items", async () => {
    pathnameRef.current = "/instagram";
    stubFetchWith({});
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    const workspace = sidebarGroups().get("Workspace")!;
    expect(workspace).toContainElement(
      screen.getByRole("link", { name: "Dashboard" })
    );
    expect(workspace).toContainElement(
      screen.getByRole("link", { name: "Drafts" })
    );
    expect(screen.getByRole("link", { name: "Drafts" })).toHaveAttribute(
      "href",
      "/status"
    );
  });

  it("shows a platform quick-nav with an external channel link on /youtube", async () => {
    pathnameRef.current = "/youtube";
    stubFetchWith({
      "/api/youtube/status": {
        configured: true,
        connected: true,
        account: { id: "UC123", name: "Roel's Channel" },
        scopes: [],
      },
    });
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    const upload = screen.getByRole("link", { name: "Upload video" });
    expect(upload).toHaveAttribute("href", "/youtube");
    const channel = screen.getByRole("link", { name: "Open channel" });
    expect(channel).toHaveAttribute(
      "href",
      "https://www.youtube.com/channel/UC123"
    );
    expect(channel).toHaveAttribute("target", "_blank");
    // The composer CTA is platform-aware.
    expect(screen.getByText("New upload")).toBeInTheDocument();
    // The Facebook-only header control hides inside platform studios.
    expect(
      screen.queryByRole("button", { name: "Connect Facebook Page" })
    ).not.toBeInTheDocument();
  });

  it("omits the external channel link when the channel id is unknown", async () => {
    pathnameRef.current = "/youtube";
    stubFetchWith({
      "/api/youtube/status": {
        configured: true,
        connected: true,
        account: { id: "unknown", name: "YouTube" },
        scopes: [],
      },
    });
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    expect(
      screen.getByRole("link", { name: "Upload video" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open channel" })
    ).not.toBeInTheDocument();
  });

  it("links the Instagram profile and swaps the CTA on /instagram", async () => {
    pathnameRef.current = "/instagram";
    stubFetchWith({
      "/api/instagram/status": {
        configured: true,
        connected: true,
        ig: { id: "ig-1", username: "iamwowie_", picture: null },
      },
    });
    render(
      <AppFrame>
        <p>Page body</p>
      </AppFrame>
    );
    await flush();

    const profile = screen.getByRole("link", { name: "Open profile" });
    expect(profile).toHaveAttribute("href", "https://instagram.com/iamwowie_");
    expect(screen.getByText("New Instagram post")).toBeInTheDocument();
  });
});
