import { describe, expect, it } from "vitest";
import {
  avatarMediaExtension,
  avatarMediaType,
  hasAvatarHeader,
} from "./output";

describe("avatar output media", () => {
  it("uses format-specific MIME types and extensions", () => {
    expect(avatarMediaType("mp4")).toBe("video/mp4");
    expect(avatarMediaType("webm")).toBe("video/webm");
    expect(avatarMediaExtension("mp4")).toBe("mp4");
    expect(avatarMediaExtension("webm")).toBe("webm");
  });

  it("validates MP4 and WebM headers without accepting each other", () => {
    const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);

    expect(hasAvatarHeader(mp4, "mp4")).toBe(true);
    expect(hasAvatarHeader(mp4, "webm")).toBe(false);
    expect(hasAvatarHeader(webm, "webm")).toBe(true);
    expect(hasAvatarHeader(webm, "mp4")).toBe(false);
    expect(hasAvatarHeader(new Uint8Array(4), "mp4")).toBe(false);
  });
});
