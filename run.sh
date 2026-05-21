#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

APP_URL="${APP_URL:-}"
PORTS_TO_CLEAR=(3010 3011 3012 3013)
app_pid=""
tunnel_pid=""

cleanup() {
  trap - INT TERM EXIT

  if [[ -n "$app_pid" || -n "$tunnel_pid" ]]; then
    echo
    echo "Stopping servers..."
    kill ${app_pid:+"$app_pid"} ${tunnel_pid:+"$tunnel_pid"} 2>/dev/null || true
    wait ${app_pid:+"$app_pid"} ${tunnel_pid:+"$tunnel_pid"} 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH."
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is required for the public tunnel but was not found in PATH."
  echo "Install it first, then run ./run.sh again."
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

if ! command -v lsof >/dev/null 2>&1; then
  echo "lsof is required to clear ports before startup but was not found in PATH."
  exit 1
fi

if [[ -z "$APP_URL" && -f .env.local ]]; then
  cloudflare_hostname="$(
    awk -F= '/^CLOUDFLARE_HOSTNAME=/ { print $2; exit }' .env.local | tr -d "\"'"
  )"

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
npm run start:public &
app_pid=$!

echo "Starting Cloudflare tunnel..."
npm run tunnel:run &
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
