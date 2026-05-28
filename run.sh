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
TURN_ENABLED="${TURN_ENABLED:-$(env_file_value TURN_ENABLED)}"
TURN_ENABLED="${TURN_ENABLED:-0}"
TURN_MODE="${TURN_MODE:-$(env_file_value TURN_MODE)}"
TURN_MODE="${TURN_MODE:-auto}"
TURN_COMPOSE_FILE="${TURN_COMPOSE_FILE:-$(env_file_value TURN_COMPOSE_FILE)}"
TURN_COMPOSE_FILE="${TURN_COMPOSE_FILE:-docker-compose.turn.yml}"
TURN_HOST="${TURN_HOST:-$(env_file_value TURN_HOST)}"
TURN_HOST="${TURN_HOST:-auto}"
OCI_TURN_STOP_INSTANCE_ON_EXIT="${OCI_TURN_STOP_INSTANCE_ON_EXIT:-$(env_file_value OCI_TURN_STOP_INSTANCE_ON_EXIT)}"
OCI_TURN_STOP_INSTANCE_ON_EXIT="${OCI_TURN_STOP_INSTANCE_ON_EXIT:-1}"
export OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING="${OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING:-$(env_file_value OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING)}"
export OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING="${OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING:-True}"
export PYTHONWARNINGS="${PYTHONWARNINGS:-$(env_file_value PYTHONWARNINGS)}"
export PYTHONWARNINGS="${PYTHONWARNINGS:-ignore::FutureWarning}"
app_pid=""
tunnel_pid=""
turn_started=""
turn_host=""
oci_config_file=""

ssh_common_options=(
  -o StrictHostKeyChecking=accept-new
  -o BatchMode=yes
  -o ConnectTimeout=10
)

cleanup() {
  trap - INT TERM HUP EXIT

  if [[ -n "$app_pid" || -n "$tunnel_pid" ]]; then
    echo
    echo "Stopping servers..."
    kill ${app_pid:+"$app_pid"} ${tunnel_pid:+"$tunnel_pid"} 2>/dev/null || true
    wait ${app_pid:+"$app_pid"} ${tunnel_pid:+"$tunnel_pid"} 2>/dev/null || true
  fi

  if [[ "$turn_started" == "local" ]]; then
    echo "Stopping local TURN server..."
    docker compose -f "$TURN_COMPOSE_FILE" down >/dev/null 2>&1 || true
  elif [[ "$turn_started" == "oci" ]]; then
    echo "Stopping OCI TURN server..."
    if [[ -n "$turn_host" ]]; then
      ssh -i "$(env_file_value OCI_TURN_SSH_KEY_FILE)" \
        "${ssh_common_options[@]}" \
        "$(env_file_value OCI_TURN_SSH_USER)@$turn_host" \
        "sudo /opt/sakura-turn/stop-turn.sh" >/dev/null 2>&1 || true
    fi

    if [[ "$OCI_TURN_STOP_INSTANCE_ON_EXIT" == "1" ]]; then
      echo "Stopping OCI TURN VM..."
      oci --config-file "$oci_config_file" compute instance action \
        --instance-id "$(env_file_value OCI_TURN_INSTANCE_ID)" \
        --action STOP >/dev/null 2>&1 || true
    fi
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

env_file_value_any() {
  local key

  for key in "$@"; do
    env_file_value "$key"
  done | awk 'NF { print; exit }'
}

detect_public_ip() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to auto-detect TURN_HOST." >&2
    return 1
  fi

  curl -fsS https://cloudflare.com/cdn-cgi/trace | awk -F= '$1 == "ip" { print $2; exit }'
}

random_secret() {
  node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))'
}

