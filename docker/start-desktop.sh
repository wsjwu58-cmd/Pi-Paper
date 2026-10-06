#!/bin/bash
set -euo pipefail
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
chown pi-paper:pi-paper "$XDG_RUNTIME_DIR" /home/pi-paper /projects
# Compose file secrets preserve host ownership. Copy them into private runtime
# files before dropping privileges, so host files can retain mode 0600.
install -m 600 -o pi-paper -g pi-paper /run/secrets/vnc-password "$XDG_RUNTIME_DIR/vnc-password"
install -m 600 -o pi-paper -g pi-paper /run/secrets/keyring-password "$XDG_RUNTIME_DIR/keyring-password"
exec gosu pi-paper dbus-run-session -- /opt/pi-paper/docker/run-session.sh
