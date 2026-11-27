import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireWorkspaceMock, getAvatarJobMock, openStagedBlobMock } = vi.hoisted(
  () => ({
    requireWorkspaceMock: vi.fn(),
    getAvatarJobMock: vi.fn(),
    openStagedBlobMock: vi.fn(),
  }),
);

vi.mock("@/lib/session", () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () => new Response(null, { status: 401 }),
}));
vi.mock("@/lib/avatar/queue", () => ({ getAvatarJob: getAvatarJobMock }));
vi.mock("@/lib/storage", () => ({ openStagedBlob: openStagedBlobMock }));
vi.mock("@/lib/db", () => ({ sql: vi.fn() }));

import type { AvatarJobRow } from "@/lib/avatar/jobs";
import { GET } from "./route";

const access = { user: { id: "user-1" }, workspace: { id: "ws-1" } };
const BLOB_URL = "https://huggingface.co/datasets/owner/staging/resolve/main/avatar.mp4";
const MP4_HEADER = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);

function row(overrides: Partial<AvatarJobRow> = {}): AvatarJobRow {
  return {
    id: "job-1",
    workspace_id: "ws-1",
    user_id: "user-1",
    avatar_id: "max-business",
    avatar_kind: "video",
    avatar_style: "business",
    voice_id: "en-PH-RosaNeural",
    speed: 1,
    text: "Hello",
    characters: 5,
    estimated_seconds: 3,
    provider_synthesis_id: null,
    status: "completed",
    progress: 1,
    status_message: "Avatar video is ready.",
    blob_url: BLOB_URL,
    file_size: MP4_HEADER.byteLength,
    duration_seconds: 3,
    error: null,
    worker_id: null,
    attempts: 1,
    cancel_requested: false,
    publish_state: "ready",
    created_at: "2026-11-17T10:00:00.000Z",
    updated_at: "2026-11-17T10:01:00.000Z",
    ...overrides,
  };
}

function get(id = "job-1") {
  return GET(
    new Request(`http://localhost/api/avatar/syntheses/${id}/video`),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireWorkspaceMock.mockResolvedValue(access);
  getAvatarJobMock.mockResolvedValue(row());
  openStagedBlobMock.mockResolvedValue(new Response(MP4_HEADER));
});

describe("GET /api/avatar/syntheses/[id]/video", () => {
  it("requires a workspace session before looking up the job", async () => {
    requireWorkspaceMock.mockResolvedValue(null);

    expect((await get()).status).toBe(401);
    expect(getAvatarJobMock).not.toHaveBeenCalled();
    expect(openStagedBlobMock).not.toHaveBeenCalled();
  });

  it.each([
    null,
    row({ status: "running", blob_url: null }),
    row({ blob_url: null }),
  ])("does not expose media without a completed workspace-owned job", async (job) => {
    getAvatarJobMock.mockResolvedValue(job);

    expect((await get()).status).toBe(404);
    expect(openStagedBlobMock).not.toHaveBeenCalled();
  });

  it("streams the stored private URL through an authenticated route", async () => {
    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(getAvatarJobMock).toHaveBeenCalledWith("job-1", "ws-1");
    expect(openStagedBlobMock).toHaveBeenCalledWith(BLOB_URL);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP4_HEADER);
  });

  it("rejects an oversized object before streaming it", async () => {
    const upstream = new Response(MP4_HEADER, {
      headers: { "content-length": String(257 * 1024 * 1024) },
    });
    const cancel = vi.spyOn(upstream.body!, "cancel");
    openStagedBlobMock.mockResolvedValue(upstream);

    expect((await get()).status).toBe(413);
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects a body that is not an MP4", async () => {
    openStagedBlobMock.mockResolvedValue(new Response("not a video"));

    const response = await get();
    await expect(response.arrayBuffer()).rejects.toThrow(
      "The avatar source is not a valid MP4 video.",
    );
  });

  it("enforces the size limit even when storage omits content-length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 257) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    openStagedBlobMock.mockResolvedValue(new Response(body));

    const response = await get();
    await expect(response.arrayBuffer()).rejects.toThrow(
      "The avatar video is too large.",
    );
  });

  it("returns a generic error when private storage cannot be read", async () => {
    openStagedBlobMock.mockRejectedValue(new Error(`failed ${BLOB_URL}`));

    const response = await get();

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(BLOB_URL);
  });
});