write_oci_config() {
  local user_ocid
  local fingerprint
  local tenancy_ocid
  local region
  local key_file

  user_ocid="$(env_file_value_any OCI_USER_OCID oci_user)"
  fingerprint="$(env_file_value_any OCI_FINGERPRINT oci_fingerprint)"
  tenancy_ocid="$(env_file_value_any OCI_TENANCY_OCID oci_tenancy)"
  region="$(env_file_value_any OCI_REGION oci_region)"
  key_file="$(env_file_value_any OCI_PRIVATE_KEY_FILE oci_key_file)"

  if [[ -z "$user_ocid" || -z "$fingerprint" || -z "$tenancy_ocid" || -z "$region" || -z "$key_file" ]]; then
    echo "Missing OCI API config in .env."
    exit 1
  fi

  oci_config_file="$(mktemp)"
  chmod 600 "$oci_config_file"
  {
    echo "[DEFAULT]"
    echo "user=$user_ocid"
    echo "fingerprint=$fingerprint"
    echo "tenancy=$tenancy_ocid"
    echo "region=$region"
    echo "key_file=$key_file"
  } >"$oci_config_file"
}

oci_instance_public_ip() {
  local instance_id="$1"
  local vnic_id

  vnic_id="$(oci --config-file "$oci_config_file" compute instance list-vnics \
    --instance-id "$instance_id" \
    --query 'data[0].id' \
    --raw-output)"

  oci --config-file "$oci_config_file" network vnic get \
    --vnic-id "$vnic_id" \
    --query 'data."public-ip"' \
    --raw-output
}

wait_for_oci_instance() {
  local instance_id="$1"
  local state

  for _ in {1..60}; do
    state="$(oci --config-file "$oci_config_file" compute instance get \
      --instance-id "$instance_id" \
      --query 'data."lifecycle-state"' \
      --raw-output)"

    if [[ "$state" == "RUNNING" ]]; then
      return
    fi

    sleep 5
  done

  echo "Timed out waiting for OCI TURN VM to start."
  exit 1
}

wait_for_ssh() {
  local ssh_user="$1"
  local ssh_key="$2"
  local host="$3"

  echo "Waiting for SSH on OCI TURN VM..."

  for _ in {1..60}; do
    if ssh -i "$ssh_key" \
      "${ssh_common_options[@]}" \
      "$ssh_user@$host" \
      "true" >/dev/null 2>&1; then
      return
    fi

    sleep 5
  done

  echo "Timed out waiting for SSH on OCI TURN VM."
  exit 1
}

configure_oci_turn() {
  local instance_id
  local ssh_user
  local ssh_key
  local state
  local turn_username
  local turn_password

  if ! command -v oci >/dev/null 2>&1; then
    echo "oci CLI is required for TURN_MODE=oci but was not found in PATH."
    exit 1
  fi

  instance_id="$(env_file_value OCI_TURN_INSTANCE_ID)"
  ssh_user="$(env_file_value OCI_TURN_SSH_USER)"
  ssh_key="$(env_file_value OCI_TURN_SSH_KEY_FILE)"

  if [[ -z "$instance_id" || -z "$ssh_user" || -z "$ssh_key" ]]; then
    echo "Missing OCI_TURN_INSTANCE_ID, OCI_TURN_SSH_USER, or OCI_TURN_SSH_KEY_FILE in .env."
    exit 1
  fi

  write_oci_config
  turn_started="oci"
  state="$(oci --config-file "$oci_config_file" compute instance get \
    --instance-id "$instance_id" \
    --query 'data."lifecycle-state"' \
    --raw-output)"

  if [[ "$state" != "RUNNING" ]]; then
    echo "Starting OCI TURN VM..."
    oci --config-file "$oci_config_file" compute instance action \
      --instance-id "$instance_id" \
      --action START >/dev/null
    wait_for_oci_instance "$instance_id"
  fi

  turn_host="$(oci_instance_public_ip "$instance_id")"
  wait_for_ssh "$ssh_user" "$ssh_key" "$turn_host"

  turn_username="${TURN_USERNAME:-$(env_file_value TURN_USERNAME)}"
  turn_password="${TURN_PASSWORD:-$(env_file_value TURN_PASSWORD)}"
  turn_username="${turn_username:-sakura}"

  if [[ -z "$turn_password" || "$turn_password" == "change-me" ]]; then
    turn_password="$(random_secret)"
  fi

  echo "Starting OCI TURN server for this run..."
  echo "  TURN host: $turn_host"
  echo "  TURN ports: 3478 tcp/udp, 49160-49200 udp"

  ssh -i "$ssh_key" \
    "${ssh_common_options[@]}" \
    "$ssh_user@$turn_host" \
    "sudo env TURN_USERNAME='$turn_username' TURN_PASSWORD='$turn_password' /opt/sakura-turn/start-turn.sh '$turn_host'" >/dev/null

  export TURN_USERNAME="$turn_username"
  export TURN_PASSWORD="$turn_password"
  export TURN_URLS="turn:$turn_host:3478?transport=udp,turn:$turn_host:3478?transport=tcp"
  export NEXT_PUBLIC_ICE_TRANSPORT_POLICY="${NEXT_PUBLIC_ICE_TRANSPORT_POLICY:-all}"
}

