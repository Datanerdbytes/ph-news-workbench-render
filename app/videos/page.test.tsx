// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ReactNode } from "react";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/components/assistant-chat", () => ({
  AssistantChat: () => null,
}));
vi.mock("@/components/publishing/media-preview-card", () => ({
  MediaPreviewCard: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  MediaPreviewMedia: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/videos/video-animation-overlay", () => ({
  VideoAnimationOverlay: () => null,
}));
// One-click attachment so the bake path runs without the real picker.
vi.mock("@/components/videos/video-animation-picker", () => ({
  VideoAnimationPicker: ({
    onSelect,
  }: {
    onSelect: (slot: "start", presetId: string) => void;
  }) => (
    <button type="button" onClick={() => onSelect("start", "cinema-title")}>
      Attach animation
    </button>
  ),
}));
vi.mock("@/lib/videos/bake", () => ({
  bakeAndFinalizeVideo: vi.fn(),
}));
vi.mock("@/components/publishing/publish-page", () => {
  // Mirrors the real bounds helper closely enough for the reschedule prompt:
  // the 10-minute floor padded a further minute, rounded up to the minute.
  const localInput = (date: Date) => {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  return {
    PublishPage: ({ children }: { children?: ReactNode }) => (
      <div>{children}</div>
    ),
    ComposerCard: ({ children }: { children?: ReactNode }) => (
      <section>{children}</section>
    ),
    ResultList: () => null,
    FieldLabel: ({
      htmlFor,
      children,
    }: {
      htmlFor?: string;
      children?: ReactNode;
    }) => <label htmlFor={htmlFor}>{children}</label>,
    FilePicker: ({
      id,
      onPick,
    }: {
      id: string;
      onPick: (file: File | null) => void;
    }) => (
      <input
        id={id}
        type="file"
        aria-label="File"
        onChange={(event) => onPick(event.target.files?.[0] ?? null)}
      />
    ),
    PageSelector: () => null,
    ScheduleField: ({
      enabled,
      onEnabled,
      value,
      onChange,
      error,
    }: {
      enabled: boolean;
      onEnabled: (value: boolean) => void;
      value: string;
      onChange: (value: string) => void;
      error?: string;
    }) => (
      <>
        <input
          type="checkbox"
          aria-label="Schedule with Facebook"
          checked={enabled}
          onChange={(event) => onEnabled(event.target.checked)}
        />
        {enabled && (
          <input
            type="datetime-local"
            aria-label="Publish date and time"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        {error && <p role="alert">{error}</p>}
      </>
    ),
    defaultScheduleValue: () => "2026-11-15T09:00",
    toLocalInput: localInput,
    scheduleBounds: (now: Date = new Date()) => ({
      min: localInput(
        new Date(Math.ceil((now.getTime() + 11 * 60_000) / 60_000) * 60_000)
      ),
      max: localInput(new Date(now.getTime() + 75 * 24 * 60 * 60_000)),
    }),
    useScheduleClock: () => new Date(),
    mediaFileError: () => null,
    inputClass: "",
    textareaClass: "",
    useManagedPages: () => ({
      pages: [{ id: "p1", name: "The Daily Buzz", primary: true }],
      selected: ["p1"],
      selectOne: () => {},
      loading: false,
    }),
  };
});

import { bakeAndFinalizeVideo } from "@/lib/videos/bake";
import { SCHEDULE_TOO_SOON_ERROR } from "@/lib/publishing/schedule";
import { toast } from "sonner";
import VideosPage from "./page";

const bakeMock = bakeAndFinalizeVideo as unknown as Mock;

type SentForm = Record<string, unknown>;
let sentForms: SentForm[] = [];

// Per-request script: lets a test make one upload slow and/or rejected, the
// way a slow transfer crosses the server's post-upload schedule check.
type ScriptedResponse = {
  status?: number;
  body?: unknown;
  onSend?: () => void;
};
let script: ScriptedResponse[] = [];

// A simulated server clock: every request is judged against one floor, so a
// slot the browser still accepts can be refused however often it is offered.
let serverMin: Date | null = null;

// The composer posts the file through XMLHttpRequest (for real upload
// progress); this stub records the form and answers with a published row.
class FakeXmlHttpRequest {
  status = 200;
  responseText = JSON.stringify({
    results: [
      { page: { id: "p1", name: "The Daily Buzz" }, ok: true, permalink: null },
    ],
  });
  upload: {
    onprogress:
      | null
      | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void);
  } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open = vi.fn();
  setRequestHeader = vi.fn();
  send(body: FormData) {
    const form = Object.fromEntries(
      body as unknown as Iterable<[string, FormDataEntryValue]>
    );
    sentForms.push(form);
    const step = script.shift();
    step?.onSend?.();
    if (step?.status) this.status = step.status;
    if (step?.body !== undefined) this.responseText = JSON.stringify(step.body);
    const sentSlot = form.scheduledFor ? new Date(String(form.scheduledFor)) : null;
    if (serverMin && sentSlot && sentSlot.getTime() < serverMin.getTime()) {
      this.status = 400;
      this.responseText = JSON.stringify({ error: SCHEDULE_TOO_SOON_ERROR });
    }
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 });
    queueMicrotask(() => this.onload?.());
  }
}

