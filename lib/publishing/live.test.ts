import { beforeEach, describe, expect, it, vi } from 'vitest';

const { graphRequestMock, graphPostFormMock } = vi.hoisted(() => ({
  graphRequestMock: vi.fn(),
  graphPostFormMock: vi.fn(),
}));

vi.mock('@/lib/facebook', () => ({
  graphRequest: graphRequestMock,
  graphPostForm: graphPostFormMock,
}));

import { resolveEndVideoId } from './live';

describe('resolveEndVideoId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the live video id the node read yields', async () => {
    graphRequestMock.mockResolvedValue({ id: 'real-live-video-999' });

    await expect(
      resolveEndVideoId({
        liveVideoId: '122152546167117522',
        accessToken: 'page-token',
      })
    ).resolves.toBe('real-live-video-999');

    expect(graphRequestMock).toHaveBeenCalledWith(
      '122152546167117522',
      expect.objectContaining({ fields: expect.stringContaining('id') }),
      'page-token'
    );
  });

  it('keeps the stored id when the node read returns no id', async () => {
    graphRequestMock.mockResolvedValue({});

    await expect(
      resolveEndVideoId({ liveVideoId: 'fb-video-37', accessToken: 'page-token' })
    ).resolves.toBe('fb-video-37');
  });

  it('returns null when the node cannot be read', async () => {
    graphRequestMock.mockRejectedValue(
      new Error(
        "Unsupported post request. Object with ID '122152546167117522' does not exist, cannot be loaded due to missing permissions, or does not support this operation."
      )
    );

    await expect(
      resolveEndVideoId({
        liveVideoId: '122152546167117522',
        accessToken: 'page-token',
      })
    ).resolves.toBeNull();
  });

  it('returns null when the row stores no id', async () => {
    await expect(
      resolveEndVideoId({ liveVideoId: '', accessToken: 'page-token' })
    ).resolves.toBeNull();
    expect(graphRequestMock).not.toHaveBeenCalled();
  });
});
