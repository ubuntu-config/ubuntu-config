"""Stand in for the OpenURI portal of xdg-desktop-portal on the session bus.

Usage: openuri_portal.py OUT

Owns org.freedesktop.portal.Desktop, answers every OpenURI, OpenFile and OpenDirectory request as done, and appends each
request to OUT as a line of JSON, with the method, the parent window, the URI and the options.
"""

import json
import sys

from gi.repository import Gio, GLib

BUS_NAME = "org.freedesktop.portal.Desktop"
OBJECT_PATH = "/org/freedesktop/portal/desktop"

INTERFACE = """
<node>
  <interface name="org.freedesktop.portal.OpenURI">
    <method name="OpenURI">
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="s" name="uri" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="o" name="handle" direction="out"/>
    </method>
    <method name="OpenFile">
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="h" name="fd" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="o" name="handle" direction="out"/>
    </method>
    <method name="OpenDirectory">
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="h" name="fd" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="o" name="handle" direction="out"/>
    </method>
    <property name="version" type="u" access="read"/>
  </interface>
</node>
"""


def main():
    out = sys.argv[1]
    info = Gio.DBusNodeInfo.new_for_xml(INTERFACE).interfaces[0]
    loop = GLib.MainLoop()

    def method_call(connection, sender, path, interface, method, parameters, invocation):
        parent_window, target, options = parameters.unpack()
        with open(out, "a") as f:
            f.write(json.dumps({"method": method, "parent_window": parent_window,
                                "uri": target if method == "OpenURI" else None, "options": options}) + "\n")
        # The request object of the portal's Request interface, which libportal waits on for the Response signal.
        request_path = "%s/request/%s/%s" % (OBJECT_PATH, sender[1:].replace(".", "_"), options.get("handle_token", "t"))
        invocation.return_value(GLib.Variant("(o)", (request_path,)))

        def respond():
            connection.emit_signal(sender, request_path, "org.freedesktop.portal.Request", "Response",
                                   GLib.Variant("(ua{sv})", (0, {})))
            return GLib.SOURCE_REMOVE

        GLib.idle_add(respond)

    def get_property(connection, sender, path, interface, name):
        return GLib.Variant("u", 4)

    def bus_acquired(connection, name):
        # Newer PyGObject deprecates register_object() in favour of register_object_with_closures2().
        if hasattr(connection, "register_object_with_closures2"):
            connection.register_object_with_closures2(OBJECT_PATH, info, method_call, get_property, None)
        else:
            connection.register_object(OBJECT_PATH, info, method_call, get_property, None)

    Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE, bus_acquired, None,
                     lambda connection, name: loop.quit())
    loop.run()


if __name__ == "__main__":
    main()
