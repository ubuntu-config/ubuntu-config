#!/usr/bin/env python3
"""Build a patched Firefox add-on from its release on addons.mozilla.org.

Usage: build-addon.py ADDON_DIR OUT_XPI

ADDON_DIR is a directory of firefox-addons/ in this repository. Its file "release" names the add-on's ID ("id"), the
URL of the release ("url") and the SHA-256 of that file ("sha256"), one "key value" per line, and its file "series"
lists the patches to apply, in order. The release is downloaded and refused when its SHA-256 differs. Its signature,
META-INF/, is left out, since the patched files no longer match it, and the patches are applied to the other files.
Each patch is a commit of the add-on's repository, whose add-on files are below src/, and only its changes there are
applied, with patch -p2, without fuzz. The result is written to OUT_XPI with the order, dates and compression of the
entries of the release, so that building the same release with the same patches again writes the same bytes.

Exits with 1 and a message when the download fails, the SHA-256 differs or a patch does not apply.
"""

import hashlib
import io
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
import zipfile


def read_release(addon_dir):
    release = {}
    with open(os.path.join(addon_dir, "release")) as f:
        for line in f:
            if line.strip():
                key, value = line.split(None, 1)
                release[key] = value.strip()
    return release


def src_part(patch):
    """Returns the sections of patch which change files below src/, without its header."""
    sections = re.split(r"(?m)^(?=diff --git )", patch)
    return "".join(section for section in sections if section.startswith("diff --git a/src/"))


def main():
    addon_dir, out = sys.argv[1:3]
    release = read_release(addon_dir)
    with urllib.request.urlopen(release["url"], timeout=60) as response:
        data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != release["sha256"]:
        sys.exit("%s has SHA-256 %s instead of %s" % (release["url"], digest, release["sha256"]))

    with zipfile.ZipFile(io.BytesIO(data)) as xpi, tempfile.TemporaryDirectory() as tree:
        entries = [info for info in xpi.infolist() if not info.filename.startswith("META-INF/")]
        for info in entries:
            xpi.extract(info, tree)
        with open(os.path.join(addon_dir, "series")) as f:
            patches = [line.strip() for line in f if line.strip() and not line.startswith("#")]
        for name in patches:
            with open(os.path.join(addon_dir, name)) as f:
                diff = src_part(f.read())
            result = subprocess.run(["patch", "--batch", "--forward", "-p2", "-F", "0", "-d", tree], input=diff,
                                    capture_output=True, text=True)
            if result.returncode != 0:
                sys.exit("%s does not apply:\n%s%s" % (name, result.stdout, result.stderr))

        known = {info.filename for info in entries}
        added = sorted(os.path.relpath(os.path.join(root, f), tree) for root, _, files in os.walk(tree) for f in files)
        added = [name for name in added if name not in known]
        with zipfile.ZipFile(out + ".tmp", "w") as built:
            for info in entries:
                if info.is_dir():
                    built.writestr(info, b"")
                else:
                    with open(os.path.join(tree, info.filename), "rb") as f:
                        built.writestr(info, f.read())
            # Files a patch adds have no entry to copy the date from.
            for name in added:
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                with open(os.path.join(tree, name), "rb") as f:
                    built.writestr(info, f.read())
        os.replace(out + ".tmp", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
