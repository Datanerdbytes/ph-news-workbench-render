import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/publishing/connection", () => ({
  requirePublishingConnection: vi.fn(),
}));
vi.mock("@/lib/media-file", () => ({
  parseMultipartToDisk: vi.fn(),
  cleanupParsedMultipart: vi.fn(() => Promise.resolve()),
  uploadedFileType: () => "image/png",
  MultipartTooLargeError: class MultipartTooLargeError extends Error {},
}));
vi.mock("@/lib/publishing/crosspost", () => ({
  publishToSelectedPages: vi.fn(),
  crosspostResponse: vi.fn(() =>
    new Response(JSON.stringify({ id: "story_1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })
  ),
}));
vi.mock("@/lib/publishing/stories", () => ({
  MAX_STORY_VIDEO_BYTES: 100 * 1024 * 1024,
  publishPhotoStory: vi.fn(),
  publishVideoStory: vi.fn(),
}));
vi.mock("@/lib/publishing/errors", () => ({
  facebookErrorResponse: vi.fn(() =>
    new Response(JSON.stringify({ error: "nope" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    })
  ),
}));
vi.mock("@/lib/schedule-mirror", () => ({ recordNativeSchedule: vi.fn() }));

import { parseMultipartToDisk } from "@/lib/media-file";
import { publishToSelectedPages } from "@/lib/publishing/crosspost";
import { requirePublishingConnection } from "@/lib/publishing/connection";
import { recordNativeSchedule } from "@/lib/schedule-mirror";
import { POST } from "./route";

const requireMock = requirePublishingConnection as unknown as Mock;
const parseMock = parseMultipartToDisk as unknown as Mock;
const publishMock = publishToSelectedPages as unknown as Mock;
const mirrorMock = recordNativeSchedule as unknown as Mock;

const access = {
  user: { id: "u1" },
  workspace: { id: "ws_1", role: "owner" },
};

const results = [
  {
    page: { id: "page_1", name: "The Daily Buzz" },
    ok: true,
    id: "story_1",
    permalink: null,
  },
];

function post() {
  return new Request("http://localhost/api/stories", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireMock.mockResolvedValue({ context: { access } });
  parseMock.mockResolvedValue({
    fields: { kind: "photo", pageIds: ["page_1"] },
    files: {
      photo: { kind: "buffer", buffer: Buffer.from("png"), filename: "story.png" },
    },
  });
  publishMock.mockResolvedValue({ targets: [], results });
  mirrorMock.mockResolvedValue(undefined);
});

describe("POST /api/stories", () => {
  it("mirrors the story so the platform counters see it", async () => {
    const response = await POST(post());

    expect(response.status).toBe(201);
    expect(mirrorMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "u1",
      kind: "story",
      text: "",
      scheduledFor: null,
      results,
    });
  });

  it("mirrors a rejected story so the failure stays visible", async () => {
    const failed = [
      {
        page: { id: "page_1", name: "The Daily Buzz" },
        ok: false,
        error: "Facebook said no",
      },
    ];
    publishMock.mockResolvedValue({ targets: [], results: failed });

    await POST(post());

    // The mirror decides the row's status (a rejected publish becomes a
    // 'failed' row) — the route only hands it the outcome.
    expect(mirrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "story", results: failed })
    );
  });
});
