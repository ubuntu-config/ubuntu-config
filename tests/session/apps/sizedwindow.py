#!/usr/bin/env python3
"""A GTK window of a given size, which can be resized or has a fixed size, for the tests of window placement.

Usage: sizedwindow.py gtk3|gtk4 TITLE WIDTH HEIGHT [fixed]

The window is titled TITLE and has WIDTH and HEIGHT as its default size. With "fixed" it cannot be resized, which GTK
declares to the compositor as a minimum and maximum size equal to its size.
"""

import sys

import gi

toolkit, title, width, height = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
fixed = len(sys.argv) > 5 and sys.argv[5] == "fixed"
gi.require_version("Gtk", "3.0" if toolkit == "gtk3" else "4.0")

from gi.repository import Gtk  # noqa: E402

if toolkit == "gtk3":
    window = Gtk.Window(title=title)
    window.set_default_size(width, height)
    window.set_resizable(not fixed)
    window.add(Gtk.Label(label=title))
    window.connect("destroy", Gtk.main_quit)
    window.show_all()
    Gtk.main()
else:
    app = Gtk.Application()

    def activate(application):
        window = Gtk.ApplicationWindow(application=application, title=title)
        window.set_default_size(width, height)
        window.set_resizable(not fixed)
        window.set_child(Gtk.Label(label=title))
        window.present()

    app.connect("activate", activate)
    sys.exit(app.run([sys.argv[0]]))
