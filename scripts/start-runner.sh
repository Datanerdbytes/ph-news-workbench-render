#!/bin/sh
# Start the media runner on this Mac and expose it to the live (Render) app
# through Tailscale Funnel.
#
#   ./scripts/start-runner.sh          # start everything, leave it running
#   ./scripts/start-runner.sh stop     # tear it all down
#
# Why this exists: the deployed app's Live features are proxied to
# MEDIA_RUNNER_URL. This machine is that runner, so the tunnel, the daemon,
# and the process all have to be up for "Go live" to work. Nothing here is
# installed as a login item on purpose — a media runner that starts itself
# would keep the Mac awake and reachable without anyone asking.
#
# Prerequisites (one-time):
#   brew install tailscale
#   .env.runner must exist with production DATABASE_URL, BETTER_AUTH_SECRET
#   and MEDIA_RUNNER_TOKEN (see docs/deployment.md).
set -eu

cd "$(dirname "$0")/.."

TS_DIR="${TS_DIR:-$HOME/.local/share/tailscale-local}"
TS_SOCK="$TS_DIR/tailscaled.sock"
RUNNER_PID_FILE="$TS_DIR/runner.pid"
RUNNER_LOCK="$TS_DIR/runner.lock"
RUNNER_ENTRY="$PWD/media-runner.ts"
TS_BIN="$(command -v tailscale || echo /opt/homebrew/bin/tailscale)"
TAILSCALED="$(command -v tailscaled || echo /opt/homebrew/opt/tailscale/bin/tailscaled)"
RUNNER_PORT="${RUNNER_PORT:-8080}"
HOSTNAME_TS="${TS_HOSTNAME:-ph-news-runner}"

runner_pid() {
  cat "$RUNNER_PID_FILE" 2>/dev/null || true
}

process_args() {
  case "$1" in
    ''|*[!0-9]*|0*) return 1 ;;
  esac
  # A zombie has exited even if its parent has not reaped it yet.
  args="$(ps -ww -p "$1" -o stat= -o args= 2>/dev/null)" || return 1
  printf '%s\n' "$args" | awk '
    NF && $1 !~ /^Z/ { sub(/^[[:space:]]*[^[:space:]]+[[:space:]]+/, ""); print; found = 1 }
    END { exit !found }
  '
}

is_runner() {
  args="$(process_args "$1")" || return 1
  case "$args" in
    "node --env-file=.env.runner --import tsx $RUNNER_ENTRY"|*/"node --env-file=.env.runner --import tsx $RUNNER_ENTRY") return 0 ;;
    *) return 1 ;;
  esac
}

listener_pid() {
  lsof -nP -t -iTCP:"$RUNNER_PORT" -sTCP:LISTEN 2>/dev/null || true
}

is_up() {
  is_runner "$1" && [ "$(listener_pid)" = "$1" ] || return 1
  body="$(curl -fsS -m 5 "http://127.0.0.1:$RUNNER_PORT/healthz" 2>/dev/null)" || return 1
  printf '%s' "$body" | node -e '
    try {
      const data = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      process.exitCode = data?.sandbox === "ready" ? 0 : 1;
    } catch { process.exitCode = 1; }
  '
}

stop_runner() {
  pid="$(runner_pid)"
  if is_runner "$pid"; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      is_runner "$pid" || break
      sleep 1
    done
    if is_runner "$pid"; then
      kill -9 "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5; do
        is_runner "$pid" || break
        sleep 1
      done
    fi
  fi
  if is_runner "$pid" || process_args "$pid" >/dev/null; then
    echo "could not confirm runner PID $pid exited; keeping $RUNNER_PID_FILE" >&2
    return 1
  fi
  rm -f "$RUNNER_PID_FILE"
}

