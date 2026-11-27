import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {fillAppMenu} from './appMenu.js';
import {
    activateMnemonic, addSubmenuItem, focusedSubmenuItem, hasModifiers, isWindowShortcut, setLabelMnemonic,
    setMenuMnemonicsShown, setMnemonicShown, typedLetter,
} from './util.js';

// How long a menu without items waits for the application to fill it before it gives up opening.
const FILL_TIMEOUT_MS = 1000;

// The keys which move the keyboard focus between the items of an open menu.
const NAVIGATION_KEYS = new Set([
    Clutter.KEY_Up, Clutter.KEY_Down, Clutter.KEY_Left, Clutter.KEY_Right, Clutter.KEY_Tab, Clutter.KEY_ISO_Left_Tab,
    Clutter.KEY_Home, Clutter.KEY_End, Clutter.KEY_Page_Up, Clutter.KEY_Page_Down,
]);

// The window properties which name the menu of a window, and its type, which tells whether it is the desktop.
const WINDOW_PROPERTIES = [
    'dbus-appmenu-service-name',
    'dbus-appmenu-object-path',
    'gtk-unique-bus-name',
    'gtk-menubar-object-path',
    'window-type',
];

const MenuButton = GObject.registerClass(
class MenuButton extends PanelMenu.Button {
    /**
     * @param {string} text - the title shown in the top bar
     * @param {string} styleClass - the style class of the title
     * @param {function(PopupMenu.PopupMenu): void} fill - fills the menu right before it opens
     * @param {function(function(): void): void|null} prepare - asks the application to fill a menu which has no
     *   items and calls its argument once the items are there or it gave up waiting for them, or null
     * @param {function(Clutter.Event): boolean} onEvent - receives the events of the open menu before GNOME Shell does,
     *   and returns Clutter.EVENT_STOP for an event it handled
     */
    _init(text, styleClass, fill, prepare, onEvent) {
        // The menu is centered under its title, as the menus of the status icons are.
        super._init(0.5, text);
        // A menu without items does not open, so it is filled before PopupMenu.open() checks that, also when the
        // menu opens through a click, the keyboard, or a move from another menu of the top bar. LibreOffice fills a
        // submenu only when its submenu action says that the submenu opens, so an empty menu opens once the
        // application filled it.
        const open = animate => PopupMenu.PopupMenu.prototype.open.call(this.menu, animate);
        this.menu.open = animate => {
            fill(this.menu);
            if (!this.menu.isEmpty() || !prepare) {
                open(animate);
                return;
            }
            prepare(() => {
                // The buttons are replaced when the window's menus change, which can happen meanwhile.
                if (this._destroyed)
                    return;
                fill(this.menu);
                open(animate);
            });
        };
        this.connect('destroy', () => (this._destroyed = true));
        this.add_style_class_name('global-menu-button');
        this.label = new St.Label({text, y_align: Clutter.ActorAlign.CENTER, style_class: styleClass});
        this.add_child(this.label);
        this.label_actor = this.label;
        // A grab of the menu leaves the keyboard focus with the focused window, so that Chromium and Electron keep
        // the window active and act on the item chosen.
        global.display.set_grab_keeps_keyboard_focus(this.menu.actor, true);
        // GNOME Shell's menu manager closes the whole menu on Escape, which onEvent closes one level at a time, so
        // onEvent is connected first.
        this.menu.actor.connect('captured-event', (actor, event) => onEvent(event));
        Main.panel.menuManager.addMenu(this.menu);
    }
});

/**
 * The container of the menu bar's buttons: the button with the application's name first, then one button for each
 * top-level menu, and the overflow button last. The name and the menus get their natural widths, as many menus as
 * fit into the width the top bar gives the container, and the overflow button shows the menus which do not fit. The
 * buttons which are not shown are placed right of the container, which clips them. The top bar allocates the container
 * again whenever its layout changes, so the menus which fit follow the space there is.
 *
 * Signals: "overflow-changed" after the number of the menus which fit changed.
 */
