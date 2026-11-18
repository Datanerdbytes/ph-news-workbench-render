import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

// assertPublicUrl must never hit real DNS in unit tests.
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { isHlsUrl, proxyUrl, rewritePlaylist } from './preview-proxy';
import { assertPublicUrl, PreviewProxyError } from './preview-proxy.server';

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

describe('assertPublicUrl', () => {
  it('accepts a public host and returns the normalized URL', async () => {
    resolveTo('93.184.216.34');

    await expect(
      assertPublicUrl('https://manifest.example/live.m3u8')
    ).resolves.toBe('https://manifest.example/live.m3u8');
    expect(lookupMock).toHaveBeenCalledWith('manifest.example', { all: true });
  });

  it('rejects localhost resolving to 127.0.0.1', async () => {
    resolveTo('127.0.0.1');

    await expect(assertPublicUrl('https://localhost:3000/live.m3u8')).rejects.toThrow(
      PreviewProxyError
    );
  });

  it('rejects private, link-local, and loopback IPv4 ranges', async () => {
    const privates = [
      '127.0.0.1', // loopback
      '10.1.2.3', // 10/8
      '172.16.0.1', // 172.16/12
      '172.31.255.255', // 172.16/12 top
      '192.168.1.1', // 192.168/16
      '169.254.169.254', // cloud metadata endpoint
      '0.0.0.0', // unspecified
    ];
    for (const address of privates) {
      resolveTo(address);
      await expect(
        assertPublicUrl('https://evil.example/live.m3u8')
      ).rejects.toThrow(PreviewProxyError);
    }
    expect(lookupMock).toHaveBeenCalledTimes(privates.length);
  });

  it('rejects IPv6 loopback, link-local, and unique-local addresses', async () => {
    for (const address of ['::1', 'fe80::1', 'fc00::1', 'fd12:3455:67ab::1']) {
      resolveTo(address);
      await expect(
        assertPublicUrl('https://evil.example/live.m3u8')
      ).rejects.toThrow(PreviewProxyError);
    }
  });

  it('judges IPv4-mapped IPv6 by the embedded IPv4 address', async () => {
    resolveTo('::ffff:10.0.0.7');
    await expect(
      assertPublicUrl('https://evil.example/live.m3u8')
    ).rejects.toThrow(PreviewProxyError);

    resolveTo('::ffff:93.184.216.34');
    await expect(
      assertPublicUrl('https://ok.example/live.m3u8')
    ).resolves.toBe('https://ok.example/live.m3u8');
  });

  it('rejects when any resolved address is private, even alongside a public one', async () => {
    resolveTo('93.184.216.34', '192.168.0.10');
    await expect(
      assertPublicUrl('https://dual.example/live.m3u8')
    ).rejects.toThrow(PreviewProxyError);
  });

  it('accepts 172.32.x.x, which sits outside the 172.16/12 range', async () => {
    resolveTo('172.32.0.1');
    await expect(
      assertPublicUrl('https://edge.example/live.m3u8')
    ).resolves.toBe('https://edge.example/live.m3u8');
  });

  it('rejects non-http schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(
      PreviewProxyError
    );
    await expect(assertPublicUrl('ftp://host.example/video.ts')).rejects.toThrow(
      PreviewProxyError
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects strings that are not URLs at all', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toThrow(
      PreviewProxyError
    );
  });

  it('rejects when DNS lookup fails', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      assertPublicUrl('https://gone.example/live.m3u8')
    ).rejects.toThrow(PreviewProxyError);
  });

  it('rejects unparseable resolved addresses instead of trusting them', async () => {
    resolveTo('not-an-address');
    await expect(
      assertPublicUrl('https://weird.example/live.m3u8')
    ).rejects.toThrow(PreviewProxyError);
  });
});
