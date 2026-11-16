// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/post",
}));

vi.mock("@/components/publishing/publish-page", () => ({
  PublishPage: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ComposerCard: ({ children }: { children?: ReactNode }) => (
    <section>{children}</section>
  ),
  PageSelector: () => null,
  ScheduleField: () => null,
  ResultList: () => null,
  FieldLabel: ({
    htmlFor,
    children,
    hint,
  }: {
    htmlFor?: string;
    children?: ReactNode;
    hint?: string;
  }) => (
    <label htmlFor={htmlFor}>
      {children}
      {hint ? <span data-testid="field-hint">{hint}</span> : null}
    </label>
  ),
  FilePicker: ({
    id,
    file,
    onPick,
    label,
  }: {
    id: string;
    file: File | null;
    onPick: (file: File | null) => void;
    label?: string;
  }) => (
    <div>
      { }
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        data-testid="video-input"
        type="file"
        onChange={(event) => {
          void onPick(event.target.files?.[0] ?? null);
          event.target.value = "";
        }}
      />
      {file ? <span data-testid="picked-file">{file.name}</span> : null}
    </div>
  ),
  defaultScheduleValue: () => "2026-11-07T12:00",
  inputClass: "",
  textareaClass: "",
  mediaFileError: () => null,
  useManagedPages: () => ({
    pages: [{ id: "p1", name: "NeuralVerse", picture: null }],
    selected: ["p1"],
    selectOne: vi.fn(),
    loading: false,
  }),
}));

vi.mock("@/components/facebook-connection", () => ({
  useFacebookConnection: () => ({ connected: true, loading: false }),
}));

vi.mock("@/components/facebook-preview", () => ({
  FacebookPreview: ({ text }: { text?: string }) => (
    <div data-testid="fb-post-preview" data-text={text ?? ""} />
  ),
}));

vi.mock("@/components/assistant-chat", () => ({
  AssistantChat: () => null,
}));

vi.mock("sonner", () => ({ toast: toastMock }));

import PostPage from "./page";

async function flush() {
  await act(async () => {});
}

/** Captures the multipart body the page hands to /api/videos. */
class FakeXHR {
  status = 0;
  responseText = "";
  upload = { onprogress: null as ((event: unknown) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static last: FakeXHR | null = null;

  open(_method: string, url: string) {
    FakeXHR.last = this;
    (this as unknown as { url: string }).url = url;
  }

  send(form: FormData) {
    (this as unknown as { form: FormData }).form = form;
    setTimeout(() => {
      this.status = 200;
      this.responseText = JSON.stringify({ results: [{ id: "r1" }] });
      this.onload?.();
    }, 0);
  }
}

let xhrInstances: FakeXHR[];

beforeEach(() => {
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  xhrInstances = [];
  vi.stubGlobal(
    "XMLHttpRequest",
    class extends FakeXHR {
      constructor() {
        super();
        xhrInstances.push(this);
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ id: "r1" }], warning: undefined }),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PostPage unified composer", () => {
  it("publishes text through /api/posts when no video is attached", async () => {
    render(<PostPage />);
    await flush();

    fireEvent.change(screen.getByLabelText(/Message/), {
      target: { value: "Plain text post" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish post" }));
    await flush();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/posts");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).message).toBe(
      "Plain text post"
    );
    expect(toastMock.success).toHaveBeenCalled();
  });

  it("routes an attached video through /api/videos with the message as description", async () => {
    render(<PostPage />);
    await flush();

    const video = new File(["video-bytes"], "clip.mp4", { type: "video/mp4" });
    fireEvent.change(screen.getByTestId("video-input"), {
      target: { files: [video] },
    });
    await flush();

    fireEvent.change(screen.getByLabelText(/Message/), {
      target: { value: "Watch this" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Publish post|Publishing|Uploading/ }));
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        "Post published",
        expect.anything()
      ),
    );

    const xhr = FakeXHR.last!;
    expect((xhr as unknown as { url: string }).url).toBe("/api/videos");
    const form = (xhr as unknown as { form: FormData }).form;
    expect(form.get("description")).toBe("Watch this");
    expect(form.get("video")).toBeInstanceOf(File);
    expect(JSON.stringify(form.get("pageIds"))).toContain("p1");

    // The text path stayed idle.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears a typed link when a video is attached", async () => {
    render(<PostPage />);
    await flush();

    const link = screen.getByLabelText(/Link/);
    fireEvent.change(link, { target: { value: "https://example.com" } });

    fireEvent.change(screen.getByTestId("video-input"), {
      target: { files: [new File(["v"], "clip.mp4", { type: "video/mp4" })] },
    });

    // The link field only makes sense for text/link posts — it is hidden
    // once a video is attached.
    expect(screen.queryByLabelText(/Link/)).not.toBeInTheDocument();
    expect(screen.getByTestId("picked-file")).toHaveTextContent("clip.mp4");
  });
});
