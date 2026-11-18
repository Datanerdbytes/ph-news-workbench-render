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
  vi.restoreAllMocks();
});

beforeEach(() => {
  hlsMock.instances.length = 0;
  hlsMock.Hls.mockClear();
  hlsMock.Hls.isSupported.mockClear();
  // Default to a Chrome-like browser: no native HLS.
  stubCanPlayType('');
});

const MANIFEST_URL = 'https://cdn.example/live.m3u8';
const FILE_URL = 'https://cdn.example/clip.mp4?token=1';

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
  it('sets the video src directly in a native-HLS browser and never loads hls.js', () => {
    stubCanPlayType('probably');
    renderPreview({ isLive: true });

    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video.src).toBe(MANIFEST_URL);
    expect(hlsMock.Hls).not.toHaveBeenCalled();
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
    expect(instance.loadSource).toHaveBeenCalledWith(MANIFEST_URL);
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
