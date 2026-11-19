import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMock, delMock, headMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  delMock: vi.fn(),
  headMock: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  list: listMock,
  del: delMock,
  head: headMock,
}));

import { deleteStagedBlobsInFolder, stagedFileExtension } from "./storage";

const STORE = "https://store.public.blob.vercel-storage.com";
const RECORDED = `${STORE}/downloads/ws-1/job-1/clip.mp4`;
const SUPERSEDED = `${STORE}/downloads/ws-1/job-1/clip 2.mp4`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STORAGE_DRIVER", "blob");
  vi.stubEnv("NEXT_PUBLIC_STORAGE_DRIVER", "blob");
  delMock.mockResolvedValue(undefined);
  listMock.mockResolvedValue({ blobs: [], hasMore: false });
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
