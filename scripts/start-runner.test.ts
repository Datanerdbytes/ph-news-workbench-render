import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

function fakeHost() {
  const root = mkdtempSync(join(tmpdir(), 'runner-start-'));
  for (const dir of ['scripts', 'bin', 'state']) mkdirSync(join(root, dir));
  const script = join(root, 'scripts/start-runner.sh');
  copyFileSync(new URL('./start-runner.sh', import.meta.url), script);
  copyFileSync(new URL('./run-with-runner-lock.py', import.meta.url), join(root, 'scripts/run-with-runner-lock.py'));
  const calls = join(root, 'calls');
  writeFileSync(calls, '');
  const stub = (name: string, body: string) => writeFileSync(join(root, 'bin', name), '#!/bin/sh\n' + body, { mode: 0o755 });
  stub('tailscale', `printf '%s\\n' "$*" >> "$RUNNER_TEST_CALLS"
case "$*" in
  *'funnel status --json'*)
    case "$RUNNER_TEST_RULE" in
      absent) echo '{}' ;;
      invalid) echo 'bad json' ;;
      unreadable) exit 1 ;;
      *) echo '{"Web":{"runner.test:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8080"}}}}}' ;;
    esac ;;
  *'funnel --https=443 off'*)
    [ "$RUNNER_TEST_RULE" != absent ] || { echo 'handler does not exist' >&2; exit 1; }
    [ "$RUNNER_TEST_RULE" != removal-fails ] || exit 1 ;;
esac
`);
  stub('lsof', 'echo 99999999\n');
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    TS_DIR: join(root, 'state'),
    RUNNER_TEST_CALLS: calls,
    ...extra,
  });
  const run = (args: string[] = [], extra: Record<string, string> = {}) => spawnSync('sh', [script, ...args], {
    env: env(extra),
    encoding: 'utf8', timeout: 5000,
  });
  return { root, calls, stub, run, script, env };
}

