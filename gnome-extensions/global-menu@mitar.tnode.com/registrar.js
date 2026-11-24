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
     * Wayland registers every window with the same made-up window ID, so a Wayland window is found by the process which
     * registered the menu, the process which owns the window. Its most recent registration is used.
     *
     * @param {Meta.Window} window - the window
     * @returns {{sender: string, path: string}|null} the D-Bus name and object path of the menu, or null without one
     */
    lookup(window) {
        let matches;
        if (window.get_client_type() === Meta.WindowClientType.X11) {
            const xid = window.get_xwindow?.() ?? parseInt(window.get_description(), 16);
            matches = this._registrations.filter(r => r.windowId === xid);
        } else {
            const pid = window.get_pid();
            matches = pid > 0 ? this._registrations.filter(r => r.pid === pid) : [];
        }
        return matches[matches.length - 1] ?? null;
    }
}
