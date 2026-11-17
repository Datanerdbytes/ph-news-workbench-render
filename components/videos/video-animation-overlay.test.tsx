// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import {
  contentBox,
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