async function flush() {
  await act(async () => {});
}

function pickVideo() {
  const file = new File(["bytes"], "clip.mp4", { type: "video/mp4" });
  Object.defineProperty(file, "size", { value: 1024 });
  const input = document.querySelector<HTMLInputElement>("#video-file")!;
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The composer validates the schedule against the real clock, so pin it:
  // the mocked default ("2026-11-15T09:00") has to land inside the window.
  // performance is faked too: the slow-upload retry measures the transfer with
  // the monotonic clock, and advancing the fake timers moves both.
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(new Date("2026-11-14T08:00:00"));
  sentForms = [];
  script = [];
  serverMin = null;
  vi.stubGlobal("XMLHttpRequest", FakeXmlHttpRequest);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("VideosPage composer", () => {
  it("asks for a new time when the slot elapses during the bake, reusing the baked file", async () => {
    // The bake runs for the clip's length: this one finishes at 08:10,
    // leaving the chosen 08:15 slot five minutes out.
    const baked = new File(["baked"], "baked.mp4", { type: "video/mp4" });
    bakeMock.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-11-14T08:10:00"));
      return baked;
    });

    render(<VideosPage />);
    await flush();

    pickVideo();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Attach animation" }));
    fireEvent.click(screen.getByLabelText("Schedule with Facebook"));
    fireEvent.change(screen.getByLabelText("Publish date and time"), {
      target: { value: "2026-11-14T08:15" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Schedule video/ }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(sentForms).toHaveLength(0);
    expect(bakeMock).toHaveBeenCalledTimes(1);

    // The prompt is seeded with the earliest valid slot (08:21), one click away.
    fireEvent.click(screen.getByRole("button", { name: /Schedule at/ }));
    await waitFor(() => expect(sentForms).toHaveLength(1));

    expect(sentForms[0].scheduledFor).toBe(
      new Date("2026-11-14T08:21").toISOString()
    );
    // The baked file is what gets uploaded, not the original clip. FormData
    // clones the File, so compare the name it was appended with.
    expect((sentForms[0].video as File).name).toBe("baked.mp4");
    // The baked file is reused — the bake never runs twice.
    expect(bakeMock).toHaveBeenCalledTimes(1);
  });

  it("reopens the prompt when the server rejects the time after a slow upload", async () => {
    // The transfer itself takes 6 minutes; the server checks the schedule
    // only once the body has arrived, so the 08:15 slot is 9 minutes out.
    script = [
      {
        status: 400,
        body: { error: SCHEDULE_TOO_SOON_ERROR },
        onSend: () => vi.advanceTimersByTime(6 * 60_000),
      },
    ];

    render(<VideosPage />);
    await flush();

    pickVideo();
    await flush();

    fireEvent.click(screen.getByLabelText("Schedule with Facebook"));
    fireEvent.change(screen.getByLabelText("Publish date and time"), {
      target: { value: "2026-11-14T08:15" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Schedule video/ }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // The seed clears the measured 6-minute upload plus the 10-minute floor.
    expect(
      screen.getByRole("button", { name: /Schedule at 2026-11-14 08:23/ })
    ).toBeInTheDocument();
    // Videos re-uploads, so the copy must not promise a free retry.
    expect(screen.getByText(/only the upload repeats/)).toBeInTheDocument();
    expect(sentForms).toHaveLength(1);

    // An edited time must clear the next upload too, not just the floor.
    fireEvent.change(screen.getByLabelText("New publish date and time"), {
      target: { value: "2026-11-14T08:20" },
    });
    expect(screen.getByRole("button", { name: /Schedule at/ })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The last upload took about 6 min — pick at least 16 min ahead."
    );

    fireEvent.change(screen.getByLabelText("New publish date and time"), {
      target: { value: "2026-11-14T08:23" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Schedule at/ }));
    await waitFor(() => expect(sentForms).toHaveLength(2));

    expect(sentForms[1].scheduledFor).toBe(
      new Date("2026-11-14T08:23").toISOString()
    );
    expect(toast.success).toHaveBeenCalledWith("Video scheduled", expect.anything());
  });

  it("reopens the prompt when the server rejects a time the browser still accepts", async () => {
    // No clock movement: the browser sees 08:15 as 15 minutes out, but the
    // server clock runs ahead and applies a 08:17 floor to every request.
    // Each suggestion must clear the slot that was actually refused, so the
    // flow retries 08:16 and then 08:17 — never the refused slot — and only
    // the final time passes the server's own check.
    serverMin = new Date("2026-11-14T08:17:00");

    render(<VideosPage />);
    await flush();

    pickVideo();
    await flush();

    fireEvent.click(screen.getByLabelText("Schedule with Facebook"));
    fireEvent.change(screen.getByLabelText("Publish date and time"), {
      target: { value: "2026-11-14T08:15" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Schedule video/ }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(sentForms).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: /Schedule at 2026-11-14 08:16/ })
    );
    await waitFor(() => expect(sentForms).toHaveLength(2));

    // Still under the server's floor; the prompt moves past the refused slot.
    expect(
      await screen.findByRole("button", { name: /Schedule at 2026-11-14 08:17/ })
    ).toBeInTheDocument();

    // The refused slot cannot be re-confirmed even by editing back to it.
    fireEvent.change(screen.getByLabelText("New publish date and time"), {
      target: { value: "2026-11-14T08:16" },
    });
    expect(screen.getByRole("button", { name: /Schedule at/ })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The server already refused 2026-11-14 08:16 — pick a later time."
    );
    fireEvent.change(screen.getByLabelText("New publish date and time"), {
      target: { value: "2026-11-14T08:17" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Schedule at 2026-11-14 08:17/ })
    );
    await waitFor(() => expect(sentForms).toHaveLength(3));

    expect(sentForms.map((form) => form.scheduledFor)).toEqual([
      new Date("2026-11-14T08:15").toISOString(),
      new Date("2026-11-14T08:16").toISOString(),
      new Date("2026-11-14T08:17").toISOString(),
    ]);
    expect(toast.success).toHaveBeenCalledWith("Video scheduled", expect.anything());
  });

  it("seeds the retry from the server's earliest acceptable slot", async () => {
    // The server clock runs minutes ahead: it refuses 08:15 and reports its
    // own floor, 08:25. The next upload takes 4 minutes, so the retry must
    // clear 08:25 + 4 min — later than the browser's own floor.
    script = [
      {
        status: 400,
        body: {
          error: SCHEDULE_TOO_SOON_ERROR,
          earliest: new Date("2026-11-14T08:25").toISOString(),
        },
        onSend: () => vi.advanceTimersByTime(4 * 60_000),
      },
    ];

    render(<VideosPage />);
    await flush();

    pickVideo();
    await flush();

    fireEvent.click(screen.getByLabelText("Schedule with Facebook"));
    fireEvent.change(screen.getByLabelText("Publish date and time"), {
      target: { value: "2026-11-14T08:15" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Schedule video/ }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // Browser floor lands at 08:19; the server's floor plus the transfer at
    // 08:29, so the seed is 08:30.
    expect(
      screen.getByRole("button", { name: /Schedule at 2026-11-14 08:30/ })
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /Schedule at 2026-11-14 08:30/ })
    );
    await waitFor(() => expect(sentForms).toHaveLength(2));

    expect(sentForms[1].scheduledFor).toBe(
      new Date("2026-11-14T08:30").toISOString()
    );
  });
});
