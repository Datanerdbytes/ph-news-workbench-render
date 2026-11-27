import { describe, expect, it } from "vitest";
import {
  DEFAULT_AVATAR_PLACEMENT,
  avatarPlacementHeight,
  avatarPlacementPixels,
  avatarPlacementPreset,
  clampAvatarPlacement,
  clampOriginalAudioVolume,
  moveAvatarPlacement,
  resizeAvatarPlacement,
} from "./composition";

describe("avatar composition geometry", () => {
  it("keeps the default lower-right placement inside 16:9", () => {
    const placement = clampAvatarPlacement(DEFAULT_AVATAR_PLACEMENT, 16 / 9);
    expect(placement.x + placement.width).toBeLessThanOrEqual(1);
    expect(placement.y + avatarPlacementHeight(placement, 16 / 9)).toBeLessThanOrEqual(1);
  });

  it("clamps invalid coordinates and oversized avatars", () => {
    const placement = clampAvatarPlacement(
      { x: -4, y: 8, width: 3 },
      16 / 9,
    );
    expect(placement).toEqual({ x: 0, y: 0, width: 1 });
  });

  it("limits width for tall avatar aspect ratios", () => {
    const placement = clampAvatarPlacement(
      { x: 0, y: 0, width: 1 },
      0.5,
    );
    expect(placement.width).toBeCloseTo(0.28125);
    expect(avatarPlacementHeight(placement, 0.5)).toBeCloseTo(1);
  });

  it("moves without allowing the avatar to leave the canvas", () => {
    const moved = moveAvatarPlacement(DEFAULT_AVATAR_PLACEMENT, 10, 10, 16 / 9);
    expect(moved.x).toBeCloseTo(0.66);
    expect(moved.y).toBeCloseTo(0.66);
    expect(moved.width).toBe(0.34);
    expect(
      moveAvatarPlacement(DEFAULT_AVATAR_PLACEMENT, -10, -10, 16 / 9),
    ).toEqual({ x: 0, y: 0, width: 0.34 });
  });

  it("resizes while preserving the top-left position when possible", () => {
    expect(
      resizeAvatarPlacement(DEFAULT_AVATAR_PLACEMENT, 0.5, 16 / 9),
    ).toEqual({ x: 0.5, y: 0.5, width: 0.5 });
  });

  it("returns even pixel dimensions inside the canvas", () => {
    const pixels = avatarPlacementPixels(
      { x: 0.333, y: 0.777, width: 0.345 },
      16 / 9,
    );
    expect(pixels.x % 2).toBe(0);
    expect(pixels.y % 2).toBe(0);
    expect(pixels.width % 2).toBe(0);
    expect(pixels.height % 2).toBe(0);
    expect(pixels.x + pixels.width).toBeLessThanOrEqual(1920);
    expect(pixels.y + pixels.height).toBeLessThanOrEqual(1080);
  });

  it("derives the avatar box from the canvas it is drawn on", () => {
    // A portrait 1080x1920 canvas must not assume the fixed 1920x1080
    // composition: a half-width 16:9 avatar is 540x304 pixels there.
    const pixels = avatarPlacementPixels(
      { x: 0, y: 0, width: 0.5 },
      16 / 9,
      1080,
      1920,
    );
    expect(pixels).toEqual({ x: 2, y: 2, width: 540, height: 304 });
  });

  it("keeps the 16:9 geometry unchanged for the default canvas", () => {
    expect(
      avatarPlacementPixels({ x: 0, y: 0, width: 0.5 }, 16 / 9),
    ).toEqual(
      avatarPlacementPixels({ x: 0, y: 0, width: 0.5 }, 16 / 9, 1920, 1080),
    );
    expect(
      avatarPlacementPixels({ x: 0, y: 0, width: 0.5 }, 16 / 9),
    ).toEqual({ x: 2, y: 2, width: 960, height: 540 });
  });

  it("clamps the avatar height against the real canvas height", () => {
    // On a portrait canvas a tall avatar may fill the height, so the
    // placement clamps against 1920 rather than 1080.
    const placement = clampAvatarPlacement(
      { x: 0, y: 0.5, width: 0.3 },
      0.5,
      1080,
      1920,
    );
    const height = avatarPlacementHeight(placement, 0.5, 1080, 1920);
    expect(placement.y + height).toBeLessThanOrEqual(1);
    expect(placement.width).toBeCloseTo(0.3);
  });

  it("provides bounded position presets", () => {
    for (const preset of ["lower-right", "lower-left", "center", "full-width"] as const) {
      const placement = avatarPlacementPreset(preset, 16 / 9);
      expect(placement.x).toBeGreaterThanOrEqual(0);
      expect(placement.y).toBeGreaterThanOrEqual(0);
      expect(placement.x + placement.width).toBeLessThanOrEqual(1);
      expect(
        placement.y + avatarPlacementHeight(placement, 16 / 9),
      ).toBeLessThanOrEqual(1);
    }
  });

  it("clamps original audio volume", () => {
    expect(clampOriginalAudioVolume(-1)).toBe(0);
    expect(clampOriginalAudioVolume(0.25)).toBe(0.25);
    expect(clampOriginalAudioVolume(4)).toBe(1);
    expect(clampOriginalAudioVolume(Number.NaN)).toBe(0.25);
  });
});
