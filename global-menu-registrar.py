#!/usr/bin/python3 -I
"""Registrar of application menus for the global menu extension global-menu@mitar.tnode.com.

Installed as /usr/local/libexec/global-menu-registrar by configure-gnome-desktop.sh, and run by
global-menu-registrar.service in the user's service manager, which starts it before the applications started at login.

Owns com.canonical.AppMenu.Registrar on the session bus while the extension is enabled in org.gnome.shell, that is
listed in enabled-extensions, not listed in disabled-extensions, and user extensions are not disabled. Chromium,
Electron and LibreOffice export their menus over com.canonical.dbusmenu only while that name has an owner, and Electron
checks for it only when it sets its menu, so an Electron application started before the name has an owner keeps the
menu bar in its window. GNOME Shell enables extensions only after the applications started at login are already
running, so the extension cannot own the name itself.

Every application registers the menu of a window with RegisterWindow(window ID, object path). The window ID is an X11
window ID for an application under XWayland, while Electron on Wayland registers every window of every application
with the ID 1, so registrations are kept per sender and window ID. A registration ends when its sender leaves the bus.

The extension reads the registrations, with the process ID of each sender, from the interface local.GlobalMenuRegistrar
under the name local.GlobalMenuRegistrar, which this program owns all the time. With Deactivate() there, the extension
has the program release com.canonical.AppMenu.Registrar until it exits, which the extension does when GNOME Shell runs
without the mutter patches it needs.

It notifies systemd that it is ready once it owns the names it wants, or right away when the extension is disabled.
"""

import os
import socket
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

EXTENSION_UUID = "global-menu@mitar.tnode.com"
REGISTRAR_NAME = "com.canonical.AppMenu.Registrar"
REGISTRAR_PATH = "/com/canonical/AppMenu/Registrar"
LOCAL_NAME = "local.GlobalMenuRegistrar"
LOCAL_PATH = "/local/GlobalMenuRegistrar"

INTERFACES = Gio.DBusNodeInfo.new_for_xml(
    """
<node>
  <interface name="com.canonical.AppMenu.Registrar">
    <method name="RegisterWindow">
      <arg name="windowId" type="u" direction="in"/>
      <arg name="menuObjectPath" type="o" direction="in"/>
    </method>
    <method name="UnregisterWindow">
      <arg name="windowId" type="u" direction="in"/>
    </method>
    <method name="GetMenuForWindow">
      <arg name="windowId" type="u" direction="in"/>
      <arg name="service" type="s" direction="out"/>
      <arg name="menuObjectPath" type="o" direction="out"/>
    </method>
    <method name="GetMenus">
      <arg name="menus" type="a(uso)" direction="out"/>
    </method>
    <signal name="WindowRegistered">
      <arg name="windowId" type="u"/>
      <arg name="service" type="s"/>
      <arg name="menuObjectPath" type="o"/>
    </signal>
    <signal name="WindowUnregistered">
      <arg name="windowId" type="u"/>
    </signal>
  </interface>
  <interface name="local.GlobalMenuRegistrar">
    <method name="ListRegistrations">
      <arg name="registrations" type="a(suuo)" direction="out"/>
    </method>
    <method name="Deactivate"/>
    <signal name="RegistrationsChanged"/>
  </interface>
</node>
"""
)
REGISTRAR_INTERFACE = INTERFACES.lookup_interface("com.canonical.AppMenu.Registrar")
LOCAL_INTERFACE = INTERFACES.lookup_interface("local.GlobalMenuRegistrar")


