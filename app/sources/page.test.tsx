// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { pushMock, replaceMock, searchParamsRef, toastMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  searchParamsRef: { value: new URLSearchParams() },
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => "/sources",
  useSearchParams: () => searchParamsRef.value,
}));

vi.mock("@/components/app-frame", () => ({
  AppFrame: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("sonner", () => ({ toast: toastMock }));

import SourcesPage from "./page";

const todayIso = new Date().toISOString();

const feedsPayload = {
  feeds: [
    {
      id: 7,
      title: "The Verge",
      url: "https://verge.test/rss.xml",
      category: "Tech",
      last_fetched_at: todayIso,
      error_message: null,
      enabled: true,
      created_at: todayIso,
      item_count: 2,
    },
    {
      id: 8,
      title: "Rappler",
      url: "https://rappler.test/rss.xml",
      category: "Tech",
      last_fetched_at: todayIso,
      error_message: null,
      enabled: true,
      created_at: todayIso,
      item_count: 1,
    },
    {
      id: 9,
      title: "Solo Feed",
      url: "https://solo.test/rss.xml",
      category: null,
      last_fetched_at: null,
      error_message: null,
      enabled: false,
      created_at: todayIso,
      item_count: 0,
    },
  ],
};

const allItemsPayload = {
  rows: [
    {
      id: 1,
      title: "Story One",
      summary: "First story summary",
      link: "https://verge.test/one",
      image_url: "https://cdn.test/one.jpg",
      published_at: todayIso,
      created_at: todayIso,
      feed_id: 7,
      feed_title: "The Verge",
      status: "pending",
    },
    {
      id: 2,
      title: "Story Two",
      summary: null,
      link: "https://rappler.test/two",
      image_url: null,
      published_at: todayIso,
      created_at: todayIso,
      feed_id: 8,
      feed_title: "Rappler",
      status: "drafted",
    },
  ],
  nextCursor: null,
  hasMore: false,
};

const vergeItemsPayload = {
  rows: [
    {
      id: 1,
      title: "Story One",
      summary: "First story summary",
      link: "https://verge.test/one",
      image_url: "https://cdn.test/one.jpg",
      published_at: todayIso,
      created_at: todayIso,
      feed_id: 7,
      feed_title: "The Verge",
      status: "pending",
    },
  ],
  nextCursor: null,
  hasMore: false,
};

function jsonResponse(payload: unknown, ok = true) {
  return { ok, json: async () => payload } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  pushMock.mockReset();
  replaceMock.mockReset();
  searchParamsRef.value = new URLSearchParams();
  for (const fn of Object.values(toastMock)) fn.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/source-items")) {
      return jsonResponse(url.includes("feed=") ? vergeItemsPayload : allItemsPayload);
    }
    if (url.includes("/api/items")) {
      return jsonResponse({ rows: [allItemsPayload.rows[0]] });
    }
    if (url.includes("/api/sources")) {
      return jsonResponse(feedsPayload);
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SourcesPage", () => {
  it("groups sources by category in the sidebar and renders dated article rows", async () => {
    render(<SourcesPage />);

    const sidebar = await waitFor(() =>
      screen.getByRole("navigation", { name: "Source list" }),
    );
    await waitFor(() =>
      expect(within(sidebar).getByText("The Verge")).toBeInTheDocument(),
    );

    // Group headers: Tech holds two feeds, the uncategorized one lands last.
    expect(within(sidebar).getByText("Tech")).toBeInTheDocument();
    expect(within(sidebar).getByText("Ungrouped")).toBeInTheDocument();
    expect(within(sidebar).getByText("Solo Feed")).toBeInTheDocument();

    // All sources row aggregates the story counts.
    const allRow = within(sidebar).getByRole("button", { name: /All sources/ });
    expect(allRow).toHaveAttribute("aria-current", "true");
    expect(within(allRow).getByText("3")).toBeInTheDocument();

    // Article rows carry their source, a date group and the Draft action.
    expect(await screen.findByText("Story One")).toBeInTheDocument();
    expect(screen.getByText("Story Two")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getAllByText("Read original")).toHaveLength(2);
  });

  it("switches to a source on click and mirrors the selection in the URL", async () => {
    render(<SourcesPage />);

    const sidebar = await screen.findByRole("navigation", { name: "Source list" });
    fireEvent.click(within(sidebar).getByRole("button", { name: /The Verge/ }));

    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith("/sources?feed=7"),
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/source-items?feed=7"))).toBe(true),
    );
    expect(await screen.findByRole("heading", { name: "The Verge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fetch now" })).toBeInTheDocument();
  });

  it("falls back to All sources when a deep link points at a missing feed", async () => {
    searchParamsRef.value = new URLSearchParams("?feed=99");
    render(<SourcesPage />);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "All sources" })).toBeInTheDocument(),
    );
  });

  it("keeps archived stories visible after the last source is gone", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      jsonResponse(url === "/api/sources"
        ? { feeds: [] }
        : { ...allItemsPayload, rows: [{ ...allItemsPayload.rows[0], feed_id: null, feed_title: null }] }),
    );
    render(<SourcesPage />);
    expect(await screen.findByText("Story One")).toBeInTheDocument();
    expect(screen.queryByText("No sources yet")).not.toBeInTheDocument();
  });

  it("ignores delayed pagination from an earlier visit to the same source", async () => {
    let finishOldPage!: (response: Response) => void;
    const oldPage = new Promise<Response>(resolve => { finishOldPage = resolve; });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/sources") return jsonResponse(feedsPayload);
      if (url === "/api/source-items?feed=7&before=30") return oldPage;
      if (url === "/api/source-items?feed=7&before=20") return jsonResponse({
        ...vergeItemsPayload, rows: [{ ...vergeItemsPayload.rows[0], id: 3, title: "Current next page" }],
      });
      if (url === "/api/source-items?feed=7") {
        const visits = fetchMock.mock.calls.filter(([input]) => input === url).length;
        return jsonResponse({ ...vergeItemsPayload, hasMore: true, nextCursor: visits === 1 ? 30 : 20 });
      }
      return jsonResponse({ rows: [] });
    });

    render(<SourcesPage />);
    const sidebar = await screen.findByRole("navigation", { name: "Source list" });
    const select = (name: RegExp) => fireEvent.click(within(sidebar).getByRole("button", { name }));
    await within(sidebar).findByRole("button", { name: /The Verge/ });

    select(/The Verge/);
    fireEvent.click(await screen.findByRole("button", { name: "Load more stories" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/source-items?feed=7&before=30", expect.anything());
    select(/All sources/);
    await screen.findByText("No stories yet");
    select(/The Verge/);
    await screen.findByRole("button", { name: "Load more stories" });

    await act(async () => {
      finishOldPage(jsonResponse({
        rows: [{ ...vergeItemsPayload.rows[0], id: 4, title: "Obsolete page" }],
        hasMore: true,
        nextCursor: 10,
      }));
    });
    expect(screen.queryByText("Obsolete page")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more stories" }));
    expect(await screen.findByText("Current next page")).toBeInTheDocument();
  });

  it("drafts a pending story via the compose deep link", async () => {
    render(<SourcesPage />);

    const draft = await screen.findByRole("button", {
      name: 'Draft "Story One" in Compose',
    });
    fireEvent.click(draft);

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/items?item=1"))).toBe(true),
    );
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/compose?item=1"));
  });
});
