import { describe, expect, it } from "vitest";
import { stagedFileExtension } from "./storage";

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
