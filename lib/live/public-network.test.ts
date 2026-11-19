import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

// resolvePublicAddresses must never hit real DNS in unit tests.
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import {
  assertPublicSourceUrl,
  isPublicAddress,
  MAX_SOURCE_URL_LENGTH,
  resolvePublicAddresses,
  validateSourceUrl,
} from './public-network';

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
});

describe('validateSourceUrl', () => {
  it('returns the exact original string for a valid https URL', () => {
    const url =
      'https://manifest.example/live/master.m3u8?sig=abc&Expires=123&x=%2Fpath';
    expect(validateSourceUrl(url)).toBe(url);
  });

  it('accepts plain http', () => {
    expect(validateSourceUrl('http://cdn.example/video.mp4')).toBe(
      'http://cdn.example/video.mp4'
    );
  });

  it.each(['ftp://x', 'javascript:alert(1)', 'file:///etc/passwd'])(
    'rejects non-http scheme %j',
    (input) => {
      expect(() => validateSourceUrl(input)).toThrow(/http and https/);
    }
  );

  it('rejects embedded credentials', () => {
    expect(() =>
      validateSourceUrl('https://user:pass@manifest.example/live.m3u8')
    ).toThrow();
  });

  it('rejects non-standard ports', () => {
    expect(() =>
      validateSourceUrl('http://localhost:8080/admin')
    ).toThrow(/non-standard ports/);
    expect(() => validateSourceUrl('https://host.example:8443/x')).toThrow(
      /non-standard ports/
    );
  });

  it('accepts default ports 80 and 443', () => {
    expect(validateSourceUrl('http://host.example:80/x')).toBe(
      'http://host.example:80/x'
    );
    expect(validateSourceUrl('https://host.example:443/x')).toBe(
      'https://host.example:443/x'
    );
  });

  it('rejects control characters and whitespace-padded input', () => {
    expect(() => validateSourceUrl('https://host.example/\u0000x')).toThrow();
    expect(() => validateSourceUrl('https://host.example/\u007fx')).toThrow();
    expect(() => validateSourceUrl(' https://host.example/x')).toThrow();
  });

  it('rejects input longer than the bound instead of truncating', () => {
    const long = `https://host.example/${'a'.repeat(MAX_SOURCE_URL_LENGTH)}`;
    expect(long.length).toBeGreaterThan(MAX_SOURCE_URL_LENGTH);
    expect(() => validateSourceUrl(long)).toThrow();
  });

  it.each([undefined, null, 42, {}, []])('rejects non-string input %j', (input) => {
    expect(() => validateSourceUrl(input)).toThrow();
  });
});

describe('resolvePublicAddresses', () => {
  it('accepts a hostname that resolves only to public addresses', async () => {
    resolveTo('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946');
    await expect(
      resolvePublicAddresses('manifest.example')
    ).resolves.toHaveLength(2);
  });

  it('classifies IP literals directly without DNS', async () => {
    lookupMock.mockImplementation(() => {
      throw new Error('DNS must not be consulted for literals');
    });
    await expect(resolvePublicAddresses('93.184.216.34')).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.0.0.5', 'private'],
    ['172.16.0.9', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local metadata'],
    ['100.64.0.1', 'shared space'],
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['fc00::1', 'unique-local'],
    ['::ffff:127.0.0.1', 'mapped loopback'],
    ['0.0.0.0', 'unspecified'],
  ])('rejects %j (%s) with a friendly error', async (address) => {
    resolveTo(address);
    await expect(resolvePublicAddresses('host.example')).rejects.toThrow(
      /non-public/
    );
  });

  it('fails closed on a failed DNS lookup', async () => {
    lookupMock.mockRejectedValue(new Error('SERVFAIL'));
    await expect(resolvePublicAddresses('host.example')).rejects.toThrow(
      /could not look up/
    );
  });

  it('fails closed on an empty answer', async () => {
    lookupMock.mockResolvedValue([]);
    await expect(resolvePublicAddresses('host.example')).rejects.toThrow(
      /non-public/
    );
  });

  it('fails closed on mixed answers (one private record poisons the set)', async () => {
    resolveTo('93.184.216.34', '10.0.0.5');
    await expect(resolvePublicAddresses('host.example')).rejects.toThrow(
      /non-public/
    );
  });
});

describe('assertPublicSourceUrl', () => {
  it('returns the exact original string when the host is public', async () => {
    resolveTo('93.184.216.34');
    const url =
      'https://manifest.example/live/master.m3u8?api_sig=ZZZ&x=%2Fsegment';
    await expect(assertPublicSourceUrl(url)).resolves.toBe(url);
  });

  it('combines input validation with the DNS policy', async () => {
    await expect(
      assertPublicSourceUrl('ftp://host.example/x')
    ).rejects.toThrow(/http and https/);
  });
});

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])(
    'treats %j as public',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    }
  );

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '100.127.255.255',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '::ffff:10.0.0.1',
  ])('treats %j as non-public', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('respects the expected family when given', () => {
    expect(isPublicAddress('93.184.216.34', 4)).toBe(true);
    expect(isPublicAddress('93.184.216.34', 6)).toBe(false);
    expect(isPublicAddress('2606:2800::1', 6)).toBe(true);
    expect(isPublicAddress('2606:2800::1', 4)).toBe(false);
  });

  it('treats unparseable addresses as non-public', () => {
    expect(isPublicAddress('not-an-address')).toBe(false);
  });
});
