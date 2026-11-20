import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMock, delMock, putMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  delMock: vi.fn(),
  putMock: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  list: listMock,
  del: delMock,
  put: putMock,
}));

import { blobJobPrefix, removeSupersededBlobs, uploadJobVideo } from "./download-worker";

const STORE = "https://store.public.blob.vercel-storage.com";
const UPLOADED = `${STORE}/downloads/ws-1/job-1/new.mp4`;
const SUPERSEDED = `${STORE}/downloads/ws-1/job-1/old.mp4`;

function blob(url: string) {
  return { url, pathname: url.slice(STORE.length + 1) };
}

beforeEach(() => {
  vi.clearAllMocks();
  delMock.mockResolvedValue(undefined);
  putMock.mockResolvedValue({ url: UPLOADED, pathname: "downloads/ws-1/job-1/new.mp4" });
  listMock.mockResolvedValue({ blobs: [], hasMore: false });
});

describe("blobJobPrefix", () => {
  it("gives every job its own folder in the store", () => {
    expect(blobJobPrefix("ws-1", "job-1")).toBe("downloads/ws-1/job-1/");
  });
});

describe("removeSupersededBlobs", () => {
  it("keeps the file that was just uploaded and deletes the superseded ones", async () => {
    listMock.mockResolvedValue({
      blobs: [blob(UPLOADED), blob(SUPERSEDED)],
      hasMore: false,
    });

    await removeSupersededBlobs(blobJobPrefix("ws-1", "job-1"), UPLOADED, 2);

    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "downloads/ws-1/job-1/" })
    );
    expect(delMock).toHaveBeenCalledWith([SUPERSEDED]);
  });

  it("deletes every file in the folder when nothing should be kept", async () => {
    listMock.mockResolvedValue({
      blobs: [blob(UPLOADED), blob(SUPERSEDED)],
      hasMore: false,
    });

    await removeSupersededBlobs(blobJobPrefix("ws-1", "job-1"), null, 2);

    expect(delMock).toHaveBeenCalledWith([UPLOADED, SUPERSEDED]);
  });

  it("walks every page of the folder", async () => {
    listMock
      .mockResolvedValueOnce({ blobs: [blob(UPLOADED)], hasMore: true, cursor: "page-2" })
      .mockResolvedValueOnce({ blobs: [blob(SUPERSEDED)], hasMore: false });

    await removeSupersededBlobs(blobJobPrefix("ws-1", "job-1"), null, 2);

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(listMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "page-2" })
    );
    expect(delMock).toHaveBeenCalledWith([UPLOADED, SUPERSEDED]);
  });

  it("does not delete a newer attempt if it appears during cleanup", async () => {
    const newer = `${STORE}/downloads/ws-1/job-1/attempt-3/clip.mp4`;
    const older = `${STORE}/downloads/ws-1/job-1/attempt-1/clip.mp4`;
    listMock.mockResolvedValue({ blobs: [blob(newer), blob(older)], hasMore: false });
    await removeSupersededBlobs(blobJobPrefix("ws-1", "job-1"), null, 2);
    expect(delMock).toHaveBeenCalledWith([older]);
  });

  it("never throws when the store cannot be listed", async () => {
    listMock.mockRejectedValue(new Error("the store is unreachable"));

    await expect(
      removeSupersededBlobs(blobJobPrefix("ws-1", "job-1"), UPLOADED, 2)
    ).resolves.toBeUndefined();
    expect(delMock).not.toHaveBeenCalled();
  });
});

describe("uploadJobVideo", () => {
  it("uploads into an attempt-specific folder without pruning before ownership is confirmed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ph-blob-upload-"));
    const file = path.join(dir, "clip.mp4");
    await writeFile(file, "video");
    listMock.mockResolvedValue({
      blobs: [blob(UPLOADED), blob(SUPERSEDED)],
      hasMore: false,
    });

    try {
      const result = await uploadJobVideo(blobJobPrefix("ws-1", "job-1"), file, "clip.mp4", 2);

      expect(result.url).toBe(UPLOADED);
      expect(putMock).toHaveBeenCalledTimes(1);
      expect(putMock.mock.calls[0][0]).toBe("downloads/ws-1/job-1/attempt-2/clip.mp4");
      expect(delMock).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
