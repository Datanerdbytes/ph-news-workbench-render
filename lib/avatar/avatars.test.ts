import { describe, expect, it } from "vitest";
import {
  AVATARS,
  DEFAULT_AVATAR_ID,
  getAvatar,
  isAvatarId,
} from "./avatars";

describe("avatar catalog", () => {
  it("recognizes only catalog ids", () => {
    expect(isAvatarId("meg-formal")).toBe(true);
    expect(isAvatarId("anika")).toBe(true);
    expect(isAvatarId("not-an-avatar")).toBe(false);
    expect(isAvatarId(undefined)).toBe(false);
    expect(isAvatarId(null)).toBe(false);
  });

  it("returns the catalog entry for a known id", () => {
    expect(getAvatar("max-business")).toMatchObject({
      id: "max-business",
      kind: "video",
      style: "business",
    });
    expect(getAvatar("anika")).toMatchObject({ id: "anika", kind: "photo" });
  });

  it("falls back to the first catalog entry for an unknown id", () => {
    expect(getAvatar("not-an-avatar")).toBe(AVATARS[0]);
    expect(getAvatar(undefined)).toBe(AVATARS[0]);
  });

  it("defaults to an avatar that exists in the catalog", () => {
    expect(isAvatarId(DEFAULT_AVATAR_ID)).toBe(true);
    expect(getAvatar(DEFAULT_AVATAR_ID).id).toBe(DEFAULT_AVATAR_ID);
  });
});
