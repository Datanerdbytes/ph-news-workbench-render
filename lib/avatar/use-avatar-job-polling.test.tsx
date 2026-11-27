// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicAvatarJob } from "./jobs";
import { useAvatarJobPolling } from "./use-avatar-job-polling";

function job(overrides: Partial<PublicAvatarJob> = {}): PublicAvatarJob {
  return {
    id: "job-1",
    avatarId: "meg-formal",
    voiceId: "en-PH-RosaNeural",
    speed: 1,
    text: "Hello",
    status: "running",
    statusMessage: "Generating",
    progress: 0.25,
    videoUrl: null,
    outputFormat: "mp4",
    hasAlpha: false,
    durationSeconds: null,
    error: null,
    publishState: "ready",
    createdAt: "2026-11-17T10:00:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
    ...overrides,
  };
}

function response(value: PublicAvatarJob) {
  return new Response(JSON.stringify(value), { status: 200 });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const fetchMock = vi.spyOn(globalThis, "fetch");

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("useAvatarJobPolling", () => {
  it("schedules the next poll only after the previous request settles", async () => {
    const first = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(
      response(job({ status: "completed", progress: 1 })),
    );
    const onJob = vi.fn();
    const onError = vi.fn();
    const { unmount } = renderHook(() =>
      useAvatarJobPolling({ job: job(), onJob, onError }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve(response(job({ progress: 0.5 }))));
    expect(onJob).toHaveBeenCalledWith(job({ progress: 0.5 }));
    await act(async () => vi.advanceTimersByTimeAsync(2_499));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("does not restart the timer when progress changes", async () => {
    fetchMock.mockResolvedValue(response(job({ progress: 0.5 })));
    const onJob = vi.fn();
    const onError = vi.fn();
    const { rerender } = renderHook(
      ({ current }) => useAvatarJobPolling({ job: current, onJob, onError }),
      { initialProps: { current: job() } },
    );

    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    rerender({ current: job({ progress: 0.5 }) });
    await act(async () => vi.advanceTimersByTimeAsync(2_500));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a response that settles after unmount", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const onJob = vi.fn();
    const onError = vi.fn();
    const { unmount } = renderHook(() =>
      useAvatarJobPolling({ job: job(), onJob, onError }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    const signal = fetchMock.mock.calls[0][1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => pending.resolve(response(job({ progress: 0.75 }))));
    expect(onJob).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not poll a terminal job", () => {
    const onJob = vi.fn();
    const onError = vi.fn();
    renderHook(() =>
      useAvatarJobPolling({
        job: job({ status: "completed", progress: 1 }),
        onJob,
        onError,
      }),
    );

    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a polling error and retries on its own schedule", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(response(job({ progress: 0.5 })));
    const onJob = vi.fn();
    const onError = vi.fn();
    renderHook(() => useAvatarJobPolling({ job: job(), onJob, onError }));

    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(onError).toHaveBeenCalledWith("The avatar status could not be refreshed.");
    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onJob).toHaveBeenCalledWith(job({ progress: 0.5 }));
    expect(onError).toHaveBeenLastCalledWith("");
  });
});
