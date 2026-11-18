// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ReactNode } from "react";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/stage-client", () => ({
  stageUpload: vi.fn(),
}));
vi.mock("@/lib/blob-cleanup", () => ({
  deleteStagedBlob: vi.fn(),
}));
vi.mock("@/lib/reels/browser-normalize", () => ({
  normalizeVideo: vi.fn(),
}));
vi.mock("@/lib/reels/bake", () => ({
  bakeReelAnimation: vi.fn(),
}));
vi.mock("@/lib/reels/import-download", () => ({
  fetchDownloadedVideo: vi.fn(),
  parseVideoParam: () => null,
}));
vi.mock("@/components/reels/animation-picker", () => ({
  AnimationPicker: ({
    onSelect,
  }: {
    onSelect: (slot: "start", id: string) => void;
  }) => (
    <button type="button" onClick={() => onSelect("start", "headline")}>
      Attach animation
    </button>
  ),
}));
vi.mock("@/components/publishing/final-reel-preview", () => ({
  FinalReelPreview: () => null,
}));
vi.mock("@/components/assistant-chat", () => ({
  AssistantChat: () => null,
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
    // Interactive stub: the page drives the schedule toggle and the datetime
    // value through these props. Submit-time validation runs through the real
    // resolveScheduledFor in @/lib/publishing/schedule, so it is not mocked
    // away here.
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

import { stageUpload } from "@/lib/stage-client";
import { deleteStagedBlob } from "@/lib/blob-cleanup";
import { bakeReelAnimation } from "@/lib/reels/bake";
import { normalizeVideo } from "@/lib/reels/browser-normalize";
import { toast } from "sonner";
import ReelsPage from "./page";

const stageUploadMock = stageUpload as unknown as Mock;
const deleteStagedBlobMock = deleteStagedBlob as unknown as Mock;
const bakeMock = bakeReelAnimation as unknown as Mock;
const normalizeMock = normalizeVideo as unknown as Mock;
const fetchMock = vi.fn();

async function flush() {
  await act(async () => {});
}

function stageVideo() {
  const file = new File(["bytes"], "clip.mp4", { type: "video/mp4" });
  Object.defineProperty(file, "size", { value: 1024 });
  normalizeMock.mockResolvedValue({ file, normalized: false, error: undefined });
  const input = document.querySelector<HTMLInputElement>("#reel-video")!;
  fireEvent.change(input, { target: { files: [file] } });
}

function reelPost() {
  return fetchMock.mock.calls.find(([url]) => String(url) === "/api/reels");
}

beforeEach(() => {
  vi.clearAllMocks();
  // The composer validates the schedule against the real clock, so pin it:
  // the mocked default ("2026-11-15T09:00") has to land inside the window.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-14T08:00:00"));
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      results: [
        {
          page: { id: "p1", name: "The Daily Buzz" },
          ok: true,
          permalink: "https://facebook.com/reel_1",
        },
      ],
    }),
  });
  stageUploadMock.mockResolvedValue({
    url: "https://bucket.public.blob.vercel-storage.com/reels/clip.mp4",
  });
  // jsdom has no scrollIntoView, and the composer calls it after a publish.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReelsPage composer", () => {
  it("posts the reel with the scheduled time", async () => {
    render(<ReelsPage />);
    await flush();

    stageVideo();
    await flush();

    fireEvent.change(screen.getByLabelText("Caption"), {
      target: { value: "The Daily Buzz" },
    });
    fireEvent.click(screen.getByLabelText("Schedule with Facebook"));

    fireEvent.click(screen.getByRole("button", { name: /Schedule reel/ }));
    await waitFor(() => expect(reelPost()).toBeDefined());

    const body = JSON.parse(String(reelPost()![1].body));
    expect(body.scheduledFor).toBe(new Date("2026-11-15T09:00").toISOString());
    expect(body.caption).toBe("The Daily Buzz");
    expect(body.videoUrl).toBe(
      "https://bucket.public.blob.vercel-storage.com/reels/clip.mp4"
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Reel scheduled",
      expect.anything()
    );
  });

  it("publishes straight away with no schedule field when scheduling is off", async () => {
    render(<ReelsPage />);
    await flush();

    stageVideo();
    await flush();

    fireEvent.change(screen.getByLabelText("Caption"), {
      target: { value: "The Daily Buzz" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Publish reel/ }));
    await waitFor(() => expect(reelPost()).toBeDefined());

    const body = JSON.parse(String(reelPost()![1].body));
    expect(body.scheduledFor).toBeUndefined();
    expect(toast.success).toHaveBeenCalledWith(
      "Reel published",
      expect.anything()
    );
  });

  it("refuses a schedule inside the 10-minute floor and says which bound it broke", async () => {
    render(<ReelsPage />);
    await flush();

    stageVideo();
    await flush();

    fireEvent.change(screen.getByLabelText("Caption"), {
      target: { value: "The Daily Buzz" },
    });
    fireEvent.click(screen.getByLabelText("Schedule with Facebook"));
    // Chrome's native picker seeds its time column with the current time, so
    // editing the date can leave the time a few minutes out — inside the
    // 10-minute floor. The composer must refuse it before uploading.
    fireEvent.change(screen.getByLabelText("Publish date and time"), {
      target: { value: "2026-11-14T08:05" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Schedule reel/ }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Scheduled time must be at least 10 minutes from now."
    );
    expect(stageUploadMock).not.toHaveBeenCalled();
    expect(reelPost()).toBeUndefined();
  });

  it("asks for a new time when the slot elapses during staging, reusing the staged reel", async () => {
    render(<ReelsPage />);
    await flush();

    stageVideo();
    await flush();

    fireEvent.click(screen.getByLabelText("Schedule with Facebook"));
    fireEvent.change(screen.getByLabelText("Publish date and time"), {
      target: { value: "2026-11-14T08:15" },
    });
    // Staging outlives the 10-minute window: the upload finishes at 08:10,
    // leaving the chosen 08:15 slot five minutes out.
    stageUploadMock.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-11-14T08:10:00"));
      return {
        url: "https://bucket.public.blob.vercel-storage.com/reels/clip.mp4",
      };
    });

    fireEvent.click(screen.getByRole("button", { name: /Schedule reel/ }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(reelPost()).toBeUndefined();
    expect(stageUploadMock).toHaveBeenCalledTimes(1);

    // The prompt is seeded with the earliest valid slot (08:21), one click away.
    fireEvent.click(screen.getByRole("button", { name: /Schedule at/ }));
    await waitFor(() => expect(reelPost()).toBeDefined());

    const body = JSON.parse(String(reelPost()![1].body));
    expect(body.scheduledFor).toBe(new Date("2026-11-14T08:21").toISOString());
    // The staged upload is reused — no second bake or upload.
    expect(stageUploadMock).toHaveBeenCalledTimes(1);
  });

  it("asks for a new time when the bake outlives the slot, before staging anything", async () => {
    render(<ReelsPage />);
    await flush();

    stageVideo();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Attach animation" }));

    fireEvent.click(screen.getByLabelText("Schedule with Facebook"));
    fireEvent.change(screen.getByLabelText("Publish date and time"), {
      target: { value: "2026-11-14T08:15" },
    });
    // The real-time bake finishes at 08:10, five minutes short of the slot.
    bakeMock.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-11-14T08:10:00"));
      return new File(["baked"], "clip.mp4", { type: "video/mp4" });
    });

    fireEvent.click(screen.getByRole("button", { name: /Schedule reel/ }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // The stale slot is caught before the GB-scale upload, so nothing staged.
    expect(stageUploadMock).not.toHaveBeenCalled();
    expect(deleteStagedBlobMock).not.toHaveBeenCalled();
    expect(reelPost()).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: /Schedule at/ }));
    await waitFor(() => expect(reelPost()).toBeDefined());

    const body = JSON.parse(String(reelPost()![1].body));
    expect(body.scheduledFor).toBe(new Date("2026-11-14T08:21").toISOString());
    // Confirming the new time is not re-prompted by the post-staging check.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stageUploadMock).toHaveBeenCalledTimes(1);
    expect(deleteStagedBlobMock).not.toHaveBeenCalled();
  });

  it("posts nothing and re-enables the composer when the new time is cancelled", async () => {
    render(<ReelsPage />);
    await flush();

    stageVideo();
    await flush();

    fireEvent.click(screen.getByLabelText("Schedule with Facebook"));
    fireEvent.change(screen.getByLabelText("Publish date and time"), {
      target: { value: "2026-11-14T08:15" },
    });
    stageUploadMock.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-11-14T08:10:00"));
      return {
        url: "https://bucket.public.blob.vercel-storage.com/reels/clip.mp4",
      };
    });

    fireEvent.click(screen.getByRole("button", { name: /Schedule reel/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(reelPost()).toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Schedule reel/ })).toBeEnabled();
    // The staged reel is removed instead of being orphaned in the store.
    expect(deleteStagedBlobMock).toHaveBeenCalledWith(
      "https://bucket.public.blob.vercel-storage.com/reels/clip.mp4"
    );
  });

  it("releases the staged reel when the composer unmounts with the prompt open", async () => {
    const { unmount } = render(<ReelsPage />);
    await flush();

    stageVideo();
    await flush();

    fireEvent.click(screen.getByLabelText("Schedule with Facebook"));
    fireEvent.change(screen.getByLabelText("Publish date and time"), {
      target: { value: "2026-11-14T08:15" },
    });
    stageUploadMock.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-11-14T08:10:00"));
      return {
        url: "https://bucket.public.blob.vercel-storage.com/reels/clip.mp4",
      };
    });

    fireEvent.click(screen.getByRole("button", { name: /Schedule reel/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // Navigating away settles the pending prompt as a cancellation, which is
    // what releases the staged upload.
    unmount();
    await flush();

    expect(deleteStagedBlobMock).toHaveBeenCalledWith(
      "https://bucket.public.blob.vercel-storage.com/reels/clip.mp4"
    );
    expect(reelPost()).toBeUndefined();
  });

  it("releases the staged reel when staging finishes after the composer unmounts", async () => {
    let finishStage: (() => void) | null = null;
    stageUploadMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStage = () => {
            vi.setSystemTime(new Date("2026-11-14T08:10:00"));
            resolve({
              url: "https://bucket.public.blob.vercel-storage.com/reels/clip.mp4",
            });
          };
        })
    );

    const { unmount } = render(<ReelsPage />);
    await flush();

    stageVideo();
    await flush();

    fireEvent.click(screen.getByLabelText("Schedule with Facebook"));
    fireEvent.change(screen.getByLabelText("Publish date and time"), {
      target: { value: "2026-11-14T08:15" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Schedule reel/ }));
    await waitFor(() => expect(stageUploadMock).toHaveBeenCalled());

    // The tab is gone before the upload lands; the slot has lapsed by then.
    unmount();
    await act(async () => finishStage!());
    await flush();

    expect(deleteStagedBlobMock).toHaveBeenCalledWith(
      "https://bucket.public.blob.vercel-storage.com/reels/clip.mp4"
    );
    expect(reelPost()).toBeUndefined();
  });
});
