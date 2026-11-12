#!/usr/bin/env bash
# Offline test of the image workflows and deploy/ci/image-checks.sh: `deploy/ci/test.sh`. Needs bash, python3 + PyYAML. No docker, no network.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I "$here/check.py" "$here"
