// @vitest-environment jsdom
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TtsProviderId } from "@/lib/tts/providers";
import type { TtsVoiceId } from "@/lib/tts/voices";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children?: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/app-frame", () => ({
  AppFrame: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/facebook-connection", () => ({
  useFacebookConnection: () => ({
    loading: false,
    configured: true,
    connected: true,
    scopes: ["pages_manage_posts"],
    page: { id: "page-1", name: "Test Page" },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

vi.mock("@/components/publishing/publish-page", () => ({
  ComposerCard: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
  FieldLabel: () => null,
  FilePicker: () => null,
  PageSelector: () => null,
  defaultScheduleValue: () => "2026-11-27T09:00",
  mediaFileError: () => null,
  scheduleBounds: () => ({ min: "", max: "" }),
  useManagedPages: () => ({
    pages: [{ id: "page-1", name: "Test Page" }],
    selected: ["page-1"],
    selectOne: vi.fn(),
    loading: false,
  }),
  useScheduleClock: () => new Date("2026-11-26T10:00:00Z"),
}));

vi.mock("@/components/publishing/schedule-retry-dialog", () => ({
  useScheduleRetry: () => ({
    resolveSubmit: vi.fn().mockResolvedValue({ kind: "submit", iso: "2026-11-29T09:00:00.000Z" }),
    cancel: vi.fn(),
    dialog: null,
  }),
}));

vi.mock("@/components/assistant-chat", () => ({ AssistantChat: () => null }));
vi.mock("@/components/facebook-preview", () => ({ FacebookPreview: () => null }));
vi.mock("@/components/compose/avatar-overlay-editor", () => ({
  AvatarOverlayEditor: () => null,
}));
vi.mock("@/components/videos/video-animation-picker", () => ({
  VideoAnimationPicker: () => null,
}));
vi.mock("@/components/videos/video-animation-overlay", () => ({
  VideoAnimationOverlay: () => null,
}));
vi.mock("@/lib/avatar/use-avatar-job-polling", () => ({
  useAvatarJobPolling: vi.fn(),
}));
vi.mock("@/lib/videos/bake", () => ({ bakeAndFinalizeVideo: vi.fn() }));
vi.mock("@/lib/videos/slideshow", () => ({
  bakeAndFinalizeNarratedSlideshow: vi.fn().mockResolvedValue(
    new File(["video"], "narration.mp4", { type: "video/mp4" }),
  ),
}));
vi.mock("@/lib/videos/avatar-video", () => ({
  flattenTransparentAvatar: vi.fn(),
}));
vi.mock("@/lib/stage-client", () => ({
  stageUpload: vi.fn().mockResolvedValue({ url: "https://example.com/narration.mp4" }),
}));
vi.mock("@/lib/blob-cleanup", () => ({ deleteStagedBlob: vi.fn() }));
const { toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("@/components/compose/voice-over-panel", () => ({
  VoiceOverPanel: ({
    provider,
    providerConfigured,
    providerLoading,
    providerRefreshing,
    providerLoadError,
    clonedVoiceIds,
    language,
    voiceId,
    speed,
    audio,
    stale,
    onVoiceChange,
    onGenerate,
  }: {
    provider: TtsProviderId;
    providerConfigured: boolean;
    providerLoading: boolean;
    providerRefreshing: boolean;
    providerLoadError: string;
    clonedVoiceIds: readonly string[];
    language: "en" | "tl";
    voiceId: string;
    speed: number;
    audio: { text: string } | null;
    stale: boolean;
    onVoiceChange: (voiceId: string) => void;
    onGenerate: () => void;
  }) => (
    <section aria-label="Voice-over panel">
      <output data-testid="voice-over-provider">{provider}</output>
      <output data-testid="voice-over-configured">{String(providerConfigured)}</output>
      <output data-testid="voice-over-loading">{String(providerLoading)}</output>
      <output data-testid="voice-over-refreshing">{String(providerRefreshing)}</output>
      <output data-testid="voice-over-ready">{String(Boolean(audio && !stale))}</output>
      <output data-testid="voice-over-load-error">{providerLoadError}</output>
      <output data-testid="voice-over-cloned-voices">{clonedVoiceIds.join(",")}</output>
      <output data-testid="voice-over-language">{language}</output>
      <output data-testid="voice-over-speed">{speed}</output>
      <output data-testid="voice-over-text">{audio?.text ?? ""}</output>
      <button
        type="button"
        onClick={onGenerate}
        disabled={
          providerLoading ||
          providerRefreshing ||
          Boolean(providerLoadError) ||
          !providerConfigured
        }
      >
        Generate voice-over
      </button>
      <label>
        Voice-over voice
        <select
          value={voiceId}
          onChange={(event) => onVoiceChange(event.target.value)}
          disabled={providerLoading || providerRefreshing || Boolean(providerLoadError) || !providerConfigured}
        >
          <option value="en-PH-RosaNeural">Rosa</option>
          <option value="en-US-ChristopherNeural">Christopher</option>
          <option value="fil-PH-BlessicaNeural">Blessica</option>
          <option value="aai-kyla">Kyla</option>
          <option value="aai-peter">Peter</option>
          {provider === "assemblyai" && clonedVoiceIds.includes("cloned-voice-id") ? (
            <option value="cloned-voice-id">Cloned · cloned-voice-id</option>
          ) : null}
        </select>
      </label>
    </section>
  ),
}));

vi.mock("@/components/compose/talking-avatar-panel", () => ({
  TalkingAvatarPanel: ({
    voiceId,
    speed,
    onVoiceChange,
  }: {
    voiceId: TtsVoiceId;
    speed: number;
    onVoiceChange: (voiceId: TtsVoiceId) => void;
  }) => (
    <section aria-label="Talking avatar panel">
      <output data-testid="avatar-speed">{speed}</output>
      <label>
        Avatar voice
        <select value={voiceId} onChange={(event) => onVoiceChange(event.target.value as TtsVoiceId)}>
          <option value="en-PH-RosaNeural">Rosa</option>
          <option value="en-PH-JamesNeural">James</option>
          <option value="fil-PH-BlessicaNeural">Blessica</option>
          <option value="fil-PH-AngeloNeural">Angelo</option>
          <option value="en-US-ChristopherNeural">Christopher</option>
        </select>
      </label>
    </section>
  ),
}));

import ComposePage from "./page";

const fetchMock = vi.fn();
const createObjectURLMock = vi.fn(() => "blob:narration");
const revokeObjectURLMock = vi.fn();
let workspace: {
  ttsProvider: TtsProviderId;
  ttsConfigured: boolean;
  assemblyAiVoiceIds: string[];
};
let workspaceRequest: Promise<Response> | null;
let queuedWorkspaceRequests: Promise<Response>[] = [];

function jsonResponse(payload: unknown, ok = true) {
  return { ok, json: async () => payload } as Response;
}

function audioResponse() {
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });
}

async function attachImage() {
  const input = document.querySelector<HTMLInputElement>(
    'input[type="file"][accept="image/jpeg,image/png,image/webp"]',
  );
  expect(input).not.toBeNull();
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["image"], "story.png", { type: "image/png" })],
  });
  fireEvent.change(input!);
  await waitFor(() =>
    expect(screen.getByAltText("Attachment 1")).toBeInTheDocument(),
  );
}

