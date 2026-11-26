import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listMock, delMock, headMock, putMock, s3SendMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  delMock: vi.fn(),
  headMock: vi.fn(),
  putMock: vi.fn(),
  s3SendMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-s3")>()),
  S3Client: class {
    send = s3SendMock;
  },
}));

vi.mock("@vercel/blob", () => ({
  list: listMock,
  del: delMock,
  head: headMock,
  put: putMock,
}));

import {
  assertStagedBlob,
  deleteStagedBlobsInFolder,
  getManagedStoragePublicOrigin,
  openStagedBlob,
  stageServerFile,
  stagedFileExtension,
} from "./storage";

const STORE = "https://store.public.blob.vercel-storage.com";
const RECORDED = `${STORE}/downloads/ws-1/job-1/clip.mp4`;
const SUPERSEDED = `${STORE}/downloads/ws-1/job-1/clip 2.mp4`;
const tempDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STORAGE_DRIVER", "blob");
  vi.stubEnv("NEXT_PUBLIC_STORAGE_DRIVER", "blob");
  delMock.mockResolvedValue(undefined);
  listMock.mockResolvedValue({ blobs: [], hasMore: false });
  s3SendMock.mockResolvedValue({});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("getManagedStoragePublicOrigin", () => {
  it("returns only the normalized origin for the active s3 driver", () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("S3_PUBLIC_BASE", "https://media.example.com/bucket/path/");

    expect(getManagedStoragePublicOrigin()).toBe("https://media.example.com");
  });

  it("returns null for the blob and hf drivers", () => {
    vi.stubEnv("S3_PUBLIC_BASE", "https://media.example.com/bucket/");
    expect(getManagedStoragePublicOrigin()).toBeNull();

    vi.stubEnv("STORAGE_DRIVER", "hf");
    expect(getManagedStoragePublicOrigin()).toBeNull();
  });

  it.each([
    "",
    "not a url",
    "ftp://media.example.com/bucket/",
    "https://user:pass@media.example.com/bucket/",
    "https://media.example.com/bucket/?token=secret",
    "https://media.example.com/bucket/#fragment",
  ])("rejects an invalid public base: %s", (value) => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("S3_PUBLIC_BASE", value);

    expect(getManagedStoragePublicOrigin()).toBeNull();
  });
});

describe("assertStagedBlob", () => {
  it("removes a configured s3 base path from the object key", async () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("S3_PUBLIC_BASE", "https://media.example.com/bucket/path/");
    vi.stubEnv("S3_BUCKET", "workbench");
    vi.stubEnv("S3_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "test-secret");

    await assertStagedBlob(
      "https://media.example.com/bucket/path/avatars/job-1/avatar%20video.mp4",
    );

    expect(s3SendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: "workbench",
          Key: "avatars/job-1/avatar video.mp4",
        }),
      }),
    );
  });

  it.each([
    "https://media.example.com/bucket/path-other/avatars/job-1/avatar.mp4",
    "https://media.example.com.evil.test/bucket/path/avatars/job-1/avatar.mp4",
    "https://user:pass@media.example.com/bucket/path/avatars/job-1/avatar.mp4",
    "https://media.example.com/bucket/path/avatars/job-1/avatar.mp4?token=secret",
    "https://media.example.com/bucket/path/avatars/job-1/avatar.mp4#fragment",
  ])("rejects a url outside the exact s3 base: %s", async (url) => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("S3_PUBLIC_BASE", "https://media.example.com/bucket/path/");
    vi.stubEnv("S3_BUCKET", "workbench");
    vi.stubEnv("S3_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "test-secret");

    await expect(assertStagedBlob(url)).rejects.toThrow(
      "The staged URL does not belong to this app.",
    );
    expect(s3SendMock).not.toHaveBeenCalled();
  });
});

