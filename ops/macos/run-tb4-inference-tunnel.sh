#!/bin/zsh
set -uo pipefail

typeset -r TB4_HOST="${NEXUS_TB4_HOST:-169.254.77.1}"
typeset -r TAILSCALE_HOST="${NEXUS_TAILSCALE_HOST:-100.107.237.37}"
typeset -r LOCAL_PORT="${NEXUS_LOCAL_PORT:-18080}"
typeset -r REMOTE_PORT="${NEXUS_REMOTE_PORT:-8080}"
typeset child_pid=''

cleanup() {
  if [[ -n "$child_pid" ]] && /bin/kill -0 "$child_pid" 2>/dev/null; then
    /bin/kill "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
}

terminate() {
  cleanup
  trap - EXIT
  exit 0
}

trap cleanup EXIT
trap terminate INT TERM

tb4_ready() {
  /usr/bin/nc -G 1 -z "$TB4_HOST" 22 >/dev/null 2>&1
}

while true; do
  if tb4_ready; then
    target_host="$TB4_HOST"
    route=tb4
  else
    target_host="$TAILSCALE_HOST"
    route=tailscale
  fi

  print "$(/bin/date -u +%FT%TZ) route=$route target=$target_host"
  /usr/bin/ssh \
    -N \
    -o BatchMode=yes \
    -o ConnectTimeout=5 \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=5 \
    -o ServerAliveCountMax=2 \
    -o StrictHostKeyChecking=yes \
    -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" \
    "kei@$target_host" &
  child_pid=$!

  while /bin/kill -0 "$child_pid" 2>/dev/null; do
    /bin/sleep 5
    if [[ "$route" == tailscale ]] && tb4_ready; then
      print "$(/bin/date -u +%FT%TZ) route=tb4 available; switching"
      /bin/kill "$child_pid" 2>/dev/null || true
      break
    fi
  done

  wait "$child_pid" 2>/dev/null || true
  child_pid=''
  /bin/sleep 1
done
