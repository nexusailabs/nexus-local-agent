#!/usr/bin/env bash
set -euo pipefail
IFACE="${1:-}"
if [[ -z "$IFACE" ]]; then
  echo "usage: $0 <thunderbolt-net-interface>" >&2
  ip -brief link >&2
  exit 2
fi
sudo ip link set "$IFACE" up
sudo ip addr flush dev "$IFACE"
sudo ip addr add 169.254.77.2/24 dev "$IFACE"
echo "Z13 TB4 address configured: 169.254.77.2/24 on $IFACE"
