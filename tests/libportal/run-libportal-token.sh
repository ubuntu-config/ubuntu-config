#!/usr/bin/env bash
#
# Run libportal_token.py against a headless mutter of its own, in a D-Bus session of its own. See README.
#
# Usage: run-libportal-token.sh MUTTER_ROOT LIBPORTAL_ROOT OUT_DIR
#
# MUTTER_ROOT is a directory the mutter and libmutter-18-0 packages were extracted into, and LIBPORTAL_ROOT one the
# libportal1, libportal-gtk4-1, libportal-gtk3-1, gir1.2-xdp-1.0, gir1.2-xdpgtk4-1.0 and gir1.2-xdpgtk3-1.0 packages to
# test were extracted into. OUT_DIR is removed first, then receives the mutter log, the clients' logs and the requests
# the portal received. A temporary directory under /tmp, removed at the end, is the XDG runtime directory.

set -euo pipefail

# The private D-Bus session sees only the headless display, so that nothing it starts opens windows on your desktop.
if [ -z "${INSIDE_DBUS:-}" ]; then
  exec env -u DISPLAY WAYLAND_DISPLAY=libportal-test-$$ INSIDE_DBUS=1 dbus-run-session -- "$0" "$@"
fi

MUTTER_ROOT=$1
LIBPORTAL_ROOT=$(readlink -f "$2")
OUT=$(readlink -f "$3")
HERE=$(dirname "$(readlink -f "$0")")
DISPLAY_NAME=$WAYLAND_DISPLAY

rm -rf "$OUT"
mkdir -p "$OUT"
# It is kept short, because the Wayland socket is created in it and socket paths are limited to 108 bytes.
RUNTIME_DIR=$(mktemp -d /tmp/libportal-test.XXXXXX)
export XDG_RUNTIME_DIR=$RUNTIME_DIR

LIBDIR=$MUTTER_ROOT/usr/lib/x86_64-linux-gnu
env -u WAYLAND_DISPLAY LD_LIBRARY_PATH=$LIBDIR:$LIBDIR/mutter-18 "$MUTTER_ROOT/usr/bin/mutter" --headless --no-x11 \
  --virtual-monitor 1920x1080 --wayland-display "$DISPLAY_NAME" --mutter-plugin="$LIBDIR/mutter-18/plugins/libdefault.so" > "$OUT/mutter.log" 2>&1 &
MUTTER_PID=$!

cleanup() {
  kill "$MUTTER_PID" 2>/dev/null || true
  rm -rf "${RUNTIME_DIR:?}"
}
trap cleanup EXIT

for _ in $(seq 100); do
  [ -S "$XDG_RUNTIME_DIR/$DISPLAY_NAME" ] && break
  sleep 0.1
done
[ -S "$XDG_RUNTIME_DIR/$DISPLAY_NAME" ] || { echo "mutter did not start, see $OUT/mutter.log" >&2; exit 1; }

PORTAL_LIBDIR=$LIBPORTAL_ROOT/usr/lib/x86_64-linux-gnu
env -u DISPLAY WAYLAND_DISPLAY="$DISPLAY_NAME" GDK_BACKEND=wayland \
  LD_LIBRARY_PATH="$PORTAL_LIBDIR" GI_TYPELIB_PATH="$PORTAL_LIBDIR/girepository-1.0" \
  python3 -I "$HERE/libportal_token.py" "$OUT"
