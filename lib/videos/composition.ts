export const COMPOSITION_WIDTH = 1920;
export const COMPOSITION_HEIGHT = 1080;
export const MIN_AVATAR_WIDTH = 0.12;
export const DEFAULT_ORIGINAL_AUDIO_VOLUME = 0.25;

export type AvatarPlacement = {
  x: number;
  y: number;
  width: number;
};

export type AvatarPlacementPreset =
  | "lower-right"
  | "lower-left"
  | "center"
  | "full-width";

export const DEFAULT_AVATAR_PLACEMENT: AvatarPlacement = {
  x: 0.63,
  y: 0.63,
  width: 0.34,
};

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function avatarPlacementHeight(
  placement: AvatarPlacement,
  avatarAspect: number,
): number {
  const aspect = finiteOr(avatarAspect, 16 / 9);
  if (aspect <= 0) return placement.width;
  return (placement.width * COMPOSITION_WIDTH) / aspect / COMPOSITION_HEIGHT;
}

export function clampAvatarPlacement(
  placement: AvatarPlacement,
  avatarAspect: number,
): AvatarPlacement {
  const aspect = Math.max(0.01, finiteOr(avatarAspect, 16 / 9));
  const maxWidth = Math.min(1, (aspect * COMPOSITION_HEIGHT) / COMPOSITION_WIDTH);
  const width = Math.max(
    Math.min(MIN_AVATAR_WIDTH, maxWidth),
    Math.min(maxWidth, finiteOr(placement.width, DEFAULT_AVATAR_PLACEMENT.width)),
  );
  const height = avatarPlacementHeight({ ...placement, width }, aspect);
  return {
    x: Math.max(0, Math.min(1 - width, finiteOr(placement.x, 0))),
    y: Math.max(0, Math.min(1 - height, finiteOr(placement.y, 0))),
    width,
  };
}

export function moveAvatarPlacement(
  placement: AvatarPlacement,
  deltaX: number,
  deltaY: number,
  avatarAspect: number,
): AvatarPlacement {
  return clampAvatarPlacement(
    {
      ...placement,
      x: placement.x + finiteOr(deltaX, 0),
      y: placement.y + finiteOr(deltaY, 0),
    },
    avatarAspect,
  );
}

export function resizeAvatarPlacement(
  placement: AvatarPlacement,
  width: number,
  avatarAspect: number,
): AvatarPlacement {
  return clampAvatarPlacement({ ...placement, width }, avatarAspect);
}

export function avatarPlacementPixels(
  placement: AvatarPlacement,
  avatarAspect: number,
  canvasWidth = COMPOSITION_WIDTH,
  canvasHeight = COMPOSITION_HEIGHT,
): { x: number; y: number; width: number; height: number } {
  const safe = clampAvatarPlacement(placement, avatarAspect);
  const height = avatarPlacementHeight(safe, avatarAspect);
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return {
    x: even(safe.x * canvasWidth),
    y: even(safe.y * canvasHeight),
    width: Math.min(even(canvasWidth), even(safe.width * canvasWidth)),
    height: Math.min(even(canvasHeight), even(height * canvasHeight)),
  };
}

export function avatarPlacementPreset(
  preset: AvatarPlacementPreset,
  avatarAspect: number,
): AvatarPlacement {
  if (preset === "full-width") {
    return clampAvatarPlacement({ x: 0, y: 0, width: 1 }, avatarAspect);
  }
  if (preset === "center") {
    const width = 0.34;
    const height = avatarPlacementHeight({ x: 0, y: 0, width }, avatarAspect);
    return clampAvatarPlacement(
      { x: (1 - width) / 2, y: (1 - height) / 2, width },
      avatarAspect,
    );
  }
  const width = 0.34;
  const height = avatarPlacementHeight({ x: 0, y: 0, width }, avatarAspect);
  return clampAvatarPlacement(
    {
      x: preset === "lower-right" ? 1 - width - 0.03 : 0.03,
      y: 1 - height - 0.03,
      width,
    },
    avatarAspect,
  );
}

export function clampOriginalAudioVolume(value: number): number {
  return Math.max(0, Math.min(1, finiteOr(value, DEFAULT_ORIGINAL_AUDIO_VOLUME)));
}
