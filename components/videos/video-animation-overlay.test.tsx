// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import {
  contentBox,
  frameKey,
  VideoAnimationOverlay,
} from './video-animation-overlay';

const emptySlots = { start: null, middle: null, end: null };
const noLoops = { start: false, middle: false, end: false };

describe('contentBox', () => {
  it('letterboxes a 16:9 video inside a taller box', () => {
    const box = contentBox(1600, 900, 800, 800);
    expect(box.w).toBe(800);
    expect(box.h).toBe(450);
    expect(box.x).toBe(0);
    expect(box.y).toBe(175);
  });

  it('pillarboxes a vertical video inside a wide box', () => {
    const box = contentBox(1080, 1920, 800, 400);
    expect(box.h).toBe(400);
    expect(box.w).toBeCloseTo(225);
    expect(box.y).toBe(0);
    expect(box.x).toBeCloseTo(287.5);
  });
});

describe('frameKey', () => {
  const frame = {
    currentTime: 3.2,
    clientWidth: 320,
    clientHeight: 180,
    videoWidth: 640,
    videoHeight: 360,
    duration: 12,
    paused: true,
  };

  it('keeps the key stable for a paused frame with unchanged metadata', () => {
    expect(frameKey({ ...frame })).toBe(frameKey({ ...frame }));
  });

  it('repaints when metadata arrives after a paused attach', () => {
    const beforeMetadata = frameKey({
      ...frame,
      duration: Number.NaN,
      videoWidth: 0,
      videoHeight: 0,
    });
    const afterMetadata = frameKey({ ...frame });
    expect(afterMetadata).not.toBe(beforeMetadata);
    expect(
      frameKey({ ...frame, videoWidth: 1080, videoHeight: 1920 })
    ).not.toBe(afterMetadata);
  });

  it('repaints when the playhead moves or playback resumes', () => {
    const base = frameKey({ ...frame });
    expect(frameKey({ ...frame, currentTime: 3.3 })).not.toBe(base);
    expect(frameKey({ ...frame, paused: false })).not.toBe(base);
  });
});

describe('VideoAnimationOverlay', () => {
  it('renders nothing until an animation is attached', () => {
    const videoRef = createRef<HTMLVideoElement>();
    const { container } = render(
      <div>
        <video ref={videoRef} />
        <VideoAnimationOverlay
          videoRef={videoRef}
          slots={emptySlots}
          loops={noLoops}
          values={{}}
        />
      </div>
    );
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('draws an overlay canvas once a preset is attached', () => {
    const videoRef = createRef<HTMLVideoElement>();
    const { container } = render(
      <div>
        <video ref={videoRef} />
        <VideoAnimationOverlay
          videoRef={videoRef}
          slots={{ ...emptySlots, start: 'cinema-title' }}
          loops={noLoops}
          values={{}}
        />
      </div>
    );
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(canvas?.className).toContain('pointer-events-none');
  });
});
