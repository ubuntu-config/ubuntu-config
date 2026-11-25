import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const NAME = 'local.GlobalMenuRegistrar';
const PATH = '/local/GlobalMenuRegistrar';
const INTERFACE = 'local.GlobalMenuRegistrar';

/**
 * Asks global-menu-registrar to give up com.canonical.AppMenu.Registrar for the rest of the session, so that
 * applications keep the menu bars in their windows. Nothing happens when the registrar does not run.
 */
export function deactivateRegistrar() {
    Gio.DBus.session.call(NAME, PATH, INTERFACE, 'Deactivate', null, null, Gio.DBusCallFlags.NO_AUTO_START, -1, null,
        (bus, result) => {
            try {
                bus.call_finish(result);
            } catch {
                // The registrar does not run, so it owns nothing.
            }
        });
}

/**
 * Follows the menus applications registered with global-menu-registrar, which Electron and the applications under
 * XWayland register there.
 *
 * Signals: "changed" when the registrations change.
 */
export class RegistrarClient extends Signals.EventEmitter {
    constructor() {
        super();
        this._registrations = [];
        this._cancellable = new Gio.Cancellable();
        this._signalId = Gio.DBus.session.signal_subscribe(NAME, INTERFACE, 'RegistrationsChanged', PATH, null,
            Gio.DBusSignalFlags.NONE, () => this._refresh());
        this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, NAME, Gio.BusNameWatcherFlags.NONE,
            () => this._refresh(), () => this._set([]));
    }

    destroy() {
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._signalId);
        Gio.bus_unwatch_name(this._watchId);
    }

    _refresh() {
        Gio.DBus.session.call(NAME, PATH, INTERFACE, 'ListRegistrations', null, new GLib.VariantType('(a(suuo))'),
            Gio.DBusCallFlags.NO_AUTO_START, -1, this._cancellable, (bus, result) => {
                let list;
                try {
                    [list] = bus.call_finish(result).deepUnpack();
                } catch (error) {
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this._set([]);
                    return;
                }
                this._set(list.map(([sender, pid, windowId, path]) => ({sender, pid, windowId, path})));
            });
    }

    _set(registrations) {
        this._registrations = registrations;
        this.emit('changed');
    }

    /**
     * Returns the menu registered for a window. A window under XWayland is found by its X11 window ID. Electron on
     * Wayland registers its windows with numbers of its own instead, so a Wayland window is found among the
     * registrations of the process which owns it.
     *
     * @param {Meta.Window} window - the window
     * @returns {{sender: string, path: string}|null} the D-Bus name and object path of the menu, or null without one
     */
    lookup(window) {
        if (window.get_client_type() === Meta.WindowClientType.X11) {
            const xid = window.get_xwindow?.() ?? parseInt(window.get_description(), 16);
            return this._registrations.findLast(r => r.windowId === xid) ?? null;
        }
        const pid = window.get_pid();
        const matches = pid > 0 ? this._registrations.filter(r => r.pid === pid) : [];
        // Electron numbers its windows in the order it creates them, counting from 1, and mutter's window IDs grow in
        // the order mutter creates the windows, so with as many normal windows of the process as registrations, the
        // windows match the registrations in these orders. Otherwise, as when Electron registered a window which it did
        // not show, the most recent registration is used.
        // TODO: Drop this matching once the applications ship an Electron which announces menus on Wayland.
        //       Electron pull request 54629 announces the menu of each window with org_kde_kwin_appmenu on Wayland, as
        //       Chromium does, and source.js finds such a menu by the window's KDE appmenu properties before it asks
        //       the registrar.
        const windows = global.display.list_all_windows()
            .filter(w => w.get_pid() === pid && w.get_window_type() === Meta.WindowType.NORMAL &&
                w.get_client_type() === Meta.WindowClientType.WAYLAND)
            .sort((a, b) => Number(a.get_id() - b.get_id()));
        const index = windows.indexOf(window);
        if (matches.length > 1 && windows.length === matches.length && index >= 0)
            return [...matches].sort((a, b) => a.windowId - b.windowId)[index];
        return matches[matches.length - 1] ?? null;
    }
}
