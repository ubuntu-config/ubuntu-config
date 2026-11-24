import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {DbusMenuModel} from './dbusMenu.js';
import {GtkMenuModel} from './gtkMenu.js';

/**
 * Finds the menu of a window and keeps one model for each menu, shared by the windows which have the same menu, as the
 * windows of an Electron application have.
 *
 * Signals: "changed" when the menu a window has can have changed without the window telling.
 */
export class MenuSources extends Signals.EventEmitter {
    /**
     * @param {import('./registrar.js').RegistrarClient} registrar - the menus registered with global-menu-registrar
     */
    constructor(registrar) {
        super();
        this._registrar = registrar;
        // Key to {model, users}.
        this._models = new Map();
        registrar.connectObject('changed', () => this.emit('changed'), this);
    }

    destroy() {
        this._registrar.disconnectObject(this);
        for (const {model} of this._models.values())
            model.destroy();
        this._models.clear();
    }

    /**
     * Describes the menu of a window. The window properties mutter sets from the org_kde_kwin_appmenu protocol come
     * first, as Chromium, Firefox and Qt use it on Wayland, then the menu bar GTK names through gtk_shell1, then the
     * registrations with global-menu-registrar.
     *
     * @param {Meta.Window} window - the window
     * @returns {{key: string, create: function(): object}|null} a key which names the menu and a function which
     *   creates its model, or null when the window has no menu
     */
    describe(window) {
        const service = window.get_dbus_appmenu_service_name();
        const path = window.get_dbus_appmenu_object_path();
        if (service && path)
            return {key: `dbusmenu ${service} ${path}`, create: () => new DbusMenuModel(service, path)};

        const busName = window.get_gtk_unique_bus_name();
        const menubar = window.get_gtk_menubar_object_path();
        if (busName && menubar) {
            const application = window.get_gtk_application_object_path();
            const windowPath = window.get_gtk_window_object_path();
            return {
                key: `gtk ${busName} ${menubar} ${application} ${windowPath}`,
                create: () => new GtkMenuModel(busName, menubar, application, windowPath),
            };
        }

        const registration = this._registrar.lookup(window);
        if (registration) {
            const {sender, path: registered} = registration;
            return {key: `dbusmenu ${sender} ${registered}`, create: () => new DbusMenuModel(sender, registered)};
        }
        return null;
    }

    /**
     * Returns the model of a menu, creating it for the first user.
     *
     * @param {{key: string, create: function(): object}} description - the menu, as describe() returned it
     * @returns {object} the model, to be given back with release()
     */
    acquire(description) {
        let entry = this._models.get(description.key);
        if (!entry) {
            entry = {model: description.create(), users: 0};
            this._models.set(description.key, entry);
        }
        entry.users++;
        return entry.model;
    }

    /**
     * Gives back a model, which is destroyed once it has no users.
     *
     * @param {string} key - the key of the menu
     */
    release(key) {
        const entry = this._models.get(key);
        if (!entry || --entry.users > 0)
            return;
        this._models.delete(key);
        entry.model.destroy();
    }
}
