import { assertStagedBlob, isManagedStagedUrl } from "@/lib/storage";

const COMPOSITE_PATH = "/compose/avatars";

export function isAvatarCompositeUrl(avatarJobId: string, url: string): boolean {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    return pathname.includes(`${COMPOSITE_PATH}/${avatarJobId}/`);
  } catch {
    return false;
  }
}

export async function assertAvatarCompositeUrl(
  avatarJobId: string,
  url: string,
): Promise<void> {
  if (!isAvatarCompositeUrl(avatarJobId, url) || !isManagedStagedUrl(url)) {
    throw new Error("The avatar overlay is not a staged workbench video.");
  }
  await assertStagedBlob(url);
}