describe("openStagedBlob", () => {
  const HF_URL =
    "https://huggingface.co/datasets/owner/staging/resolve/main/avatars/job-1/avatar.mp4";

  function configureHf() {
    vi.stubEnv("STORAGE_DRIVER", "hf");
    vi.stubEnv("NEXT_PUBLIC_STORAGE_DRIVER", "hf");
    vi.stubEnv("HF_STAGING_REPO", "owner/staging");
    vi.stubEnv("HF_TOKEN", "test-token");
  }

  it("follows a private Hugging Face CDN redirect without forwarding its token", async () => {
    configureHf();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn-lfs.huggingface.co/avatar.mp4" },
        }),
      )
      .mockResolvedValueOnce(new Response("video"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await openStagedBlob(HF_URL);

    expect(await response.text()).toBe("video");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      HF_URL,
      expect.objectContaining({ method: "HEAD", redirect: "manual" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      HF_URL,
      expect.objectContaining({
        headers: { Authorization: "Bearer test-token" },
        redirect: "manual",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://cdn-lfs.huggingface.co/avatar.mp4",
      expect.objectContaining({ headers: {}, redirect: "manual" }),
    );
  });

  it.each([
    "https://evil.example/avatar.mp4",
    "http://cdn-lfs.huggingface.co/avatar.mp4",
    "https://user:pass@cdn-lfs.huggingface.co/avatar.mp4",
  ])("rejects an untrusted Hugging Face redirect: %s", async (location) => {
    configureHf();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302 }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(openStagedBlob(HF_URL)).rejects.toThrow(
      "The staged file redirect is not allowed.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a cross-origin redirect from managed blob storage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/avatar.mp4" },
        }),
      ),
    );

    await expect(openStagedBlob(RECORDED)).rejects.toThrow(
      "The staged file redirect is not allowed.",
    );
  });

  it("allows only same-origin redirects from managed s3 storage", async () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("S3_PUBLIC_BASE", "https://media.example.com/bucket");
    vi.stubEnv("S3_BUCKET", "workbench");
    vi.stubEnv("S3_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "test-secret");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://media.example.com/bucket/avatar.mp4" },
        }),
      )
      .mockResolvedValueOnce(new Response("video"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await openStagedBlob(
      "https://media.example.com/bucket/avatars/job-1/avatar.mp4",
    );

    expect(await response.text()).toBe("video");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops after too many redirects", async () => {
    configureHf();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302 }))
      .mockImplementation(async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://huggingface.co/datasets/owner/staging/next" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(openStagedBlob(HF_URL)).rejects.toThrow(
      "The staged file redirected too many times.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });
});

describe("stagedFileExtension", () => {
  it("reads the extension from an s3/hf key with the random suffix appended", () => {
    // stagedKey() appends "-<uuid8>" AFTER the pathname, so the raw
    // extension is ".mov-a1b2c3d4" until the suffix is stripped.
    expect(
      stagedFileExtension("https://cdn.example.com/reels/1712345678-clip.mov-a1b2c3d4")
    ).toBe(".mov");
    expect(
      stagedFileExtension("https://cdn.example.com/reels/1712345678-clip.mp4-a1b2c3d4")
    ).toBe(".mp4");
  });

  it("reads the extension from a blob url with the suffix before it", () => {
    expect(
      stagedFileExtension(
        "https://store.public.blob.vercel-storage.com/reels/1712345678-clip-Xy9.mp4"
      )
    ).toBe(".mp4");
  });

  it("returns an empty extension when there is none", () => {
    expect(stagedFileExtension("https://cdn.example.com/reels/clip-a1b2c3d4")).toBe("");
    expect(stagedFileExtension("https://cdn.example.com/reels/clip.mp4")).toBe(".mp4");
  });

  it("lowercases the extension", () => {
    expect(
      stagedFileExtension("https://cdn.example.com/reels/clip.MOV-a1b2c3d4")
    ).toBe(".mov");
  });
});

