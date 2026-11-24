#!/usr/bin/env python3
"""A window with a menu bar, for the tests of the global menu: GTK 3, GTK 4 or Qt 6, with the same menus in each.

Usage: [MENUAPP_EXTRA_MENUS=N] menuapp.py gtk3|gtk4|qt LOG

The window is titled "menu-test-<toolkit>" and has a focused text field under its menu bar, which has the menus File
(New with Ctrl+N, Open), Edit (Copy, Paste) and View (Show Toolbar, which can be checked, and the submenu Zoom with Zoom
In and Zoom Out). With MENUAPP_EXTRA_MENUS, up to 14 further menus follow, titled Extra G, Extra H and so on, each with
the mnemonic of its letter and an item named after it, Item G, Item H and so on. GTK exports the menu bar through
gtk_shell1 and hides it when GNOME Shell announces that it shows the menu bars, and Qt exports it over
com.canonical.dbusmenu while com.canonical.AppMenu.Registrar has an owner.

Each line of LOG is a JSON object with the event "activate" and the item's label for an activated menu item, "active"
with the window's active state when it changes, "focus" with the text field's focus when it changes, and
"menubar-hidden" with whether the window's own menu bar is hidden, two seconds after the window opened and, with GTK,
also when it opened and whenever it changes.
"""

import json
import os
import sys

LABELS = {
    "file": "_File",
    "new": "_New",
    "open": "_Open",
    "edit": "_Edit",
    "copy": "_Copy",
    "paste": "_Paste",
    "view": "_View",
    "toolbar": "Show _Toolbar",
    "zoom": "_Zoom",
    "zoom-in": "Zoom _In",
    "zoom-out": "Zoom _Out",
}

# The letters of the further menus, which none of the other menus uses as its mnemonic.
EXTRA_LETTERS = "GHIJKLMNOPQRSU"
EXTRA_COUNT = int(os.environ.get("MENUAPP_EXTRA_MENUS", "0"))
EXTRA_MENUS = [(f"Extra _{letter}", f"Item _{letter}") for letter in EXTRA_LETTERS[:EXTRA_COUNT]]

toolkit, log_path = sys.argv[1], sys.argv[2]
log_file = open(log_path, "a", buffering=1)


def log(event, value):
    log_file.write(json.dumps({"event": event, "value": value}) + "\n")
    return False


def run_gtk(version):
    import gi

    gi.require_version("Gtk", f"{version}.0")
    from gi.repository import Gio, GLib, Gtk

    def on_activate(app):
        for name in ("new", "open", "copy", "paste", "zoom-in", "zoom-out"):
            action = Gio.SimpleAction.new(name, None)
            action.connect("activate", lambda _action, _parameter, name=name: log("activate", LABELS[name]))
            app.add_action(action)
        toolbar = Gio.SimpleAction.new_stateful("toolbar", None, GLib.Variant.new_boolean(False))
        toolbar.connect("change-state", lambda action, value: (action.set_state(value),
                                                               log("activate", LABELS["toolbar"])))
        app.add_action(toolbar)
        app.set_accels_for_action("app.new", ["<Primary>n"])

        menubar = Gio.Menu()
        file_menu = Gio.Menu()
        file_menu.append(LABELS["new"], "app.new")
        file_menu.append(LABELS["open"], "app.open")
        menubar.append_submenu(LABELS["file"], file_menu)
        edit_menu = Gio.Menu()
        edit_menu.append(LABELS["copy"], "app.copy")
        edit_menu.append(LABELS["paste"], "app.paste")
        menubar.append_submenu(LABELS["edit"], edit_menu)
        view_menu = Gio.Menu()
        view_menu.append(LABELS["toolbar"], "app.toolbar")
        zoom_menu = Gio.Menu()
        zoom_menu.append(LABELS["zoom-in"], "app.zoom-in")
        zoom_menu.append(LABELS["zoom-out"], "app.zoom-out")
        view_menu.append_submenu(LABELS["zoom"], zoom_menu)
        menubar.append_submenu(LABELS["view"], view_menu)
        for i, (title, item) in enumerate(EXTRA_MENUS):
            action = Gio.SimpleAction.new(f"extra-{i}", None)
            action.connect("activate", lambda _action, _parameter, item=item: log("activate", item))
            app.add_action(action)
            extra_menu = Gio.Menu()
            extra_menu.append(item, f"app.extra-{i}")
            menubar.append_submenu(title, extra_menu)
        app.set_menubar(menubar)

        window = Gtk.ApplicationWindow(application=app, title=f"menu-test-gtk{version}")
        window.set_show_menubar(True)
        window.set_default_size(800, 500)
        entry = Gtk.Entry()
        if version == "3":
            window.add(entry)
            entry.connect("focus-in-event", lambda *_args: log("focus", True))
            entry.connect("focus-out-event", lambda *_args: log("focus", False))
            window.show_all()
        else:
            window.set_child(entry)
            focus = Gtk.EventControllerFocus()
            focus.connect("enter", lambda _controller: log("focus", True))
            focus.connect("leave", lambda _controller: log("focus", False))
            entry.add_controller(focus)
            window.present()
        window.connect("notify::is-active", lambda w, _pspec: log("active", w.is_active()))
        entry.grab_focus()
        settings = Gtk.Settings.get_default()
        log("menubar-hidden", settings.props.gtk_shell_shows_menubar)
        GLib.timeout_add(2000, lambda: log("menubar-hidden", settings.props.gtk_shell_shows_menubar))
        settings.connect("notify::gtk-shell-shows-menubar",
                         lambda s, _pspec: log("menubar-hidden", s.props.gtk_shell_shows_menubar))

    app = Gtk.Application(application_id=f"local.MenuTest.Gtk{version}", flags=Gio.ApplicationFlags.NON_UNIQUE)
    app.connect("activate", on_activate)
    app.run([])


