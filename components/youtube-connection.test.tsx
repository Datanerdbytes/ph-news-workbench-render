// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { YouTubeConnectionProvider, useYouTubeConnection } from './youtube-connection';

vi.mock('next/navigation', () => ({ usePathname: () => '/platforms' }));

function Consumer() {
  const youtube = useYouTubeConnection();
  return <><span>{youtube.connected ? youtube.account?.name : youtube.unreachable ? 'unavailable' : 'disconnected'}</span><button onClick={youtube.refresh}>Refresh</button></>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('clears a previously connected account when refresh fails', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ configured: true, connected: true, account: { id: '1', name: 'Channel' } }) })
    .mockRejectedValueOnce(new Error('unavailable'));
  vi.stubGlobal('fetch', fetchMock);
  render(<YouTubeConnectionProvider><Consumer /></YouTubeConnectionProvider>);
  await screen.findByText('Channel');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(screen.getByText('unavailable')).toBeInTheDocument());
});