describe("stageServerFile", () => {
  async function tempFile(contents = "video") {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stage-server-test-"));
    tempDirs.push(dir);
    const file = path.join(dir, "avatar.mp4");
    await writeFile(file, contents);
    return file;
  }

  it("streams a server file to Blob with a unique key and the supplied limits", async () => {
    const file = await tempFile();
    const controller = new AbortController();
    putMock.mockImplementation(
      async (key: string, stream: AsyncIterable<Buffer>) => {
        let size = 0;
        for await (const chunk of stream) size += chunk.byteLength;
        expect(size).toBe(5);
        return { url: `${STORE}/${key}`, pathname: key };
      },
    );

    const result = await stageServerFile(
      "avatars/ws-1/job-1/avatar.mp4",
      file,
      "video/mp4",
      1024,
      controller.signal,
    );

    const [key, stream, options] = putMock.mock.calls[0];
    expect(key).toMatch(/^avatars\/ws-1\/job-1\/avatar-[0-9a-f]{8}\.mp4$/);
    expect(stream).toBeDefined();
    expect(options).toEqual({
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
      multipart: true,
      abortSignal: controller.signal,
    });
    expect(result).toEqual({
      url: `${STORE}/${key}`,
      pathname: key,
      contentType: "video/mp4",
    });
  });

  it.each([
    "../avatar.mp4",
    "/avatar.mp4",
    "avatars//avatar.mp4",
    "avatars/avatar clip.mp4",
  ])("rejects an invalid staging path before upload: %s", async (pathname) => {
    await expect(
      stageServerFile(pathname, "/missing/avatar.mp4", "video/mp4"),
    ).rejects.toThrow("The staged upload path is invalid.");
    expect(putMock).not.toHaveBeenCalled();
  });

  it("rejects empty and oversized files before upload", async () => {
    const empty = await tempFile("");
    const oversized = await tempFile("large");

    await expect(
      stageServerFile("avatars/empty.mp4", empty, "video/mp4"),
    ).rejects.toThrow("The staged upload has an invalid file size.");
    await expect(
      stageServerFile("avatars/large.mp4", oversized, "video/mp4", 2),
    ).rejects.toThrow("The staged upload has an invalid file size.");
    expect(putMock).not.toHaveBeenCalled();
  });

  it("rejects a directory instead of a file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stage-server-test-"));
    tempDirs.push(dir);

    await expect(
      stageServerFile("avatars/directory.mp4", dir, "video/mp4"),
    ).rejects.toThrow("The staged upload has an invalid file size.");
    expect(putMock).not.toHaveBeenCalled();
  });
});

describe("deleteStagedBlobsInFolder", () => {
  it("deletes every blob that sits in the folder of the given url", async () => {
    listMock.mockResolvedValue({
      blobs: [
        { url: RECORDED, pathname: "downloads/ws-1/job-1/clip.mp4" },
        { url: SUPERSEDED, pathname: "downloads/ws-1/job-1/clip 2.mp4" },
      ],
      hasMore: false,
    });

    await deleteStagedBlobsInFolder([RECORDED]);

    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "downloads/ws-1/job-1/" })
    );
    expect(delMock).toHaveBeenCalledWith([RECORDED, SUPERSEDED]);
  });

  it("deletes all attempt folders for a completed download", async () => {
    const current = `${STORE}/downloads/ws-1/job-1/attempt-2/clip.mp4`;
    listMock.mockResolvedValue({ blobs: [{ url: SUPERSEDED }, { url: current }], hasMore: false });
    await deleteStagedBlobsInFolder([current]);
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ prefix: "downloads/ws-1/job-1/" }));
    expect(delMock).toHaveBeenCalledWith([current, SUPERSEDED]);
  });

  it("still deletes the recorded file when the folder cannot be listed", async () => {
    listMock.mockRejectedValue(new Error("the store is unreachable"));

    await deleteStagedBlobsInFolder([RECORDED]);

    expect(delMock).toHaveBeenCalledWith([RECORDED]);
  });

  it("does nothing without urls", async () => {
    await deleteStagedBlobsInFolder([]);

    expect(listMock).not.toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
  });
});
