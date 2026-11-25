import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

// How long a registration which ended is still used. Visual Studio Code ends the registration of its window shortly
// after it starts and makes it again 300 to 400 ms later, and in between the window would have no menu, so that its
// menus would disappear and come back.
const ENDED_GRACE_MS = 1000;

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
        // The timeout which drops each registration which ended, by its sender and window ID.
        this._ending = new Map();
        this._cancellable = new Gio.Cancellable();
        this._signalId = Gio.DBus.session.signal_subscribe(NAME, INTERFACE, 'RegistrationsChanged', PATH, null,
            Gio.DBusSignalFlags.NONE, () => this._refresh());
        this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, NAME, Gio.BusNameWatcherFlags.NONE,
            () => this._refresh(), () => this._set([]));
    }

    destroy() {
        for (const timeoutId of this._ending.values())
            GLib.source_remove(timeoutId);
        this._ending.clear();
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

    // Uses the registrations global-menu-registrar lists, in its order, which has the most recent registration last. A
    // registration which ended is kept for ENDED_GRACE_MS before it, and dropped then, unless it was made again.
    _set(listed) {
        const keyOf = registration => `${registration.sender} ${registration.windowId}`;
        const listedKeys = new Set(listed.map(keyOf));
        for (const key of listedKeys) {
            if (this._ending.has(key)) {
                GLib.source_remove(this._ending.get(key));
                this._ending.delete(key);
            }
        }
        const ended = this._registrations.filter(registration => !listedKeys.has(keyOf(registration)));
        for (const registration of ended) {
            const key = keyOf(registration);
            if (this._ending.has(key))
                continue;
            this._ending.set(key, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ENDED_GRACE_MS, () => {
                this._ending.delete(key);
                this._registrations = this._registrations.filter(other => keyOf(other) !== key);
                this.emit('changed');
                return GLib.SOURCE_REMOVE;
            }));
        }
        const registrations = [...ended, ...listed];
        const changed = JSON.stringify(registrations) !== JSON.stringify(this._registrations);
        this._registrations = registrations;
        if (changed)
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
