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
TS_BIN="$(command -v tailscale || echo /opt/homebrew/bin/tailscale)"
TAILSCALED="$(command -v tailscaled || echo /opt/homebrew/opt/tailscale/bin/tailscaled)"
RUNNER_PORT="${RUNNER_PORT:-8080}"
HOSTNAME_TS="${TS_HOSTNAME:-ph-news-runner}"

is_up() {
  # The runner answers /healthz only when its sandbox bootstrapped.
  curl -fsS -m 5 "http://127.0.0.1:$RUNNER_PORT/healthz" >/dev/null 2>&1
}

stop_all() {
  echo "stopping runner…"
  pkill -f "media-runner.ts" 2>/dev/null || true
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

# 2. The runner itself. caffeinate -s keeps the Mac from idle-sleeping, which
#    would freeze the ffmpeg pump mid-broadcast.
if is_up; then
  echo "runner already healthy on :$RUNNER_PORT"
else
  echo "starting runner on :${RUNNER_PORT}…"
  nohup caffeinate -s ./node_modules/.bin/tsx --env-file=.env.runner media-runner.ts \
    >>"$TS_DIR/runner.log" 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 3
    is_up && break
  done
  is_up || { echo "runner did not become healthy — see $TS_DIR/runner.log" >&2; exit 1; }
fi

# 3. Funnel: the public HTTPS URL the Render app dials.
FUNNEL_HOST="$("$TS_BIN" --socket="$TS_SOCK" status --json 2>/dev/null \
  | sed -n 's/.*"DNSName": *"\([^"]*\)\..*/\1/p' | head -1)"
echo "exposing https://$FUNNEL_HOST …"
"$TS_BIN" --socket="$TS_SOCK" funnel --bg "$RUNNER_PORT" >/dev/null
"$TS_BIN" --socket="$TS_SOCK" funnel status

echo
echo "public healthz:"
curl -fsS -m 45 "https://$FUNNEL_HOST/healthz" && echo
echo "point Render's MEDIA_RUNNER_URL at https://$FUNNEL_HOST"