def notify_systemd(message):
    """Sends a message to systemd's notification socket, when systemd gave one."""
    path = os.environ.get("NOTIFY_SOCKET")
    if not path:
        return
    if path.startswith("@"):
        path = "\0" + path[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
        sock.connect(path)
        sock.sendall(message.encode())


class Registrar:
    """Keeps the registrations of menus and owns REGISTRAR_NAME while the extension wants it."""

    def __init__(self, bus):
        self.bus = bus
        self.settings = Gio.Settings.new("org.gnome.shell")
        # (sender, window ID) to (process ID, object path), in the order of registration.
        self.registrations = {}
        self.registrar_owner_id = 0
        self.deactivated = False
        self.ready = False

        bus.register_object_with_closures2(REGISTRAR_PATH, REGISTRAR_INTERFACE, self.on_registrar_call, None, None)
        bus.register_object_with_closures2(LOCAL_PATH, LOCAL_INTERFACE, self.on_local_call, None, None)
        bus.signal_subscribe(
            "org.freedesktop.DBus",
            "org.freedesktop.DBus",
            "NameOwnerChanged",
            "/org/freedesktop/DBus",
            None,
            Gio.DBusSignalFlags.NONE,
            self.on_name_owner_changed,
        )
        Gio.bus_own_name_on_connection(bus, LOCAL_NAME, Gio.BusNameOwnerFlags.NONE, None, None)

        self.settings.connect("changed::enabled-extensions", self.update)
        self.settings.connect("changed::disabled-extensions", self.update)
        self.settings.connect("changed::disable-user-extensions", self.update)
        self.update()

    def wanted(self):
        """Returns whether REGISTRAR_NAME is to be owned."""
        if self.deactivated or self.settings.get_boolean("disable-user-extensions"):
            return False
        if EXTENSION_UUID in self.settings.get_strv("disabled-extensions"):
            return False
        return EXTENSION_UUID in self.settings.get_strv("enabled-extensions")

    def update(self, *_arguments):
        """Owns or releases REGISTRAR_NAME as wanted() says."""
        if self.wanted() and not self.registrar_owner_id:
            self.registrar_owner_id = Gio.bus_own_name_on_connection(
                self.bus, REGISTRAR_NAME, Gio.BusNameOwnerFlags.NONE, self.on_name_acquired, self.on_name_lost
            )
        elif not self.wanted() and self.registrar_owner_id:
            Gio.bus_unown_name(self.registrar_owner_id)
            self.registrar_owner_id = 0
            self.clear()
        if not self.registrar_owner_id:
            self.notify_ready()

    def notify_ready(self):
        """Tells systemd once that the service is ready."""
        if not self.ready:
            self.ready = True
            notify_systemd("READY=1")

    def on_name_acquired(self, _bus, _name):
        self.notify_ready()

    def on_name_lost(self, _bus, name):
        # Another registrar owns the name, so its registrations go there.
        print(f"Another program owns {name}, registrations go to it", file=sys.stderr)
        self.clear()
        self.notify_ready()

    def clear(self):
        """Forgets all registrations."""
        if self.registrations:
            self.registrations.clear()
            self.emit_local("RegistrationsChanged")

    def emit_registrar(self, signal, parameters):
        self.bus.emit_signal(None, REGISTRAR_PATH, REGISTRAR_INTERFACE.name, signal, parameters)

    def emit_local(self, signal):
        self.bus.emit_signal(None, LOCAL_PATH, LOCAL_INTERFACE.name, signal, None)

    def sender_pid(self, sender):
        """Returns the process ID of a sender, or 0 when the bus does not know it."""
        try:
            result = self.bus.call_sync(
                "org.freedesktop.DBus",
                "/org/freedesktop/DBus",
                "org.freedesktop.DBus",
                "GetConnectionUnixProcessID",
                GLib.Variant("(s)", (sender,)),
                GLib.VariantType("(u)"),
                Gio.DBusCallFlags.NONE,
                1000,
                None,
            )
        except GLib.Error:
            return 0
        return result.unpack()[0]

    def on_registrar_call(self, _bus, sender, _path, _interface, method, parameters, invocation):
        if method == "RegisterWindow":
            window_id, path = parameters.unpack()
            key = (sender, window_id)
            # A registration made again moves to the end, so it is the most recent one.
            self.registrations.pop(key, None)
            self.registrations[key] = (self.sender_pid(sender), path)
            invocation.return_value(None)
            self.emit_registrar("WindowRegistered", GLib.Variant("(uso)", (window_id, sender, path)))
            self.emit_local("RegistrationsChanged")
        elif method == "UnregisterWindow":
            (window_id,) = parameters.unpack()
            invocation.return_value(None)
            if self.registrations.pop((sender, window_id), None):
                self.emit_registrar("WindowUnregistered", GLib.Variant("(u)", (window_id,)))
                self.emit_local("RegistrationsChanged")
        elif method == "GetMenuForWindow":
            (window_id,) = parameters.unpack()
            # Several senders can register the same window ID, and the most recent registration is the answer.
            for (owner, registered_id), (_pid, path) in reversed(self.registrations.items()):
                if registered_id == window_id:
                    invocation.return_value(GLib.Variant("(so)", (owner, path)))
                    return
            invocation.return_dbus_error(f"{REGISTRAR_NAME}.Error.NotFound", f"No menu for window {window_id}")
        elif method == "GetMenus":
            menus = [(window_id, owner, path) for (owner, window_id), (_pid, path) in self.registrations.items()]
            invocation.return_value(GLib.Variant("(a(uso))", (menus,)))

    def on_local_call(self, _bus, _sender, _path, _interface, method, _parameters, invocation):
        if method == "ListRegistrations":
            registrations = [
                (owner, pid, window_id, path) for (owner, window_id), (pid, path) in self.registrations.items()
            ]
            invocation.return_value(GLib.Variant("(a(suuo))", (registrations,)))
        elif method == "Deactivate":
            invocation.return_value(None)
            self.deactivated = True
            self.update()

    def on_name_owner_changed(self, _bus, _sender, _path, _interface, _signal, parameters):
        name, _old_owner, new_owner = parameters.unpack()
        if new_owner:
            return
        gone = [key for key in self.registrations if key[0] == name]
        for key in gone:
            del self.registrations[key]
            self.emit_registrar("WindowUnregistered", GLib.Variant("(u)", (key[1],)))
        if gone:
            self.emit_local("RegistrationsChanged")


def main():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    Registrar(bus)
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
