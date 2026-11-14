import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupParsedMultipart,
  fileUploadInit,
  MultipartParseError,
  MultipartTooLargeError,
  parseMultipartToDisk,
  uploadedFileType,
} from "./media-file";

function multipartRequest(form: FormData): Request {
  // Node's undici serializes FormData bodies as proper multipart/form-data.
  return new Request("http://localhost/test", { method: "POST", body: form });
}

/**
 * A hand-built multipart body: FormData always stamps a Content-Type on a
 * file part, so the "client sent no type" case needs raw bytes.
 */
function rawMultipartRequest(
  parts: {
    name: string;
    filename?: string;
    body: string;
    contentType?: string;
  }[]
): Request {
  const boundary = "----opencode-test-boundary";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;
    const type = part.contentType ? `Content-Type: ${part.contentType}\r\n` : "";
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n${part.body}\r\n`
      )
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(chunks),
  });
}

describe("parseMultipartToDisk", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "media-file-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("spools file parts to disk and keeps small parts in memory", async () => {
    const videoBytes = Buffer.alloc(1024 * 1024, 7); // 1 MB of filler
    const thumbBytes = Buffer.from("thumbnail-bytes");
    const form = new FormData();
    form.append("title", "My video");
    form.append("video", new File([videoBytes], "clip.mp4", { type: "video/mp4" }));
    form.append("thumbnail", new File([thumbBytes], "thumb.jpg", { type: "image/jpeg" }));
    form.append("mystery", new File(["ignored"], "unknown.bin"));

    const parsed = await parseMultipartToDisk(
      multipartRequest(form),
      {
        video: { maxBytes: 1024 * 1024 * 1024, spool: "file" },
        thumbnail: { maxBytes: 1024 * 1024, spool: "memory" },
      }
    );

    try {
      expect(parsed.fields.title).toBe("My video");

      const video = parsed.files.video;
      expect(video?.kind).toBe("file");
      if (video?.kind !== "file") return;
      expect(video.size).toBe(videoBytes.length);
      expect(video.type).toBe("video/mp4");
      expect(video.filename).toBe("clip.mp4");
      expect(video.path.startsWith(tmpdir())).toBe(true);
      await expect(readFile(video.path)).resolves.toEqual(videoBytes);
      await expect(stat(video.path)).resolves.toMatchObject({ size: videoBytes.length });

      const thumbnail = parsed.files.thumbnail;
      expect(thumbnail?.kind).toBe("buffer");
      if (thumbnail?.kind !== "buffer") return;
      expect(thumbnail.buffer).toEqual(thumbBytes);
      expect(thumbnail.type).toBe("image/jpeg");

      // Unknown parts are drained, not captured.
      expect(parsed.files.mystery).toBeUndefined();
    } finally {
      await cleanupParsedMultipart(parsed);
    }
  });

  it("rejects a part over its cap and names the part", async () => {
    const form = new FormData();
    form.append("video", new File([Buffer.alloc(64)], "clip.mp4", { type: "video/mp4" }));

    await expect(
      parseMultipartToDisk(multipartRequest(form), {
        video: { maxBytes: 32, spool: "file" },
      })
    ).rejects.toMatchObject({
      name: "MultipartTooLargeError",
      part: "video",
      maxBytes: 32,
    });
  });

  it("rejects a memory-spool part over its cap", async () => {
    const form = new FormData();
    form.append("photo", new File([Buffer.alloc(64)], "p.jpg", { type: "image/jpeg" }));

    await expect(
      parseMultipartToDisk(multipartRequest(form), {
        photo: { maxBytes: 16, spool: "memory" },
      })
    ).rejects.toBeInstanceOf(MultipartTooLargeError);
  });

  it("rejects non-multipart bodies", async () => {
    await expect(
      parseMultipartToDisk(
        new Request("http://localhost/test", {
          method: "POST",
          body: "plain text",
        }),
        { video: { maxBytes: 1024, spool: "file" } }
      )
    ).rejects.toBeInstanceOf(MultipartParseError);
  });

  it("rejects an empty body", async () => {
    await expect(
      parseMultipartToDisk(
        new Request("http://localhost/test", { method: "POST" }),
        { video: { maxBytes: 1024, spool: "file" } }
      )
    ).rejects.toBeInstanceOf(MultipartParseError);
  });

  it("keeps a part with no Content-Type resolvable by filename", async () => {
    const parsed = await parseMultipartToDisk(
      rawMultipartRequest([
        { name: "video", filename: "clip.mp4", body: "video-bytes" },
      ]),
      { video: { maxBytes: 1024, spool: "file" } }
    );

    try {
      const video = parsed.files.video;
      expect(video?.kind).toBe("file");
      if (video?.kind !== "file") return;
      // busboy reports the generic default for a part with no type header.
      expect(video.type).toBe("text/plain");
      // The filename still identifies the upload, as request.formData() did.
      expect(uploadedFileType(video)).toBe("video/mp4");
    } finally {
      await cleanupParsedMultipart(parsed);
    }
  });
});

describe("uploadedFileType", () => {
  it("trusts the declared type", () => {
    expect(
      uploadedFileType({
        kind: "file",
        path: "/tmp/video",
        size: 1,
        type: "video/quicktime",
        filename: "clip.mov",
      })
    ).toBe("video/quicktime");
  });

  it("falls back to the filename when the client sent no type", () => {
    expect(
      uploadedFileType({
        kind: "buffer",
        buffer: Buffer.alloc(1),
        type: "text/plain",
        filename: "clip.mp4",
      })
    ).toBe("video/mp4");
    expect(
      uploadedFileType({
        kind: "buffer",
        buffer: Buffer.alloc(1),
        type: "text/plain",
        filename: "CLIP.MOV",
      })
    ).toBe("video/quicktime");
    expect(
      uploadedFileType({
        kind: "buffer",
        buffer: Buffer.alloc(1),
        type: "text/plain",
        filename: "photo.jpg",
      })
    ).toBe("image/jpeg");
  });

  it("returns an empty type for an unknown extension", () => {
    expect(
      uploadedFileType({
        kind: "buffer",
        buffer: Buffer.alloc(1),
        type: "text/plain",
        filename: "clip.mkv",
      })
    ).toBe("");
  });
});

describe("fileUploadInit", () => {
  let server: Server;
  let seen: {
    contentLength: string | undefined;
    contentType: string | undefined;
    body: Buffer;
  } | null = null;

  beforeEach(async () => {
    seen = null;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        seen = {
          contentLength: req.headers["content-length"],
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks),
        };
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it("streams a file body with an exact content-length (no chunked encoding)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "upload-wire-test-"));
    try {
      const payload = Buffer.alloc(512 * 1024, 42);
      const filePath = path.join(dir, "video.mp4");
      await writeFile(filePath, payload);

      const port = (server.address() as AddressInfo).port;
      const response = await fetch(
        `http://127.0.0.1:${port}/upload`,
        fileUploadInit(filePath, payload.length, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
        })
      );
      expect(response.ok).toBe(true);

      expect(seen).not.toBeNull();
      expect(seen!.contentLength).toBe(String(payload.length));
      expect(seen!.contentType).toBe("application/octet-stream");
      expect(seen!.body).toEqual(payload);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
