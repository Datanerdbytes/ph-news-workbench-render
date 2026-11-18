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
import VideosPage from "./page";

const bakeMock = bakeAndFinalizeVideo as unknown as Mock;

type SentForm = Record<string, unknown>;
let sentForms: SentForm[] = [];

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
    sentForms.push(
      Object.fromEntries(body as unknown as Iterable<[string, FormDataEntryValue]>)
    );
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-14T08:00:00"));
  sentForms = [];
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
    bakeMock.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-11-14T08:10:00"));
      return new File(["baked"], "baked.mp4", { type: "video/mp4" });
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
    // The baked file is reused — the bake never runs twice.
    expect(bakeMock).toHaveBeenCalledTimes(1);
  });
});
