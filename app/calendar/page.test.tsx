// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ReactNode } from "react";

vi.mock("sonner", () => {
  const toast = vi.fn();
  return {
    toast: Object.assign(toast, {
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    }),
  };
});
vi.mock("@/components/app-frame", () => ({
  AppFrame: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { toast } from "sonner";
import CalendarPage from "./page";

type ToastMock = Mock & { success: Mock; error: Mock; warning: Mock };
const toastMock = toast as unknown as ToastMock;

const fetchMock = vi.fn();

type Row = {
  id: number;
  text: string;
  scheduled_for: string;
  status: string;
  kind: string;
  source: string;
  news_title: string | null;
  error_message: string | null;
};

const reel: Row = {
  id: 49,
  text: "(no caption)",
  // December, so the hand-off must move the calendar off today's month.
  scheduled_for: "2026-12-02T07:00:00.000Z",
  status: "scheduled",
  kind: "reel",
  source: "facebook",
  news_title: null,
  error_message: null,
};

const published: Row = {
  id: 50,
  text: "Warm welcome to ASEAN delegates",
  scheduled_for: "2026-11-16T06:11:18.908Z",
  status: "published",
  kind: "reel",
  source: "facebook",
  news_title: null,
  error_message: null,
};

function respond(rows: Row[], deleted = true) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/schedule") {
      return { ok: true, json: async () => rows };
    }
    if (url.startsWith("/api/schedule/")) {
      return { ok: deleted, json: async () => ({ deleted }) };
    }
    return { ok: false, json: async () => ({ error: "unexpected" }) };
  });
}

async function flush() {
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T08:00:00Z"));
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState({}, "", "/calendar");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("CalendarPage Dashboard hand-off", () => {
  it("opens the post from ?post on its own month with a labeled cancel button", async () => {
    respond([reel, published]);
    window.history.replaceState({}, "", "/calendar?post=49");

    render(<CalendarPage />);
    await flush();

    // Jumped to the post's month and opened its day panel. Both the desktop
    // header and the mobile agenda print the month label.
    expect((await screen.findAllByText("December 2026")).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 post$/)).toBeTruthy();
    // The focused row explains where the cancel happens — mobile agenda, day
    // panel and the Scheduled sidebar all carry the labeled button.
    expect(
      screen.getAllByRole("button", { name: "Cancel on Facebook" }).length
    ).toBe(3);
  });

  it("cancels the focused post through the schedule DELETE route", async () => {
    respond([reel, published]);
    window.history.replaceState({}, "", "/calendar?post=49");

    render(<CalendarPage />);
    await flush();

    const [cancelButton] = await screen.findAllByRole("button", {
      name: "Cancel on Facebook",
    });
    fireEvent.click(cancelButton);
    fireEvent.click(screen.getByRole("button", { name: "Click again to cancel" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/schedule/49", {
        method: "DELETE",
      })
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Scheduled post canceled")
    );
    expect(
      screen.queryAllByRole("button", { name: "Cancel on Facebook" })
    ).toHaveLength(0);
  });

  it("reports a stale hand-off instead of silently doing nothing", async () => {
    respond([published]);
    window.history.replaceState({}, "", "/calendar?post=999");

    render(<CalendarPage />);
    await flush();

    expect(toastMock).toHaveBeenCalledWith(
      "That scheduled post is no longer on the calendar."
    );
  });

  it("leaves the calendar on today when there is no hand-off", async () => {
    respond([reel, published]);

    render(<CalendarPage />);
    await flush();

    expect(screen.getAllByText("November 2026").length).toBeGreaterThan(0);
    // No day panel opened; the only labeled cancel is the Scheduled sidebar,
    // which lists queued posts regardless of the visible month.
    expect(screen.queryByText(/1 post$/)).toBeNull();
    const sidebar = screen.getByRole("heading", { name: "Scheduled" }).closest("section")!;
    expect(
      within(sidebar).getAllByRole("button", { name: "Cancel on Facebook" })
    ).toHaveLength(1);
  });
});
