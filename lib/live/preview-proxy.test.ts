import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

// assertPublicUrl must never hit real DNS in unit tests.
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { isHlsUrl, proxyUrl, rewritePlaylist } from './preview-proxy';

/** Queue the addresses `lookup` reports for the hostname under test. */
function resolveTo(...addresses: string[]) {
  lookupMock.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }))
  );
}

beforeEach(() => {
  lookupMock.mockReset();
  // Default the guard open — each SSRF test narrows it on purpose.
  resolveTo('93.184.216.34');
});

const BASE = 'https://manifest.example/live/master.m3u8';

function proxied(target: string) {
  return `/api/live/preview?url=${encodeURIComponent(target)}`;
}

describe('isHlsUrl', () => {
  it('detects a manifest in the pathname', () => {
    expect(
      isHlsUrl(
        'https://manifest.googlevideo.com/api/manifest/hls_playlist/id/1/file/index.m3u8?ip=1.2.3.4'
      )
    ).toBe(true);
  });

  it('detects a manifest hiding in the query string', () => {
    expect(isHlsUrl('https://host.example/api?target=%2Fplay.m3u8&sig=1')).toBe(
      true
    );
  });

  it('matches case-insensitively', () => {
    expect(isHlsUrl('https://host.example/LIVE.M3U8?X=1')).toBe(true);
  });

  it('ignores direct files and DASH manifests', () => {
    expect(isHlsUrl('https://host.example/clip.mp4?token=1')).toBe(false);
    expect(isHlsUrl('https://host.example/video.webm')).toBe(false);
    expect(isHlsUrl('https://host.example/manifest.mpd')).toBe(false);
  });

  it('returns false for strings that are not URLs', () => {
    expect(isHlsUrl('not a url at all')).toBe(false);
  });
});

describe('proxyUrl', () => {
  it('wraps the target as the encoded url query parameter', () => {
    const target = 'https://cdn.example/live.m3u8?a=1&b=2';
    expect(proxyUrl(target)).toBe(`/api/live/preview?url=${encodeURIComponent(target)}`);
  });
});

describe('rewritePlaylist', () => {
  it('rewrites a relative variant line against the manifest URL', () => {
    const playlist = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1280000', 'video/720p.m3u8', ''].join('\n');
    const rewritten = rewritePlaylist(playlist, BASE);

    expect(rewritten.split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
      proxied('https://manifest.example/live/video/720p.m3u8'),
      '',
    ]);
  });

  it('rewrites absolute variant lines verbatim into the proxy', () => {
    const variant = 'https://other-cdn.example/hls/720p/index.m3u8';
    const rewritten = rewritePlaylist(`${variant}\n`, BASE);
    expect(rewritten).toBe(`${proxied(variant)}\n`);
  });

  it('rewrites the URI attribute of an EXT-X-KEY tag', () => {
    const key = 'https://keys.example/live/session?key=abc';
    const playlist = `#EXT-X-KEY:METHOD=AES-128,URI="${key}",IV=0x1\n#EXTINF:6.0,\nseg1.ts\n`;
    const rewritten = rewritePlaylist(playlist, BASE);

    expect(rewritten).toContain(`URI="${proxied(key)}"`);
    expect(rewritten).toContain(proxied('https://manifest.example/live/seg1.ts'));
    // The raw attribute value must be gone (the proxied URL still mentions
    // the key host inside its encoded query parameter).
    expect(rewritten).not.toContain('URI="https://keys.example');
  });

  it('rewrites a relative EXT-X-MAP URI against the manifest URL', () => {
    const playlist = '#EXT-X-MAP:URI="init/codec.mp4"\n';
    expect(rewritePlaylist(playlist, BASE)).toBe(
      `#EXT-X-MAP:URI="${proxied('https://manifest.example/live/init/codec.mp4')}"\n`
    );
  });

  it('rewrites EXT-X-MEDIA renditions without touching other attributes', () => {
    const audio = 'https://cdn.example/audio/en.m3u8';
    const playlist = `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="${audio}"\n`;
    const rewritten = rewritePlaylist(playlist, BASE);

    expect(rewritten).toContain(`GROUP-ID="aud"`);
    expect(rewritten).toContain(`NAME="English"`);
    expect(rewritten).toContain(`URI="${proxied(audio)}"`);
  });

  it('rewrites EXT-X-I-FRAME-STREAM-INF URIs', () => {
    const iframe = 'iframe/720p.m3u8';
    const playlist = `#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="${iframe}"\n`;
    expect(rewritePlaylist(playlist, BASE)).toBe(
      `#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="${proxied('https://manifest.example/live/iframe/720p.m3u8')}"\n`
    );
  });

  it('leaves comments, tags without URIs, and blank lines untouched', () => {
    const playlist = [
      '#EXTM3U',
      '# comment line',
      '#EXT-X-PLAYLIST-TYPE:EVENT',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-ENDLIST',
      '',
      'seg2.ts',
    ].join('\n');
    const rewritten = rewritePlaylist(`${playlist}\n`, BASE);

    expect(rewritten.split('\n').slice(0, 6)).toEqual([
      '#EXTM3U',
      '# comment line',
      '#EXT-X-PLAYLIST-TYPE:EVENT',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-ENDLIST',
      '',
    ]);
    expect(rewritten.split('\n')[6]).toBe(
      proxied('https://manifest.example/live/seg2.ts')
    );
  });

  it('leaves non-http URI attributes (data:) verbatim', () => {
    const playlist = '#EXT-X-KEY:METHOD=NONE,URI="data:text/plain,none"\n';
    expect(rewritePlaylist(playlist, BASE)).toBe(playlist);
  });

  it('preserves CRLF line endings while rewriting', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
      'video/720p.m3u8',
    ].join('\r\n');
    const rewritten = rewritePlaylist(`${playlist}\r\n`, BASE);

    expect(rewritten.endsWith('\r\n')).toBe(true);
    expect(rewritten.split('\r\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
      proxied('https://manifest.example/live/video/720p.m3u8'),
      '',
    ]);
    // No bare LF anywhere: every ending stayed CRLF.
    expect(rewritten.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('rewrites a final line that has no trailing newline', () => {
    expect(rewritePlaylist('#EXTM3U\nseg1.ts', BASE)).toBe(
      `#EXTM3U\n${proxied('https://manifest.example/live/seg1.ts')}`
    );
  });
});
