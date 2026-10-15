#!/bin/bash
set -euo pipefail
# Docker reuses the writable layer and process IDs after restart. These are
# temporary display/profile singleton locks, not project locks or user data.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 \
  /home/pi-paper/.config/VibePaper/SingletonLock \
  /home/pi-paper/.config/VibePaper/SingletonSocket \
  /home/pi-paper/.config/VibePaper/SingletonCookie
install -d -m 1777 /tmp/.X11-unix
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
chown pi-paper:pi-paper "$XDG_RUNTIME_DIR" /home/pi-paper /projects
# Compose file secrets preserve host ownership. Copy them into private runtime
# files before dropping privileges, so host files can retain mode 0600.
install -m 600 -o pi-paper -g pi-paper /run/secrets/vnc-password "$XDG_RUNTIME_DIR/vnc-password"
install -m 600 -o pi-paper -g pi-paper /run/secrets/keyring-password "$XDG_RUNTIME_DIR/keyring-password"
exec gosu pi-paper dbus-run-session -- /opt/pi-paper/docker/run-session.sh
