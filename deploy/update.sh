#!/bin/bash
# Rebuild the web bundle and restart the service (the forwards keep running).
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build -w web
systemctl --user restart lensa
