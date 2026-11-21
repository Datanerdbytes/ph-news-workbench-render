import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('runner startup publication cleanup', () => {
  it.each(['missing env', 'unmanaged listener'])('withdraws an existing Funnel rule after %s', (failure) => {
    const root = mkdtempSync(join(tmpdir(), 'runner-start-'));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'bin'));
      copyFileSync(new URL('./start-runner.sh', import.meta.url), join(root, 'scripts/start-runner.sh'));
      const calls = join(root, 'calls');
      writeFileSync(calls, '');
      writeFileSync(join(root, 'bin/tailscale'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RUNNER_TEST_CALLS"\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(root, 'bin/lsof'), '#!/bin/sh\necho 99999999\n', { mode: 0o755 });
      if (failure === 'unmanaged listener') writeFileSync(join(root, '.env.runner'), '');
      const result = spawnSync('sh', [join(root, 'scripts/start-runner.sh')], {
        env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TS_DIR: join(root, 'state'), RUNNER_TEST_CALLS: calls },
        encoding: 'utf8', timeout: 5000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(failure === 'missing env' ? 'missing .env.runner' : 'unmanaged listener');
      expect(readFileSync(calls, 'utf8')).toContain('funnel --https=443 off');
      expect(readFileSync(calls, 'utf8')).not.toContain('funnel --bg');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
