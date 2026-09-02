#!/bin/zsh
set -u

repo=/Users/kei/projects/nexus-local-agent
proxy_pid=''

cleanup() {
  if [[ -n "$proxy_pid" ]]; then
    kill "$proxy_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

/usr/bin/python3 "$repo/ops/macos/tb4-http-proxy.py" 3128 &
proxy_pid=$!

while kill -0 "$proxy_pid" 2>/dev/null; do
  /usr/bin/ssh \
    -i /Users/kei/.ssh/id_ed25519 \
    -o BatchMode=yes \
    -o ConnectTimeout=5 \
    -o ServerAliveInterval=5 \
    -o ServerAliveCountMax=3 \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=/Users/kei/.ssh/nexus-z13-known-hosts \
    -o ExitOnForwardFailure=yes \
    -N -R 127.0.0.1:3128:127.0.0.1:3128 \
    kei@169.254.77.2 || true
  sleep 2
done

wait "$proxy_pid"
