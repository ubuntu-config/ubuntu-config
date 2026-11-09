"""Check that Multi-Account Containers reopens a page in the window of the tab it replaces, in headless mode. See README.

Usage: test_container_tab_window.py FIREFOX OUT_DIR [XPI]

OUT_DIR is removed first, then receives the profile, Firefox's output in firefox.log, the page the test opens and the
add-on, built by firefox-addons/build-addon.py from firefox-addons/multi-account-containers/ unless XPI names another
build of it. Firefox has to load unsigned add-ons from its application directory, where configure-gnome-desktop.sh
installs the add-on, which the test checks with AppConstants.MOZ_UNSIGNED_APP_SCOPE. The add-on is installed as a
temporary add-on, which needs no signature either, so that the test runs without root. The test assigns the host of
a page served on 127.0.0.1 to the first container, without asking, opens a second window, B, which then has the
focus, and opens the page in a new tab of the first window, A. The add-on has to reopen the page in a tab of the
container in window A and remove the tab it replaces, and window B has to keep its only tab.

Prints one line for each check. When every check passed and Firefox exited with status 0, prints "RESULT: OK" and
exits with 0, and otherwise exits with 1.
"""

import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import threading
import time

# No __pycache__ is left in the repository.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import driver  # noqa: E402

ADDON_ID = "@testpilot-containers"
REPO_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def run(m, body):
    """Runs body, the statements of an async function which calls resolve() with its result, in the chrome context."""
    return m.script("let [resolve] = arguments; (async () => {" + body + "})().catch(e => resolve('error: ' + e));")


def main():
    firefox, out = sys.argv[1:3]
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    if len(sys.argv) > 3:
        xpi = os.path.abspath(sys.argv[3])
    else:
        xpi = os.path.join(out, ADDON_ID + ".xpi")
        subprocess.run([sys.executable, "-I", os.path.join(REPO_DIR, "firefox-addons", "build-addon.py"),
                        os.path.join(REPO_DIR, "firefox-addons", "multi-account-containers"), xpi], check=True)
    with open(os.path.join(out, "page.html"), "w") as f:
        f.write("<!DOCTYPE html><title>page</title><p>page\n")
    # The add-on assigns pages to containers by host and port, so the page is served over HTTP.
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(QuietHandler, directory=out))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    page = "http://127.0.0.1:%d/page.html" % port

    profile = os.path.join(out, "profile")
    os.makedirs(profile)
    driver.write_prefs(profile, 0)
    os.environ["MOZ_HEADLESS"] = "1"
    proc, m = driver.start(firefox, profile, os.path.join(out, "firefox.log"))

    driver.report("unsigned add-ons load from the application directory: %s", run(m, """
        const {AppConstants} = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
        resolve(AppConstants.MOZ_UNSIGNED_APP_SCOPE);
    """), True)
    m.call("Addon:Install", {"path": xpi, "temporary": True})
    # The add-on reads an assignment from its storage, under the host and port of the page.
    print("assignment: %s" % run(m, """
        const {ExtensionStorageIDB} = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
        let policy = WebExtensionPolicy.getByID(%s);
        let db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(policy.extension));
        await db.set({"siteContainerMap@@_127.0.0.1%d": {userContextId: "1", neverAsk: true}});
        resolve("container 1 for 127.0.0.1:%d");
    """ % (json.dumps(ADDON_ID), port, port)), flush=True)
    driver.open_windows(m, 1)
    time.sleep(2)

    # Each window is listed with the page and the container of each of its tabs.
    windows = json.loads(run(m, """
        let [a, b] = Array.from(Services.wm.getEnumerator("navigator:browser"));
        b.focus();
        await new Promise(r => setTimeout(r, 1000));
        let focused = Services.wm.getMostRecentWindow("navigator:browser") === b ? "B" : "A";
        a.gBrowser.addTab(%s, {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});
        await new Promise(r => setTimeout(r, 4000));
        let tabs = win => win.gBrowser.tabs.map(tab => [tab.linkedBrowser.currentURI.spec, tab.userContextId]);
        resolve(JSON.stringify({focused, a: tabs(a), b: tabs(b)}));
    """ % json.dumps(page)))
    print("window A: %s" % windows["a"], flush=True)
    print("window B: %s" % windows["b"], flush=True)
    driver.report("window with the focus when the page opens: %s", windows["focused"], "B")
    driver.report("tabs of window A: %s", windows["a"], [["about:blank", 0], [page, 1]])
    driver.report("tabs of window B: %s", windows["b"], [["about:blank", 0]])
    driver.report("exit status %s", driver.quit(m, proc), 0)

    print("RESULT: %s" % ("OK" if not driver.failures else "%d check(s) failed" % len(driver.failures)), flush=True)
    return 1 if driver.failures else 0


if __name__ == "__main__":
    sys.exit(main())
