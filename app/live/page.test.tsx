// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { PumpStatus } from '@/components/live/source-preview';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/components/assistant-chat', () => ({
  AssistantChat: () => null,
}));
vi.mock('@/components/publishing/media-preview-card', () => ({
  MediaPreviewCard: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  MediaPreviewMedia: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('@/components/publishing/publish-page', () => ({
  PublishPage: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ComposerCard: ({ children, headerRight }: {
    children?: ReactNode;
    headerRight?: ReactNode;
  }) => <section>{headerRight}{children}</section>,
  FieldLabel: ({ htmlFor, children }: {
    htmlFor?: string;
    children?: ReactNode;
  }) => <label htmlFor={htmlFor}>{children}</label>,
  ScheduleField: () => null,
  defaultScheduleValue: () => '2026-11-15T09:00',
  inputClass: '',
  textareaClass: '',
}));

import { toast } from 'sonner';
import LivePage from './page';

function stream(pumpStatus: PumpStatus = 'running', id = 1) {
  return {
    id,
    facebookVideoId: `video-${id}`,
    title: 'News briefing',
    description: 'The latest news',
    status: 'UNPUBLISHED',
    streamKey: null,
    secureStreamUrl: null,
    permalink: null,
    plannedStartTime: null,
    createdAt: '2026-11-14T08:00:00Z',
    sourceUrl: 'https://example.com/news.mp4',
    sourceMode: 'direct',
    pumpStatus,
    pumpStartedAt: '2026-11-14T08:01:00Z',
    pumpError: pumpStatus === 'failed' ? 'Runner could not open the source.' : null,
  };
}

function response(streams: ReturnType<typeof stream>[]) {
  return Response.json({ streams });
}

const fetchMock = vi.fn<typeof fetch>();

async function flush() {
  await act(async () => {});
}

async function advance(ms = 5_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('live pump status refresh', () => {
  it('shows a runner failure after Go live without reloading or disturbing edits', async () => {
    let resolvePoll!: (value: Response) => void;
    fetchMock
      .mockResolvedValueOnce(response([stream('idle')]))
      .mockResolvedValueOnce(Response.json({
        pump: { status: 'running', startedAt: '2026-11-14T08:01:00Z' },
      }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
    render(<LivePage />);
    await flush();

    // Idle streams must not start a background loop.
    await advance(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Go live' }));
    await flush();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/live/1/pump', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });

    const title = screen.getByLabelText('Stream title');
    fireEvent.change(title, { target: { value: 'Unsaved title' } });
    fireEvent.change(screen.getByLabelText('Stream description'), {
      target: { value: 'Unsaved description' },
    });
    fireEvent.change(screen.getByLabelText('Planned start time'), {
      target: { value: '2026-11-16T10:30' },
    });
    title.focus();

    await advance();
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/live', {
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
    expect(screen.queryByText('Loading live streams…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh from Facebook' })).toBeEnabled();
    expect(screen.getByLabelText('Stream title')).toBe(title);

    await act(async () => {
      // Even if another session changes details, a pump read must not reset
      // the StreamCard's locally edited title, description, or schedule.
      resolvePoll(Response.json({ streams: [{
        ...stream('failed'),
        title: 'Server title changed',
        description: 'Server description changed',
        plannedStartTime: '2026-11-17T12:00:00Z',
      }] }));
    });
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.queryByText('Running')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Runner could not open the source.');
    expect(screen.getByRole('button', { name: 'Go live' })).toBeEnabled();
    expect(screen.getByLabelText('Stream title')).toBe(title);
    expect(title).toHaveValue('Unsaved title');
    expect(title).toHaveFocus();
    expect(screen.getByLabelText('Stream description')).toHaveValue('Unsaved description');
    expect(screen.getByLabelText('Planned start time')).toHaveValue('2026-11-16T10:30');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(['idle', 'stopped', 'failed', 'interrupted'] as const)(
    'stops polling after the pump becomes %s',
    async (status) => {
      fetchMock
        .mockResolvedValueOnce(response([stream()]))
        .mockResolvedValue(response([stream(status)]));
      render(<LivePage />);
      await flush();
      expect(screen.getByText('Running')).toBeInTheDocument();

      await advance();
      expect(screen.queryByText('Running')).not.toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      await advance(30_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );

  it('keeps refreshing until every running pump reaches a terminal state', async () => {
    fetchMock
      .mockResolvedValueOnce(response([stream(), stream('running', 2)]))
      .mockResolvedValueOnce(response([stream('stopped'), stream('running', 2)]))
      .mockResolvedValueOnce(response([stream('stopped'), stream('failed', 2)]));
    render(<LivePage />);
    await flush();

    await advance();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);
    await advance();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    await advance(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries transient read failures quietly without losing the running card', async () => {
    fetchMock
      .mockResolvedValueOnce(response([stream()]))
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce(Response.json({ error: 'Unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(response([stream('failed')]));
    render(<LivePage />);
    await flush();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await advance();
      expect(screen.getByText('Running')).toBeInTheDocument();
      expect(screen.queryByText('Loading live streams…')).not.toBeInTheDocument();
      expect(toast.error).not.toHaveBeenCalled();
    }
    await advance();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('avoids overlapping reads and aborts a pending poll on unmount', async () => {
    let resolvePoll!: (value: Response) => void;
    fetchMock
      .mockResolvedValueOnce(response([stream()]))
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
    const { unmount } = render(<LivePage />);
    await flush();
    await advance();
    const signal = fetchMock.mock.calls[1][1]?.signal;
    expect(signal?.aborted).toBe(false);

    await advance(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    // A response arriving after cleanup must not restart the loop.
    await act(async () => { resolvePoll(response([stream()])); });
    await advance(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(toast.error).not.toHaveBeenCalled();
  });
});


describe('live source resolution deadline', () => {
  const source = {
    playableUrl: 'https://example.com/live.mp4',
    mode: 'direct', title: 'Live source', isLive: true, extractor: 'test',
  };

  async function startPreview() {
    render(<LivePage />);
    await flush();
    fireEvent.change(screen.getByLabelText('Source URL'), {
      target: { value: 'https://example.com/live' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await flush();
  }

  it('leaves Resolving and allows a retry if the deployed request never finishes', async () => {
    fetchMock.mockResolvedValueOnce(response([]));
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    render(<LivePage />);
    await flush();
    fireEvent.change(screen.getByLabelText('Source URL'), {
      target: { value: 'https://example.com/live' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await flush();
    expect(screen.getByRole('button', { name: 'Resolving…' })).toBeDisabled();
    await advance(90_000);
    expect(screen.getByRole('button', { name: 'Retry preview' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/took too long/i);
  });

  it('bounds a stalled response body and succeeds on retry', async () => {
    fetchMock.mockResolvedValueOnce(response([]));
    fetchMock.mockImplementationOnce(async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"title":'));
        init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
      },
    })));
    await startPreview();
    await advance(90_000);
    expect(screen.getByRole('alert')).toHaveTextContent(/took too long/i);

    fetchMock.mockResolvedValueOnce(Response.json(source));
    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
    await flush();
    expect(document.querySelector('video')?.getAttribute('src')).toBe(source.playableUrl);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('unmounts the previous player while re-resolving the same source', async () => {
    fetchMock.mockResolvedValueOnce(response([]));
    fetchMock.mockResolvedValueOnce(Response.json(source));
    await startPreview();
    const previousVideo = document.querySelector('video');
    expect(previousVideo).not.toBeNull();

    fetchMock.mockResolvedValueOnce(Response.json(source));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(document.querySelector('video')).toBeNull();
    await flush();
    expect(document.querySelector('video')).not.toBe(previousVideo);
    expect(document.querySelector('video')?.getAttribute('src')).toBe(source.playableUrl);
  });

  it('cancels an obsolete resolve so its late result cannot replace a newer source', async () => {
    fetchMock.mockResolvedValueOnce(response([]));
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await startPreview();
    const signal = fetchMock.mock.calls[1][1]?.signal;

    fireEvent.change(screen.getByLabelText('Source URL'), {
      target: { value: 'https://example.com/new' },
    });
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled();
    fetchMock.mockResolvedValueOnce(Response.json(source));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await flush();

    finish(Response.json({ ...source, playableUrl: 'https://example.com/obsolete.mp4' }));
    await flush();
    expect(document.querySelector('video')?.getAttribute('src')).toBe(source.playableUrl);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
