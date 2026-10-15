#!/bin/bash
set -euo pipefail
width="${SCREEN_WIDTH:-1600}"
height="${SCREEN_HEIGHT:-1000}"
[[ "$width" =~ ^[0-9]+$ && "$height" =~ ^[0-9]+$ ]] || { echo 'Screen dimensions must be integers.' >&2; exit 1; }
(( width >= 960 && width <= 4096 && height >= 640 && height <= 4096 )) || { echo 'Screen dimensions are outside the supported range.' >&2; exit 1; }
[[ -s "$XDG_RUNTIME_DIR/vnc-password" && -s "$XDG_RUNTIME_DIR/keyring-password" ]] || { echo 'Create the two password files before starting the desktop.' >&2; exit 1; }
vnc_password="$(cat "$XDG_RUNTIME_DIR/vnc-password")"
[[ ${#vnc_password} -eq 8 ]] || { echo 'The VNC password must contain exactly 8 ASCII characters.' >&2; exit 1; }
x11vnc -storepasswd "$vnc_password" "$XDG_RUNTIME_DIR/vnc.pass" >/dev/null
unset vnc_password
chmod 600 "$XDG_RUNTIME_DIR/vnc.pass"

# Persist the secret-service keyring in the desktop-home volume; unlock it using
# the host secret file on every start. Never pass provider keys via the image.
gnome-keyring-daemon --unlock --components=secrets < "$XDG_RUNTIME_DIR/keyring-password" >/dev/null
dbus-send --session --print-reply --dest=org.freedesktop.secrets \
  /org/freedesktop/secrets org.freedesktop.Secret.Service.ReadAlias string:default >/dev/null

pids=()
cleanup() {
  trap - EXIT
  if (( ${#pids[@]} )); then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM INT
Xvfb "$DISPLAY" -screen 0 "${width}x${height}x24" -nolisten tcp &
pids+=("$!")
ready=false
for attempt in {1..60}; do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.1
done
[[ "$ready" == true ]] || { echo 'Virtual display failed to start.' >&2; exit 1; }
openbox &
pids+=("$!")
x11vnc -display "$DISPLAY" -rfbport 5900 -localhost \
  -rfbauth "$XDG_RUNTIME_DIR/vnc.pass" -forever -shared -noxdamage -quiet &
pids+=("$!")
websockify --web=/usr/share/novnc 0.0.0.0:8080 127.0.0.1:5900 &
pids+=("$!")
# Container isolation replaces Chromium's OS sandbox here; Electron still uses
# contextIsolation and disables nodeIntegration in the original Renderer.
/opt/pi-paper/pi-paper --no-sandbox --disable-gpu --password-store=gnome-libsecret &
pids+=("$!")
wait -n "${pids[@]}"
