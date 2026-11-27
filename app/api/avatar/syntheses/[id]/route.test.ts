import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireWorkspaceMock,
  getAvatarJobMock,
  requestAvatarCancellationMock,
  removeAvatarJobMock,
  deleteStagedBlobsMock,
  deleteAvatarSynthesisMock,
} = vi.hoisted(() => ({
  requireWorkspaceMock: vi.fn(),
  getAvatarJobMock: vi.fn(),
  requestAvatarCancellationMock: vi.fn(),
  removeAvatarJobMock: vi.fn(),
  deleteStagedBlobsMock: vi.fn(),
  deleteAvatarSynthesisMock: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () =>
    new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
}));
vi.mock("@/lib/avatar/queue", () => ({
  getAvatarJob: getAvatarJobMock,
  requestAvatarCancellation: requestAvatarCancellationMock,
  removeAvatarJob: removeAvatarJobMock,
}));
vi.mock("@/lib/avatar/azure", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/avatar/azure")>()),
  deleteAvatarSynthesis: deleteAvatarSynthesisMock,
}));
vi.mock("@/lib/storage", () => ({
  deleteStagedBlobs: deleteStagedBlobsMock,
}));
vi.mock("@/lib/db", () => ({ sql: vi.fn() }));

import type { AvatarJobRow } from "@/lib/avatar/jobs";
import { DELETE, GET } from "./route";

const access = { user: { id: "user-1" }, workspace: { id: "ws-1" } };
const BLOB_URL = "https://store.test/avatars/ws-1/job-1/avatar.mp4";

function row(overrides: Partial<AvatarJobRow> = {}): AvatarJobRow {
  return {
    id: "job-1",
    workspace_id: "ws-1",
    user_id: "user-1",
    avatar_id: "max-business",
    avatar_kind: "video",
    avatar_style: "business",
    voice_id: "en-PH-RosaNeural",
    speed: 1.1,
    text: "Hello",
    characters: 5,
    estimated_seconds: 3,
    provider_synthesis_id: null,
    status: "running",
    progress: 0.25,
    status_message: "Azure is generating the avatar video…",
    blob_url: null,
    output_format: "mp4",
    has_alpha: false,
    file_size: null,
    duration_seconds: null,
    error: null,
    worker_id: "worker-1",
    attempts: 1,
    cancel_requested: false,
    publish_state: "ready",
    created_at: "2026-11-17T10:00:00.000Z",
    updated_at: "2026-11-17T10:01:00.000Z",
    ...overrides,
  };
}

function ctx(id = "job-1") {
  return { params: Promise.resolve({ id }) };
}

function get(id = "job-1") {
  return GET(new Request(`http://localhost/api/avatar/syntheses/${id}`), ctx(id));
}

function remove(id = "job-1") {
  return DELETE(new Request(`http://localhost/api/avatar/syntheses/${id}`, {
    method: "DELETE",
  }), ctx(id));
}

beforeEach(() => {
  vi.clearAllMocks();
  requireWorkspaceMock.mockResolvedValue(access);
  getAvatarJobMock.mockResolvedValue(row());
  requestAvatarCancellationMock.mockResolvedValue(
    row({ cancel_requested: true, status_message: "Cancellation requested" }),
  );
  removeAvatarJobMock.mockResolvedValue({
    blobUrl: BLOB_URL,
    providerSynthesisId: "job-1",
  });
  deleteStagedBlobsMock.mockResolvedValue(undefined);
  deleteAvatarSynthesisMock.mockResolvedValue(undefined);
});

describe("GET /api/avatar/syntheses/[id]", () => {
  it("requires a workspace session before lookup", async () => {
    requireWorkspaceMock.mockResolvedValue(null);

    const response = await get();

    expect(response.status).toBe(401);
    expect(getAvatarJobMock).not.toHaveBeenCalled();
  });

  it("scopes lookup to the workspace and returns only public job fields", async () => {
    getAvatarJobMock.mockResolvedValue(
      row({
        status: "completed",
        progress: 1,
        blob_url: BLOB_URL,
        file_size: "4096",
        duration_seconds: 13.4,
        provider_synthesis_id: "provider-secret",
      }),
    );

    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getAvatarJobMock).toHaveBeenCalledWith("job-1", "ws-1");
    expect(body).toEqual({
      id: "job-1",
      avatarId: "max-business",
      voiceId: "en-PH-RosaNeural",
      speed: 1.1,
      text: "Hello",
      status: "completed",
      statusMessage: "Azure is generating the avatar video…",
      progress: 1,
      videoUrl: BLOB_URL,
      outputFormat: "mp4",
      hasAlpha: false,
      durationSeconds: 13.4,
      error: null,
      publishState: "ready",
      createdAt: "2026-11-17T10:00:00.000Z",
      updatedAt: "2026-11-17T10:01:00.000Z",
    });
    expect(body).not.toHaveProperty("workspace_id");
    expect(body).not.toHaveProperty("provider_synthesis_id");
    expect(body).not.toHaveProperty("worker_id");
  });

  it("returns 404 for a missing or foreign-workspace job", async () => {
    getAvatarJobMock.mockResolvedValue(null);

    const response = await get("foreign-job");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Avatar job not found.",
      code: "not_found",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getAvatarJobMock).toHaveBeenCalledWith("foreign-job", "ws-1");
  });
});