stop_all() {
  echo "stopping runner…"
  runner_stopped=0
  stop_runner || runner_stopped=$?
  echo "stopping funnel…"
  "$TS_BIN" --socket="$TS_SOCK" funnel --https=443 off 2>/dev/null || true
  echo "stopping tailscaled…"
  for daemon_pid in $(pgrep -u "$(id -u)" -x tailscaled || true); do
    daemon_args="$(process_args "$daemon_pid")" || continue
    case " $daemon_args " in
      *" --socket=$TS_SOCK "*) kill "$daemon_pid" 2>/dev/null || true ;;
    esac
  done
  [ "$runner_stopped" -eq 0 ] || return "$runner_stopped"
  echo "stopped."
}

# mkdir is atomic on macOS and Linux. Keep the lock across PID changes and
# Funnel commands so a stale watcher cannot withdraw a replacement's rule.
acquire_runner_lock() {
  mkdir -p "$TS_DIR" || return 1
  lock_wait=0
  until mkdir "$RUNNER_LOCK" 2>/dev/null; do
    lock_wait=$((lock_wait + 1))
    if [ "$lock_wait" -ge 300 ]; then
      echo "timed out waiting for $RUNNER_LOCK; check for an interrupted runner command" >&2
      return 1
    fi
    sleep 1
  done
}

release_runner_lock() {
  rmdir "$RUNNER_LOCK"
}

trap 'exit 1' HUP INT TERM

# A background Funnel rule survives a previous invocation. Withdraw it on
# every failed start so an unrelated replacement listener is never published.
withdraw_funnel() {
  config="$("$TS_BIN" --socket="$TS_SOCK" funnel status --json)" || return 1
  has_handler="$(printf '%s' "$config" | node -e '
    try {
      const config = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      if (config !== null && (typeof config !== "object" || Array.isArray(config))) process.exit(1);
      const present = Object.entries(config?.Web || {}).some(([host, web]) =>
        host.endsWith(":443") && web?.Handlers?.["/"]);
      process.stdout.write(present ? "yes" : "no");
    } catch { process.exit(1); }
  ')" || return 1
  [ "$has_handler" = yes ] || return 0
  "$TS_BIN" --socket="$TS_SOCK" funnel --https=443 off >/dev/null 2>&1
}

# Detached supervisor: withdraw publication if the verified server exits.
# A newer runner PID owns its own publication, so an old supervisor leaves it.
if [ "${1:-}" = watch ]; then
  watched_pid="${2:?missing runner PID}"
  while [ "$(runner_pid)" = "$watched_pid" ] && is_runner "$watched_pid"; do
    sleep 1
  done
  while :; do
    acquire_runner_lock || { sleep 1; continue; }
    trap 'release_runner_lock' 0
    if [ "$(runner_pid)" != "$watched_pid" ]; then
      exit 0
    fi
    if withdraw_funnel; then
      exit 0
    fi
    echo "could not withdraw Funnel after runner exit; retrying" >&2
    release_runner_lock
    trap - 0
    sleep 1
  done
fi

acquire_runner_lock
trap 'release_runner_lock' 0
if [ "${1:-}" = "stop" ]; then
  stop_all
  exit 0
fi
trap 'withdraw_funnel || true; release_runner_lock' 0

if ! command -v lsof >/dev/null; then
  echo "lsof is required to verify the runner listener" >&2
  exit 1
fi

if [ ! -f .env.runner ]; then
  echo "missing .env.runner — see docs/deployment.md" >&2
  exit 1
fi

# 1. tailscaled in userspace mode: no root, no system extension, no TUN.
if ! "$TS_BIN" --socket="$TS_SOCK" status >/dev/null 2>&1; then
  echo "starting tailscaled…"
  mkdir -p "$TS_DIR"
  # nohup: the daemon must outlive the terminal that launched it.
  nohup "$TAILSCALED" --tun=userspace-networking \
    --statedir="$TS_DIR" --socket="$TS_SOCK" --port=41641 \
    >>"$TS_DIR/tailscaled.log" 2>&1 &
  # First run needs a browser login; the URL is printed by `tailscale up`.
  sleep 5
  if ! "$TS_BIN" --socket="$TS_SOCK" status >/dev/null 2>&1; then
    "$TS_BIN" --socket="$TS_SOCK" up --hostname="$HOSTNAME_TS" \
      --accept-dns=false --accept-routes=false || true
  fi
