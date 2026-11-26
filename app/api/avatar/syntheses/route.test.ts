import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sqlMock, requireWorkspaceMock, enqueueAvatarJobMock, avatarEndpointMock } =
  vi.hoisted(() => ({
    sqlMock: vi.fn(),
    requireWorkspaceMock: vi.fn(),
    enqueueAvatarJobMock: vi.fn(),
    avatarEndpointMock: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({ sql: sqlMock }));
vi.mock("@/lib/session", () => ({
  requireWorkspace: requireWorkspaceMock,
  unauthorized: () =>
    new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
}));
vi.mock("@/lib/avatar/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/avatar/queue")>()),
  enqueueAvatarJob: enqueueAvatarJobMock,
}));
vi.mock("@/lib/avatar/azure", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/avatar/azure")>()),
  avatarEndpoint: avatarEndpointMock,
}));

import { AvatarError } from "@/lib/avatar/azure";
import type { AvatarJobRow } from "@/lib/avatar/jobs";
import { AvatarQueueError } from "@/lib/avatar/queue";
import { GET, POST } from "./route";

const access = { user: { id: "user-1" }, workspace: { id: "ws-1" } };
const VALID_BODY = {
  text: "  **Hello** [world](https://example.com)  ",
  avatarId: "meg-formal",
  voiceId: "fil-PH-BlessicaNeural",
  speed: 1.1,
};

