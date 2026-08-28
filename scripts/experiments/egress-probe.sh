#!/usr/bin/env bash
# Thin wrapper so operators, run-cell.sh, and CI invoke the egress probe
# uniformly. All logic (and its unit tests) lives in egress-probe.mjs.
#
# Usage: egress-probe.sh --endpoint-host <host> --proxy-url <url> \
#          [--non-allowlisted-host <host>]
# Prints a machine-readable JSON report on stdout; exits 0 only when
# 1) direct egress is blocked, 2) proxied non-allowlisted egress is rejected,
# and 3) the proxied model endpoint CONNECT succeeds.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$script_dir/egress-probe.mjs" "$@"