describe('runner startup publication cleanup', () => {
  it('keeps stop behind a cancelled startup until its shell finishes cleanup', async () => {
    const host = fakeHost();
    const state = join(host.root, 'state');
    const release = join(state, 'release-start');
    let startup;
    let stop;
    try {
      writeFileSync(join(host.root, '.env.runner'), '');
      host.stub('tailscale', `
case "$*" in
  *'funnel status --json'*) echo '{"Web":{"runner.test:443":{"Handlers":{"/":{}}}}}' ;;
  *'funnel --https=443 off'*) echo withdrew >> "$RUNNER_TEST_CALLS" ;;
  *' status')
    echo startup-check >> "$RUNNER_TEST_CALLS"
    while [ ! -f "$TS_DIR/release-start" ]; do sleep 0.02; done
    echo startup-check-finished >> "$RUNNER_TEST_CALLS" ;;
esac
`);
      host.stub('lsof', 'echo listener-check >> "$RUNNER_TEST_CALLS"\necho 99999999\n');
      const launch = (args: string[]) => {
        const child = spawn('sh', [host.script, ...args], { env: host.env(), stdio: 'ignore' });
        const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
        return { child, exited };
      };
      startup = launch([]);
      await vi.waitFor(() => expect(readFileSync(host.calls, 'utf8')).toContain('startup-check\n'));
      startup.child.kill('SIGTERM');
      stop = launch(['stop']);
      // Give a stop that escaped the lock time to enter its withdrawal path.
      const stoppedEarly = await Promise.race([
        stop.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
      ]);
      writeFileSync(release, '');
      expect(await startup.exited).toBe(143);
      expect(await stop.exited).toBe(0);
      expect(stoppedEarly).toBe(false);
      const calls = readFileSync(host.calls, 'utf8');
      expect(calls).not.toContain('listener-check');
      expect(calls.indexOf('startup-check-finished')).toBeLessThan(calls.indexOf('withdrew'));
    } finally {
      writeFileSync(release, '');
      await Promise.all([startup?.exited, stop?.exited]);
      rmSync(host.root, { recursive: true, force: true });
    }
  });
  it.each(['missing env', 'unmanaged listener'])('withdraws an existing Funnel rule after %s', (failure) => {
    const host = fakeHost();
    try {
      if (failure === 'unmanaged listener') writeFileSync(join(host.root, '.env.runner'), '');
      const result = host.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(failure === 'missing env' ? 'missing .env.runner' : 'unmanaged listener');
      expect(readFileSync(host.calls, 'utf8')).toContain('funnel --https=443 off');
      expect(readFileSync(host.calls, 'utf8')).not.toContain('funnel --bg');
    } finally { rmSync(host.root, { recursive: true, force: true }); }
  });

  it.each(['absent', 'invalid', 'unreadable', 'removal-fails'])('handles %s Funnel configuration before checking the listener', (rule) => {
    const host = fakeHost();
    try {
      writeFileSync(join(host.root, '.env.runner'), '');
      const result = host.run([], { RUNNER_TEST_RULE: rule });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rule === 'absent' ? 'unmanaged listener' : 'could not withdraw');
      if (rule === 'absent') expect(readFileSync(host.calls, 'utf8')).not.toContain('funnel --https=443 off');
      expect(readFileSync(host.calls, 'utf8')).not.toContain('funnel --bg');
    } finally { rmSync(host.root, { recursive: true, force: true }); }
  });

  it.each([false, true])('withdraws publication on runner exit, preserving a replacement (replacement: %s)', (replacement) => {
    const host = fakeHost();
    try {
      writeFileSync(join(host.root, 'state/runner.pid'), replacement ? '4343' : '4242');
      host.stub('ps', 'exit 1\n');
      const result = host.run(['watch', '4242']);
      expect(result.status).toBe(0);
      expect(readFileSync(host.calls, 'utf8').includes('funnel --https=443 off')).toBe(!replacement);
    } finally { rmSync(host.root, { recursive: true, force: true }); }
  });

  it('rechecks runner ownership after acquiring the publication lock', () => {
    const host = fakeHost();
    try {
      writeFileSync(join(host.root, 'state/runner.pid'), '4242');
      host.stub('ps', 'exit 1\n');
      const helper = join(host.root, 'scripts/run-with-runner-lock.py');
      writeFileSync(helper, readFileSync(helper, 'utf8').replace(
        'os.set_inheritable(lock_fd, True)',
        `with open(os.path.join(os.environ['TS_DIR'], 'runner.pid'), 'w') as pid:\n    pid.write('4343')\nos.set_inheritable(lock_fd, True)`
      ));
      const result = host.run(['watch', '4242']);
      expect(result.status).toBe(0);
      expect(readFileSync(join(host.root, 'state/runner.pid'), 'utf8')).toBe('4343');
      expect(readFileSync(host.calls, 'utf8')).not.toContain('funnel --https=443 off');
    } finally { rmSync(host.root, { recursive: true, force: true }); }
  });
  it('retries a failed watcher withdrawal while it still owns the rule', () => {
    const host = fakeHost();
    try {
      writeFileSync(join(host.root, 'state/runner.pid'), '4242');
      host.stub('ps', 'exit 1\n');
      host.stub('sleep', 'echo slept >> "$RUNNER_TEST_CALLS"\n');
      host.stub('tailscale', `printf '%s\\n' "$*" >> "$RUNNER_TEST_CALLS"
case "$*" in
  *'funnel status --json'*) echo '{"Web":{"runner.test:443":{"Handlers":{"/":{}}}}}' ;;
  *'funnel --https=443 off'*) mkdir "$TS_DIR/failed-once" 2>/dev/null && exit 1 ;;
esac
exit 0
`);
      expect(host.run(['watch', '4242']).status).toBe(0);
      const calls = readFileSync(host.calls, 'utf8').trim().split('\n');
      expect(calls.filter((call) => call.endsWith('funnel --https=443 off') || call === 'slept')
        .map((call) => call === 'slept' ? call : 'off')).toEqual(['off', 'slept', 'off']);
    } finally { rmSync(host.root, { recursive: true, force: true }); }
  });

});
