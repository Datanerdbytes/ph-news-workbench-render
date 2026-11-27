import { beforeEach, describe, expect, it, vi } from "vitest";

const { managedMock, assertMock } = vi.hoisted(() => ({
  managedMock: vi.fn(),
  assertMock: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  isManagedStagedUrl: managedMock,
  assertStagedBlob: assertMock,
}));

import { assertAvatarCompositeUrl, isAvatarCompositeUrl } from "./media";

const jobId = "11111111-1111-4111-8111-111111111111";
const compositeUrl = `https://store.example/compose/avatars/${jobId}/avatar-composite.mp4`;

describe("avatar composite media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedMock.mockReturnValue(true);
    assertMock.mockResolvedValue(undefined);
  });

  it("recognizes a composite bound to its source avatar", () => {
    expect(isAvatarCompositeUrl(jobId, compositeUrl)).toBe(true);
    expect(
      isAvatarCompositeUrl(
        jobId,
        `https://store.example/compose/avatars/${jobId}/avatar%2Dcomposite.mp4`,
      ),
    ).toBe(true);
  });

  it("rejects another avatar's composite or a malformed URL", () => {
    expect(
      isAvatarCompositeUrl(
        "22222222-2222-4222-8222-222222222222",
        compositeUrl,
      ),
    ).toBe(false);
    expect(isAvatarCompositeUrl(jobId, "not a url")).toBe(false);
  });

  it("verifies managed storage ownership before accepting a composite", async () => {
    await expect(assertAvatarCompositeUrl(jobId, compositeUrl)).resolves.toBeUndefined();
    expect(managedMock).toHaveBeenCalledWith(compositeUrl);
    expect(assertMock).toHaveBeenCalledWith(compositeUrl);
  });

  it("rejects an unmanaged composite before touching storage", async () => {
    managedMock.mockReturnValue(false);

    await expect(assertAvatarCompositeUrl(jobId, compositeUrl)).rejects.toThrow(
      "not a staged workbench video",
    );
    expect(assertMock).not.toHaveBeenCalled();
  });
});
