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

const localPost: Row = {
  id: 51,
  text: "Queued by the Story Queue",
  scheduled_for: "2026-11-20T09:00:00.000Z",
  status: "scheduled",
  kind: "post",
  source: "local",
  news_title: null,
  error_message: null,
};

const youtubePost: Row = {
  id: 52,
  text: "Short scheduled to YouTube",
  scheduled_for: "2026-11-22T09:00:00.000Z",
  status: "scheduled",
  kind: "reel",
  source: "youtube",
  news_title: null,
  error_message: null,
};

function respond(rows: Row[], deleted = true) {
  fetchMock.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/schedule") {
        return { ok: true, json: async () => rows };
      }
      if (url.startsWith("/api/schedule/")) {
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body));
          return {
            ok: true,
            json: async () => ({
              id: Number(url.split("/").pop()),
              scheduled_for: body.scheduledFor,
            }),
          };
        }
        return { ok: deleted, json: async () => ({ deleted }) };
      }
      return { ok: false, json: async () => ({ error: "unexpected" }) };
    }
  );
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

describe("CalendarPage reschedule", () => {
  it("moves a workspace-scheduled post through PATCH", async () => {
    respond([localPost]);

    render(<CalendarPage />);
    await flush();

    const sidebar = screen
      .getByRole("heading", { name: "Scheduled" })
      .closest("section")!;
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Reschedule" })
    );

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("New date and time"), {
      target: { value: "2026-11-21T10:30" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reschedule" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/schedule/51",
        expect.objectContaining({ method: "PATCH" })
      )
    );
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH"
    )!;
    expect(JSON.parse(String(patchCall[1].body))).toEqual({
      scheduledFor: new Date("2026-11-21T10:30").toISOString(),
    });
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Scheduled post moved")
    );
  });

  it("offers reschedule on Facebook-held schedules", async () => {
    respond([reel]);

    render(<CalendarPage />);
    await flush();

    expect(
      screen.getAllByRole("button", { name: "Reschedule" }).length
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "Cancel on Facebook" }).length
    ).toBeGreaterThan(0);
  });

  it("hides reschedule for platforms that cannot move a schedule", async () => {
    respond([youtubePost]);

    render(<CalendarPage />);
    await flush();

    expect(
      screen.queryByRole("button", { name: "Reschedule" })
    ).not.toBeInTheDocument();
  });

  it("shows a spinner instead of text while the move is in flight", async () => {
    let finishPatch!: (value: unknown) => void;
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/schedule") {
          return { ok: true, json: async () => [localPost] };
        }
        if (init?.method === "PATCH") {
          return new Promise((resolve) => {
            finishPatch = resolve;
          });
        }
        return { ok: true, json: async () => ({ deleted: true }) };
      }
    );

    render(<CalendarPage />);
    await flush();

    const sidebar = screen
      .getByRole("heading", { name: "Scheduled" })
      .closest("section")!;
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Reschedule" })
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reschedule" }));

    const busy = await within(dialog).findByRole("button", {
      name: "Rescheduling…",
    });
    expect(busy).toBeDisabled();
    // Icon only: the busy state is a spinner, not copy.
    expect(busy.textContent).toBe("");

    finishPatch({
      ok: true,
      json: async () => ({
        id: 51,
        scheduled_for: new Date("2026-11-21T10:30").toISOString(),
      }),
    });
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Scheduled post moved")
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
  });

  it("surfaces a platform refusal inside the dialog", async () => {
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/schedule") {
          return { ok: true, json: async () => [localPost] };
        }
        if (init?.method === "PATCH") {
          return {
            ok: false,
            json: async () => ({
              error: "That queue cannot move an existing schedule.",
            }),
          };
        }
        return { ok: true, json: async () => ({ deleted: true }) };
      }
    );

    render(<CalendarPage />);
    await flush();

    const sidebar = screen
      .getByRole("heading", { name: "Scheduled" })
      .closest("section")!;
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Reschedule" })
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reschedule" }));

    expect(
      await within(dialog).findByText("That queue cannot move an existing schedule.")
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("warns after a partial multi-Page move", async () => {
    const warning =
      "Facebook refused to move this item: (#10) permission denied. It did move on 1 of 2 Pages, so those are now at the new time.";
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/schedule") {
          return { ok: true, json: async () => [reel] };
        }
        if (init?.method === "PATCH") {
          return {
            ok: true,
            json: async () => ({
              id: 49,
              scheduled_for: new Date("2026-12-05T10:30").toISOString(),
              warning,
            }),
          };
        }
        return { ok: true, json: async () => ({ deleted: true }) };
      }
    );

    render(<CalendarPage />);
    await flush();

    const sidebar = screen
      .getByRole("heading", { name: "Scheduled" })
      .closest("section")!;
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Reschedule" })
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("New date and time"), {
      target: { value: "2026-12-05T10:30" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reschedule" }));

    await waitFor(() =>
      expect(toastMock.warning).toHaveBeenCalledWith(
        "Moved on some Pages",
        { description: warning }
      )
    );
    expect(toastMock.success).not.toHaveBeenCalledWith("Scheduled post moved");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
  });

  it("clears a failed request on edit and lets the move be retried", async () => {
    let patches = 0;
    fetchMock.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/schedule") {
          return { ok: true, json: async () => [localPost] };
        }
        if (init?.method === "PATCH") {
          patches += 1;
          if (patches === 1) {
            return {
              ok: false,
              json: async () => ({ error: "Facebook refused to move this item." }),
            };
          }
          return {
            ok: true,
            json: async () => ({
              id: 51,
              scheduled_for: new Date("2026-11-22T10:30").toISOString(),
            }),
          };
        }
        return { ok: true, json: async () => ({ deleted: true }) };
      }
    );

    render(<CalendarPage />);
    await flush();

    const sidebar = screen
      .getByRole("heading", { name: "Scheduled" })
      .closest("section")!;
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Reschedule" })
    );
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("New date and time");
    fireEvent.change(input, { target: { value: "2026-11-22T10:30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reschedule" }));

    expect(
      await within(dialog).findByText("Facebook refused to move this item.")
    ).toBeInTheDocument();
    const submit = within(dialog).getByRole("button", { name: "Reschedule" });
    // A failed request is retryable; only an invalid time blocks submission.
    expect(submit).toBeEnabled();

    fireEvent.change(input, { target: { value: "2026-11-22T11:00" } });
    expect(
      within(dialog).queryByText("Facebook refused to move this item.")
    ).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Reschedule" }));
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Scheduled post moved")
    );
    expect(patches).toBe(2);
  });

  it("caps a Facebook row's picker at Meta's 29-day window", async () => {
    respond([reel]);

    render(<CalendarPage />);
    await flush();

    const sidebar = screen
      .getByRole("heading", { name: "Scheduled" })
      .closest("section")!;
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Reschedule" })
    );
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText(
      "New date and time"
    ) as HTMLInputElement;
    const pad = (value: number) => String(value).padStart(2, "0");
    const cap = new Date(Date.parse("2026-11-16T08:00:00Z") + 29 * 24 * 60 * 60 * 1000);
    expect(input.max).toBe(
      `${cap.getFullYear()}-${pad(cap.getMonth() + 1)}-${pad(cap.getDate())}T${pad(cap.getHours())}:${pad(cap.getMinutes())}`
    );
  });
});
