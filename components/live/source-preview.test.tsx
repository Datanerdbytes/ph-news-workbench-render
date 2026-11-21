// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proxyUrl } from '@/lib/live/preview-proxy';
import { PumpControls, SourcePreview } from './source-preview';

// hls.js is only imported by SourcePreview when the browser has no native
// HLS — the mock stands in for that dynamic import, recording every
// instance the component creates.
const hlsMock = vi.hoisted(() => {
  const instances: {
    on: ReturnType<typeof vi.fn>;
    loadSource: ReturnType<typeof vi.fn>;
    attachMedia: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Hls: any = Object.assign(
    // A `function` implementation so `new Hls()` works like the real class.
    vi.fn(function mockHls() {
      const instance = {
        on: vi.fn(),
        loadSource: vi.fn(),
        attachMedia: vi.fn(),
        destroy: vi.fn(),
      };
      instances.push(instance);
      return instance;
    }),
    {
      isSupported: vi.fn(() => true),
      Events: { ERROR: 'hlsError' },
    }
  );
  return { instances, Hls };
});

vi.mock('hls.js', () => ({ default: hlsMock.Hls }));

function stubCanPlayType(answer: '' | 'maybe' | 'probably') {
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue(answer);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  hlsMock.instances.length = 0;
  hlsMock.Hls.mockClear();
  hlsMock.Hls.isSupported.mockClear();
  // Default to a Chrome-like browser: no native HLS.
  stubCanPlayType('');
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});

const MANIFEST_URL = 'https://cdn.example/live.m3u8';
const FILE_URL = 'https://cdn.example/clip.mp4?token=1';

/** Where the browser should actually load an HLS manifest: the proxy. */
function proxiedManifestUrl(target: string) {
  return new URL(proxyUrl(target), window.location.href).href;
}

function renderPreview(props: Partial<Parameters<typeof SourcePreview>[0]> = {}) {
  return render(
    <SourcePreview
      playableUrl={MANIFEST_URL}
      mode="direct"
      title="Midday briefing"
      isLive={false}
      extractor="youtube"
      {...props}
    />
  );
}

function renderPump(
  overrides: Partial<Parameters<typeof PumpControls>[0]> = {}
) {
  const props = {
    pumpStatus: 'idle' as const,
    pumpError: null,
    disabled: false,
    onStart: vi.fn(),
    onStop: vi.fn(),
    ...overrides,
  };
  render(<PumpControls {...props} />);
  return props;
}

