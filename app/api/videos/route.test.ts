import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/db", () => ({ sql: vi.fn() }));
vi.mock("@/lib/publishing/connection", () => ({
  requirePublishingConnection: vi.fn(),
}));
vi.mock("@/lib/publishing/crosspost", () => ({
  publishToSelectedPages: vi.fn(),
  crosspostResponse: vi.fn(),
}));
vi.mock("@/lib/publishing/videos", () => ({
  MAX_VIDEO_BYTES: 1024 * 1024 * 1024,
  publishPageVideo: vi.fn(),
}));
vi.mock("@/lib/notifications", () => ({
  notifyPublishAttemptFailure: vi.fn(),
}));
vi.mock("@/lib/schedule-mirror", () => ({ recordNativeSchedule: vi.fn() }));
vi.mock("@/lib/reel-meta", () => ({ readMp4DurationSecondsFromFile: vi.fn() }));

import { notifyPublishAttemptFailure } from "@/lib/notifications";
import { crosspostResponse, publishToSelectedPages } from "@/lib/publishing/crosspost";
import { requirePublishingConnection } from "@/lib/publishing/connection";
import { publishPageVideo } from "@/lib/publishing/videos";
import { readMp4DurationSecondsFromFile } from "@/lib/reel-meta";
import { POST } from "./route";

const requireMock = requirePublishingConnection as unknown as Mock;
const publishMock = publishToSelectedPages as unknown as Mock;
const responseMock = crosspostResponse as unknown as Mock;
const videoMock = publishPageVideo as unknown as Mock;
const durationMock = readMp4DurationSecondsFromFile as unknown as Mock;
const notifyMock = notifyPublishAttemptFailure as unknown as Mock;

const access = {
  user: { id: "u1" },
  workspace: { id: "ws_1", role: "owner" },
};

const VIDEO_BYTES = Buffer.alloc(64 * 1024, 7);

/**
 * A hand-built multipart body. FormData always stamps a Content-Type on a
 * file part, so the "client sent no type" case needs raw bytes.
 */
function multipartRequest(
  parts: {
    name: string;
    filename?: string;
    body?: Buffer;
    contentType?: string;
  }[]
): Request {
  const boundary = "----videos-route-test";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;
    const type = part.contentType ? `Content-Type: ${part.contentType}\r\n` : "";
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n`
      )
    );
    chunks.push(part.body ?? Buffer.alloc(0));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return new Request("http://localhost/api/videos", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(chunks),
  });
}

/** The happy path: a video part plus whatever else the test needs. */
function videoRequest(extra: Parameters<typeof multipartRequest>[0]) {
  return multipartRequest([
    { name: "title", body: Buffer.from("My video") },
    { name: "pageIds", body: Buffer.from(JSON.stringify(["p1"])) },
    {
      name: "video",
      filename: "clip.mp4",
      body: VIDEO_BYTES,
      contentType: "video/mp4",
    },
    ...extra,
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireMock.mockResolvedValue({ response: null, context: { access } });
  publishMock.mockImplementation(async ({ publish }) => {
    const result = await publish({
      id: "p1",
      accessToken: "token",
      name: "NeuralVerse",
    });
    return {
      results: [{ page: { id: "p1", name: "NeuralVerse" }, ok: true, ...result }],
    };
  });
  videoMock.mockResolvedValue({ id: "fb_video_1", permalink: null });
  durationMock.mockResolvedValue(30);
  responseMock.mockReturnValue(
    new Response(JSON.stringify({ ok: true }), { status: 201 })
  );
});

describe("POST /api/videos", () => {
  it("ignores an empty thumbnail part", async () => {
    // An <input type="file"> the user never picked still posts a zero-byte
    // part; Facebook rejects a 0-byte image with an opaque error.
    const res = await POST(
      videoRequest([
        {
          name: "thumbnail",
          filename: "thumb.jpg",
          body: Buffer.alloc(0),
          contentType: "image/jpeg",
        },
      ])
    );

    expect(res.status).toBe(201);
    expect(videoMock).toHaveBeenCalledTimes(1);
    expect(videoMock.mock.calls[0][0].thumbnail).toBeNull();
  });

  it("publishes a real thumbnail with its type and filename", async () => {
    const res = await POST(
      videoRequest([
        {
          name: "thumbnail",
          filename: "thumb.png",
          body: Buffer.alloc(128, 3),
          contentType: "image/png",
        },
      ])
    );

    expect(res.status).toBe(201);
    expect(videoMock.mock.calls[0][0].thumbnail).toEqual({
      bytes: Buffer.alloc(128, 3),
      type: "image/png",
      filename: "thumb.png",
    });
  });

  it("accepts a video part that carries no Content-Type header", async () => {
    // busboy reports 'text/plain' for such a part; the filename identifies it.
    const res = await POST(
      multipartRequest([
        { name: "title", body: Buffer.from("My video") },
        { name: "pageIds", body: Buffer.from(JSON.stringify(["p1"])) },
        { name: "video", filename: "clip.mp4", body: VIDEO_BYTES },
      ])
    );

    expect(res.status).toBe(201);
    expect(videoMock.mock.calls[0][0].video).toMatchObject({
      type: "video/mp4",
      filename: "clip.mp4",
    });
  });

  it("rejects a video part whose filename is not a video", async () => {
    const res = await POST(
      multipartRequest([
        { name: "title", body: Buffer.from("My video") },
        { name: "pageIds", body: Buffer.from(JSON.stringify(["p1"])) },
        { name: "video", filename: "clip.mkv", body: VIDEO_BYTES },
      ])
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Upload an MP4 or MOV video.");
    expect(videoMock).not.toHaveBeenCalled();
    // A rejected video rings the bell like any other failed post attempt.
    expect(notifyMock).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      kind: "video",
      reason: "Upload an MP4 or MOV video.",
    });
  });

  it("rejects a thumbnail that is not an image", async () => {
    const res = await POST(
      videoRequest([
        {
          name: "thumbnail",
          filename: "thumb.pdf",
          body: Buffer.alloc(128, 3),
          contentType: "application/pdf",
        },
      ])
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Thumbnails must be JPEG, PNG, or WebP."
    );
    expect(videoMock).not.toHaveBeenCalled();
  });

  it("rejects a body that is not multipart", async () => {
    const res = await POST(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "not an upload" }),
      })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Choose an MP4 or MOV video.");
    expect(videoMock).not.toHaveBeenCalled();
  });
});
