export const MEDIA_REJECTED_BEFORE_GRAPH = "media_rejected_before_graph" as const;

type AvatarCompositePublishFailure = {
  status: number;
  code: unknown;
  avatarJobId: string | null;
  mediaUrl: string | null;
  sourceAvatarUrl: string | null;
};

export function shouldDeleteAvatarCompositeAfterPublishFailure({
  status,
  code,
  avatarJobId,
  mediaUrl,
  sourceAvatarUrl,
}: AvatarCompositePublishFailure): boolean {
  if (!avatarJobId || !mediaUrl || mediaUrl === sourceAvatarUrl) return false;
  return (
    (status === 400 && code === MEDIA_REJECTED_BEFORE_GRAPH) ||
    (status === 409 && code === "avatar_unavailable")
  );
}