describe('SourcePreview', () => {
  it('stops a player that never receives media and offers a preview retry', async () => {
    vi.useFakeTimers();
    renderPreview();
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });

    expect(screen.getByRole('alert')).toHaveTextContent(/took too long.*preview.*again/i);
    expect(hlsMock.instances[0].destroy).toHaveBeenCalledOnce();
    expect(document.querySelector('video')?.hasAttribute('src')).toBe(false);
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledOnce();
  });

  it('clears the loading deadline when media arrives, including while paused', async () => {
    vi.useFakeTimers();
    renderPreview();
    await act(async () => {});
    fireEvent.loadedData(document.querySelector('video')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(hlsMock.instances[0].destroy).not.toHaveBeenCalled();
  });

  it('bounds a later playback stall too', async () => {
    vi.useFakeTimers();
    renderPreview();
    await act(async () => {});
    const video = document.querySelector('video')!;
    fireEvent.loadedData(video);
    Object.defineProperty(video, 'paused', { value: false });
    fireEvent.waiting(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });

    expect(screen.getByRole('alert')).toHaveTextContent(/took too long/i);
    expect(hlsMock.instances[0].destroy).toHaveBeenCalledOnce();
  });

  it('suspends a buffering deadline while paused and re-arms it on resume', async () => {
    vi.useFakeTimers();
    renderPreview();
    await act(async () => {});
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'paused', { value: false, writable: true });
    fireEvent.loadedData(video);
    fireEvent.waiting(video);
    Object.defineProperty(video, 'paused', { value: true });
    fireEvent.pause(video);
    fireEvent.stalled(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.queryByRole('alert')).toBeNull();

    Object.defineProperty(video, 'paused', { value: false });
    fireEvent.play(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(screen.getByRole('alert')).toHaveTextContent(/took too long/i);
  });

  it('keeps the initial deadline when paused before any media arrives', async () => {
    vi.useFakeTimers();
    renderPreview();
    await act(async () => {});
    fireEvent.pause(document.querySelector('video')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(screen.getByRole('alert')).toHaveTextContent(/took too long/i);
  });

  it('does not time out a stalled network request while enough media is buffered', async () => {
    vi.useFakeTimers();
    renderPreview();
    await act(async () => {});
    const video = document.querySelector('video')!;
    fireEvent.loadedData(video);
    Object.defineProperty(video, 'readyState', { value: video.HAVE_ENOUGH_DATA });
    fireEvent.stalled(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(hlsMock.instances[0].destroy).not.toHaveBeenCalled();
  });

  it('cancels the player deadline on unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = renderPreview();
    await act(async () => {});
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(hlsMock.instances[0].destroy).toHaveBeenCalledOnce();
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
  });

  it('reports native media errors instead of leaving a direct-file spinner', () => {
    renderPreview({ playableUrl: FILE_URL });
    fireEvent.error(document.querySelector('video')!);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be played/i);
  });

  it('always routes an HLS manifest through hls.js even in a native-HLS browser', async () => {
    stubCanPlayType('probably');
    renderPreview({ isLive: true });

    await waitFor(() => expect(hlsMock.Hls).toHaveBeenCalledTimes(1));
    const [instance] = hlsMock.instances;
    expect(instance.loadSource).toHaveBeenCalled();
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video.src).toBe('');
  });

  it('plays a direct mp4 file through src without hls.js', () => {
    renderPreview({ playableUrl: FILE_URL });

    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video.src).toBe(FILE_URL);
    expect(hlsMock.Hls).not.toHaveBeenCalled();
  });

  it('attaches hls.js once in a non-native browser and destroys it on unmount', async () => {
    const { unmount } = renderPreview();
    await waitFor(() => expect(hlsMock.instances).toHaveLength(1));
    const [instance] = hlsMock.instances;

    expect(hlsMock.Hls).toHaveBeenCalledTimes(1);
    // hls.js loads the manifest same-origin through the preview proxy.
    const [loadedUrl] = instance.loadSource.mock.calls[0] as [string];
    const loaded = new URL(loadedUrl, window.location.href);
    expect(loaded.pathname).toBe('/api/live/preview');
    // Decoded, the proxied parameter is the original manifest URL.
    expect(loaded.searchParams.get('url')).toBe(MANIFEST_URL);
    expect(instance.attachMedia).toHaveBeenCalledWith(
      expect.any(HTMLVideoElement)
    );

    unmount();
    expect(instance.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys hls.js with a friendly message on a fatal player error', async () => {
    renderPreview();
    await waitFor(() => expect(hlsMock.instances).toHaveLength(1));
    const [instance] = hlsMock.instances;

    const onError = instance.on.mock.calls.find(
      ([event]) => event === 'hlsError'
    )?.[1] as (event: string, data: { fatal: boolean }) => void;
    expect(onError).toEqual(expect.any(Function));

    act(() => {
      onError('hlsError', { fatal: true });
    });

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The stream stopped playing'
      )
    );
    expect(instance.destroy).toHaveBeenCalledTimes(1);
  });

  it('leaves hls.js alone on non-fatal player errors', async () => {
    renderPreview();
    await waitFor(() => expect(hlsMock.instances).toHaveLength(1));
    const [instance] = hlsMock.instances;

    const onError = instance.on.mock.calls.find(
      ([event]) => event === 'hlsError'
    )?.[1] as (event: string, data: { fatal: boolean }) => void;

    act(() => {
      onError('hlsError', { fatal: false });
    });

    expect(instance.destroy).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the resolved title, extractor, and LIVE badge muted-autoplay-ready', () => {
    renderPreview({ isLive: true, extractor: 'youtube' });

    expect(screen.getByText('Midday briefing')).toBeInTheDocument();
    expect(screen.getByText('youtube')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();

    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.hasAttribute('controls')).toBe(true);
  });

  // Facebook replay VODs resolve with no playable URL — the pump pipes them
  // through yt-dlp. The preview must say so honestly (a normal state, not an
  // error) and never mount a player.
  it('renders a staged resolve as a calm no-video card and never loads hls.js', () => {
    renderPreview({
      playableUrl: null,
      mode: 'staged',
      isLive: true,
      extractor: 'facebook',
    });

    expect(screen.getByText('Midday briefing')).toBeInTheDocument();
    expect(screen.getByText('facebook')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(
      screen.getByText(/Preview unavailable for this source/)
    ).toBeInTheDocument();

    expect(document.querySelector('video')).toBeNull();
    expect(hlsMock.Hls).not.toHaveBeenCalled();
    // A staged resolve is not a failure — no alert styling anywhere.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('PumpControls', () => {
  it('shows Stop for a running pump and calls onStop', () => {
    const { onStop } = renderPump({ pumpStatus: 'running' });

    expect(screen.getByText('Running')).toBeInTheDocument();
    const stop = screen.getByRole('button', { name: /stop/i });
    expect(stop).toBeEnabled();

    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('shows an enabled Go live for an idle pump and calls onStart', () => {
    const { onStart } = renderPump({ pumpStatus: 'idle' });

    expect(screen.getByText('Idle')).toBeInTheDocument();
    const goLive = screen.getByRole('button', { name: /go live/i });
    expect(goLive).toBeEnabled();

    fireEvent.click(goLive);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('shows Stopped with a Go live button after a stop', () => {
    renderPump({ pumpStatus: 'stopped' });

    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go live/i })).toBeEnabled();
  });

  it('renders the interrupted chip with one-click restart, restarting calls onStart', () => {
    const { onStart } = renderPump({ pumpStatus: 'interrupted' });

    expect(screen.getByText('Interrupted')).toBeInTheDocument();
    // The chip offers restart, and so does the action button.
    const restarts = screen.getAllByRole('button', { name: /restart/i });
    expect(restarts).toHaveLength(2);

    fireEvent.click(restarts[0]);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
  });

  it('shows the pump error and offers Go live again when failed', () => {
    const { onStart } = renderPump({
      pumpStatus: 'failed',
      pumpError: 'The video is private. Check the link and try again.',
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The video is private. Check the link and try again.'
    );
    const goLive = screen.getByRole('button', { name: /go live/i });
    expect(goLive).toBeEnabled();

    fireEvent.click(goLive);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('disables Go live without a resolved source and explains why', () => {
    renderPump({ disabled: true });

    const goLive = screen.getByRole('button', { name: /go live/i });
    expect(goLive).toBeDisabled();
    expect(
      screen.getByText(/Resolve and preview a source URL/)
    ).toBeInTheDocument();
  });
});