fi

# 2. The runner itself, plus a separate caffeinate that keeps the Mac from
#    idle-sleeping (which would freeze the ffmpeg pump mid-broadcast). They are
#    separate processes so `stop` can end both cleanly, and caffeinate waits on
#    the runner's PID (-w) so a crash never leaves the Mac pinned awake.
if ! withdraw_funnel; then
  echo "could not withdraw the previous Funnel rule; refusing startup" >&2
  exit 1
fi
RUNNER_PID="$(runner_pid)"
if is_up "$RUNNER_PID"; then
  echo "runner already healthy on :$RUNNER_PORT"
else
  listener="$(listener_pid)"
  if [ -n "$listener" ] && [ "$listener" != "$RUNNER_PID" ]; then
    echo "port $RUNNER_PORT is occupied by an unmanaged listener; stop it or choose another RUNNER_PORT" >&2
    exit 1
  fi
  if ! is_runner "$RUNNER_PID"; then
    if process_args "$RUNNER_PID" >/dev/null || [ -n "$listener" ]; then
      echo "cannot verify the previous runner; stop it before restarting" >&2
      exit 1
    fi
    echo "starting runner on :${RUNNER_PORT}…"
    # Load tsx into Node so $! is the actual server, with no launcher child.
    PORT="$RUNNER_PORT" nohup node --env-file=.env.runner --import tsx "$RUNNER_ENTRY" \
      >>"$TS_DIR/runner.log" 2>&1 &
    RUNNER_PID=$!
    echo "$RUNNER_PID" >"$RUNNER_PID_FILE"
    nohup caffeinate -i -s -w "$RUNNER_PID" >/dev/null 2>&1 &
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 3
    is_up "$RUNNER_PID" && break
  done
  if ! is_up "$RUNNER_PID"; then
    echo "runner did not become healthy — see $TS_DIR/runner.log" >&2
    stop_runner
    exit 1
  fi
fi

# 3. Funnel: the public HTTPS URL the Render app dials. Self.DNSName is read
#    from the JSON (not scraped line-by-line) so a peer's name can never be
#    mistaken for this machine's.
FUNNEL_HOST="$("$TS_BIN" --socket="$TS_SOCK" status --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.Self?.DNSName||"").replace(/\.$/,""))}catch{}})')"
if [ -z "$FUNNEL_HOST" ]; then
  echo "could not read this machine's tailnet DNS name — is Tailscale logged in?" >&2
  exit 1
fi
echo "exposing https://$FUNNEL_HOST …"
# Install the supervisor before publication, including when reusing a runner.
TS_DIR="$TS_DIR" nohup sh "$PWD/scripts/start-runner.sh" watch "$RUNNER_PID" \
  >>"$TS_DIR/runner.log" 2>&1 &
"$TS_BIN" --socket="$TS_SOCK" funnel --bg "$RUNNER_PORT" >/dev/null
"$TS_BIN" --socket="$TS_SOCK" funnel status

echo
echo "public healthz:"
published=""
for _ in 1 2 3; do
  if curl -fs -m 45 "https://$FUNNEL_HOST/healthz"; then
    published=yes
    echo
    break
  fi
  sleep 5
done
if [ -z "$published" ]; then
  echo "the funnel is configured but not answering yet — TLS/DERP can take a minute after tailscaled restarts" >&2
  exit 1
fi
if ! is_up "$RUNNER_PID"; then
  echo "runner lost readiness during publication" >&2
  exit 1
fi
trap 'release_runner_lock' 0
echo "point Render's MEDIA_RUNNER_URL at https://$FUNNEL_HOST"
