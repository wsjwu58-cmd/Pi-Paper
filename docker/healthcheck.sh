#!/bin/bash
set -euo pipefail
curl --fail --silent http://127.0.0.1:8080/vnc.html >/dev/null
xdotool search --onlyvisible --name 'Pi-Paper' >/dev/null
