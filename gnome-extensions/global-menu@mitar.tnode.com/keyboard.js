import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// F10 opens the menu bar in GTK and in the applications which follow it. XF86Launch8 is the key the tap-keys setting
// of the patched mutter sends for a tap of the left Alt, and no physical key sends it.
const OPEN_ACCELERATORS = ['F10', 'XF86Launch8'];

// TODO: Leave F10 to the applications which use it themselves, chosen per application.
//       F10 is grabbed for every window, so terminal programs such as htop and Midnight Commander never receive it.
//       Together with menus for common applications without menus of their own (see MenuBar), F10 could stay with
//       terminals and other applications which bind it.

/**
 * The keys which open the menus of the menu bar: F10 and a tap of the left Alt open the menu of the application's name,
 * and Alt with the mnemonic of a top-level menu opens that menu. The mnemonics are grabbed only while the focused
 * window has menus with them, so in other windows these keys reach the window.
 */
export class Keyboard {
    /**
     * @param {import('./menuBar.js').MenuBar} menuBar - the menu bar
     */
    constructor(menuBar) {
        this._menuBar = menuBar;
        // Action to callback.
        this._grabs = new Map();
        this._mnemonicKey = '';
        this._active = true;
        global.display.connectObject('accelerator-activated', (_display, action) => this._grabs.get(action)?.(), this);
        menuBar.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    destroy() {
        global.display.disconnectObject(this);
        this._menuBar.disconnectObject(this);
        this._ungrabAll();
    }

    /**
     * Grabs the keys or gives them back, which happens while the screen is locked.
     *
     * @param {boolean} active - whether the keys are grabbed
     */
    setActive(active) {
        this._active = active;
        this._sync();
    }

    _grab(accelerator, callback) {
        const action = global.display.grab_accelerator(accelerator, Meta.KeyBindingFlags.NONE);
        // A combination another program or GNOME Shell has already grabbed is left to it.
        if (action === Meta.KeyBindingAction.NONE)
            return;
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action),
            Shell.ActionMode.NORMAL | Shell.ActionMode.POPUP);
        this._grabs.set(action, callback);
    }

    _ungrabAll() {
        for (const action of this._grabs.keys()) {
            global.display.ungrab_accelerator(action);
            Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), Shell.ActionMode.NONE);
        }
        this._grabs.clear();
        this._mnemonicKey = '';
    }

    _sync() {
        const titles = this._active ? this._menuBar.titles : [];
        const mnemonicKey = JSON.stringify(titles.map(title => title.mnemonic));
        if (this._active && this._grabs.size && mnemonicKey === this._mnemonicKey)
            return;
        this._ungrabAll();
        if (!this._active)
            return;
        this._mnemonicKey = mnemonicKey;
        for (const accelerator of OPEN_ACCELERATORS)
            this._grab(accelerator, () => this._menuBar.toggleAppMenu());
        const grabbed = new Set();
        titles.forEach(({mnemonic}, index) => {
            if (!mnemonic || grabbed.has(mnemonic))
                return;
            grabbed.add(mnemonic);
            this._grab(`<Alt>${mnemonic}`, () => this._menuBar.openMenu(index));
        });
    }
}