describe("DELETE /api/avatar/syntheses/[id]", () => {
  it("requires a workspace session before lookup or cleanup", async () => {
    requireWorkspaceMock.mockResolvedValue(null);

    const response = await remove();

    expect(response.status).toBe(401);
    expect(getAvatarJobMock).not.toHaveBeenCalled();
    expect(deleteStagedBlobsMock).not.toHaveBeenCalled();
    expect(deleteAvatarSynthesisMock).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing or foreign-workspace job", async () => {
    getAvatarJobMock.mockResolvedValue(null);

    const response = await remove("foreign-job");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
    expect(getAvatarJobMock).toHaveBeenCalledWith("foreign-job", "ws-1");
    expect(requestAvatarCancellationMock).not.toHaveBeenCalled();
    expect(removeAvatarJobMock).not.toHaveBeenCalled();
  });

  it.each([
    "queued",
    "submitting",
    "running",
    "downloading",
    "finalizing",
  ])("requests cancellation instead of removing an active %s job", async (status) => {
    const current = row({ status: status as AvatarJobRow["status"] });
    getAvatarJobMock.mockResolvedValue(current);
    requestAvatarCancellationMock.mockResolvedValue({
      ...current,
      cancel_requested: true,
      status: status === "queued" ? "cancelled" : current.status,
    });

    const response = await remove();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.status).toBe(status === "queued" ? "cancelled" : status);
    expect(body).not.toHaveProperty("cancelRequested");
    expect(body).not.toHaveProperty("cancel_requested");
    expect(requestAvatarCancellationMock).toHaveBeenCalledWith("job-1", "ws-1");
    expect(removeAvatarJobMock).not.toHaveBeenCalled();
    expect(deleteStagedBlobsMock).not.toHaveBeenCalled();
    expect(deleteAvatarSynthesisMock).not.toHaveBeenCalled();
  });

  it("returns 409 when an active job becomes publish-locked during cancellation", async () => {
    requestAvatarCancellationMock.mockResolvedValue(null);

    const response = await remove();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This avatar is being published and cannot be cancelled.",
      code: "in_use",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(removeAvatarJobMock).not.toHaveBeenCalled();
    expect(deleteStagedBlobsMock).not.toHaveBeenCalled();
  });

  it("removes a terminal job and cleans its staged and provider outputs", async () => {
    getAvatarJobMock.mockResolvedValue(
      row({ status: "completed", blob_url: BLOB_URL, provider_synthesis_id: "job-1" }),
    );

    const response = await remove();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(requestAvatarCancellationMock).not.toHaveBeenCalled();
    expect(removeAvatarJobMock).toHaveBeenCalledWith("job-1", "ws-1");
    expect(deleteStagedBlobsMock).toHaveBeenCalledWith([BLOB_URL]);
    expect(deleteAvatarSynthesisMock).toHaveBeenCalledWith("job-1");
    expect(deleteStagedBlobsMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteAvatarSynthesisMock.mock.invocationCallOrder[0],
    );
  });

  it("keeps the deletion successful when provider cleanup fails", async () => {
    getAvatarJobMock.mockResolvedValue(row({ status: "failed" }));
    deleteAvatarSynthesisMock.mockRejectedValue(new Error("provider unavailable"));

    const response = await remove();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(deleteStagedBlobsMock).toHaveBeenCalledWith([BLOB_URL]);
  });

  it("does not call cleanup for a terminal job with no outputs", async () => {
    getAvatarJobMock.mockResolvedValue(row({ status: "cancelled" }));
    removeAvatarJobMock.mockResolvedValue({
      blobUrl: null,
      providerSynthesisId: null,
    });

    const response = await remove();

    expect(response.status).toBe(200);
    expect(deleteStagedBlobsMock).not.toHaveBeenCalled();
    expect(deleteAvatarSynthesisMock).not.toHaveBeenCalled();
  });

  it("returns 409 when removal is restricted by publishing or a scheduled post", async () => {
    getAvatarJobMock.mockResolvedValue(row({ status: "completed" }));
    removeAvatarJobMock.mockResolvedValue(null);

    const response = await remove();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This avatar is attached to a published or scheduled post.",
      code: "in_use",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(deleteStagedBlobsMock).not.toHaveBeenCalled();
    expect(deleteAvatarSynthesisMock).not.toHaveBeenCalled();
  });
});
