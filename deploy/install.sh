#!/bin/bash
# Idempotent: links the units, creates the env file only if absent, reloads systemd. Starts nothing.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
units=~/.config/systemd/user; envd=~/.config/lensa
mkdir -p "$units" "$envd"
ln -sfn "$here/lensa.service" "$units/lensa.service"
ln -sfn "$here/lensa-pf@.service" "$units/lensa-pf@.service"
if [ ! -e "$envd/lensa.env" ]; then
  (umask 077; sed "s#/home/ecs-user/project/rd/platform-ekplorasi#$(cd "$here/../.." && pwd)#g" "$here/lensa.env.example" > "$envd/lensa.env")
fi
chmod 600 "$envd/lensa.env"
systemctl --user daemon-reload
systemctl --user enable lensa.service # boot start under linger; enabling starts nothing now
echo "installed; start with: systemctl --user start lensa"
