import { describe, expect, it } from "vitest";
import {
  AVATARS,
  DEFAULT_AVATAR_ID,
  getAvatar,
  isAvatarId,
  supportsAvatarTransparency,
} from "./avatars";

const FULL_BODY_AVATAR_IDS = [
  "meg-formal",
  "max-business",
  "rowan",
  "celine",
  "nia",
  "malik",
  "harry-business",
  "harry-casual",
  "harry-youthful",
  "lisa-casual-sitting",
  "lisa-business-sitting",
  "lisa-business-standing",
  "lisa-coach-sitting",
  "lisa-coach-standing",
  "lori-casual",
  "lori-graceful",
  "lori-formal",
  "max-casual",
  "max-formal",
  "meg-casual",
  "meg-business",
] as const;

const FULL_BODY_PROVIDER_CONFIG = {
  "meg-formal": ["meg", "formal"],
  "max-business": ["max", "business"],
  rowan: ["rowan", null],
  celine: ["celine", null],
  nia: ["nia", null],
  malik: ["malik", null],
  "harry-business": ["harry", "business"],
  "harry-casual": ["harry", "casual"],
  "harry-youthful": ["harry", "youthful"],
  "lisa-casual-sitting": ["lisa", "casual-sitting"],
  "lisa-business-sitting": ["lisa", "business-sitting"],
  "lisa-business-standing": ["lisa", "business-standing"],
  "lisa-coach-sitting": ["lisa", "coach-sitting"],
  "lisa-coach-standing": ["lisa", "coach-standing"],
  "lori-casual": ["lori", "casual"],
  "lori-graceful": ["lori", "graceful"],
  "lori-formal": ["lori", "formal"],
  "max-casual": ["max", "casual"],
  "max-formal": ["max", "formal"],
  "meg-casual": ["meg", "casual"],
  "meg-business": ["meg", "business"],
} as const;

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
  it("includes every currently supported documented full-body avatar", () => {
    expect(
      AVATARS.filter((avatar) => avatar.kind === "video").map((avatar) => avatar.id),
    ).toEqual(FULL_BODY_AVATAR_IDS);
  });

  it("maps every full-body avatar to its documented Azure character and style", () => {
    expect(
      Object.fromEntries(
        AVATARS.filter((avatar) => avatar.kind === "video").map((avatar) => [
          avatar.id,
          [avatar.character, avatar.style],
        ]),
      ),
    ).toEqual(FULL_BODY_PROVIDER_CONFIG);
  });

  it("includes every documented photo avatar", () => {
    expect(
      AVATARS.filter((avatar) => avatar.kind === "photo").map((avatar) => avatar.id),
    ).toEqual(PHOTO_AVATAR_IDS);
  });

  it("marks only batch-supported Lisa variants as full-body previews", () => {
    const fullBodyAvatars = AVATARS.filter((avatar) => avatar.kind === "video");
    expect(
      fullBodyAvatars.filter((avatar) => avatar.preview).map((avatar) => avatar.id),
    ).toEqual([
      "lisa-business-sitting",
      "lisa-business-standing",
      "lisa-coach-sitting",
      "lisa-coach-standing",
    ]);
  });

  it("excludes the Lisa styles scheduled for retirement", () => {
    for (const id of [
      "lisa-graceful-sitting",
      "lisa-graceful-standing",
      "lisa-technical-sitting",
      "lisa-technical-standing",
    ]) {
      expect(isAvatarId(id)).toBe(false);
    }
  });

  it("keeps avatar ids and provider character/style pairs unique", () => {
    expect(new Set(AVATARS.map((avatar) => avatar.id)).size).toBe(AVATARS.length);
    expect(
      new Set(
        AVATARS.map((avatar) => `${avatar.character}:${avatar.style ?? ""}`),
      ).size,
    ).toBe(AVATARS.length);
  });

  it("supports transparent backgrounds only for Meg and Max", () => {
    expect(
      AVATARS.filter(supportsAvatarTransparency).map((avatar) => avatar.id),
    ).toEqual([
      "meg-formal",
      "max-business",
      "max-casual",
      "max-formal",
      "meg-casual",
      "meg-business",
    ]);
    expect(supportsAvatarTransparency(undefined)).toBe(false);
  });
  it("marks only vasa-2 photo avatars as real-time previews", () => {
    const photoAvatars = AVATARS.filter((avatar) => avatar.kind === "photo");
    expect(
      photoAvatars.filter((avatar) => avatar.preview).map((avatar) => avatar.id),
    ).toEqual(["leonie", "leonie-professional", "george", "marcel"]);
    expect(
      photoAvatars.filter((avatar) => avatar.baseModel === "vasa-1"),
    ).toHaveLength(30);
  });

  it("represents documented N/A styles as null", () => {
    expect(
      AVATARS.filter((avatar) => avatar.kind === "video" && avatar.style === null).map(
        (avatar) => avatar.id,
      ),
    ).toEqual(["rowan", "celine", "nia", "malik"]);
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
    expect(getAvatar("rowan")).toMatchObject({
      id: "rowan",
      kind: "video",
      style: null,
    });
    expect(getAvatar("lisa-business-sitting")).toMatchObject({
      id: "lisa-business-sitting",
      kind: "video",
      style: "business-sitting",
      preview: true,
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
