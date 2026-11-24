import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// F10 opens the menu bar in GTK and in the applications which follow it.
const OPEN_ACCELERATOR = 'F10';

// The modifier whose tap opens the menu of the application's name, and which underlines the letters of the mnemonics
// while it is held.
const MENU_MODIFIER = 'Alt_L';

// TODO: Leave F10 to the applications which use it themselves, chosen per application.
//       F10 is grabbed for every window, so terminal programs such as htop and Midnight Commander never receive it.
//       Together with menus for common applications without menus of their own (see MenuBar), F10 could stay with
//       terminals and other applications which bind it.

/**
 * The keys which open the menus of the menu bar: F10 and a tap of the left Alt open the menu of the application's name,
 * and Alt with the mnemonic of a top-level menu opens that menu. The mnemonics are grabbed only while the focused
 * window has menus with them, so in other windows these keys reach the window. While the left Alt is held on its own,
 * the titles of the menus underline the letters of their mnemonics.
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
        global.display.connectObject(
            'accelerator-activated', (_display, action) => this._grabs.get(action)?.(),
            'watched-modifier-pressed', () => this._menuBar.setAltHeld(this._active),
            'watched-modifier-combined', () => this._menuBar.setAltHeld(false),
            'watched-modifier-released', (_display, _key, tapped) => {
                this._menuBar.setAltHeld(false);
                if (tapped && this._active)
                    this._menuBar.toggleAppMenu();
            },
            this);
        // Mutter reports the presses of the key, which still reaches the focused window.
        global.display.set_watched_modifiers([MENU_MODIFIER]);
        menuBar.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    destroy() {
        global.display.set_watched_modifiers([]);
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
        this._grab(OPEN_ACCELERATOR, () => this._menuBar.toggleAppMenu());
        const grabbed = new Set();
        titles.forEach(({mnemonic}, index) => {
            if (!mnemonic || grabbed.has(mnemonic))
                return;
            grabbed.add(mnemonic);
            this._grab(`<Alt>${mnemonic}`, () => this._menuBar.openMenu(index));
        });
    }
}
