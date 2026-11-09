"""Check that libportal passes an activation token from a GTK 4 and a GTK 3 window when it opens a URI. See README.

Usage: libportal_token.py OUT_DIR
       libportal_token.py client TOOLKIT URI

The first form starts openuri_portal.py, runs the second form for each toolkit, an application which opens URI through
libportal for its window, with TOOLKIT gtk4 or gtk3, and checks the request the portal received. The second form needs
the libportal to test in LD_LIBRARY_PATH and GI_TYPELIB_PATH, and the Wayland display of a compositor with
xdg-activation in WAYLAND_DISPLAY.
"""

import json
import os
import re
import subprocess
import sys
import time

from gi.repository import Gio, GLib

URI = "https://example.com/libportal-token-test"
HERE = os.path.dirname(os.path.realpath(__file__))

failures = []


def check(condition, message):
    print(("ok:   " if condition else "FAIL: ") + message, flush=True)
    if not condition:
        failures.append(message)


def wait_until(predicate, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.2)
    return predicate()


def client(toolkit, uri):
    import gi
    gi.require_version("Gtk", "4.0" if toolkit == "gtk4" else "3.0")
    gi.require_version("Xdp", "1.0")
    gi.require_version("XdpGtk4" if toolkit == "gtk4" else "XdpGtk3", "1.0")
    from gi.repository import Gtk, Xdp
    if toolkit == "gtk4":
        from gi.repository import XdpGtk4 as XdpGtk
    else:
        from gi.repository import XdpGtk3 as XdpGtk

    app = Gtk.Application(application_id="org.example.LibportalTokenTest", flags=Gio.ApplicationFlags.NON_UNIQUE)

    def opened(portal, result):
        try:
            portal.open_uri_finish(result)
        except GLib.Error as error:
            print("open_uri failed: %s" % error.message, flush=True)
        app.quit()

    def activate(app):
        window = Gtk.ApplicationWindow(application=app)
        if toolkit == "gtk3":
            window.show_all()
        window.present()

        # The link is opened once the window is shown, as an application opens one when the user clicks it.
        def open_link():
            portal = Xdp.Portal.initable_new()
            portal.open_uri(XdpGtk.parent_new_gtk(window), uri, Xdp.OpenUriFlags.NONE, None, opened)
            return GLib.SOURCE_REMOVE

        GLib.timeout_add(1000, open_link)

    app.connect("activate", activate)
    app.run([])


def check_toolkit(toolkit, out, requests_path):
    """Runs the client for toolkit and checks the request it made, the last one in requests_path."""
    client_log = os.path.join(out, "client-%s.log" % toolkit)
    before = 0
    if os.path.exists(requests_path):
        with open(requests_path) as f:
            before = len(f.readlines())
    with open(client_log, "w") as log:
        result = subprocess.run([sys.executable, "-I", os.path.realpath(__file__), "client", toolkit, URI], stdout=log,
                                stderr=subprocess.STDOUT, env=dict(os.environ, WAYLAND_DEBUG="1"), timeout=60)
    check(result.returncode == 0, "%s: the client exited with status %s" % (toolkit, result.returncode))

    requests = []
    if os.path.exists(requests_path):
        with open(requests_path) as f:
            requests = [json.loads(line) for line in f.readlines()[before:]]
    print("%s: requests: %s" % (toolkit, requests), flush=True)
    check(len(requests) == 1 and requests[0]["method"] == "OpenURI" and requests[0]["uri"] == URI,
          "%s: the portal received one OpenURI request for the URI" % toolkit)
    request = requests[0] if requests else {"parent_window": "", "options": {}}
    check(request["parent_window"].startswith("wayland:"),
          "%s: the request names the client's Wayland window as its parent" % toolkit)
    token = request["options"].get("activation_token")
    check(isinstance(token, str) and token != "", "%s: the request carries an activation token (%r)" % (toolkit, token))

    # The token is the one the compositor created for the client.
    with open(client_log, errors="replace") as f:
        created = re.findall(r'xdg_activation_token_v1#\d+\.done\("([^"]*)"\)', f.read())
    check(token in created, "%s: the compositor created the token for the client (created %s)" % (toolkit, created))


def main():
    out = sys.argv[1]
    requests_path = os.path.join(out, "requests.json")
    portal = subprocess.Popen([sys.executable, "-I", os.path.join(HERE, "openuri_portal.py"), requests_path])
    bus = Gio.bus_get_sync(Gio.BusType.SESSION)
    check(wait_until(lambda: bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                                           "NameHasOwner", GLib.Variant("(s)", ("org.freedesktop.portal.Desktop",)),
                                           GLib.VariantType("(b)"), 0, -1, None).unpack()[0]),
          "the stand-in portal owns org.freedesktop.portal.Desktop")

    for toolkit in ("gtk4", "gtk3"):
        check_toolkit(toolkit, out, requests_path)
    portal.terminate()
    portal.wait()

    print("RESULT: %s" % ("OK" if not failures else "%d check(s) failed" % len(failures)), flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    if sys.argv[1] == "client":
        client(sys.argv[2], sys.argv[3])
    else:
        sys.exit(main())
