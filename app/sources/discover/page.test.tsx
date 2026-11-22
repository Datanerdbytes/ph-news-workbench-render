// @vitest-environment jsdom
import {
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
  usePathname: () => "/sources/discover",
  useSearchParams: () => searchParamsRef.value,
}));

vi.mock("@/components/app-frame", () => ({
  AppFrame: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("sonner", () => ({ toast: toastMock }));

import DiscoverPage from "./page";

const searchFixture = {
  sources: [
    {
      feedUrl: "https://techcrunch.test/feed/",
      title: "TechCrunch",
      description: "Reporting on the business of technology.",
      siteUrl: "https://techcrunch.test/",
      subscribers: 1_340_140,
      iconUrl: "https://cdn.test/icon.png",
      language: "en",
    },
    {
      feedUrl: "https://already.test/feed",
      title: "Already Added",
      description: "",
      siteUrl: "https://already.test/",
      subscribers: 8200,
      iconUrl: null,
      language: "en",
    },
  ],
};

const previewFixture = {
  feed: {
    title: "TechCrunch",
    description: "Reporting on the business of technology.",
    url: "https://techcrunch.test/feed/",
    siteUrl: "https://techcrunch.test/",
  },
  items: [
    {
      title: "Story one",
      link: "https://techcrunch.test/one",
      published_at: new Date().toISOString(),
      image_url: null,
    },
  ],
};

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => payload } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  pushMock.mockReset();
  replaceMock.mockReset();
  searchParamsRef.value = new URLSearchParams();
  for (const fn of Object.values(toastMock)) fn.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/discover/search")) {
      return jsonResponse(searchFixture);
    }
    if (url.includes("/api/sources/preview")) {
      return jsonResponse(previewFixture);
    }
    if (init?.method === "POST") {
      return jsonResponse(
        { feed: { id: 9, title: "TechCrunch" }, preview: [] },
        true,
        201,
      );
    }
    if (url.includes("/api/sources")) {
      return jsonResponse({
        feeds: [
          { id: 7, url: "https://already.test/feed/", title: "Already Added", enabled: true },
        ],
      });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DiscoverPage", () => {
  it("renders topic tiles and the popular grid with added-state cards", async () => {
    render(<DiscoverPage />);

    expect(await screen.findByRole("heading", { name: "Popular right now" })).toBeInTheDocument();

    // Topic tiles come from the curated taxonomy.
    const topicsGroup = screen.getByRole("group", { name: "Browse topics" });
    expect(within(topicsGroup).getByText("Philippines")).toBeInTheDocument();
    expect(within(topicsGroup).getByText("Tech")).toBeInTheDocument();

    // Cards show follower counts, and an already-tracked feed shows Added.
    expect(await screen.findByText("TechCrunch")).toBeInTheDocument();
    expect(screen.getByText("1.3M followers")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
  });

  it("renders a topic page from the topic/ deep link", async () => {
    searchParamsRef.value = new URLSearchParams("?query=topic/philippines");
    render(<DiscoverPage />);

    expect(await screen.findByRole("heading", { name: "Philippines" })).toBeInTheDocument();
    const topicsGroup = screen.getByRole("group", { name: "Browse topics" });
    expect(within(topicsGroup).getByText("Philippines")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("debounces search input into the URL", async () => {
    render(<DiscoverPage />);

    const input = await screen.findByLabelText("Search publications");
    fireEvent.change(input, { target: { value: "rappler" } });

    await waitFor(
      () => expect(replaceMock).toHaveBeenCalledWith("/sources/discover?query=rappler"),
      { timeout: 2000 },
    );
  });

  it("previews a source and adds it with the topic as its group", async () => {
    searchParamsRef.value = new URLSearchParams("?query=topic/philippines");
    render(<DiscoverPage />);

    const previewButtons = await screen.findAllByRole("button", {
      name: "Preview latest stories",
    });
    fireEvent.click(previewButtons[0]);

    const dialog = await screen.findByRole("heading", { name: "Source preview" });
    expect(dialog).toBeInTheDocument();
    expect(await screen.findByText("Story one")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add source" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/sources",
      expect.objectContaining({ method: "POST" }),
    ));
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/sources" && init?.method === "POST",
    );
    expect(JSON.parse(String(postCall![1].body))).toEqual({
      url: "https://techcrunch.test/feed/",
      category: "Philippines",
    });
    expect(toastMock.success).toHaveBeenCalled();
  });
});
