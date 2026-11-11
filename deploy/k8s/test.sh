#!/usr/bin/env bash
# Offline test of deploy/k8s (plan S4-S6): `deploy/k8s/test.sh`. Needs bash, python3 + PyYAML. No cluster, no kubectl.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I "$here/test/check.py" "$here/render.sh" "$here/test/fixtures"
