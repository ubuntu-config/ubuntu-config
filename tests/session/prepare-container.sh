#!/usr/bin/env bash
#
# Prepare a container for run-session-tests.sh. See README.
#
# Usage: [SESSION_TEST_APPS=APP...] prepare-container.sh DEBS_DIR...
#
# Runs as root in a container, and refuses to run anywhere else, as it installs packages and system files. Installs a
# GNOME session as Ubuntu ships it, with the applications the tests run, then the packages from the .deb files in each
# DEBS_DIR over the installed ones of the same name, and Firefox from there, which Ubuntu has only as a snap. A package
# in a later DEBS_DIR replaces one of the same name in an earlier one, so a build to test can come after the local
# repository. Chromium is installed when a configured repository has it, as the xtradeb one does. Then installs this
# repository's session files where configure-gnome-desktop.sh installs them, and the files the tests need besides,
# with Just Perfection and V-Shell from extensions.gnome.org, which change the top bar on the configured desktop.
#
# SESSION_TEST_APPS names further applications to install, for the tests of the global menu, so that each test
# installs only the ones it runs:
#
#   signal        Signal Desktop, from the repository in sources.list.d/
#   vscode        Visual Studio Code, from the repository in sources.list.d/
#   libreoffice   LibreOffice Writer, with its GTK 3 interface
#   qt            PyQt6, with Qt's Wayland platform
#   gtk           GTK 3 and GTK 4 for Python
#   ibus          IBus with its Pinyin engine, an input method which composes Chinese text from the letters typed

set -euo pipefail

REPO_DIR=$(readlink -f "$(dirname "$(readlink -f "$0")")/../..")
HERE=$REPO_DIR/tests/session

[ "$(id -u)" = 0 ] || { echo "prepare-container.sh has to run as root, in a container" >&2; exit 2; }
[ -e /.dockerenv ] || [ -e /run/.containerenv ] || { echo "prepare-container.sh runs only in a container" >&2; exit 2; }

export DEBIAN_FRONTEND=noninteractive

# The packages of a GNOME session on Ubuntu, without the services of the machine, and the applications the tests run.
# Python runs the tests, and xdg-utils and the portals open links and files as they do on the desktop. --no-upgrade
# keeps the installed packages as they are, as apt-get would otherwise replace a package built here, when this runs
# again, with Ubuntu's package of the same version.
apt-get update -q
apt-get install -y -q --no-install-recommends --no-upgrade \
  at-spi2-core dbus dbus-user-session dconf-cli dconf-gsettings-backend fonts-dejavu-core gnome-session gnome-shell \
  gnome-shell-extension-appindicator gnome-shell-extension-ubuntu-dock gnome-text-editor gsettings-desktop-schemas \
  libdbusmenu-gtk3-4 procps ptyxis python3 python3-gi systemd ubuntu-session util-linux xdg-desktop-portal \
  xdg-desktop-portal-gnome xdg-utils
if [ -n "$(apt-cache policy chromium 2>/dev/null | awk '/Candidate:/ && $2 != "(none)" {print $2}')" ]; then
  apt-get install -y -q --no-install-recommends --no-upgrade chromium chromium-driver chromium-sandbox
fi
apps=()
for app in ${SESSION_TEST_APPS:-}; do
  case $app in
    signal)
      cp "$REPO_DIR/sources.list.d/signal-desktop.sources" /etc/apt/sources.list.d/
      apps+=(signal-desktop)
      ;;
    vscode)
      cp "$REPO_DIR/sources.list.d/vscode.sources" /etc/apt/sources.list.d/
      apps+=(code)
      ;;
    libreoffice) apps+=(libreoffice-writer libreoffice-gtk3) ;;
    qt) apps+=(python3-pyqt6 qt6-wayland) ;;
    gtk) apps+=(gir1.2-gtk-3.0 gir1.2-gtk-4.0) ;;
    ibus) apps+=(ibus ibus-libpinyin) ;;
    *) echo "unknown application $app in SESSION_TEST_APPS" >&2; exit 2 ;;
  esac
