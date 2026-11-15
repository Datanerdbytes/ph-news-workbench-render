// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ReactNode } from "react";

vi.mock("@vercel/blob/client", () => ({
  upload: vi.fn(),
}));
vi.mock("@/lib/blob-cleanup", () => ({ deleteStagedBlob: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/components/publishing/publish-page", () => ({
  PlatformPublishPage: ({ children }: { children?: ReactNode }) => (
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
        aria-label="Schedule on Instagram"
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
  inputClass: "",
  textareaClass: "",
}));
vi.mock("@/components/instagram-connection", () => ({
  useInstagramConnection: () => ({
    connected: true,
    loading: false,
    ig: { username: "iamwowie_" },
    reason: null,
    detail: null,
  }),
}));
vi.mock("@/components/instagram-preview", () => ({
  InstagramPreview: () => null,
}));

import { upload } from "@vercel/blob/client";
import { toast } from "sonner";
import InstagramPage from "./page";

const uploadMock = upload as unknown as Mock;
const fetchMock = vi.fn();

async function flush() {
  await act(async () => {});
}

function stageImage() {
  uploadMock.mockResolvedValue({
    url: "https://bucket.public.blob.vercel-storage.com/instagram/img.jpg",
  });
  const input = document.querySelector<HTMLInputElement>("#ig-image")!;
  fireEvent.change(input, {
    target: {
      files: [new File(["bytes"], "photo.jpg", { type: "image/jpeg" })],
    },
  });
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
      id: "ig_media_1",
      permalink: "https://www.instagram.com/p/xyz",
      account: { name: "iamwowie_" },
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("InstagramPage composer", () => {
  it("publishes now without a schedule field", async () => {
    render(<InstagramPage />);
    await flush();

    stageImage();
    await flush();

    fireEvent.change(screen.getByLabelText("Caption"), {
      target: { value: "Behind the headline" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Publish to Instagram" })
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/instagram/posts");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      message: "Behind the headline",
      imageUrl: "https://bucket.public.blob.vercel-storage.com/instagram/img.jpg",
    });
    expect(body.scheduledFor).toBeUndefined();
    expect(toast.success).toHaveBeenCalledWith(
      "Posted to Instagram",
      expect.anything()
    );
  });

  it("sends the scheduled time when scheduling", async () => {
    render(<InstagramPage />);
    await flush();

    stageImage();
    await flush();

    fireEvent.change(screen.getByLabelText("Caption"), {
      target: { value: "Behind the headline" },
    });
    fireEvent.click(screen.getByLabelText("Schedule on Instagram"));

    fireEvent.click(screen.getByRole("button", { name: "Schedule post" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.scheduledFor).toBe(new Date("2026-11-15T09:00").toISOString());
    expect(toast.success).toHaveBeenCalledWith(
      "Instagram post scheduled",
      expect.anything()
    );
  });

  it("refuses a schedule inside the 10-minute floor and says which bound it broke", async () => {
    render(<InstagramPage />);
    await flush();

    stageImage();
    await flush();

    fireEvent.change(screen.getByLabelText("Caption"), {
      target: { value: "Behind the headline" },
    });
    fireEvent.click(screen.getByLabelText("Schedule on Instagram"));
    // Chrome's native picker seeds its time column with the current time, so
    // editing the date can leave the time a few minutes out — inside the
    // 10-minute floor. The composer must refuse it before uploading.
    fireEvent.change(screen.getByLabelText("Publish date and time"), {
      target: { value: "2026-11-14T08:05" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Schedule post" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Scheduled time must be at least 10 minutes from now."
    );
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url) === "/api/instagram/posts"
      )
    ).toBe(false);
  });
});