configure_turn() {
  if [[ "$TURN_ENABLED" == "0" ]]; then
    echo "TURN relay startup deferred for this run (TURN_ENABLED=0). Use the host relay button if fallback is needed."
    return
  fi

  if [[ "$TURN_MODE" == "auto" && -n "$(env_file_value OCI_TURN_INSTANCE_ID)" ]]; then
    TURN_MODE="oci"
  elif [[ "$TURN_MODE" == "auto" ]]; then
    TURN_MODE="local"
  fi

  if [[ "$TURN_MODE" == "oci" ]]; then
    configure_oci_turn
    return
  fi

  if [[ "$TURN_MODE" != "local" ]]; then
    echo "Unsupported TURN_MODE=$TURN_MODE. Use auto, oci, or local."
    exit 1
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required for TURN_MODE=local but was not found in PATH."
    echo "Install Docker, use TURN_MODE=oci, or run with TURN_ENABLED=0 ./run.sh."
    exit 1
  fi

  local turn_username
  local turn_password

  turn_username="${TURN_USERNAME:-$(env_file_value TURN_USERNAME)}"
  turn_password="${TURN_PASSWORD:-$(env_file_value TURN_PASSWORD)}"
  turn_username="${turn_username:-sakura}"

  if [[ -z "$turn_password" || "$turn_password" == "change-me" ]]; then
    turn_password="$(random_secret)"
  fi

  if [[ "$TURN_HOST" == "auto" ]]; then
    turn_host="$(detect_public_ip)"
    if [[ -z "$turn_host" ]]; then
      echo "Could not auto-detect public IP for TURN_HOST."
      echo "Set TURN_HOST explicitly, for example TURN_HOST=localhost ./run.sh"
      exit 1
    fi
  else
    turn_host="$TURN_HOST"
  fi

  export TURN_USERNAME="$turn_username"
  export TURN_PASSWORD="$turn_password"
  export TURN_EXTERNAL_IP="${TURN_EXTERNAL_IP:-$turn_host}"
  export TURN_URLS="turn:$turn_host:3478?transport=udp,turn:$turn_host:3478?transport=tcp"
  export NEXT_PUBLIC_ICE_TRANSPORT_POLICY="${NEXT_PUBLIC_ICE_TRANSPORT_POLICY:-all}"

  echo "Starting fallback TURN server for this run..."
  echo "  TURN host: $turn_host"
  echo "  TURN ports: 3478 tcp/udp, 49160-49200 udp"
  echo "Cloudflare Tunnel does not expose TURN; those ports must be reachable by the other browser."
  docker compose -f "$TURN_COMPOSE_FILE" up -d
  turn_started="local"
}

if ! command -v lsof >/dev/null 2>&1; then
  echo "lsof is required to clear ports before startup but was not found in PATH."
  exit 1
fi

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

configure_turn

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
