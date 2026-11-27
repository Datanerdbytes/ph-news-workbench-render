import { describe, expect, it } from "vitest";
import {
  AVATARS,
  DEFAULT_AVATAR_ID,
  getAvatar,
  isAvatarId,
} from "./avatars";

const PHOTO_AVATAR_IDS = [
  "leonie",
  "leonie-professional",
  "george",
  "marcel",
  "adrian",
  "amara",
  "amira",
  "anika",
  "bianca",
  "camila",
  "carlos",
  "clara",
  "darius",
  "diego",
  "elise",
  "farhan",
  "faris",
  "gabrielle",
  "hyejin",
  "imran",
  "isabella",
  "layla",
  "liwei",
  "ling",
  "marcus",
  "matteo",
  "rahul",
  "rana",
  "ren",
  "riya",
  "sakura",
  "simone",
  "zayd",
  "zoe",
] as const;

describe("avatar catalog", () => {
  it("includes every documented photo avatar", () => {
    expect(
      AVATARS.filter((avatar) => avatar.kind === "photo").map((avatar) => avatar.id),
    ).toEqual(PHOTO_AVATAR_IDS);
  });

  it("marks only vasa-2 avatars as real-time previews", () => {
    const photoAvatars = AVATARS.filter((avatar) => avatar.kind === "photo");
    expect(
      photoAvatars.filter((avatar) => avatar.preview).map((avatar) => avatar.id),
    ).toEqual(["leonie", "leonie-professional", "george", "marcel"]);
    expect(
      photoAvatars.filter((avatar) => avatar.baseModel === "vasa-1"),
    ).toHaveLength(30);
  });

  it("keeps avatar ids and provider characters unique", () => {
    expect(new Set(AVATARS.map((avatar) => avatar.id)).size).toBe(AVATARS.length);
    expect(new Set(AVATARS.map((avatar) => avatar.character)).size).toBe(
      AVATARS.length,
    );
  });
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
    expect(getAvatar("anika")).toMatchObject({
      id: "anika",
      kind: "photo",
      baseModel: "vasa-1",
    });
    expect(getAvatar("leonie-professional")).toMatchObject({
      id: "leonie-professional",
      kind: "photo",
      baseModel: "vasa-2",
      preview: true,
    });
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
