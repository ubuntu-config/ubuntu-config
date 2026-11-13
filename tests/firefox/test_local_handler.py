"""Check that Firefox launches an executable chosen as a handler through GIO, in headless mode. See README.

Usage: test_local_handler.py FIREFOX OUT_DIR [--scope]

OUT_DIR is removed first, then receives the profile, Firefox's output in firefox.log, the handler, the files it
opens and a record of each launch. The handler is a shell script, and Firefox launches it three ways: with a URI, as
the application a URI scheme is opened with, with a file, as the application chosen for a MIME type, and with a file,
as the default application of a MIME type which a mailcap file names. Each launch has to pass the URI or the path of
the file unchanged, and has to run the handler through gio-launch-desktop, which sets GIO_LAUNCHED_DESKTOP_FILE_PID to
its process ID, and the handler keeps that process ID when gio-launch-desktop executes it.

With --scope, each launch also has to run the handler in a systemd scope of its own, app-gnome-handler-PID.scope,
which GLib with patches/glib2.0/scope-before-exec.patch creates when Firefox runs in a unit of the systemd user
instance. GLib names the scope after the base name of the executable, which Firefox quotes in the Exec key, so GLib
needs patches/glib2.0/executable-shell-quoting.patch for the name to be "handler".

Prints one line for each launch. When every check passed and Firefox exited with status 0, prints "RESULT: OK" and
exits with 0, and otherwise exits with 1.
"""

import json
import os
import shutil
import sys
import time

# No __pycache__ is left in the repository.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import driver  # noqa: E402

# Characters which shells, URIs and desktop entries treat specially. The URI is written as Firefox normalizes it.
URI = "https://example.com/a%20b/%25f?c=%27d%27&e=%22f%22&$HOME#g"
CHOSEN_NAME = "chosen file 'quoted' %f $HOME.txt"
MAILCAP_NAME = "mailcap file \"double\" %u.bin"
MAILCAP_TYPE = "application/x-local-handler-test"

HANDLER = r"""#!/bin/sh
# Records the argument, the process ID, the process ID gio-launch-desktop set and the cgroup of this launch.
record=%(out)s/launch-$$
{
  printf '%%s\n' "$1"
  printf '%%s\n' "$$"
  printf '%%s\n' "${GIO_LAUNCHED_DESKTOP_FILE_PID:-}"
  sed -n 's/^0:://p' /proc/$$/cgroup
} > "$record.tmp"
mv "$record.tmp" "$record"
"""

SCRIPT = r"""
let [resolve] = arguments;
try {
  const file = path => {
    const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    f.initWithPath(path);
    return f;
  };
  const handler = Cc["@mozilla.org/uriloader/local-handler-app;1"].createInstance(Ci.nsILocalHandlerApp);
  handler.executable = file(%(handler)s);
  handler.launchWithURI(Services.io.newURI(%(uri)s));

  const mime = Cc["@mozilla.org/mime;1"].getService(Ci.nsIMIMEService);
  const chosen = mime.getFromTypeAndExtension("text/plain", "txt");
  chosen.preferredApplicationHandler = handler;
  chosen.preferredAction = Ci.nsIHandlerInfo.useHelperApp;
  chosen.launchWithFile(file(%(chosen)s));

  Services.prefs.setStringPref("helpers.private_mailcap_file", %(mailcap)s);
  const mailcap = mime.getFromTypeAndExtension(%(mailcap_type)s, null);
  mailcap.preferredAction = Ci.nsIHandlerInfo.useSystemDefault;
  mailcap.launchWithFile(file(%(mailcap_file)s));
  resolve("launched");
} catch (e) {
  resolve("error " + e);
}
"""


def read_records(out_dir, count, timeout):
    """Returns the records of the launches, once there are count of them or timeout seconds passed."""
    deadline = time.time() + timeout
    while True:
        names = [name for name in os.listdir(out_dir) if name.startswith("launch-") and not name.endswith(".tmp")]
        if len(names) >= count or time.time() > deadline:
            break
        time.sleep(0.2)
    records = []
    for name in names:
        with open(os.path.join(out_dir, name)) as f:
            argument, pid, gio_pid, cgroup = (f.read().split("\n") + ["", "", "", ""])[:4]
        records.append({"argument": argument, "pid": pid, "gio_pid": gio_pid, "cgroup": cgroup})
    return records


def main():
    firefox, out_dir = sys.argv[1:3]
    want_scope = "--scope" in sys.argv[3:]
    out_dir = os.path.abspath(out_dir)
    profile = os.path.join(out_dir, "profile")
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(profile)

    handler = os.path.join(out_dir, "handler")
    with open(handler, "w") as f:
        f.write(HANDLER % {"out": out_dir})
    os.chmod(handler, 0o755)
    chosen = os.path.join(out_dir, CHOSEN_NAME)
    mailcap_file = os.path.join(out_dir, MAILCAP_NAME)
    for path in (chosen, mailcap_file):
        open(path, "w").close()
    mailcap = os.path.join(out_dir, "mailcap")
    with open(mailcap, "w") as f:
        f.write("%s; %s\n" % (MAILCAP_TYPE, handler))

    driver.write_prefs(profile, 0)
    os.environ["MOZ_HEADLESS"] = "1"
    proc, m = driver.start(firefox, profile, os.path.join(out_dir, "firefox.log"))
    ok = True
    try:
        result = m.script(SCRIPT % {key: json.dumps(value) for key, value in {
            "handler": handler, "uri": URI, "chosen": chosen, "mailcap": mailcap, "mailcap_type": MAILCAP_TYPE,
            "mailcap_file": mailcap_file}.items()})
        print("  script: %s" % result)
        ok = result == "launched"
    except (ConnectionError, OSError, RuntimeError) as e:
        print("  FAILED: %s" % e)
        ok = False

    records = read_records(out_dir, 3, 30)
    for name, argument in (("uri", URI), ("chosen", chosen), ("mailcap", mailcap_file)):
        record = next((r for r in records if r["argument"] == argument), None)
        if record is None:
            print("  %-8s FAIL: no launch with argument %r" % (name, argument))
            ok = False
            continue
        through_gio = record["gio_pid"] == record["pid"]
        scope = os.path.basename(record["cgroup"])
        in_scope = scope == "app-gnome-handler-%s.scope" % record["pid"]
        print("  %-8s argument passed unchanged, through gio-launch-desktop: %s, cgroup %s%s" % (
            name, through_gio, record["cgroup"], "" if in_scope or not want_scope else " FAIL"))
        ok = ok and through_gio and (in_scope or not want_scope)
    unexpected = [r["argument"] for r in records if r["argument"] not in (URI, chosen, mailcap_file)]
    if unexpected:
        print("  FAIL: launches with other arguments: %r" % unexpected)
        ok = False

    status = driver.quit(m, proc)
    print("  exit status %s" % status)
    ok = ok and status == 0
    print("RESULT: %s" % ("OK" if ok else "FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
