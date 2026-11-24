import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Keyboard} from './keyboard.js';
import {MenuBar} from './menuBar.js';
import {RegistrarClient, deactivateRegistrar} from './registrar.js';
import {MenuSources} from './source.js';

/**
 * Returns whether mutter has the calls of the patches of ubuntu-config which the extension needs: grabs which leave
 * the keyboard focus with the focused window, the menu addresses of the org_kde_kwin_appmenu protocol, and telling
 * GTK that the shell shows the menu bars.
 *
 * @returns {boolean} whether the calls are there
 */
function mutterHasPatches() {
    return typeof global.display.set_grab_keeps_keyboard_focus === 'function' &&
        typeof global.display.set_shell_shows_menubar === 'function' &&
        typeof Meta.Window.prototype.get_dbus_appmenu_service_name === 'function';
}

/**
 * Shows the menus of the focused window in the top bar.
 *
 * Without the mutter patches it does nothing but have global-menu-registrar give up its name, so that applications
 * keep the menu bars in their windows: without them, Chromium and Electron would lose the active state of their
 * window while a menu is open, and act on no window when an item is chosen.
 *
 * The extension stays enabled while the screen is locked, so that GTK windows do not show their menu bars for the time
 * of the lock and change their layouts twice, and hides the menu bar and gives back its keys meanwhile.
 */
export default class GlobalMenuExtension extends Extension {
    enable() {
        if (!mutterHasPatches()) {
            console.warn(`${this.uuid}: mutter lacks the patches of ubuntu-config, so the menus stay in the windows`);
            deactivateRegistrar();
            return;
        }
        this._registrar = new RegistrarClient();
        this._sources = new MenuSources(this._registrar);
        this._menuBar = new MenuBar(this._sources);
        this._keyboard = new Keyboard(this._menuBar);
        global.display.set_shell_shows_menubar(true);
        Main.sessionMode.connectObject('updated', () => this._syncSessionMode(), this);
        this._syncSessionMode();
    }

    disable() {
        if (!this._menuBar)
            return;
        Main.sessionMode.disconnectObject(this);
        global.display.set_shell_shows_menubar(false);
        this._keyboard.destroy();
        this._keyboard = null;
        this._menuBar.destroy();
        this._menuBar = null;
        this._sources.destroy();
        this._sources = null;
        this._registrar.destroy();
        this._registrar = null;
    }

    _syncSessionMode() {
        const active = !Main.sessionMode.isLocked;
        this._menuBar.setActive(active);
        this._keyboard.setActive(active);
    }
}
