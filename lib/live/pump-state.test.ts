import { describe, expect, it } from 'vitest';

import {
  buildIngestUrl,
  mapPumpStatus,
  parsePumpAction,
  parseSourceMode,
  pumpProcessRecord,
  PumpStateError,
} from './pump-state';

const RTMPS_BASE = 'rtmps://live-api-s.facebook.com:443/rtmp/1234567890';
const STREAM_KEY = '1_secret-key-do-not-leak';
const INGEST_URL = `${RTMPS_BASE}/${STREAM_KEY}`;

describe('buildIngestUrl', () => {
  it('base with trailing slash + key → joined rtmps url', () => {
    expect(buildIngestUrl(`${RTMPS_BASE}/`, STREAM_KEY)).toBe(INGEST_URL);
  });

  it('base without trailing slash + key → slash inserted before the key', () => {
    expect(buildIngestUrl(RTMPS_BASE, STREAM_KEY)).toBe(INGEST_URL);
  });

  it('null base + key → PumpStateError missing_ingest_base', () => {
    expect(() => buildIngestUrl(null, STREAM_KEY)).toThrow(PumpStateError);
    try {
      buildIngestUrl(null, STREAM_KEY);
      expect.unreachable('buildIngestUrl should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PumpStateError);
      expect((error as PumpStateError).code).toBe('missing_ingest_base');
    }
  });

  it('base + null key → PumpStateError missing_stream_key', () => {
    expect(() => buildIngestUrl(RTMPS_BASE, null)).toThrowError(
      new PumpStateError(
        'missing_stream_key',
        'This stream has no stream key stored. Recreate the live stream to get a fresh one.'
      )
    );
  });

  it('null base + real key → error message never quotes the key', () => {
    try {
      buildIngestUrl(null, STREAM_KEY);
      expect.unreachable('buildIngestUrl should have thrown');
    } catch (error) {
      expect((error as PumpStateError).message).not.toContain(STREAM_KEY);
    }
  });
});

describe('mapPumpStatus', () => {
  it('DB running + process alive → running', () => {
    expect(
      mapPumpStatus({ pumpStatus: 'running' }, { running: true, error: null })
    ).toBe('running');
  });

  it('DB running + no process record (undefined, e.g. after a restart) → interrupted', () => {
    expect(mapPumpStatus({ pumpStatus: 'running' }, undefined)).toBe(
      'interrupted'
    );
  });

  it('DB running + process exited with an error → failed', () => {
    expect(
      mapPumpStatus(
        { pumpStatus: 'running' },
        { running: false, error: 'ffmpeg exited with code 1' }
      )
    ).toBe('failed');
  });

  it('DB running + process exited without an error → stopped', () => {
    expect(
      mapPumpStatus({ pumpStatus: 'running' }, { running: false, error: null })
    ).toBe('stopped');
  });

  it('DB stopped + no process → stopped (passes through)', () => {
    expect(mapPumpStatus({ pumpStatus: 'stopped' }, undefined)).toBe('stopped');
  });

  it('DB idle + no process → idle (passes through)', () => {
    expect(mapPumpStatus({ pumpStatus: 'idle' }, undefined)).toBe('idle');
  });

  it('DB failed + no process → failed (passes through)', () => {
    expect(mapPumpStatus({ pumpStatus: 'failed' }, undefined)).toBe('failed');
  });

  it('DB failed + process alive → failed (DB row wins over manager)', () => {
    expect(
      mapPumpStatus({ pumpStatus: 'failed' }, { running: true, error: null })
    ).toBe('failed');
  });

  it('unknown DB status string → passes through unchanged', () => {
    expect(mapPumpStatus({ pumpStatus: 'weird' }, undefined)).toBe('weird');
  });
});

describe('pumpProcessRecord', () => {
  it('manager status without startedAt (no record for the id) → undefined', () => {
    expect(
      pumpProcessRecord({ running: false, startedAt: null, error: null })
    ).toBeUndefined();
  });

  it('manager status of a live process (startedAt set, running) → { running: true }', () => {
    const startedAt = new Date('2026-11-19T10:00:00Z');
    expect(
      pumpProcessRecord({ running: true, startedAt, error: null })
    ).toEqual({ running: true, error: null });
  });

  it('manager status of an exited process (startedAt set, not running) → { running: false, error }', () => {
    const startedAt = new Date('2026-11-19T10:00:00Z');
    expect(
      pumpProcessRecord({
        running: false,
        startedAt,
        error: 'ffmpeg exited with code 1',
      })
    ).toEqual({ running: false, error: 'ffmpeg exited with code 1' });
  });
});

describe('parsePumpAction', () => {
  it("{ action: 'start' } → 'start'", () => {
    expect(parsePumpAction({ action: 'start' })).toBe('start');
  });

  it("{ action: 'stop' } → 'stop'", () => {
    expect(parsePumpAction({ action: 'stop' })).toBe('stop');
  });

  it("{ action: 'pause' } → null", () => {
    expect(parsePumpAction({ action: 'pause' })).toBeNull();
  });

  it("{ action: 'START' } (wrong case) → null", () => {
    expect(parsePumpAction({ action: 'START' })).toBeNull();
  });

  it('{} (missing action) → null', () => {
    expect(parsePumpAction({})).toBeNull();
  });

  it("['start'] (array body) → null", () => {
    expect(parsePumpAction(['start'])).toBeNull();
  });

  it('null body → null', () => {
    expect(parsePumpAction(null)).toBeNull();
  });

  it("'start' (string body) → null", () => {
    expect(parsePumpAction('start')).toBeNull();
  });
});

describe('parseSourceMode', () => {
  it("'direct' → 'direct'", () => {
    expect(parseSourceMode('direct')).toBe('direct');
  });

  it("'staged' → 'staged'", () => {
    expect(parseSourceMode('staged')).toBe('staged');
  });

  it('null (legacy row, mode never stored) → null', () => {
    expect(parseSourceMode(null)).toBeNull();
  });

  it('undefined (column missing from the row) → null', () => {
    expect(parseSourceMode(undefined)).toBeNull();
  });

  it("'DIRECT' (wrong case) → null", () => {
    expect(parseSourceMode('DIRECT')).toBeNull();
  });

  it("'pipeline' (unrecognized mode) → null", () => {
    expect(parseSourceMode('pipeline')).toBeNull();
  });

  it('42 (not a string) → null', () => {
    expect(parseSourceMode(42)).toBeNull();
  });
});
