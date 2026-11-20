import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), put: vi.fn(), del: vi.fn(), list: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@vercel/blob', () => ({ put: mocks.put, del: mocks.del, list: mocks.list }));
import { claimNextJob, runJob, type Sql } from './download-worker';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill() { return true; }
}

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it('keeps the newer attempt intact when the claim is reclaimed during upload', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worker-owner-'));
  vi.stubEnv('VIDEO_DOWNLOADER_ROOT', root);
  const dir = path.join(root, 'YouTube', 'job-1');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'clip.mp4');
  await writeFile(file, 'video');
  const download = new FakeChild();
  mocks.spawn.mockImplementation((command: string) => {
    if (command !== 'ffprobe') return download;
    const probe = new FakeChild();
    queueMicrotask(() => {
      probe.stdout.emit('data', Buffer.from('{"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p"}]}'));
      probe.emit('close', 0);
    });
    return probe;
  });
  let attempt = 1;
  let status = 'queued';
  let result: string | null = null;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    if (query.includes('FOR UPDATE SKIP LOCKED')) {
      status = 'fetching';
      const field = /attempts AS "([^"]+)"/.exec(query)?.[1] ?? 'attempts';
      return Promise.resolve([{ id: 'job-1', workspace_id: 'ws-1', platform: 'YouTube', url: 'https://example.com', quality: 'best', [field]: attempt }]);
    }
    if (query.includes('SELECT attempts')) return Promise.resolve([{ attempts: attempt }]);
    if (query.includes("SET status = 'done'")) {
      if (values.at(-1) !== attempt || status !== 'fetching') return Promise.resolve([]);
      status = 'done'; result = String(values[1]); return Promise.resolve([{ id: 'job-1' }]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
  let resolveUpload!: (value: { url: string; pathname: string }) => void;
  mocks.put.mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; }));
  mocks.del.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue({ blobs: [], hasMore: false });
  const job = await claimNextJob(sql, 'worker-1');
  const active = new Map();
  try {
    await runJob(sql, job!, active, () => false);
    download.stdout.emit('data', Buffer.from(`${file}\n`));
    download.emit('close', 0);
    await vi.waitFor(() => expect(mocks.put).toHaveBeenCalled());
    attempt = 2;
    status = 'fetching';
    const staleUrl = 'https://store.public.blob.vercel-storage.com/downloads/ws-1/job-1/attempt-1/clip.mp4';
    resolveUpload({ url: staleUrl, pathname: 'downloads/ws-1/job-1/attempt-1/clip.mp4' });
    await vi.waitFor(() => expect(active.size).toBe(0));
    expect(status).toBe('fetching');
    expect(result).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.del).toHaveBeenCalledWith(staleUrl);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
