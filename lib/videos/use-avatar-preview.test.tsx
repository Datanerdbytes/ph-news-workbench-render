// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAvatarPreview } from "./use-avatar-preview";

const { prepareMock } = vi.hoisted(() => ({
  prepareMock: vi.fn(),
}));

vi.mock("./avatar-video", () => ({
  prepareAvatarVideoSource: prepareMock,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let revokeObjectURL: ReturnType<typeof vi.fn>;
let originalRevokeObjectURL: PropertyDescriptor | undefined;

beforeEach(() => {
  prepareMock.mockReset();
  originalRevokeObjectURL = Object.getOwnPropertyDescriptor(
    URL,
    "revokeObjectURL",
  );
  revokeObjectURL = vi.fn();
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL,
  });
});

afterEach(() => {
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
  } else {
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  }
});

describe("useAvatarPreview", () => {
  it("does not expose a remote source until validation completes", async () => {
    prepareMock.mockResolvedValue({ url: "blob:validated", owned: true });
    const { result, unmount } = renderHook(() =>
      useAvatarPreview("https://storage.example/avatar.mp4"),
    );

    expect(result.current).toEqual({ url: null, error: null, loading: true });
    await waitFor(() => expect(result.current.url).toBe("blob:validated"));
    expect(result.current.loading).toBe(false);

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:validated");
  });

  it("does not revoke an existing blob URL it does not own", async () => {
    prepareMock.mockResolvedValue({ url: "blob:existing", owned: false });
    const { result, unmount } = renderHook(() =>
      useAvatarPreview("blob:existing"),
    );

    await waitFor(() => expect(result.current.url).toBe("blob:existing"));
    unmount();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("ignores stale completions and revokes their owned URLs", async () => {
    const first = deferred<{ url: string; owned: boolean }>();
    const second = deferred<{ url: string; owned: boolean }>();
    prepareMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      ({ source }) => useAvatarPreview(source),
      { initialProps: { source: "https://storage.example/first.mp4" } },
    );

    rerender({ source: "https://storage.example/second.mp4" });
    await act(async () => {
      second.resolve({ url: "blob:second", owned: true });
    });
    await waitFor(() => expect(result.current.url).toBe("blob:second"));

    await act(async () => {
      first.resolve({ url: "blob:first", owned: true });
    });
    expect(result.current.url).toBe("blob:second");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:second");
  });

  it("surfaces validation failures without a playable source", async () => {
    prepareMock.mockRejectedValue(new Error("The avatar source is not supported."));
    const { result } = renderHook(() =>
      useAvatarPreview("https://storage.example/avatar.mp4"),
    );

    await waitFor(() =>
      expect(result.current.error).toBe("The avatar source is not supported."),
    );
    expect(result.current.url).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("does not start a load without a source", () => {
    const { result } = renderHook(() => useAvatarPreview(null));

    expect(result.current).toEqual({ url: null, error: null, loading: false });
    expect(prepareMock).not.toHaveBeenCalled();
  });
});
