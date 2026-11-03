#!/bin/bash
# Rebuild the web bundle into dist.new and swap it in only if the build succeeds; then restart the server.
# A failed build leaves web/dist and the running service untouched (exit non-zero). The forwards keep running.
set -euo pipefail
cd "$(dirname "$0")/../web"
rm -rf dist.new
trap 'rm -rf dist.new' ERR # a failed build leaves no half-built dist.new behind; dist itself is never touched
npx tsc --noEmit
npx vite build --outDir dist.new --emptyOutDir
[ -f dist.new/index.html ] || { echo "update: dist.new has no index.html, nothing swapped" >&2; exit 1; }
rm -rf dist.old
if [ -d dist ]; then mv dist dist.old; fi
mv dist.new dist
rm -rf dist.old
systemctl --user restart lensa
