#!/usr/bin/env bash
set -euo pipefail
# Assign a deterministic link-local address to the Thunderbolt Bridge.
# Interface name varies; inspect with: networksetup -listallhardwareports
SERVICE="Thunderbolt Bridge"
networksetup -setmanual "$SERVICE" 169.254.77.1 255.255.255.0
networksetup -setv6off "$SERVICE" || true
echo "MBP TB4 address configured: 169.254.77.1/24"
