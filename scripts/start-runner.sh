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
CAFFEINATE_PID_FILE="$TS_DIR/caffeinate.pid"
TS_BIN="$(command -v tailscale || echo /opt/homebrew/bin/tailscale)"
TAILSCALED="$(command -v tailscaled || echo /opt/homebrew/opt/tailscale/bin/tailscaled)"
RUNNER_PORT="${RUNNER_PORT:-8080}"
HOSTNAME_TS="${TS_HOSTNAME:-ph-news-runner}"

is_up() {
  # The runner answers /healthz only when its sandbox bootstrapped.
  curl -fsS -m 5 "http://127.0.0.1:$RUNNER_PORT/healthz" >/dev/null 2>&1
}

# Stops the runner and its caffeinate, using the PID files written at start.
# The pattern fallback names `.env.runner`, so it can never touch a local-dev
# runner started with `npm run media-runner` (which uses .env.local).
stop_runner() {
  pid="$(cat "$RUNNER_PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  pkill -f "tsx --env-file=.env.runner media-runner.ts" 2>/dev/null || true
  rm -f "$RUNNER_PID_FILE"

  # caffeinate is its own process, so the runner's death does not leave the
  # Mac pinned awake.
  cpid="$(cat "$CAFFEINATE_PID_FILE" 2>/dev/null || true)"
  if [ -n "$cpid" ] && kill -0 "$cpid" 2>/dev/null; then
    kill "$cpid" 2>/dev/null || true
  fi
  rm -f "$CAFFEINATE_PID_FILE"
}

stop_all() {
  echo "stopping runner…"
  stop_runner
  echo "stopping funnel…"
  "$TS_BIN" --socket="$TS_SOCK" funnel --https=443 off 2>/dev/null || true
  echo "stopping tailscaled…"
  pkill -f "tailscaled --tun=userspace-networking" 2>/dev/null || true
  echo "stopped."
}

if [ "${1:-}" = "stop" ]; then
  stop_all
  exit 0
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
if is_up; then
  echo "runner already healthy on :$RUNNER_PORT"
else
  echo "starting runner on :${RUNNER_PORT}…"
  nohup ./node_modules/.bin/tsx --env-file=.env.runner media-runner.ts \
    >>"$TS_DIR/runner.log" 2>&1 &
  RUNNER_PID=$!
  echo "$RUNNER_PID" >"$RUNNER_PID_FILE"
  nohup caffeinate -s -w "$RUNNER_PID" >/dev/null 2>&1 &
  echo $! >"$CAFFEINATE_PID_FILE"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 3
    is_up && break
  done
  if ! is_up; then
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
fi
echo "point Render's MEDIA_RUNNER_URL at https://$FUNNEL_HOST"
