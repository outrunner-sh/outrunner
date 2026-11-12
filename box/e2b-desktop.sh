#!/bin/bash
# The desktop on an E2B box (the Desktop tab): a virtual display, Xfce for the
# box user, x11vnc on loopback, and noVNC's proxy on 6080 for the browser. E2B
# has no desktop of its own (Daytona's computer use is the other providers'),
# so lib/runtime/sandbox/e2b.ts runs this, as root:
#
#   outrunner-desktop start      start what isn't running; leave what is
#   outrunner-desktop password   set a new VNC password and print it
#
# The proxy's port is reachable from outside the box (E2B's cloud gives every
# port a public host), so the VNC server asks for a password, a new one each
# time the Desktop tab opens: a link that leaks is worthless once the next one
# is made. VNC uses the first 8 characters, so it's 8 random ones.
set -eu

DISPLAY_NUM=:1
RESOLUTION=1280x800x24
VNC_PORT=5901
NOVNC_PORT=6080
BOX_USER=runtime
PASSWORD_FILE=/run/outrunner-desktop/vnc-password
LOGS=/tmp/outrunner-desktop

running() { pgrep -f "$1" >/dev/null 2>&1; }

start() {
  mkdir -p "$LOGS" "$(dirname "$PASSWORD_FILE")"
  chmod 700 "$(dirname "$PASSWORD_FILE")"
  # x11vnc reads the file at each connection: one there before the first
  # password is asked for refuses everyone.
  [ -s "$PASSWORD_FILE" ] || new_password >/dev/null

  if ! running "Xvfb $DISPLAY_NUM"; then
    Xvfb "$DISPLAY_NUM" -screen 0 "$RESOLUTION" -nolisten tcp >"$LOGS/xvfb.log" 2>&1 &
  fi
  i=0
  while [ ! -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  [ -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ] || { echo "the display didn't start" >&2; exit 1; }

  if ! running "xfce4-session"; then
    su - "$BOX_USER" -c "DISPLAY=$DISPLAY_NUM dbus-launch --exit-with-session startxfce4" >"$LOGS/xfce.log" 2>&1 &
  fi
  if ! running "x11vnc .*-rfbport $VNC_PORT"; then
    x11vnc -display "$DISPLAY_NUM" -rfbport "$VNC_PORT" -localhost -forever -shared -noxdamage \
      -passwdfile "read:$PASSWORD_FILE" >"$LOGS/x11vnc.log" 2>&1 &
  fi
  if ! running "websockify.*$NOVNC_PORT"; then
    websockify "0.0.0.0:$NOVNC_PORT" "localhost:$VNC_PORT" >"$LOGS/websockify.log" 2>&1 &
  fi
  i=0
  while ! (echo >"/dev/tcp/127.0.0.1/$NOVNC_PORT") 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
}

new_password() {
  mkdir -p "$(dirname "$PASSWORD_FILE")"
  password=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 8)
  umask 077
  printf '%s\n' "$password" >"$PASSWORD_FILE.new"
  mv "$PASSWORD_FILE.new" "$PASSWORD_FILE"
  printf '%s\n' "$password"
}

case "${1:-}" in
  start) start ;;
  password) new_password ;;
  *) echo "usage: outrunner-desktop start|password" >&2; exit 2 ;;
esac
