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

const { pushMock, toastMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => "/queue",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/app-frame", () => ({
  AppFrame: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("@/components/ui/confirm-button", () => ({
  ConfirmIconButton: ({
    onConfirm,
    title,
    disabled,
  }: {
    onConfirm: () => void;
    title?: string;
    disabled?: boolean;
  }) => (
    <button type="button" title={title} disabled={disabled} onClick={onConfirm}>
      delete
    </button>
  ),
}));

import QueuePage from "./page";

const listPayload = {
  rows: [
    {
      id: 1,
      title: "Story One",
      summary: "First story",
      link: "https://verge.test/one",
      status: "pending",
      created_at: "2026-11-16T10:00:00Z",
      draft_id: null,
      feed_id: 7,
      feed_title: "The Verge",
    },
    {
      id: 2,
      title: "Story Two",
      summary: null,
      link: "https://verge.test/two",
      status: "drafted",
      created_at: "2026-11-16T09:00:00Z",
      draft_id: 33,
      feed_id: 7,
      feed_title: "The Verge",
    },
  ],
  nextCursor: null,
  hasMore: false,
  counts: { total: 2, pending: 1, drafted: 1, published: 0 },
  feedCounts: [{ feed_id: 7, total: 2, pending: 1, drafted: 1, published: 0 }],
};

function jsonResponse(payload: unknown, ok = true) {
  return { ok, json: async () => payload } as Response;
}

beforeEach(() => {
  pushMock.mockReset();
  for (const fn of Object.values(toastMock)) fn.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/sources")) {
        return jsonResponse({
          feeds: [
            { id: 7, title: "The Verge", url: "https://verge.test", enabled: true },
          ],
        });
      }
      if (url.includes("item=")) return jsonResponse({ rows: [] });
      return jsonResponse(listPayload);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("QueuePage", () => {
  it("renders source tabs and Read original links on every card", async () => {
    render(<QueuePage />);

    await waitFor(() =>
      expect(screen.getByText("Story One")).toBeInTheDocument(),
    );

    const tabs = screen.getByRole("group", { name: "Filter stories by source" });
    expect(within(tabs).getByText("All sources")).toBeInTheDocument();
    expect(within(tabs).getByText("The Verge")).toBeInTheDocument();

    const originals = screen.getAllByText("Read original");
    expect(originals).toHaveLength(2);
    expect(screen.getByLabelText('Add "Story One" to Compose')).toBeInTheDocument();
    expect(screen.getByLabelText('Add "Story Two" to Compose')).toBeInTheDocument();
  });

  it("shows a spinner while adding and opens Compose once the request resolves", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/sources")) {
        return jsonResponse({ feeds: [] });
      }
      if (url.includes("item=")) {
        return gate.then(() =>
          jsonResponse({
            rows: [{ ...listPayload.rows[0] }],
            nextCursor: null,
            hasMore: false,
            counts: listPayload.counts,
            feedCounts: [],
          }),
        );
      }
      return jsonResponse(listPayload);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<QueuePage />);
    await waitFor(() =>
      expect(screen.getByText("Story One")).toBeInTheDocument(),
    );

    const addOne = screen.getByLabelText('Add "Story One" to Compose');
    fireEvent.click(addOne);

    // While the request is in flight the row shows the spinner state and the
    // other Add buttons go idle.
    await waitFor(() =>
      expect(screen.getByText("Adding…")).toBeInTheDocument(),
    );
    expect(
      screen.getByLabelText('Add "Story Two" to Compose'),
    ).toBeDisabled();

    release(undefined);
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/compose?item=1"),
    );
  });

  it("reports a failure and re-enables the button when the story is gone", async () => {
    render(<QueuePage />);
    await waitFor(() =>
      expect(screen.getByText("Story One")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByLabelText('Add "Story One" to Compose'));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Could not open the story in Compose",
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText('Add "Story One" to Compose'),
      ).toBeEnabled(),
    );
    expect(pushMock).not.toHaveBeenCalled();
  });
});