const MenuBarBox = GObject.registerClass({
    Signals: {'overflow-changed': {}},
}, class MenuBarBox extends St.Widget {
    _init() {
        super._init({style_class: 'global-menu-bar', y_expand: true, clip_to_allocation: true});
        // How many top-level menus fit, the rest are in the overflow button.
        this.fitCount = 0;
        this._needsSync = false;
        this._laterId = 0;
        this.connect('destroy', () => {
            if (this._laterId)
                global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        });
    }

    /**
     * Sets how many menus fit until the next allocation, after the buttons were replaced, and has that allocation
     * report the number of menus which fit even if it stays the same, so that the new buttons follow it.
     *
     * @param {number} fitCount - the number of menus treated as fitting until then
     */
    reset(fitCount) {
        this.fitCount = fitCount;
        this._needsSync = true;
        this.queue_relayout();
    }

    _widths(forHeight) {
        const widths = this.get_children().map(child => child.get_preferred_width(forHeight)[1]);
        return {app: widths[0] ?? 0, titles: widths.slice(1, -1), overflow: widths[widths.length - 1] ?? 0};
    }

    vfunc_get_preferred_width(forHeight) {
        const {app, titles, overflow} = this._widths(forHeight);
        const all = app + titles.reduce((sum, width) => sum + width, 0);
        // The name of the application is never shrunk, and the menus can all move into the overflow button.
        return [titles.length ? Math.min(app + overflow, all) : app, all];
    }

    vfunc_get_preferred_height(forWidth) {
        const heights = this.get_children().map(child => child.get_preferred_height(forWidth));
        return [Math.max(0, ...heights.map(h => h[0])), Math.max(0, ...heights.map(h => h[1]))];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const children = this.get_children();
        if (!children.length)
            return;
        const width = box.get_width();
        const height = box.get_height();
        const {app, titles, overflow} = this._widths(height);

        let fitCount = titles.length;
        if (app + titles.reduce((sum, w) => sum + w, 0) > width) {
            let used = app + overflow;
            fitCount = 0;
            while (fitCount < titles.length && used + titles[fitCount] <= width)
                used += titles[fitCount++];
        }

        let x = 0;
        const place = (child, childWidth, shown) => {
            const left = shown ? x : width;
            child.allocate(Clutter.ActorBox.new(left, 0, left + childWidth, height));
            if (shown)
                x += childWidth;
        };
        place(children[0], Math.min(app, width), true);
        children.slice(1, -1).forEach((child, i) => place(child, titles[i], i < fitCount));
        place(children[children.length - 1], overflow, fitCount < titles.length);

        // Which buttons can take the focus and react changes outside of the allocation.
        if (fitCount !== this.fitCount || this._needsSync) {
            this.fitCount = fitCount;
            this._needsSync = false;
            if (!this._laterId) {
                this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                    this._laterId = 0;
                    this.emit('overflow-changed');
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }
});

// TODO: Give common applications without menus menus of their own.
//       An application which exports no menus has only the menu of its name, which could be followed by menus made
//       for it here, with items which run its actions. Together with them, F10 could be left to the applications which
//       use it themselves (see Keyboard).

/**
 * The menus of the focused window in the top bar, right of the Activities button, which shows the workspaces. The
 * bold name of the window's application comes first, with the items of the application and the window, followed by
 * the top-level menus the window exports, if any.
 *
 * Signals: "changed" when the top-level menus change.
 */
export class MenuBar extends Signals.EventEmitter {
    /**
     * @param {import('./source.js').MenuSources} sources - the menus of windows
     */
    constructor(sources) {
        super();
        this._sources = sources;
        this._tracker = Shell.WindowTracker.get_default();
        this._window = null;
        this._app = null;
        this._model = null;
        this._modelKey = null;
        this._buttons = [];
        this._titles = [];
        // The content key, see the models' contentKey(), with which each top-level menu was last filled.
        this._filledKeys = new Map();
        this._rebuildPending = false;
        // The button whose menu gives its first item the keyboard focus when it opens, and for the overflow button
        // the index of the menu whose submenu is shown then.
        this._focusOnOpen = null;
        this._focusIndex = -1;
        // Index to the submenu item of each menu in the overflow button.
        this._overflowItems = new Map();
        this._active = true;
        // The letters of the mnemonics are underlined while Alt is held on its own, and from the moment the keyboard
        // opened a menu, or was used in one, until no menu is open anymore.
        this._keyboardUsed = false;
        this._altHeld = false;
        this._mnemonicsShown = false;
        this._mnemonicsResetId = 0;
        // The grab of the menu bar while a title stays selected after Space or Return closed its menu, see
        // _selectTitle(), and whether such a menu is closing.
        this._titleGrab = null;
        this._closingToTitle = false;
        // Whether the keyboard was used in the open menu, which Escape then closes to its title, see _onMenuEvent(),
        // and the button whose menu is engaged when it opens.
        this._engaged = false;
        this._engageOnOpen = null;

        this._box = new MenuBarBox();
        this._box.connectObject(
            'overflow-changed', () => this._syncOverflow(),
            'captured-event', (actor, event) => this._onTitleEvent(event),
            this);
        // The grab of a selected title leaves the keyboard focus with the focused window, as the grabs of the menus do.
        global.display.set_grab_keeps_keyboard_focus(this._box, true);
        Main.panel._leftBox.insert_child_at_index(this._box, 0);
        this._place();
        Main.panel._leftBox.connectObject('child-added', () => this._place(), this);

        this._appButton = new MenuButton('', 'global-menu-app-name', menu => {
            if (this._app)
                fillAppMenu(menu, this._app, this._window);
        }, null, event => this._onMenuEvent(this._appButton, event));
        this._appButton.menu.connectObject('open-state-changed', (menu, open) => {
            if (open && this._focusOnOpen === this._appButton)
                this._focusFirstItem(this._appButton);
            else if (!open)
                this._rebuildIfPending();
            this._onMenuOpenStateChanged(this._appButton, open);
        }, this);
        this._box.add_child(this._appButton.container);

        this._overflowButton = new MenuButton('\u00bb', 'global-menu-title', menu => this._fillOverflow(menu), null,
            event => this._onMenuEvent(this._overflowButton, event));
        this._overflowButton.add_style_class_name('global-menu-overflow');
        this._overflowButton.menu.connectObject('open-state-changed',
            (menu, open) => this._onOverflowOpenStateChanged(open), this);
        this._box.add_child(this._overflowButton.container);

        global.display.connectObject('notify::focus-window', () => this._sync(), this);
        this._tracker.connectObject('notify::focus-app', () => this._sync(), this);
        sources.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    destroy() {
        this._leaveTitle();
        if (this._mnemonicsResetId)
            GLib.source_remove(this._mnemonicsResetId);
        this._mnemonicsResetId = 0;
        Main.panel._leftBox.disconnectObject(this);
        global.display.disconnectObject(this);
        this._tracker.disconnectObject(this);
        this._sources.disconnectObject(this);
        this._setWindow(null);
        this._setModel(null);
        this._destroyButtons();
        this._appButton.destroy();
        this._overflowButton.destroy();
        this._box.destroy();
    }

    // Keeps the menu bar right after the Activities button, which shows the workspaces. GNOME Shell adds the Activities
    // button to the end of the left box again whenever the session mode changes, as when the screen is unlocked, while
    // the menu bar stays in the top bar.
    _place() {
        const activities = Main.panel.statusArea.activities?.container;
        if (activities?.get_parent() === this._box.get_parent() && activities.get_next_sibling() !== this._box)
            this._box.get_parent().set_child_above_sibling(this._box, activities);
    }

    /**
     * Shows or hides the menu bar, which is hidden while the screen is locked.
     *
     * @param {boolean} active - whether it is shown
     */
    setActive(active) {
        this._active = active;
        if (!active) {
            this.closeMenus();
            this._leaveTitle();
        }
        this._box.visible = active && !!this._app;
        this._updateMnemonics();
    }

    /**
     * The top-level menus of the focused window, in their order, with their texts and mnemonics.
     *
     * @type {{text: string, mnemonic: string|null, index: number}[]}
     */
    get titles() {
        return this._active ? this._titles : [];
    }

    /**
     * Whether the menu bar shows the menus of a window.
     *
     * @type {boolean}
     */
    get shown() {
        return this._box.visible;
    }

    /**
     * Opens a menu with the keyboard focus on its first item.
     *
     * @param {number} index - the index of a top-level menu, or -1 for the menu of the application's name
     */
    openMenu(index) {
        if (!this.shown || index >= this._buttons.length)
            return;
        // A menu which does not fit opens as the submenu of the overflow button.
        const overflowed = index >= this._box.fitCount;
        const button = index < 0 ? this._appButton : overflowed ? this._overflowButton : this._buttons[index];
        this._openWithFocus(button, overflowed ? index : -1);
    }

    /**
     * Opens the menu of a button with the keyboard focus on its first item.
     *
     * @param {MenuButton} button - the button
     * @param {number} focusIndex - for the overflow button the index of the menu whose submenu is shown, or -1 to focus
     *   the first item of the overflow button's menu
     */
    _openWithFocus(button, focusIndex) {
        // The menu opens later when the application still has to fill it, and its first item has the focus then.
        this._focusOnOpen = button;
        this._focusIndex = focusIndex;
        this._keyboardUsed = true;
        this._engageOnOpen = button;
        // Opening a menu which is open already would fill it again, which replaces the submenus of the overflow
        // button, so the focus only moves to its first item, or for the overflow button into the submenu of the menu.
        if (button.menu.isOpen) {
            this._engaged = true;
            this._updateMnemonics();
            this._focusFirstItem(button);
            return;
        }
        button.menu.open();
    }

    // The keys pressed in an open menu show the letters of the mnemonics: Alt while it is held, any other key until no
    // menu is open anymore. The letter of a mnemonic acts on its item, or else opens the top-level menu with that
    // mnemonic, Space and Return act on the title while no item has the keyboard focus, see _selectTitle(), Escape
    // closes one level, and a shortcut of the window closes the menu and reaches the window.
    _onMenuEvent(button, event) {
        const type = event.type();
        if (type !== Clutter.EventType.KEY_PRESS && type !== Clutter.EventType.KEY_RELEASE)
            return Clutter.EVENT_PROPAGATE;
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Alt_L || key === Clutter.KEY_Alt_R) {
            this._altHeld = type === Clutter.EventType.KEY_PRESS;
            this._updateMnemonics();
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;
        // A shortcut of the window acts as if the menu were not open, also one which an item shows. The key is
        // forwarded once the menu closed, as the window receives no keys while the menu grabs them.
        if (typeof global.display.forward_key_event === 'function' && isWindowShortcut(event)) {
            button.menu.close();
            this._leaveTitle();
            global.display.forward_key_event(event);
            return Clutter.EVENT_STOP;
        }
        // Escape closes the innermost level only: an open submenu which has the keyboard focus, or whose item has
        // it, then the menu, whose title stays selected once the keyboard was used in the menu, and then the
        // selection of the title, see _onTitleEvent(). A menu which only the pointer used, or which Left or Right
        // opened without going into it, closes with everything else.
        if (key === Clutter.KEY_Escape && !hasModifiers(event)) {
            const submenu = focusedSubmenuItem(button.menu, global.stage.get_key_focus());
            if (submenu) {
                submenu.setSubmenuShown(false);
                submenu.grab_key_focus();
                this._engaged = true;
            } else if (this._engaged) {
                this._selectTitle(button);
            } else {
                button.menu.close();
                this._leaveTitle();
            }
            return Clutter.EVENT_STOP;
        }
        // GNOME Shell activates an item which has the keyboard focus with Space and Return, and toggles the menu of
        // a title which has it. While a menu is open, the keyboard focus is in the menu, and with no item focused,
        // as in a menu opened with a click, it is on the menu itself, where these keys did nothing. They act on the
        // title then, whose menu is open, so they close it, and the title stays selected.
        if ((key === Clutter.KEY_space || key === Clutter.KEY_Return) && !hasModifiers(event)) {
            const focus = global.stage.get_key_focus();
            if (!focus || focus === button.menu.actor || !button.menu.actor.contains(focus)) {
                this._selectTitle(button);
                return Clutter.EVENT_STOP;
            }
        }
        this._keyboardUsed = true;
        this._updateMnemonics();
        if (NAVIGATION_KEYS.has(key))
            this._engaged = true;
        if (activateMnemonic(button.menu, event)) {
            this._engaged = true;
            return Clutter.EVENT_STOP;
        }
        // A letter which no item of the open menu has opens the top-level menu with that mnemonic, as a letter
        // after a tap of Alt does in Qt, and in GTK while the open menu has no selected item. The menu of the
        // application's name has no mnemonics, so there each underlined letter of a title opens its menu.
        const letter = typedLetter(event);
        const index = letter ? this._titles.findIndex(title => title.mnemonic === letter) : -1;
        if (index < 0)
            return Clutter.EVENT_PROPAGATE;
        if (button !== this._buttons[index])
            this.openMenu(index);
        return Clutter.EVENT_STOP;
    }

    // Closes the open menu of a title and keeps the title selected, with the keyboard focus on it, so that Space or
    // Return opens the menu again, see _onTitleEvent(). The menu bar grabs the keyboard meanwhile, before the menu's
    // grab ends, so that the window keeps its keyboard focus throughout.
    _selectTitle(button) {
        if (!this._titleGrab) {
            // Clutter emits the events only on reactive actors, and the menu bar is reactive only meanwhile, so that
            // otherwise a click next to its titles reaches the top bar.
            this._box.reactive = true;
            this._titleGrab = Main.pushModal(this._box, {actionMode: Shell.ActionMode.POPUP});
            global.stage.connectObject('notify::key-focus', () => this._onKeyFocusChanged(), this);
        }
        this._closingToTitle = true;
        button.menu.close();
        this._closingToTitle = false;
        // A rebuild which waited for the menu to close can have removed the button.
        if (![this._appButton, ...this._buttons, this._overflowButton].includes(button) || !button.reactive) {
            this._leaveTitle();
            return;
        }
        this._keyboardUsed = true;
        button.grab_key_focus();
        this._updateMnemonics();
    }

    // Ends the selection of a title, and the keyboard returns to the focused window.
    _leaveTitle() {
        if (!this._titleGrab)
            return;
        const grab = this._titleGrab;
        this._titleGrab = null;
        global.stage.disconnectObject(this);
        Main.popModal(grab);
        this._box.reactive = false;
        this._queueMnemonicsReset();
    }

    // The selection of a title ends when the keyboard focus leaves the menu bar while no menu is open, as when the
    // selected button is destroyed.
    _onKeyFocusChanged() {
        const focus = global.stage.get_key_focus();
        if (!this.isMenuOpen() && !(focus && this._box.contains(focus)))
            this._leaveTitle();
    }

    _selectedTitle() {
        const focus = global.stage.get_key_focus();
        return [this._appButton, ...this._buttons, this._overflowButton].find(button => button === focus) ?? null;
    }

    // The keys and clicks while a title is selected and no menu is open. Space and Return open its menu as a click
    // does, with no item focused, so that they close it again, and Down opens it with the keyboard focus on its first
    // item. Left and Right select the title next to it, and the letter of a mnemonic opens that menu. Escape, a click
    // or another key ends the selection, and another key, as a shortcut of the window, reaches the window then.
    _onTitleEvent(event) {
        if (!this._titleGrab || this.isMenuOpen())
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN ||
            type === Clutter.EventType.SCROLL) {
            // A click on a title then opens its menu as usual, and one elsewhere only ends the selection, as a click
            // outside an open menu only closes the menu.
            const onTitle = this._box.contains(global.stage.get_event_actor(event));
            this._leaveTitle();
            return onTitle && type !== Clutter.EventType.SCROLL ? Clutter.EVENT_PROPAGATE : Clutter.EVENT_STOP;
        }
        if (type !== Clutter.EventType.KEY_PRESS && type !== Clutter.EventType.KEY_RELEASE)
            return Clutter.EVENT_PROPAGATE;
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Alt_L || key === Clutter.KEY_Alt_R) {
            this._altHeld = type === Clutter.EventType.KEY_PRESS;
            this._updateMnemonics();
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;
        const button = this._selectedTitle();
        if (button && !hasModifiers(event)) {
            switch (key) {
            case Clutter.KEY_space:
            case Clutter.KEY_Return:
                this._focusOnOpen = null;
                this._focusIndex = -1;
                this._engageOnOpen = button;
                button.menu.open();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
                this._openWithFocus(button, -1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Left:
            case Clutter.KEY_Right: {
                const titles = [this._appButton, ...this._buttons, this._overflowButton].filter(b => b.reactive);
                const step = key === Clutter.KEY_Left ? -1 : 1;
                titles[(titles.indexOf(button) + step + titles.length) % titles.length]?.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
            case Clutter.KEY_Escape:
                this._leaveTitle();
                return Clutter.EVENT_STOP;
            }
        }
        const letter = typedLetter(event);
        const index = letter ? this._titles.findIndex(title => title.mnemonic === letter) : -1;
        if (button && index >= 0) {
            this.openMenu(index);
            return Clutter.EVENT_STOP;
        }
        this._leaveTitle();
        if (typeof global.display.forward_key_event === 'function')
            global.display.forward_key_event(event);
        return Clutter.EVENT_STOP;
    }

    /**
     * Underlines the letters of the mnemonics while Alt is held on its own, also while no menu is open.
     *
     * @param {boolean} held - whether Alt is held
     */
    setAltHeld(held) {
        this._altHeld = held;
        this._updateMnemonics();
    }

    _updateMnemonics() {
        const shown = this._active &&
            (this._altHeld || (this._keyboardUsed && (this.isMenuOpen() || !!this._titleGrab)));
        if (shown === this._mnemonicsShown)
            return;
        this._mnemonicsShown = shown;
        for (const button of this._buttons)
            setMnemonicShown(button.label, shown);
        for (const button of [this._appButton, ...this._buttons, this._overflowButton])
            setMenuMnemonicsShown(button.menu, shown);
    }

    // Moving from one menu to the next closes one and opens the other, so the letters are hidden only once no menu
    // stays open and no title is selected.
    _queueMnemonicsReset() {
        if (this._mnemonicsResetId)
            return;
        this._mnemonicsResetId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._mnemonicsResetId = 0;
            if (!this.isMenuOpen() && !this._titleGrab) {
                this._keyboardUsed = false;
                this._altHeld = false;
            }
            this._updateMnemonics();
            return GLib.SOURCE_REMOVE;
        });
    }

    _focusFirstItem(button) {
        const item = this._overflowItems.get(this._focusIndex);
        this._focusOnOpen = null;
        this._focusIndex = -1;
        if (button === this._overflowButton && item) {
            item.setSubmenuShown(true);
            item.menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
        } else {
            button.menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
        }
    }

    /**
     * Acts on a tap of the left Alt on its own. In a menu which the mouse opened and in which no key was used yet, it
     * underlines the letters of the mnemonics, which then stay underlined, and leaves the menu open, and otherwise it
     * acts as F10, see toggleMenu().
     */
    tapAlt() {
        if (this.isMenuOpen() && !this._keyboardUsed) {
            this._keyboardUsed = true;
            this._updateMnemonics();
            return;
        }
        this.toggleMenu();
    }

    /**
     * Acts on F10: closes the open menu, or ends the selection of a title, see _selectTitle(), and otherwise opens the
     * menu of the title under the pointer, or of the application's name when the pointer is on no other title, with the
     * keyboard focus on its first item.
     */
    toggleMenu() {
        if (this.isMenuOpen() || this._titleGrab) {
            this.closeMenus();
            this._leaveTitle();
            return;
        }
        if (!this.shown)
            return;
        const hovered = [...this._buttons, this._overflowButton].find(button => button.hover && button.reactive);
        if (hovered === this._overflowButton)
            this._openWithFocus(hovered, -1);
        else
            this.openMenu(hovered ? this._buttons.indexOf(hovered) : -1);
    }

    isMenuOpen() {
        return [this._appButton, ...this._buttons, this._overflowButton].some(button => button.menu.isOpen);
    }

    closeMenus() {
        for (const button of [this._appButton, ...this._buttons, this._overflowButton])
            button.menu.close();
    }

    /**
     * The menus which do not fit into the top bar and are in the overflow button, by their index.
     *
     * @type {number[]}
     */
    get overflowed() {
        return this._titles.map((_title, index) => index).filter(index => index >= this._box.fitCount);
    }

    _onMenuOpenStateChanged(button, open) {
        if (open) {
            // A menu is engaged when the keyboard opened it with an item focused, or Space or Return on its selected
            // title, and not when the pointer or Left and Right from another menu opened it.
            this._engaged = this._engageOnOpen === button;
            this._engageOnOpen = null;
            this._updateMnemonics();
            return;
        }
        // A title stays selected when Space, Return or Escape closed its menu to it, see _selectTitle(), and when Left
        // or Right moved to the next menu. An item chosen, a click and another menu opened by the pointer end the
        // selection.
        const event = Clutter.get_current_event();
        const key = event?.type() === Clutter.EventType.KEY_PRESS ? event.get_key_symbol() : null;
        if (!this._closingToTitle && key !== Clutter.KEY_Left && key !== Clutter.KEY_Right)
            this._leaveTitle();
        this._queueMnemonicsReset();
    }

    // The buttons of the menus which do not fit are not shown, and cannot be focused or clicked either.
    _syncOverflow() {
        this._buttons.forEach((button, index) => button.setSensitive(index < this._box.fitCount));
        this._overflowButton.setSensitive(this._box.fitCount < this._buttons.length);
        if (this._titleGrab && !this.isMenuOpen() && !this._selectedTitle()?.reactive)
            this._leaveTitle();
    }

    // The overflow button has a submenu for each menu which does not fit.
    _fillOverflow(menu) {
        menu.removeAll();
        this._overflowItems.clear();
        for (const index of this.overflowed) {
            const {text, index: mnemonicIndex} = this._titles[index];
            const item = addSubmenuItem(menu, {text, mnemonicIndex});
            this._model.fill(index, item.menu);
            this._filledKeys.set(index, this._model.contentKey(index));
            this._overflowItems.set(index, item);
        }
        setMenuMnemonicsShown(menu, this._mnemonicsShown);
    }

    // The application fills its menus when told that they open, as LibreOffice does, so all menus in the overflow
    // button are prepared when it opens, and refilled when they change.
    _onOverflowOpenStateChanged(open) {
        this._onMenuOpenStateChanged(this._overflowButton, open);
        const model = this._model;
        if (!model)
            return;
        if (!open) {
            for (const index of this._overflowItems.keys())
                model.closed(index);
            this._rebuildIfPending();
            return;
        }
        if (this._focusOnOpen === this._overflowButton)
            this._focusFirstItem(this._overflowButton);
        for (const index of this._overflowItems.keys()) {
            model.prepare(index).then(changed => {
                if (changed && this._model === model && this._overflowButton.menu.isOpen)
                    this._refillOverflow(index);
            });
        }
    }

    _refillOverflow(index) {
        const item = this._overflowItems.get(index);
        const key = this._model.contentKey(index);
        if (!item || !this._model.hasItems(index) || key === this._filledKeys.get(index))
            return;
        this._model.fill(index, item.menu);
        setMenuMnemonicsShown(item.menu, this._mnemonicsShown);
        this._filledKeys.set(index, key);
    }

    _setWindow(window) {
        if (window === this._window)
            return;
        this._leaveTitle();
        this._window?.disconnectObject(this);
        this._window = window;
        for (const property of WINDOW_PROPERTIES)
            window?.connectObject(`notify::${property}`, () => this._sync(), this);
    }

    _sync() {
        const focus = global.display.focus_window;
        this._setWindow(focus);
        // Desktop Icons NG shows the desktop in a window of the type DESKTOP, which has the focus while no other window
        // has it. The menu bar shows nothing for it, as for no focused window, and not the name GNOME Shell gives the
        // program of that window, gjs.
        const window = focus?.get_window_type() === Meta.WindowType.DESKTOP ? null : focus;
        this._app = window ? this._tracker.get_window_app(window) : null;
        this._appButton.label.text = this._app?.get_name() ?? '';
        this._appButton.accessible_name = this._appButton.label.text;
        this._box.visible = this._active && !!this._app;

        const description = window ? this._sources.describe(window) : null;
        if ((description?.key ?? null) === this._modelKey)
            return;
        this._setModel(description);
        this._queueRebuild();
    }

    _setModel(description) {
        if (this._model) {
            this._model.disconnectObject(this);
            this._sources.release(this._modelKey);
        }
        this._model = description ? this._sources.acquire(description) : null;
        this._modelKey = description?.key ?? null;
        this._model?.connectObject(
            'titles-changed', () => this._queueRebuild(),
            'content-changed', () => this._refillOpenMenu(),
            'activation-requested', (_model, index) => this.openMenu(index),
            this);
    }

    _destroyButtons() {
        for (const button of this._buttons)
            button.destroy();
        this._buttons = [];
        this._titles = [];
        this._filledKeys.clear();
    }

    // Replacing the buttons closes an open menu, so with a menu open they are replaced only once it closes.
    _queueRebuild() {
        if (this.isMenuOpen()) {
            this._rebuildPending = true;
            return;
        }
        this._rebuild();
    }

    _rebuildIfPending() {
        if (this._rebuildPending && !this.isMenuOpen())
            this._rebuild();
    }

    // Shows a button for each title of the model. A button whose title has the same text and mnemonic as before is
    // kept, so that a title stays shown, also under the pointer, while an application adds or removes another menu, and
    // the other buttons are added or removed. The buttons find their index when they are used, as it can change.
    _rebuild() {
        this._rebuildPending = false;
        const titles = this._model?.titles ?? [];
        const keyOf = title => JSON.stringify([title.text, title.index]);
        const shown = new Map();
        this._buttons.forEach((button, index) => {
            const key = keyOf(this._titles[index]);
            if (!shown.has(key))
                shown.set(key, []);
            shown.get(key).push(button);
        });
        const buttons = titles.map(title => shown.get(keyOf(title))?.shift() ?? this._createButton(title));
        for (const rest of shown.values()) {
            for (const button of rest)
                button.destroy();
        }
        this._buttons = buttons;
        this._titles = titles;
        this._filledKeys.clear();
        for (const button of buttons)
            this._box.set_child_below_sibling(button.container, this._overflowButton.container);
        this._box.reset(titles.length);
        this._syncOverflow();
        if (this._titleGrab && !this._closingToTitle && !this._selectedTitle())
            this._leaveTitle();
        this.emit('changed');
    }

    _createButton({text, index: mnemonicIndex}) {
        const button = new MenuButton(text, 'global-menu-title',
            menu => this._fill(this._buttons.indexOf(button), menu),
            done => this._prepareEmpty(this._buttons.indexOf(button), done),
            event => this._onMenuEvent(button, event));
        setLabelMnemonic(button.label, text, mnemonicIndex);
        setMnemonicShown(button.label, this._mnemonicsShown);
        button.menu.connectObject('open-state-changed',
            (menu, open) => this._onOpenStateChanged(this._buttons.indexOf(button), open), this);
        this._box.insert_child_below(button.container, this._overflowButton.container);
        return button;
    }

    _onOpenStateChanged(index, open) {
        const button = this._buttons[index];
        this._onMenuOpenStateChanged(button, open);
        const model = this._model;
        if (!model || !button)
            return;
        if (!open) {
            model.closed(index);
            this._rebuildIfPending();
            return;
        }
        if (this._focusOnOpen === button)
            this._focusFirstItem(button);
        model.prepare(index).then(changed => {
            if (changed && this._model === model && button.menu.isOpen)
                this._refill(index);
        });
    }

    /**
     * Asks the application to fill a top-level menu which has no items, and calls done once the model reports a change
     * or after FILL_TIMEOUT_MS.
     *
     * @param {number} index - the index of the top-level menu
     * @param {function(): void} done - called once
     */
    _prepareEmpty(index, done) {
        const model = this._model;
        let finished = false;
        let timeoutId = 0;
        const finish = () => {
            if (finished)
                return;
            finished = true;
            model.disconnect(changedId);
            if (timeoutId)
                GLib.source_remove(timeoutId);
            if (this._model === model)
                done();
        };
        const changedId = model.connect('content-changed', finish);
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FILL_TIMEOUT_MS, () => {
            timeoutId = 0;
            finish();
            return GLib.SOURCE_REMOVE;
        });
        model.prepare(index).then(changed => {
            if (changed)
                finish();
        });
    }

    _fill(index, menu) {
        this._model.fill(index, menu);
        setMenuMnemonicsShown(menu, this._mnemonicsShown);
        this._filledKeys.set(index, this._model.contentKey(index));
    }

    _refillOpenMenu() {
        const index = this._buttons.findIndex(button => button.menu.isOpen);
        if (index >= 0)
            this._refill(index);
        if (this._overflowButton.menu.isOpen) {
            for (const overflowed of this._overflowItems.keys())
                this._refillOverflow(overflowed);
        }
    }

    // Shows the changed items of an open menu. The items which the menu still has stay, see syncMenu(), with their open
    // submenus and the keyboard focus. When the item with the keyboard focus is gone, the item at its position receives
    // the focus.
    _refill(index) {
        // An application which sets its menu again, as Electron does, can report a menu without its items for a
        // moment, which leaves the open menu as it is.
        const key = this._model.contentKey(index);
        if (!this._buttons[index] || !this._model.hasItems(index) || key === this._filledKeys.get(index))
            return;
        const menu = this._buttons[index].menu;
        const focus = global.stage.get_key_focus();
        const position = menu._getMenuItems().findIndex(item => item === focus || item.contains(focus));
        this._fill(index, menu);
        if (position >= 0 && !menu.box.contains(global.stage.get_key_focus())) {
            const items = menu._getMenuItems();
            items[Math.min(position, items.length - 1)]?.grab_key_focus();
        }
    }
}
