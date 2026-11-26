export const AVATARS = [
  {
    id: "meg-formal",
    name: "Meg",
    kind: "video",
    style: "formal",
    character: "meg",
    description: "Full body · formal",
  },
  {
    id: "max-business",
    name: "Max",
    kind: "video",
    style: "business",
    character: "max",
    description: "Full body · business",
  },
  {
    id: "anika",
    name: "Anika",
    kind: "photo",
    style: null,
    character: "anika",
    description: "Photo avatar",
  },
  {
    id: "bianca",
    name: "Bianca",
    kind: "photo",
    style: null,
    character: "bianca",
    description: "Photo avatar",
  },
  {
    id: "carlos",
    name: "Carlos",
    kind: "photo",
    style: null,
    character: "carlos",
    description: "Photo avatar",
  },
] as const;

export type Avatar = (typeof AVATARS)[number];
export type AvatarId = Avatar["id"];
export type AvatarKind = Avatar["kind"];

export const DEFAULT_AVATAR_ID: AvatarId = "meg-formal";

export function isAvatarId(value: unknown): value is AvatarId {
  return AVATARS.some((avatar) => avatar.id === value);
}

export function getAvatar(value: unknown): Avatar {
  return AVATARS.find((avatar) => avatar.id === value) ?? AVATARS[0];
}
