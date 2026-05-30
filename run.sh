#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

env_file_value() {
  local key="$1"
  local file

  for file in .env.local .env; do
    if [[ -f "$file" ]]; then
      awk -F= -v key="$key" '$1 == key { print $2; exit }' "$file" | tr -d "\"'"
    fi
  done | awk 'NF { print; exit }'
}

APP_URL="${APP_URL:-$(env_file_value APP_URL)}"
APP_URL="${APP_URL:-}"
PORTS_TO_CLEAR=(3010 3011 3012 3013)
app_pid=""
tunnel_pid=""

kill_process_tree() {
  local signal="$1"
  local pid="$2"
  local child

  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_process_tree "$signal" "$child"
  done

  kill -"$signal" "$pid" 2>/dev/null || true
}

wait_for_process_exit() {
  local pid="$1"
  local attempts="$2"

  for _ in $(seq 1 "$attempts"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      return 0
    fi

    sleep 0.25
  done

  return 1
}

stop_process_gracefully() {
  local name="$1"
  local pid="$2"
  local grace_attempts="${3:-32}"

  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    return
  fi

  echo "Stopping $name..."
  kill -TERM "$pid" 2>/dev/null || true

  if wait_for_process_exit "$pid" "$grace_attempts"; then
    return
  fi

  echo "Force stopping $name..."
  kill_process_tree TERM "$pid"

  if wait_for_process_exit "$pid" 12; then
    return
  fi

  kill_process_tree KILL "$pid"
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  trap - INT TERM HUP EXIT

  if [[ -n "$app_pid" || -n "$tunnel_pid" ]]; then
    echo
    echo "Stopping servers..."
    stop_process_gracefully "app server" "$app_pid" 40
    stop_process_gracefully "Cloudflare tunnel" "$tunnel_pid" 24
  fi
}

trap cleanup INT TERM HUP EXIT

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH."
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is required for the public tunnel but was not found in PATH."
  echo "Install it first, then run ./run.sh again."
  exit 1
fi

if ! command -v lsof >/dev/null 2>&1; then
  echo "lsof is required to clear ports before startup but was not found in PATH."
  exit 1
fi

stop_port_processes() {
  local port="$1"
  local pids=""

  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"

  if [[ -z "$pids" ]]; then
    return
  fi

  echo "Stopping process(es) on port $port: $pids"
  kill $pids 2>/dev/null || true

  for _ in {1..20}; do
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"

    if [[ -z "$pids" ]]; then
      return
    fi

    sleep 0.25
  done

  echo "Force stopping process(es) still on port $port: $pids"
  kill -9 $pids 2>/dev/null || true
}

if [[ -z "$APP_URL" ]]; then
  cloudflare_hostname="$(env_file_value CLOUDFLARE_HOSTNAME)"

  if [[ -n "$cloudflare_hostname" ]]; then
    APP_URL="https://$cloudflare_hostname"
  fi
fi

APP_URL="${APP_URL:-your Cloudflare hostname}"

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm install
fi

for port in "${PORTS_TO_CLEAR[@]}"; do
  stop_port_processes "$port"
done

echo "Building production app..."
npm run build

echo "Starting production app server on http://localhost:3010..."
NODE_ENV=production PORT=3010 ./node_modules/.bin/tsx server/index.ts &
app_pid=$!

echo "Starting Cloudflare tunnel..."
node scripts/cloudflare-tunnel.mjs run &
tunnel_pid=$!

echo
echo "Ready when both processes finish starting:"
echo "  $APP_URL"
echo
echo "Press Ctrl+C to stop everything."

while true; do
  if ! kill -0 "$app_pid" 2>/dev/null; then
    wait "$app_pid"
    exit $?
  fi

  if ! kill -0 "$tunnel_pid" 2>/dev/null; then
    wait "$tunnel_pid"
    exit $?
  fi

  sleep 1
done