function row(overrides: Partial<AvatarJobRow> = {}): AvatarJobRow {
  return {
    id: "job-1",
    workspace_id: "ws-1",
    user_id: "user-1",
    avatar_id: "meg-formal",
    avatar_kind: "video",
    avatar_style: "formal",
    voice_id: "fil-PH-BlessicaNeural",
    speed: 1.1,
    text: "Hello world",
    characters: 11,
    estimated_seconds: 3,
    provider_synthesis_id: null,
    status: "queued",
    progress: null,
    status_message: "Queued",
    blob_url: null,
    file_size: null,
    duration_seconds: null,
    error: null,
    worker_id: null,
    attempts: 0,
    cancel_requested: false,
    publish_state: "ready",
    created_at: "2026-11-17T10:00:00.000Z",
    updated_at: "2026-11-17T10:01:00.000Z",
    ...overrides,
  };
}

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/avatar/syntheses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireWorkspaceMock.mockResolvedValue(access);
  sqlMock.mockResolvedValue([]);
  avatarEndpointMock.mockReturnValue("https://avatar.test");
  enqueueAvatarJobMock.mockResolvedValue(row());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/avatar/syntheses", () => {
  it("requires a workspace session before querying", async () => {
    requireWorkspaceMock.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/avatar/syntheses"));

    expect(response.status).toBe(401);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("lists ten workspace jobs and maps only public fields", async () => {
    sqlMock.mockResolvedValue([
      row({
        status: "completed",
        progress: 1,
        blob_url: "https://store.test/avatar.mp4",
        file_size: "4096",
        duration_seconds: 13.4,
        provider_synthesis_id: "provider-secret",
        worker_id: "worker-secret",
      }),
    ]);

    const response = await GET(new Request("http://localhost/api/avatar/syntheses"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual([
      {
        id: "job-1",
        avatarId: "meg-formal",
        voiceId: "fil-PH-BlessicaNeural",
        speed: 1.1,
        text: "Hello world",
        status: "completed",
        statusMessage: "Queued",
        progress: 1,
        videoUrl: "https://store.test/avatar.mp4",
        durationSeconds: 13.4,
        error: null,
        publishState: "ready",
        createdAt: "2026-11-17T10:00:00.000Z",
        updatedAt: "2026-11-17T10:01:00.000Z",
      },
    ]);
    expect(body[0]).not.toHaveProperty("workspace_id");
    expect(body[0]).not.toHaveProperty("provider_synthesis_id");
    expect(body[0]).not.toHaveProperty("worker_id");
    const call = sqlMock.mock.calls[0];
    expect((call[0] as TemplateStringsArray).join("?")).toContain(
      "WHERE workspace_id = ?",
    );
    expect((call[0] as TemplateStringsArray).join("?")).toContain("LIMIT 10");
    expect(call.slice(1)).toEqual(["ws-1"]);
  });
});

describe("POST /api/avatar/syntheses", () => {
  it("requires a workspace session before validation or enqueueing", async () => {
    requireWorkspaceMock.mockResolvedValue(null);

    const response = await post(VALID_BODY);

    expect(response.status).toBe(401);
    expect(avatarEndpointMock).not.toHaveBeenCalled();
    expect(enqueueAvatarJobMock).not.toHaveBeenCalled();
  });

  it("normalizes narration, defaults speed, checks config, and returns a public queued job", async () => {
    enqueueAvatarJobMock.mockResolvedValue(row({ speed: 1 }));
    const response = await post({
      text: VALID_BODY.text,
      avatarId: VALID_BODY.avatarId,
      voiceId: VALID_BODY.voiceId,
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-correlation-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(avatarEndpointMock).toHaveBeenCalledTimes(1);
    expect(enqueueAvatarJobMock).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "user-1",
      avatarId: "meg-formal",
      voiceId: "fil-PH-BlessicaNeural",
      speed: 1,
      text: "Hello world",
    });
    expect(avatarEndpointMock.mock.invocationCallOrder[0]).toBeLessThan(
      enqueueAvatarJobMock.mock.invocationCallOrder[0],
    );
    expect(body).toMatchObject({
      id: "job-1",
      avatarId: "meg-formal",
      voiceId: "fil-PH-BlessicaNeural",
      speed: 1,
      text: "Hello world",
      status: "queued",
      progress: null,
      videoUrl: null,
      publishState: "ready",
    });
    expect(body).not.toHaveProperty("workspace_id");
    expect(body).not.toHaveProperty("provider_synthesis_id");
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/avatar/syntheses", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_json" });
    expect(avatarEndpointMock).not.toHaveBeenCalled();
  });

  it.each([
    { body: null, code: "invalid_body" },
    { body: [], code: "invalid_text" },
    { body: "text", code: "invalid_body" },
  ])(
    "rejects a body without draft text: $body",
    async ({ body, code }) => {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code });
      expect(enqueueAvatarJobMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ avatarId: "meg-formal", voiceId: "fil-PH-BlessicaNeural" }, "invalid_text"],
    [{ ...VALID_BODY, text: 42 }, "invalid_text"],
    [{ ...VALID_BODY, text: " \n\t " }, "empty_text"],
    [{ ...VALID_BODY, avatarId: "unknown" }, "invalid_avatar"],
    [{ ...VALID_BODY, voiceId: "unknown" }, "invalid_voice"],
    [{ ...VALID_BODY, speed: "1" }, "invalid_speed"],
    [{ ...VALID_BODY, speed: null }, "invalid_speed"],
    [{ ...VALID_BODY, speed: 0.74 }, "invalid_speed"],
    [{ ...VALID_BODY, speed: 1.26 }, "invalid_speed"],
  ])("rejects invalid input with %s", async (body, code) => {
    const response = await post(body);
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.code).toBe(code);
    expect(payload.correlationId).toEqual(expect.any(String));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(avatarEndpointMock).not.toHaveBeenCalled();
    expect(enqueueAvatarJobMock).not.toHaveBeenCalled();
  });

  it("enforces the configured character cap before provider configuration", async () => {
    vi.stubEnv("AVATAR_MAX_CHARACTERS", "10");

    const response = await post({ ...VALID_BODY, text: "x".repeat(11) });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "text_too_long",
      error: "Avatar narration is limited to 10 characters.",
    });
    expect(avatarEndpointMock).not.toHaveBeenCalled();
    expect(enqueueAvatarJobMock).not.toHaveBeenCalled();
  });

  it("rejects narration estimated to exceed the per-job duration cap", async () => {
    vi.stubEnv("AVATAR_MAX_JOB_SECONDS", "10");

    const response = await post({ ...VALID_BODY, text: "x".repeat(110) });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "text_too_long",
      error: "This narration may exceed the 0-minute avatar limit.",
    });
    expect(enqueueAvatarJobMock).not.toHaveBeenCalled();
  });

  it("returns safe configuration errors without enqueueing", async () => {
    avatarEndpointMock.mockImplementation(() => {
      throw new AvatarError(
        503,
        "not_configured",
        "Talking avatars are not configured.",
        false,
      );
    });

    const response = await post(VALID_BODY);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      code: "not_configured",
      error: "Talking avatars are not configured.",
      correlationId: expect.any(String),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(enqueueAvatarJobMock).not.toHaveBeenCalled();
  });

  it("maps transactional quota rejection to a safe 429", async () => {
    enqueueAvatarJobMock.mockRejectedValue(
      new AvatarQueueError(
        429,
        "quota_exceeded",
        "The daily avatar allowance or active-job limit has been reached. Try again later.",
      ),
    );

    const response = await post(VALID_BODY);
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body).toMatchObject({ code: "quota_exceeded" });
    expect(body.correlationId).toEqual(expect.any(String));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not expose unexpected enqueue errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    enqueueAvatarJobMock.mockRejectedValue(new Error("secret database detail"));

    const response = await post(VALID_BODY);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "The avatar job could not be created.",
      code: "internal_error",
      correlationId: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain("secret database detail");
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