function workspaceResponse() {
  const queued = queuedWorkspaceRequests.shift();
  if (queued) return queued;
  return workspaceRequest
    ? workspaceRequest
    : Promise.resolve(jsonResponse(workspace));
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function openComposer() {
  render(<ComposePage />);
  await screen.findByRole("heading", { name: "Test story", level: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
  workspace = {
    ttsProvider: "azure",
    ttsConfigured: true,
    assemblyAiVoiceIds: [],
  };
  workspaceRequest = null;
  queuedWorkspaceRequests = [];
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/items") {
      return jsonResponse({
        rows: [
          {
            id: 1,
            title: "Test story",
            summary: "A story for voice-over tests",
            link: "https://example.com/story",
            status: "pending",
            draft_id: null,
          },
        ],
      });
    }
    if (url === "/api/workspace") {
      const response = await workspaceResponse();
      workspaceRequest = null;
      return response;
    }
    if (url === "/api/tts") return audioResponse();
    if (url === "/api/avatar/syntheses") return jsonResponse([]);
    if (url === "/api/publish") {
      return jsonResponse({ page: { name: "Test Page" } });
    }
    if (url === "/api/schedule") {
      return jsonResponse({ id: 1 });
    }
    throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("FileReader", class {
    result = "data:image/png;base64,aW1hZ2U=";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL() {
      queueMicrotask(() => this.onload?.());
    }
  });
  vi.stubGlobal("Image", class {
    naturalWidth = 1;
    naturalHeight = 1;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  });
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createObjectURLMock;
    static revokeObjectURL = revokeObjectURLMock;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ComposePage voice-over settings", () => {
  it("loads the saved provider on mount and refreshes it on window focus", async () => {
    await openComposer();
    fireEvent.click(screen.getByRole("button", { name: "Voice-over" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Voice-over voice")).toHaveValue(
        "en-PH-RosaNeural",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("voice-over-loading")).toHaveTextContent("false"),
    );
    expect(screen.getByTestId("voice-over-provider")).toHaveTextContent("azure");
    expect(screen.getByTestId("voice-over-configured")).toHaveTextContent("true");

    workspace = {
      ttsProvider: "assemblyai",
      ttsConfigured: true,
      assemblyAiVoiceIds: ["cloned-voice-id"],
    };
    fireEvent(window, new Event("focus"));

    await waitFor(() =>
      expect(screen.getByTestId("voice-over-provider")).toHaveTextContent(
        "assemblyai",
      ),
    );
    expect(screen.getByLabelText("Voice-over voice")).toHaveValue("aai-kyla");
    expect(screen.getByTestId("voice-over-speed")).toHaveTextContent("1");
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => url === "/api/workspace"),
      ).toHaveLength(2),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/workspace", { cache: "no-store" });
  });

  it("ignores stale responses from overlapping provider refreshes", async () => {
    await openComposer();
    fireEvent.click(screen.getByRole("button", { name: "Voice-over" }));
    await waitFor(() =>
      expect(screen.getByTestId("voice-over-loading")).toHaveTextContent("false"),
    );

    const older = deferredResponse();
    const newer = deferredResponse();
    queuedWorkspaceRequests.push(older.promise, newer.promise);
    fireEvent(window, new Event("focus"));
    fireEvent(window, new Event("focus"));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => url === "/api/workspace"),
      ).toHaveLength(3),
    );
    expect(screen.getByTestId("voice-over-refreshing")).toHaveTextContent("true");

    await act(async () => {
      newer.resolve(
        jsonResponse({
          ttsProvider: "assemblyai",
          ttsConfigured: true,
          assemblyAiVoiceIds: ["new-cloned-voice"],
        }),
      );
      await newer.promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId("voice-over-provider")).toHaveTextContent(
        "assemblyai",
      ),
    );
    expect(screen.getByTestId("voice-over-refreshing")).toHaveTextContent("false");
    expect(screen.getByTestId("voice-over-cloned-voices")).toHaveTextContent(
      "new-cloned-voice",
    );
    expect(screen.getByLabelText("Voice-over voice")).toHaveValue("aai-kyla");

    await act(async () => {
      older.resolve(
        jsonResponse({
          ttsProvider: "azure",
          ttsConfigured: true,
          assemblyAiVoiceIds: ["stale-cloned-voice"],
        }),
      );
      await older.promise;
    });
    expect(screen.getByTestId("voice-over-provider")).toHaveTextContent(
      "assemblyai",
    );
    expect(screen.getByTestId("voice-over-cloned-voices")).toHaveTextContent(
      "new-cloned-voice",
    );
    expect(screen.getByLabelText("Voice-over voice")).toHaveValue("aai-kyla");
    expect(screen.getByTestId("voice-over-refreshing")).toHaveTextContent("false");
  });

  it("blocks voice-over generation during the initial settings load", async () => {
    const pending = deferredResponse();
    queuedWorkspaceRequests.push(pending.promise);
    await openComposer();
    fireEvent.change(screen.getByRole("textbox", { name: "Facebook post draft" }), {
      target: { value: "A draft waiting for saved settings." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Voice-over" }));
    await attachImage();

    const generate = screen.getByRole("button", { name: "Generate voice-over" });
    expect(screen.getByTestId("voice-over-loading")).toHaveTextContent("true");
    expect(screen.getByTestId("voice-over-refreshing")).toHaveTextContent("false");
    expect(generate).toBeDisabled();
    fireEvent.click(generate);
    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/tts"),
    ).toBe(false);

    await act(async () => {
      pending.resolve(jsonResponse(workspace));
      await pending.promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId("voice-over-loading")).toHaveTextContent("false"),
    );
    expect(generate).toBeEnabled();
  });

  it("blocks voice-over generation while settings are refreshing", async () => {
    await openComposer();
    fireEvent.change(screen.getByRole("textbox", { name: "Facebook post draft" }), {
      target: { value: "A draft that should wait for fresh settings." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Voice-over" }));
    await waitFor(() =>
      expect(screen.getByTestId("voice-over-loading")).toHaveTextContent("false"),
    );
    await attachImage();
    const generate = screen.getByRole("button", { name: "Generate voice-over" });
    await waitFor(() => expect(generate).toBeEnabled());

    const pending = deferredResponse();
    queuedWorkspaceRequests.push(pending.promise);
    fireEvent(window, new Event("focus"));

    await waitFor(() =>
      expect(screen.getByTestId("voice-over-refreshing")).toHaveTextContent("true"),
    );
    expect(screen.getByTestId("voice-over-loading")).toHaveTextContent("false");
    expect(generate).toBeDisabled();
    expect(screen.getByLabelText("Voice-over voice")).toBeDisabled();
    fireEvent.click(generate);
    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/tts"),
    ).toBe(false);

    await act(async () => {
      pending.resolve(jsonResponse(workspace));
      await pending.promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId("voice-over-refreshing")).toHaveTextContent("false"),
    );
    expect(generate).toBeEnabled();
  });

  it("passes a provider load failure to the voice-over panel", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/items") {
        return jsonResponse({
          rows: [
            {
              id: 1,
              title: "Test story",
              summary: "A story for voice-over tests",
              link: "https://example.com/story",
              status: "pending",
              draft_id: null,
            },
          ],
        });
      }
      if (url === "/api/workspace") return jsonResponse({}, false);
      throw new Error(`Unexpected request: ${url}`);
    });
    await openComposer();
    fireEvent.click(screen.getByRole("button", { name: "Voice-over" }));

    await waitFor(() =>
      expect(screen.getByTestId("voice-over-load-error")).toHaveTextContent(
        "Could not load the saved voice-over provider. Reopen Settings and try again.",
      ),
    );
    expect(screen.getByTestId("voice-over-configured")).toHaveTextContent("false");
    expect(screen.getByTestId("voice-over-loading")).toHaveTextContent("false");
  });

  it("keeps ready narration available while refreshing provider settings", async () => {
    await openComposer();
    fireEvent.click(screen.getByRole("button", { name: "Voice-over" }));
    await waitFor(() =>
      expect(screen.getByTestId("voice-over-loading")).toHaveTextContent("false"),
    );

    let resolveWorkspace!: (response: Response) => void;
    workspaceRequest = new Promise<Response>((resolve) => {
      resolveWorkspace = resolve;
    });
    fireEvent(window, new Event("focus"));

    expect(screen.getByTestId("voice-over-loading")).toHaveTextContent("false");
    expect(screen.getByTestId("voice-over-refreshing")).toHaveTextContent("true");
    expect(screen.getByTestId("voice-over-ready")).toHaveTextContent("false");
    expect(screen.getByRole("combobox", { name: "Voice-over voice" })).toBeDisabled();

    resolveWorkspace(jsonResponse(workspace));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => url === "/api/workspace"),
      ).toHaveLength(2),
    );
  });

  it("keeps voice-over and avatar voice selections independent", async () => {
    await openComposer();
    fireEvent.click(screen.getByRole("button", { name: "Voice-over" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Voice-over voice")).toHaveValue(
        "en-PH-RosaNeural",
      ),
    );
    fireEvent.change(screen.getByLabelText("Voice-over voice"), {
      target: { value: "en-US-ChristopherNeural" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Talking avatar" }));
    expect(await screen.findByLabelText("Avatar voice")).toHaveValue(
      "en-PH-RosaNeural",
    );
    fireEvent.change(screen.getByLabelText("Avatar voice"), {
      target: { value: "en-PH-JamesNeural" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Voice-over" }));
    expect(screen.getByLabelText("Voice-over voice")).toHaveValue(
      "en-US-ChristopherNeural",
    );
    fireEvent.click(screen.getByRole("button", { name: "Talking avatar" }));
    expect(screen.getByLabelText("Avatar voice")).toHaveValue("en-PH-JamesNeural");
  });

  it("generates AssemblyAI narration with the saved provider settings", async () => {
    workspace = {
      ttsProvider: "assemblyai",
      ttsConfigured: true,
      assemblyAiVoiceIds: ["cloned-voice-id"],
    };
    await openComposer();
    fireEvent.change(screen.getByRole("textbox", { name: "Facebook post draft" }), {
      target: { value: "Read this **English** draft." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Voice-over" }));
    await waitFor(() =>
      expect(screen.getByTestId("voice-over-loading")).toHaveTextContent("false"),
    );
    fireEvent.change(screen.getByLabelText("Voice-over voice"), {
      target: { value: "cloned-voice-id" },
    });

    await attachImage();

    const generate = screen.getByRole("button", { name: "Generate voice-over" });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);

    await waitFor(() =>
      expect(screen.getByTestId("voice-over-text")).toHaveTextContent(
        "Read this English draft.",
      ),
    );
    const request = fetchMock.mock.calls.find(([url]) => url === "/api/tts");
    expect(request).toBeDefined();
    expect(request![1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(request![1]?.body))).toEqual({
      text: "Read this English draft.",
      voiceId: "cloned-voice-id",
      speed: 1,
      language: "en",
    });
    expect(screen.getByTestId("voice-over-ready")).toHaveTextContent("true");
    expect(screen.getByTestId("voice-over-speed")).toHaveTextContent("1");

    workspace = {
      ttsProvider: "assemblyai",
      ttsConfigured: true,
      assemblyAiVoiceIds: [],
    };
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(screen.getByLabelText("Voice-over voice")).toHaveValue("aai-kyla"),
    );
    expect(screen.getByTestId("voice-over-ready")).toHaveTextContent("false");

    workspace = {
      ttsProvider: "azure",
      ttsConfigured: true,
      assemblyAiVoiceIds: ["cloned-voice-id"],
    };
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(screen.getByTestId("voice-over-provider")).toHaveTextContent("azure"),
    );
    expect(screen.getByTestId("voice-over-ready")).toHaveTextContent("false");
    expect(screen.getByLabelText("Voice-over voice")).toHaveValue(
      "en-PH-RosaNeural",
    );
    expect(
      screen.queryByRole("option", { name: "Cloned · cloned-voice-id" }),
    ).toBeNull();
  });

  it("marks narration stale and blocks publishing after the saved provider changes", async () => {
    await openComposer();
    fireEvent.change(screen.getByRole("textbox", { name: "Facebook post draft" }), {
      target: { value: "A draft with ready narration." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Voice-over" }));
    await waitFor(() =>
      expect(screen.getByTestId("voice-over-loading")).toHaveTextContent("false"),
    );

    await attachImage();
    const generate = screen.getByRole("button", { name: "Generate voice-over" });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await waitFor(() =>
      expect(screen.getByTestId("voice-over-ready")).toHaveTextContent("true"),
    );
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();

    workspace = {
      ttsProvider: "assemblyai",
      ttsConfigured: true,
      assemblyAiVoiceIds: ["cloned-voice-id"],
    };
    fireEvent(window, new Event("focus"));

    await waitFor(() =>
      expect(screen.getByTestId("voice-over-provider")).toHaveTextContent(
        "assemblyai",
      ),
    );
    expect(screen.getByTestId("voice-over-ready")).toHaveTextContent("false");
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();
    expect(
      screen.getByText("Regenerate the voice-over for the updated draft or settings"),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/publish"),
    ).toBe(false);
  });

  it("does not interrupt narration baking when provider settings refresh", async () => {
    workspace = {
      ttsProvider: "assemblyai",
      ttsConfigured: true,
      assemblyAiVoiceIds: ["cloned-voice-id"],
    };
    await openComposer();
    fireEvent.change(screen.getByRole("textbox", { name: "Facebook post draft" }), {
      target: { value: "A draft with ready narration." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Voice-over" }));
    await waitFor(() =>
      expect(screen.getByTestId("voice-over-loading")).toHaveTextContent("false"),
    );

    await attachImage();
    const generate = screen.getByRole("button", { name: "Generate voice-over" });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await waitFor(() =>
      expect(screen.getByTestId("voice-over-ready")).toHaveTextContent("true"),
    );

    let resolveWorkspace!: (response: Response) => void;
    workspaceRequest = new Promise<Response>((resolve) => {
      resolveWorkspace = resolve;
    });
    fireEvent(window, new Event("focus"));
    expect(screen.getByTestId("voice-over-loading")).toHaveTextContent("false");
    expect(screen.getByTestId("voice-over-refreshing")).toHaveTextContent("true");
    expect(screen.getByRole("button", { name: "Generate voice-over" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    resolveWorkspace(jsonResponse(workspace));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => url === "/api/publish"),
      ).toBe(true),
    );
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(revokeObjectURLMock).not.toHaveBeenCalledWith("blob:narration");
  });
});