done
if [ ${#apps[@]} -gt 0 ]; then
  apt-get update -q
  apt-get install -y -q --no-install-recommends --no-upgrade "${apps[@]}"
fi

# The packages built here replace the installed ones of the same name, and Firefox is installed from them.
declare -A debs=()
for dir in "$@"; do
  for deb in "$dir"/*.deb; do
    [ -e "$deb" ] || continue
    package=$(dpkg-deb -f "$deb" Package)
    if [ "$package" = firefox ] || dpkg -s "$package" >/dev/null 2>&1; then
      debs[$package]=$deb
    fi
  done
done
if [ ${#debs[@]} -gt 0 ]; then
  echo "installing ${!debs[*]}"
  # dpkg installs each file also when the same version is installed already, as a build of Ubuntu's version is, which
  # apt-get would skip. apt-get then installs the dependencies which the installed packages do not provide.
  dpkg -i "${debs[@]}" || apt-get install -y -q --no-install-recommends -f
fi

# This repository's session files, where configure-gnome-desktop.sh installs them.
install -D -m 644 "$REPO_DIR/systemd/user/app-.scope.d/50-graphical-session.conf" \
  /etc/systemd/user/app-.scope.d/50-graphical-session.conf
install -D -m 644 "$REPO_DIR/systemd/user/org.gnome.Shell@.service.d/50-before-application-scopes.conf" \
  /etc/systemd/user/org.gnome.Shell@.service.d/50-before-application-scopes.conf
install -D -m 644 "$REPO_DIR/systemd/user/at-spi-dbus-bus.service.d/50-stop-launcher-only.conf" \
  /etc/systemd/user/at-spi-dbus-bus.service.d/50-stop-launcher-only.conf
install -D -m 644 "$REPO_DIR/systemd/user/xdg-desktop-portal-gtk.service.d/50-requisite-graphical-session.conf" \
  /etc/systemd/user/xdg-desktop-portal-gtk.service.d/50-requisite-graphical-session.conf
install -D -m 755 "$REPO_DIR/stop-application-scopes.sh" /usr/local/libexec/stop-application-scopes
install -D -m 755 "$REPO_DIR/stop-application-scopes-before-shutdown.py" /usr/local/libexec/stop-application-scopes-before-shutdown
install -D -m 755 "$REPO_DIR/global-menu-registrar.py" /usr/local/libexec/global-menu-registrar
for unit in stop-application-scopes.service stop-application-scopes-before-shutdown.service global-menu-registrar.service; do
  install -m 644 "$REPO_DIR/systemd/user/$unit" "/etc/systemd/user/$unit"
  systemctl --global enable --quiet "$unit"
done
if [ -d /etc/chromium.d ]; then
  install -m 644 "$REPO_DIR/chromium.d/wayland-session-management" /etc/chromium.d/wayland-session-management
  # Only for the tests: a new profile starts without the questions of a first start, and without a keyring to unlock.
  # The file is sourced by /usr/bin/chromium, which expands the variable.
  # shellcheck disable=SC2016
  echo 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-first-run --no-default-browser-check --password-store=basic"' \
    > /etc/chromium.d/session-test
  # Chromium reopens the windows of the last session with the policy of this repository, which
  # configure-gnome-desktop.sh installs too, and which the tests of the windows' placement need.
  install -D -m 644 "$REPO_DIR/chromium-policies/restore-on-startup.json" \
    /etc/chromium/policies/recommended/restore-on-startup.json
  install -D -m 755 "$REPO_DIR/chromium-quit.sh" /usr/local/libexec/chromium-quit
  install -D -m 644 "$REPO_DIR/chromium-native-messaging-hosts/local.chromium_quit.json" \
    /etc/chromium/native-messaging-hosts/local.chromium_quit.json
  rm -rf /usr/share/chromium/extensions/quit-shortcut
  mkdir -p /usr/share/chromium/extensions
  cp -r "$REPO_DIR/chromium-extensions/quit-shortcut" /usr/share/chromium/extensions/quit-shortcut
fi

# GNOME Shell runs headless, with a virtual monitor, as the container has no display. The unit refuses to start
# outside of a Wayland session, which the test session is, but whose type only gnome-session sets.
mkdir -p /etc/systemd/user/org.gnome.Shell@.service.d
cat > /etc/systemd/user/org.gnome.Shell@.service.d/90-session-test-headless.conf <<'EOF'
[Unit]
AssertEnvironment=

[Service]
ExecStart=
ExecStart=/usr/bin/gnome-shell --headless --virtual-monitor 1920x1080 --mode=%i
EOF

# Firefox saves its session every second instead of every 15, so that the tests do not wait as long, and a new profile
# starts without the pages and questions of a first start.
if [ -x /usr/lib/firefox/firefox ]; then
  mkdir -p /etc/firefox/policies
  cat > /etc/firefox/policies/policies.json <<'EOF'
{
  "policies": {
    "DisableAppUpdate": true,
    "DisableTelemetry": true,
    "DontCheckDefaultBrowser": true,
    "OverrideFirstRunPage": "",
    "OverridePostUpdatePage": "",
    "UserMessaging": {"WhatsNew": false, "ExtensionRecommendations": false, "FeatureRecommendations": false, "SkipOnboarding": true, "MoreFromMozilla": false},
    "Preferences": {
      "browser.sessionstore.interval": {"Value": 1000, "Status": "user"},
      "browser.aboutwelcome.enabled": {"Value": false, "Status": "user"}
    }
  }
}
EOF
  # Firefox reads only one policies.json, so the preferences of this repository's firefox/policies.json, which
  # configure-gnome-desktop.sh installs, join the ones of the tests: Firefox restores the windows of the last session
  # when it starts and opens links from other applications in a new window, as on the desktop.
  python3 - "$REPO_DIR/firefox/policies.json" /etc/firefox/policies/policies.json <<'EOF'
import json
import sys

repository, tests = (json.load(open(path)) for path in sys.argv[1:])
tests["policies"]["Preferences"].update(repository["policies"]["Preferences"])
with open(sys.argv[2], "w") as file:
    json.dump(tests, file, indent=2)
EOF
fi

# The extension through which the tests drive GNOME Shell, for every user of the container.
rm -rf /usr/share/gnome-shell/extensions/session-test@mitar.tnode.com
cp -r "$HERE/session-test@mitar.tnode.com" /usr/share/gnome-shell/extensions/

# The extensions which change the top bar on the configured desktop, Just Perfection and V-Shell, which
# configure-gnome-desktop.sh installs from extensions.gnome.org. Each is installed in the newest version for this
# GNOME Shell, as the desktop updates them daily, with its schemas compiled, as GNOME Shell does when it installs one.
# The tests of the global menu enable them with this repository's settings.
shell_version=$(gnome-shell --version | sed -n 's/^GNOME Shell \([0-9]*\).*/\1/p')
for uuid in just-perfection-desktop@just-perfection vertical-workspaces@G-dH.github.com; do
  python3 -I - "$uuid" "$shell_version" /usr/share/gnome-shell/extensions <<'EOF_PYTHON'
import io, json, pathlib, shutil, sys, urllib.parse, urllib.request, zipfile

uuid, shell_version, root = sys.argv[1:]
query = urllib.parse.urlencode({"uuid": uuid, "shell_version": shell_version})
with urllib.request.urlopen(f"https://extensions.gnome.org/extension-info/?{query}", timeout=60) as reply:
    info = json.load(reply)
with urllib.request.urlopen(f"https://extensions.gnome.org{info['download_url']}", timeout=300) as reply:
    data = reply.read()
target = pathlib.Path(root) / uuid
shutil.rmtree(target, ignore_errors=True)
zipfile.ZipFile(io.BytesIO(data)).extractall(target)
print(f"{uuid}: version {info['version']} from extensions.gnome.org")
EOF_PYTHON
  if [ -d "/usr/share/gnome-shell/extensions/$uuid/schemas" ]; then
    glib-compile-schemas "/usr/share/gnome-shell/extensions/$uuid/schemas"
  fi
done
