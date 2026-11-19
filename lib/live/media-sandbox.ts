import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

/**
 * Server-lifetime bootstrap for the media sandbox: the enforcing boundary
 * that makes native yt-dlp/ffprobe/ffmpeg execution safe. Initialized once
 * per server process (from instrumentation.ts), kept on globalThis so Next
 * dev hot reloads reuse the running proxies instead of leaking them.
 *
 * Enforcement model (see the sandbox-runtime README): sandboxed processes
 * have NO direct network access — every connection is forced through local
 * proxy servers that resolve DNS once, refuse any resolved private/reserved
 * address, and dial the vetted numeric address. That closes the nested-
 * request paths (redirects, HLS child playlists, extractor hosts, DNS
 * rebinding) that URL pre-checks cannot reach.
 */

/**
 * Private/reserved ranges denied on top of the runtime's built-in set
 * (loopback, unspecified, link-local, multicast, broadcast, cloud metadata,
 * host interface addresses). Render/runtime-specific internal services live
 * behind these too.
 */
const DENIED_RESOLVED_ADDRESSES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '0.0.0.0/8',
  'fc00::/7',
  'fe80::/10',
  '::ffff:0:0/96',
  'ff00::/8',
] as const;

type SandboxState = 'uninitialized' | 'ready' | 'unavailable';

type SandboxGlobal = typeof globalThis & {
  __phMediaSandbox?: {
    state: SandboxState;
    reason: string | null;
    initializing: Promise<void> | null;
  };
};

const holder = globalThis as SandboxGlobal;

function state(): NonNullable<SandboxGlobal['__phMediaSandbox']> {
  if (!holder.__phMediaSandbox) {
    holder.__phMediaSandbox = {
      state: 'uninitialized',
      reason: null,
      initializing: null,
    };
  }
  return holder.__phMediaSandbox;
}

/** User-facing availability of the verified runner for native media work. */
export function mediaSandboxAvailability(): {
  available: boolean;
  reason: string;
} {
  const current = state();
  return {
    available: current.state === 'ready',
    reason: current.reason ?? 'The media sandbox has not been initialized.',
  };
}

/**
 * Initializes the sandbox once; safe to call repeatedly (hot reloads, lazy
 * call sites). Fails closed — an unavailable sandbox is cached with its
 * reason and every later check reports the same refusal.
 */
export async function ensureMediaSandbox(): Promise<void> {
  const current = state();
  if (current.state !== 'uninitialized') return;
  if (!current.initializing) {
    current.initializing = initialize().then(
      () => {
        current.state = 'ready';
        current.reason = null;
        current.initializing = null;
      },
      (error: unknown) => {
        current.state = 'unavailable';
        // The rejection carries an Error — store its MESSAGE, not the object.
        current.reason =
          error instanceof Error ? error.message : String(error ?? 'unknown');
        current.initializing = null;
      }
    );
  }
  await current.initializing;
}

async function initialize(): Promise<void> {
  if (process.env.DISABLE_MEDIA_SANDBOX === '1') {
    throw new Error('The media sandbox is disabled by configuration.');
  }

  verifyPlatformDependencies();

  // `*` allows every DOMAIN — the resolved-address deny list above is what
  // confines destinations to public unicast, and the runtime's built-in set
  // denies loopback/metadata/etc. before anything else.
  await SandboxManager.initialize({
    network: {
      // `*` allows every DOMAIN — the resolved-address deny list below is
      // what confines destinations to public unicast, and the runtime's
      // built-in set denies loopback/metadata/etc. before anything else.
      allowedDomains: ['*'],
      deniedDomains: [],
      deniedResolvedAddresses: [...DENIED_RESOLVED_ADDRESSES],
    },
    filesystem: {
      // The pump writes its fifos and yt-dlp writes temp files under tmpdir.
      allowWrite: [os.tmpdir()],
      denyWrite: [],
      // Source tools never need the app's secrets.
      denyRead: ['**/.env*'],
    },
  });
}

/**
 * The runtime needs OS primitives: `sandbox-exec` on macOS, bubblewrap +
 * socat + ripgrep on Linux. Checked synchronously at startup — a missing
 * primitive fails closed before any native media process can exist.
 */
function verifyPlatformDependencies(): void {
  const missing: string[] = [];
  if (process.platform === 'darwin') {
    // The binary probe cannot demand exit 0: sandbox-exec answers a usage
    // probe with EX_USAGE (64) even when perfectly healthy.
    if (!binaryRuns('/usr/bin/sandbox-exec', ['h'])) {
      missing.push('sandbox-exec');
    }
    if (!commandWorks('rg', ['--version'])) missing.push('ripgrep (rg)');
    // FUNCTIONAL probe: a tiny Seatbelt run — `--version` alone can lie.
    // The profile carries the standard `(version 1)` header, which macOS 27
    // requires and older releases accept.
    if (
      !commandWorks(
        'sandbox-exec',
        ['-p', '(version 1)(allow default)', '/bin/echo', 'ok']
      )
    ) {
      missing.push('a working sandbox-exec profile run');
    }
  } else if (process.platform === 'linux') {
    if (!commandWorks('bwrap', ['--version'])) missing.push('bubblewrap (bwrap)');
    if (!commandWorks('socat', ['-u'])) missing.push('socat');
    if (!commandWorks('rg', ['--version'])) missing.push('ripgrep (rg)');
    // FUNCTIONAL probe: bwrap must actually unshare namespaces. CI on
    // Ubuntu 24.04 runners (and Render-like runtimes) refuses unprivileged
    // user namespaces even though `bwrap --version` succeeds.
    if (
      !commandWorks(
        'bwrap',
        ['--unshare-all', '--ro-bind', '/', '/', '/bin/echo', 'sandbox-ok']
      )
    ) {
      missing.push(
        'a working bubblewrap namespace run (the runtime refuses unprivileged user namespaces)'
      );
    }
  } else {
    throw new Error(
      `The media sandbox does not support this platform (${process.platform}).`
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `The media sandbox cannot run on this runtime: ${missing.join(', ')}.`
    );
  }
}

/** The command spawned, ran, and exited — whatever its exit code. */
function binaryRuns(command: string, args: string[]): boolean {
  try {
    const probe = spawnSync(command, args, { timeout: 15_000 });
    return !probe.error;
  } catch {
    return false;
  }
}

function commandWorks(command: string, args: string[]): boolean {
  try {
    const probe = spawnSync(command, args, { timeout: 15_000 });
    return probe.status === 0 && !probe.error;
  } catch {
    return false;
  }
}
