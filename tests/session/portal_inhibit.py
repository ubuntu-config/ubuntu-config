#!/usr/bin/env python3
"""Inhibits logging out through the Inhibit portal and closes the request right after, as GTK does when an application
uninhibits right after inhibiting. See README.

Usage: portal_inhibit.py COUNT OUT_FILE

Runs in the session, as an application does. Does so COUNT times, and then writes to OUT_FILE as JSON how many Close
calls failed and how many of gnome-session's inhibitors with its reason are left. It counts them while it is still
connected to the bus, because xdg-desktop-portal closes the requests of an application which disconnects, also the
ones whose inhibition was left behind.
"""

import json
import sys
import time

from gi.repository import Gio, GLib

REASON = "session test of the Inhibit portal"
LOGOUT = 1


def main():
    count = int(sys.argv[1])
    out_file = sys.argv[2]
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    close_errors = []
    for i in range(count):
        options = {"reason": GLib.Variant("s", REASON), "handle_token": GLib.Variant("s", f"portal_inhibit_{i}")}
        reply = bus.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Inhibit",
                              "Inhibit", GLib.Variant("(sua{sv})", ("", LOGOUT, options)), GLib.VariantType("(o)"),
                              Gio.DBusCallFlags.NONE, -1, None)
        handle = reply.unpack()[0]
        try:
            bus.call_sync("org.freedesktop.portal.Desktop", handle, "org.freedesktop.portal.Request", "Close", None, None,
                          Gio.DBusCallFlags.NONE, -1, None)
        except GLib.Error as error:
            close_errors.append(error.message)

    # gnome-session receives the backend's Uninhibit calls a moment after the Close calls returned.
    time.sleep(2)
    left = 0
    paths = bus.call_sync("org.gnome.SessionManager", "/org/gnome/SessionManager", "org.gnome.SessionManager", "GetInhibitors",
                          None, GLib.VariantType("(ao)"), Gio.DBusCallFlags.NONE, -1, None).unpack()[0]
    for path in paths:
        reason = bus.call_sync("org.gnome.SessionManager", path, "org.gnome.SessionManager.Inhibitor", "GetReason", None, None,
                               Gio.DBusCallFlags.NONE, -1, None).unpack()[0]
        left += reason == REASON

    with open(out_file, "w") as f:
        json.dump({"count": count, "close_errors": close_errors[:3], "close_error_count": len(close_errors), "left": left}, f)


if __name__ == "__main__":
    main()
