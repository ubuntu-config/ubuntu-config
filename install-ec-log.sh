#!/usr/bin/env bash
#
# Install ec-log.py, its service and the blacklist of the kernel module which would read the same console, as
# root-owned copies that root runs, and start the service. Only a file which differs from its installed copy is
# replaced, and the service is restarted when its program or unit was replaced.
#
#   ec-log.py                        ->  /usr/local/bin/ec-log
#   systemd/ec-log.service           ->  /etc/systemd/system/ec-log.service
#   modprobe.d/cros-ec-debugfs.conf  ->  /etc/modprobe.d/cros-ec-debugfs.conf
#
#
# Usage
# -----
#   ./install-ec-log.sh           show what would change, change nothing (default)
#   ./install-ec-log.sh --apply   install
#
# Runs as your own user and calls sudo for the writes, which will ask for a password.

set -euo pipefail

MODE=dry-run
case "${1:-}" in
  ""|--dry-run) MODE=dry-run ;;
  --apply)      MODE=apply ;;
  -h|--help)    awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/, ""); print}' "$0"; exit 0 ;;
  *)            echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
esac

REPO_DIR=$(dirname "$(readlink -f "$0")")
CHANGED=0

install_file() {
  local src=$1 dst=$2 mode=$3
  cmp -s "$src" "$dst" && return 0
  echo "  install $dst"
  CHANGED=$((CHANGED+1))
  [ "$MODE" = apply ] || return 0
  sudo install -o root -g root -m "$mode" "$src" "$dst"
  return 0
}

# Collects missing packages, so that apt runs once for all of them.
want_package() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed' && return 0
  echo "  install package $1"
  MISSING_PACKAGES+=("$1")
  CHANGED=$((CHANGED+1))
  return 0
}

# Installs a systemd unit from systemd/ in this repository into the root-owned /etc/systemd/system through sudo.
install_unit() {
  local name=$1 dst=/etc/systemd/system/$1
  cmp -s "$REPO_DIR/systemd/$name" "$dst" && return 0
  echo "  install $dst"
  CHANGED=$((CHANGED+1))
  [ "$MODE" = apply ] || return 0
  sudo install -o root -g root -m 644 "$REPO_DIR/systemd/$name" "$dst"
  sudo systemctl daemon-reload
  return 0
}

# Installs a module blacklist from modprobe.d/ in this repository into the root-owned /etc/modprobe.d through sudo,
# then removes the module if it is loaded, which a blacklist alone does only from the next boot on.
install_modprobe_blacklist() {
  local name=$1 module=$2 src=$REPO_DIR/modprobe.d/$1 dst=/etc/modprobe.d/$1
  if ! cmp -s "$src" "$dst"; then
    echo "  install $dst"
    CHANGED=$((CHANGED+1))
    [ "$MODE" = apply ] && sudo install -m 644 "$src" "$dst"
  fi
  if [ -d "/sys/module/$module" ]; then
    echo "  remove module $module"
    CHANGED=$((CHANGED+1))
    if [ "$MODE" = apply ] && ! sudo modprobe -r "$module"; then
      echo "  $module is in use, so it stays loaded until the next boot"
    fi
  fi
  return 0
}

echo "=== packages ==="
MISSING_PACKAGES=()
# ec-log decodes a panic record with framework_tool, and logs to the journal through the Python bindings of systemd.
want_package framework-tool
want_package python3-systemd
if [ "$MODE" = apply ] && [ "${#MISSING_PACKAGES[@]}" -gt 0 ]; then
  sudo apt-get install "${MISSING_PACKAGES[@]}"
fi

# The module is removed before the service starts, so that the two never read the console at the same time.
echo "=== cros_ec_debugfs ==="
install_modprobe_blacklist cros-ec-debugfs.conf cros_ec_debugfs

echo "=== ec-log ==="
BEFORE=$CHANGED
install_file "$REPO_DIR/ec-log.py" /usr/local/bin/ec-log 755
install_unit ec-log.service
if ! systemctl is-enabled --quiet ec-log.service 2>/dev/null; then
  echo "  enable ec-log.service"
  CHANGED=$((CHANGED+1))
  [ "$MODE" = apply ] && sudo systemctl enable --now --quiet ec-log.service
elif [ "$CHANGED" -ne "$BEFORE" ] || ! systemctl is-active --quiet ec-log.service; then
  echo "  restart ec-log.service"
  CHANGED=$((CHANGED+1))
  [ "$MODE" = apply ] && sudo systemctl restart ec-log.service
fi

echo
if [ "$CHANGED" -eq 0 ]; then
  echo "already installed, nothing to change"
elif [ "$MODE" = apply ]; then
  echo "installed $CHANGED item(s)"
else
  echo "$CHANGED item(s) would be installed. Nothing was written, re-run with --apply."
fi
