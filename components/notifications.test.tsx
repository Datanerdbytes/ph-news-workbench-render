// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPush = vi.fn();
// A stable router instance — next/navigation's useRouter is referentially
// stable in the real app, and the bell's polling effect must not re-subscribe.
const mockRouter = { push: mockPush };
vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/",
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { toast } from "sonner";
import { NotificationBell } from "./notifications";

type Row = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

type PollPayload = {
  rows: Row[];
  unread: number;
  nextCursor: number | null;
  hasMore: boolean;
};

function notif(id: number, overrides: Partial<Row> = {}): Row {
  return {
    id: String(id),
    type: "scheduled_publish_success",
    title: `Notification ${id}`,
    body: `Body ${id}`,
    link: "/calendar",
    readAt: null,
    createdAt: "2026-11-07T12:00:00Z",
    ...overrides,
  };
}

let pollData: PollPayload;
let moreData: PollPayload;
let moreFail = false;
let moreStatus = 200;
/** The writes the mock server has taken — it reports them like the real one. */
let readAll = false;
const readIds = new Set<string>();

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/api/notifications/read")) {
    const body = String(init?.body ?? "");
    if (body.includes('"all":true')) {
      readAll = true;
    } else {
      readIds.add(String(JSON.parse(body).id));
    }
    return { ok: true, json: async () => ({ ok: true }) };
  }
  if (url.includes("before=")) {
    if (moreFail) {
      return { ok: false, status: moreStatus, json: async () => ({}) };
    }
    return { ok: true, json: async () => moreData };
  }
  const rows = pollData.rows.map((row) =>
    readAll || readIds.has(row.id)
      ? { ...row, readAt: row.readAt ?? new Date().toISOString() }
      : row
  );
  const unread = readAll
    ? 0
    : Math.max(0, pollData.unread - readIds.size);
  return { ok: true, json: async () => ({ ...pollData, rows, unread }) };
});

async function flush() {
  await act(async () => {});
}

async function openPanel() {
  fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  moreFail = false;
  moreStatus = 200;
  readAll = false;
  readIds.clear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NotificationBell", () => {
  it("seeds the badge silently on first load — history must not toast", async () => {
    pollData = {
      rows: [notif(1), notif(2, { type: "scheduled_publish_failed" })],
      unread: 2,
      nextCursor: null,
      hasMore: false,
    };

    render(<NotificationBell />);
    await flush();

    expect(screen.getByText("2")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("toasts a new row with its severity on the next poll", async () => {
    pollData = { rows: [notif(1)], unread: 1, nextCursor: null, hasMore: false };
    render(<NotificationBell />);
    await flush();
    expect(toast.success).not.toHaveBeenCalled();

    pollData = { rows: [notif(2)], unread: 2, nextCursor: null, hasMore: false };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.success).mock.calls[0][0]).toBe("Notification 2");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts a failure row with the error channel", async () => {
    pollData = { rows: [notif(1)], unread: 1, nextCursor: null, hasMore: false };
    render(<NotificationBell />);
    await flush();

    pollData = {
      rows: [notif(2, { type: "publish_failed" })],
      unread: 2,
      nextCursor: null,
      hasMore: false,
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe("Notification 2");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("caps a busy sweep into one summary toast", async () => {
    pollData = { rows: [notif(1)], unread: 1, nextCursor: null, hasMore: false };
    render(<NotificationBell />);
    await flush();

    pollData = {
      rows: [notif(2), notif(3), notif(4), notif(5), notif(6)],
      unread: 6,
      nextCursor: null,
      hasMore: false,
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.info).mock.calls[0][0]).toBe("5 new notifications");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("stays silent while the tab is hidden", async () => {
    pollData = { rows: [notif(1)], unread: 1, nextCursor: null, hasMore: false };
    render(<NotificationBell />);
    await flush();

    const hiddenSpy = vi
      .spyOn(document, "hidden", "get")
      .mockReturnValue(true);
    pollData = { rows: [notif(2)], unread: 2, nextCursor: null, hasMore: false };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(toast.success).not.toHaveBeenCalled();
    // The row still lands in state for the panel, only the toast is skipped.
    hiddenSpy.mockRestore();
    await openPanel();
    expect(screen.getByText("Notification 2")).toBeInTheDocument();
  });

  it("caps the badge label at 9+", async () => {
    pollData = { rows: [notif(1)], unread: 12, nextCursor: null, hasMore: false };
    render(<NotificationBell />);
    await flush();

    expect(screen.getByText("9+")).toBeInTheDocument();
  });

  it("marks all rows read and clears the badge", async () => {
    pollData = {
      rows: [notif(1), notif(2)],
      unread: 2,
      nextCursor: null,
      hasMore: false,
    };
    render(<NotificationBell />);
    await flush();

    await openPanel();
    fireEvent.click(
      screen.getByRole("button", { name: "Mark all read" })
    );
    await flush();

    const readCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/notifications/read")
    );
    expect(readCall).toBeDefined();
    expect(readCall![1]?.method).toBe("POST");
    expect(readCall![1]?.body).toBe(JSON.stringify({ all: true }));
    expect(screen.queryByText("2")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Mark all read" })
    ).toBeNull();
  });

  it("keeps the badge clear when a stale refresh lands after mark all", async () => {
    pollData = {
      rows: [notif(1), notif(2)],
      unread: 2,
      nextCursor: null,
      hasMore: false,
    };
    render(<NotificationBell />);
    await flush();

    // Hold the panel's refresh open so it lands after the mutation.
    let release!: (value: Awaited<ReturnType<typeof fetchMock>>) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    await openPanel();

    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await flush();

    // The in-flight response still reports two unread — it must not win.
    release({ ok: true, json: async () => pollData });
    await flush();

    expect(screen.queryByText("2")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Mark all read" })
    ).toBeNull();
  });

  it("does not let a read issued during a pending write restore the old count", async () => {
    pollData = {
      rows: [notif(1), notif(2)],
      unread: 2,
      nextCursor: null,
      hasMore: false,
    };
    render(<NotificationBell />);
    await flush();
    await openPanel();

    // Hold the mark-all write open so a read can go out while it is pending.
    let releaseWrite!: (value: Awaited<ReturnType<typeof fetchMock>>) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseWrite = (value) => {
            readAll = true; // the server applies the write it just took
            resolve(value);
          };
        })
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await flush();

    // The poll that runs while the write is pending still reports two unread.
    let releaseRead!: (value: Awaited<ReturnType<typeof fetchMock>>) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    releaseRead({ ok: true, json: async () => pollData });
    await flush();

    // The stale count must not win.
    expect(screen.queryByText("2")).not.toBeInTheDocument();

    // Once the write lands, the settled refresh confirms the cleared badge.
    releaseWrite({ ok: true, json: async () => ({ ok: true }) });
    await flush();
    await flush();

    expect(screen.queryByText("2")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Mark all read" })
    ).toBeNull();
  });

  it("marks a row read and follows its link on click", async () => {
    pollData = {
      rows: [notif(3, { type: "facebook_token_invalid", link: "/settings" })],
      unread: 1,
      nextCursor: null,
      hasMore: false,
    };
    render(<NotificationBell />);
    await flush();
    await openPanel();

    fireEvent.click(
      screen.getByRole("button", { name: /Notification 3/ })
    );
    await flush();

    expect(mockPush).toHaveBeenCalledWith("/settings");
    const readCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/notifications/read")
    );
    expect(JSON.parse(String(readCall![1]?.body))).toEqual({ id: 3 });
    // Panel closes after navigation.
    expect(
      screen.queryByRole("button", { name: "Mark all read" })
    ).toBeNull();
  });
});

