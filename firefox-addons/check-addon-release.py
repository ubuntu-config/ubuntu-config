#!/usr/bin/env python3
"""Report a release of a patched Firefox add-on other than the one firefox-addons/ pins.

Usage: check-addon-release.py ADDON_DIR [--state FILE]

ADDON_DIR is a directory of firefox-addons/, whose file "release" names the add-on's ID ("id") and the version it
pins ("version"), see build-addon.py. The version addons.mozilla.org offers is read from its API, and when it is not
the pinned one, the patches of ADDON_DIR are applied to it with build-addon.py. The report names both versions, says
whether the patches apply, and when they do, gives the lines "release" needs for the offered version. Prints nothing
while the pinned version is the one offered.

With --state, FILE records the version reported last, so that each version is reported once: nothing is printed while
addons.mozilla.org offers the version FILE names, and FILE is written after a report.

Exits with 1 and a message on standard error when addons.mozilla.org cannot be queried, and with 0 otherwise, also
when the patches do not apply, which the report says.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://addons.mozilla.org/api/v5/addons/addon/%s/"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("addon_dir")
    parser.add_argument("--state")
    args = parser.parse_args()
    addon_dir = os.path.abspath(args.addon_dir)
    name = os.path.basename(addon_dir.rstrip("/"))
    release = {}
    with open(os.path.join(addon_dir, "release")) as f:
        for line in f:
            if line.strip():
                key, value = line.split(None, 1)
                release[key] = value.strip()

    try:
        with urllib.request.urlopen(API % urllib.parse.quote(release["id"], safe=""), timeout=60) as response:
            current = json.load(response)["current_version"]
    except (OSError, ValueError, KeyError) as e:
        sys.exit("cannot read the release of %s from addons.mozilla.org: %s" % (release["id"], e))
    version = current["version"]
    url = current["file"]["url"]
    algorithm, _, digest = current["file"]["hash"].partition(":")
    if version == release["version"]:
        return 0
    if args.state and os.path.exists(args.state):
        with open(args.state) as f:
            if f.read().strip() == version:
                return 0

    print("Firefox add-on %s: addons.mozilla.org offers %s, firefox-addons/%s/release pins %s."
          % (release["id"], version, name, release["version"]))
    if algorithm != "sha256":
        print("addons.mozilla.org gives no SHA-256 of %s but %s, so the patches were not tried on it."
              % (version, algorithm))
    else:
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run([sys.executable, "-I", os.path.join(HERE, "build-addon.py"), addon_dir,
                                     os.path.join(tmp, "addon.xpi"), "--url", url, "--sha256", digest],
                                    capture_output=True, text=True)
        if result.returncode == 0:
            print("The patches apply to %s. To use it, change firefox-addons/%s/release to:" % (version, name))
            print()
            print("    id %s" % release["id"])
            print("    version %s" % version)
            print("    url %s" % url)
            print("    sha256 %s" % digest)
            print()
            print("and install it with configure-gnome-desktop.sh --apply and install-rebuild-patched-packages.sh --apply.")
        else:
            print("The patches do not apply to %s:" % version)
            print((result.stdout + result.stderr).rstrip())
    if args.state:
        with open(args.state + ".tmp", "w") as f:
            f.write(version + "\n")
        os.replace(args.state + ".tmp", args.state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