def run_qt():
    from PyQt6 import QtCore, QtGui, QtWidgets

    def qt_label(label):
        return label.replace("_", "&")

    app = QtWidgets.QApplication(sys.argv)
    app.setDesktopFileName("local.MenuTest.Qt")
    window = QtWidgets.QMainWindow()
    window.setWindowTitle("menu-test-qt")
    window.resize(800, 500)

    def add(menu, name, shortcut=None, checkable=False):
        action = menu.addAction(qt_label(LABELS[name]))
        if shortcut:
            action.setShortcut(QtGui.QKeySequence(shortcut))
        action.setCheckable(checkable)
        action.triggered.connect(lambda _checked=False, name=name: log("activate", LABELS[name]))

    file_menu = window.menuBar().addMenu(qt_label(LABELS["file"]))
    add(file_menu, "new", "Ctrl+N")
    add(file_menu, "open")
    edit_menu = window.menuBar().addMenu(qt_label(LABELS["edit"]))
    add(edit_menu, "copy")
    add(edit_menu, "paste")
    view_menu = window.menuBar().addMenu(qt_label(LABELS["view"]))
    add(view_menu, "toolbar", checkable=True)
    zoom_menu = view_menu.addMenu(qt_label(LABELS["zoom"]))
    add(zoom_menu, "zoom-in")
    add(zoom_menu, "zoom-out")
    for title, item in EXTRA_MENUS:
        extra_menu = window.menuBar().addMenu(qt_label(title))
        extra_menu.addAction(qt_label(item)).triggered.connect(lambda _checked=False, item=item: log("activate", item))

    entry = QtWidgets.QLineEdit()
    window.setCentralWidget(entry)

    class FocusLogger(QtCore.QObject):
        def eventFilter(self, _object, event):
            if event.type() == QtCore.QEvent.Type.FocusIn:
                log("focus", True)
            elif event.type() == QtCore.QEvent.Type.FocusOut:
                log("focus", False)
            return False

    logger = FocusLogger()
    entry.installEventFilter(logger)
    app.applicationStateChanged.connect(
        lambda state: log("active", state == QtCore.Qt.ApplicationState.ApplicationActive))
    window.show()
    entry.setFocus()
    # QMenuBar hides itself when the platform shows the menu bar.
    QtCore.QTimer.singleShot(2000, lambda: log("menubar-hidden", not window.menuBar().isVisible()))
    sys.exit(app.exec())


if toolkit in ("gtk3", "gtk4"):
    run_gtk(toolkit[-1])
elif toolkit == "qt":
    run_qt()
else:
    sys.exit(f"unknown toolkit {toolkit}")