describe("NotificationBell load more", () => {
  it("appends the next page using the last row as the cursor", async () => {
    pollData = {
      rows: [notif(1), notif(2)],
      unread: 2,
      nextCursor: 2,
      hasMore: true,
    };
    moreData = { rows: [notif(3)], unread: 3, nextCursor: null, hasMore: false };

    render(<NotificationBell />);
    await flush();
    await openPanel();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await flush();

    const more = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("before=")
    );
    expect(more).toBeDefined();
    expect(String(more![0])).toContain("limit=15");
    expect(String(more![0])).toContain("before=2");
    expect(screen.getByText("Notification 3")).toBeInTheDocument();
    // hasMore flipped false — the control goes away.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("guards against double-fire while a page is loading", async () => {
    pollData = { rows: [notif(1)], unread: 1, nextCursor: 1, hasMore: true };
    moreData = { rows: [notif(2)], unread: 2, nextCursor: null, hasMore: false };

    render(<NotificationBell />);
    await flush();
    await openPanel();

    let release!: (value: Awaited<ReturnType<typeof fetchMock>>) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await flush();

    const loading = screen.getByRole("button", { name: "Loading…" });
    expect(loading).toBeDisabled();
    fireEvent.click(loading);
    await flush();

    release({ ok: true, json: async () => moreData });
    await flush();

    expect(screen.getByText("Notification 2")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes("before=")
      ).length
    ).toBe(1);
  });

  it("keeps the list and toasts when the page request fails", async () => {
    pollData = { rows: [notif(1)], unread: 1, nextCursor: 1, hasMore: true };

    render(<NotificationBell />);
    await flush();
    await openPanel();

    moreFail = true;
    moreStatus = 500;
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await flush();

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe(
      "Could not load more notifications"
    );
    expect(vi.mocked(toast.error).mock.calls[0][1]).toEqual({
      description: "Request failed (500)",
    });
    expect(screen.getByText("Notification 1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Load more" })
    ).toBeInTheDocument();
  });
});
