import { describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import {
  assertMediaIsolationAvailable,
  guardedSpawn,
  MEDIA_ISOLATION_ERROR_CODE,
  MEDIA_ISOLATION_UNAVAILABLE_MESSAGE,
  MediaIsolationError,
} from './media-egress';

describe('assertMediaIsolationAvailable', () => {
  it('throws MediaIsolationError with the quarantine code and message', () => {
    expect(() => assertMediaIsolationAvailable()).toThrow(MediaIsolationError);
    try {
      assertMediaIsolationAvailable();
      expect.unreachable('the quarantine must fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(MediaIsolationError);
      const isolationError = error as MediaIsolationError;
      expect(isolationError.code).toBe(MEDIA_ISOLATION_ERROR_CODE);
      expect(isolationError.message).toBe(MEDIA_ISOLATION_UNAVAILABLE_MESSAGE);
    }
  });
});

describe('guardedSpawn', () => {
  it('throws before spawning a child while the quarantine holds', () => {
    expect(() => guardedSpawn('ffmpeg', ['-version'])).toThrow(
      MediaIsolationError
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('still fails closed for any command and argument shape', () => {
    expect(() => guardedSpawn('yt-dlp', ['-J', 'https://host.example/x'])).toThrow(
      MediaIsolationError
    );
    expect(() =>
      guardedSpawn('ffprobe', ['-show_streams', 'http://host.example/x'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ).toThrow(MediaIsolationError);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
