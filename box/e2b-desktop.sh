#!/bin/bash
# The desktop on an E2B box (the Desktop tab): a virtual display, Xfce for the
# box user, x11vnc on loopback, and noVNC's proxy on 6080 for the browser. E2B
# has no desktop of its own (Daytona's computer use is the other providers'),
# so lib/runtime/sandbox/e2b.ts runs this, as root:
#
#   outrunner-desktop start            start what isn't running; leave what is
#   outrunner-desktop password [TTL]   set a new VNC password and print it; with
#                                      TTL seconds, it's replaced after them
#
# The proxy's port is reachable from outside the box (E2B's cloud gives every
# port a public host), so the VNC server asks for a password: a new one each
# time the Desktop tab opens, good only for the link's few minutes. A viewer
# already connected stays (x11vnc checks the password as one connects), and a
# link that leaks is worthless once it lapses or the next one is made. VNC
# uses the first 8 characters, so it's 8 random ones.
#
# Calls run one at a time (flock): two tabs opening at once mustn't start the
# desktop twice, nor a password's expiry replace a newer link's. Nothing this
# starts keeps the lock's descriptor (9>&-), or the next call would wait on
# the desktop for good.
set -eu

DISPLAY_NUM=:1
RESOLUTION=1280x800x24
VNC_PORT=5901
NOVNC_PORT=6080
BOX_USER=runtime
STATE=/run/outrunner-desktop
PASSWORD_FILE=$STATE/vnc-password
LOGS=/tmp/outrunner-desktop

running() { pgrep -f "$1" >/dev/null 2>&1; }

# Hold the desktop's lock until this call ends.
lock() {
  mkdir -p "$STATE"
  chmod 700 "$STATE"
  exec 9>"$STATE/lock"
  flock 9
}

listening() { (echo >"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

start() {
  mkdir -p "$LOGS"
  # x11vnc reads the file at each connection: one there before the first
  # password is asked for refuses everyone.
  [ -s "$PASSWORD_FILE" ] || new_password >/dev/null

  if ! running "Xvfb $DISPLAY_NUM"; then
    Xvfb "$DISPLAY_NUM" -screen 0 "$RESOLUTION" -nolisten tcp >"$LOGS/xvfb.log" 2>&1 9>&- &
  fi
  i=0
  while [ ! -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  [ -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ] || { echo "the display didn't start" >&2; exit 1; }

  if ! running "xfce4-session"; then
    su - "$BOX_USER" -c "DISPLAY=$DISPLAY_NUM dbus-launch --exit-with-session startxfce4" >"$LOGS/xfce.log" 2>&1 9>&- &
  fi
  if ! running "x11vnc .*-rfbport $VNC_PORT"; then
    x11vnc -display "$DISPLAY_NUM" -rfbport "$VNC_PORT" -localhost -forever -shared -noxdamage \
      -passwdfile "read:$PASSWORD_FILE" >"$LOGS/x11vnc.log" 2>&1 9>&- &
  fi
  if ! running "websockify.*$NOVNC_PORT"; then
    websockify "0.0.0.0:$NOVNC_PORT" "localhost:$VNC_PORT" >"$LOGS/websockify.log" 2>&1 9>&- &
  fi
  i=0
  while ! listening "$NOVNC_PORT" && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  # A link to a proxy that isn't there would only spin: said here instead.
  listening "$NOVNC_PORT" || { echo "noVNC's proxy didn't start: $(tail -n 3 "$LOGS/websockify.log" 2>/dev/null)" >&2; exit 1; }
}

new_password() {
  password=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 8)
  umask 077
  printf '%s\n' "$password" >"$PASSWORD_FILE.new"
  mv "$PASSWORD_FILE.new" "$PASSWORD_FILE"
  printf '%s\n' "$password"
}

# A new password, printed; with a TTL, replaced by one nobody has once it
# lapses, unless a newer link's has replaced it first.
password() {
  new_password
  ttl=${1:-}
  [ -z "$ttl" ] && return
  case "$ttl" in *[!0-9]*) echo "TTL must be whole seconds" >&2; exit 2 ;; esac
  # Detached, so it outlives this call, and without the lock (fd 9), which
  # it would otherwise hold through its sleep. It's given the password's
  # digest, never the password: a process's arguments are anyone's to read
  # in the box (ps), where the password file is root's alone.
  setsid sh -c "sleep $ttl; exec \"$0\" expire $(digest "$password")" </dev/null >/dev/null 2>&1 9>&- &
}

# A password's digest, enough to tell it from another.
digest() { printf '%s' "$1" | sha256sum | cut -c1-16; }

# Replace the password if it's still the one with digest $1.
expire() {
  [ "$(digest "$(head -n1 "$PASSWORD_FILE" 2>/dev/null)")" = "$1" ] && new_password >/dev/null
  return 0
}

case "${1:-}" in
  start) lock; start ;;
  password) lock; password "${2:-}" ;;
  expire) lock; expire "${2:?}" ;;
  *) echo "usage: outrunner-desktop start|password [TTL]" >&2; exit 2 ;;
esac
