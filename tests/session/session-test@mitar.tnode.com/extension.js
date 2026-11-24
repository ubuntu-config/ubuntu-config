import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

/**
 * Returns the window with the given ID.
 *
 * @param {number} id - the window's ID, as windows() reports it
 * @returns {Meta.Window} the window
 * @throws {Error} when there is no such window
 */
function windowById(id) {
    const window = global.get_window_actors().map(actor => actor.meta_window).find(w => w.get_id() === id);
    if (!window)
        throw new Error(`No window ${id}`);
    return window;
}

/**
 * Returns the application with the given ID.
 *
 * @param {string} appId - the ID of the application's desktop file, such as org.gnome.TextEditor.desktop
 * @returns {Shell.App} the application
 * @throws {Error} when there is no such application
 */
function appById(appId) {
    const app = Shell.AppSystem.get_default().lookup_app(appId);
    if (!app)
        throw new Error(`No application ${appId}`);
    return app;
}

/**
 * Waits for a while.
 *
 * @param {number} ms - how long, in milliseconds
 * @returns {Promise<void>} resolved after the time
 */
function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

/**
 * Returns the buttons of the global menu in the top bar (gnome-extensions/global-menu@mitar.tnode.com), the first
 * being the one with the application's name, without the overflow button, which globalMenuOverflow() returns.
 *
 * @returns {object[]|null} the buttons, or null when the extension shows no menu bar
 */
function globalMenuButtons() {
    const bar = Main.panel._leftBox.get_children().find(child => child.has_style_class_name?.('global-menu-bar'));
    return bar ? bar.get_children().map(container => container.get_child())
        .filter(button => !button.has_style_class_name('global-menu-overflow')) : null;
}

/**
 * @returns {object|null} the overflow button of the global menu, which has the menus which do not fit
 */
function globalMenuOverflow() {
    const bar = Main.panel._leftBox.get_children().find(child => child.has_style_class_name?.('global-menu-bar'));
    return bar?.get_children().map(container => container.get_child())
        .find(button => button.has_style_class_name('global-menu-overflow')) ?? null;
}

/**
 * Describes the items of a menu for the tests: a separator as "---", an item by its label, a submenu as an object with
 * its label and items, and a checked item with a leading "[x] ".
 *
 * @param {object} menu - the menu
 * @returns {Array} the items
 */
function describeItems(menu) {
    return menu._getMenuItems().map(item => {
        if (item.menu)
            return {label: item.label.text, open: item.menu.isOpen, items: describeItems(item.menu)};
        if (item.has_style_class_name('popup-separator-menu-item'))
            return '---';
        const checked = item._ornament === 1 || item._ornament === 2;
        return `${checked ? '[x] ' : ''}${item.label.text}${item.sensitive ? '' : ' (disabled)'}`;
    });
}

/**
 * Describes where the labels of the items of a menu start, and which items have an icon.
 *
 * @param {object} menu - the menu
 * @returns {object[]} each item with a label, as {label, x, icon}
 */
function describeLayout(menu) {
    return menu._getMenuItems()
        .filter(item => item.label && !item.has_style_class_name('popup-separator-menu-item'))
        .map(item => ({
            label: item.label.text,
            x: Math.round(item.label.get_transformed_position()[0]),
            icon: item.get_children().some(child => child instanceof St.Icon && child.gicon &&
                child.has_style_class_name('popup-menu-icon')),
        }));
}

/**
 * Finds an item of an open menu by its label, also in its open submenus.
 *
 * @param {object} menu - the menu
 * @param {string} label - the label
 * @returns {object|null} the item
 */
function findItem(menu, label) {
    for (const item of menu._getMenuItems()) {
        if (item.label?.text === label)
            return item;
        if (item.menu?.isOpen) {
            const found = findItem(item.menu, label);
            if (found)
                return found;
        }
    }
    return null;
}

/**
 * The methods the session tests call through Eval, as globalThis.sessionTest.<method>(...). Every method returns a
 * value which JSON can represent.
 */
class SessionTest {
    /**
     * @returns {boolean} whether GNOME Shell has finished starting up
     */
    ready() {
        return !Main.layoutManager._startingUp;
    }

    /**
     * @returns {object[]} the normal windows and dialogs, each with the properties the tests check
     */
    windows() {
        const tracker = Shell.WindowTracker.get_default();
        return global.get_window_actors().map(actor => actor.meta_window).filter(w => !w.is_override_redirect()).map(w => {
            const rect = w.get_frame_rect();
            const workspace = w.get_workspace();
            return {
                id: w.get_id(),
                title: w.get_title(),
                wmClass: w.get_wm_class(),
                gtkApplicationId: w.get_gtk_application_id(),
                app: tracker.get_window_app(w)?.get_id() ?? null,
                pid: w.get_pid(),
                type: w.get_window_type(),
                workspace: workspace ? workspace.index() : null,
                onAllWorkspaces: w.is_on_all_workspaces(),
                monitor: w.get_monitor(),
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                focused: w.has_focus(),
                demandsAttention: w.demands_attention,
                minimized: w.minimized,
                maximized: w.get_maximize_flags() === Meta.MaximizeFlags.BOTH,
                fullscreen: w.is_fullscreen(),
            };
        });
    }

    /**
     * @returns {{count: number, active: number}} the number of workspaces and the index of the active one
     */
    workspaces() {
        const manager = global.workspace_manager;
        return {count: manager.get_n_workspaces(), active: manager.get_active_workspace_index()};
    }

    /**
     * Switches to a workspace, as the workspace switcher does.
     *
     * @param {number} index - the index of the workspace
     */
    activateWorkspace(index) {
        global.workspace_manager.get_workspace_by_index(index).activate(global.get_current_time());
    }

    /**
     * Moves a window to a workspace, as its window menu does, without switching to it.
     *
     * @param {number} id - the window's ID
     * @param {number} index - the index of the workspace
     */
    moveWindowToWorkspace(id, index) {
        windowById(id).change_workspace_by_index(index, false);
    }

    /**
     * Moves and resizes a window, as dragging it and its edges does.
     *
     * @param {number} id - the window's ID
     * @param {number} x - where its frame's left edge goes, in stage coordinates
     * @param {number} y - where its frame's top edge goes
     * @param {number} width - the width of its frame
     * @param {number} height - the height of its frame
     */
    moveResizeWindow(id, x, y, width, height) {
        windowById(id).move_resize_frame(true, x, y, width, height);
    }

    /**
     * Activates a window, switching to its workspace, as clicking it in the overview does.
     *
     * @param {number} id - the window's ID
     */
    activateWindow(id) {
        Main.activateWindow(windowById(id));
    }

    /**
     * Marks a window as demanding attention, the mark mutter sets on a window whose activation it refuses.
     *
     * @param {number} id - the window's ID
     */
    setDemandsAttention(id) {
        windowById(id).set_demands_attention();
    }

    /**
     * Starts an application or activates it, as clicking it in the overview or in the dash does.
     *
     * @param {string} appId - the ID of the application's desktop file
     */
    activateApp(appId) {
        appById(appId).activate();
    }

    /**
     * Opens a new window of an application, as the New Window item of its menu in the dash does.
     *
     * @param {string} appId - the ID of the application's desktop file
     */
    openNewWindow(appId) {
        appById(appId).open_new_window(-1);
    }

    /**
     * Clicks an application's icon in the Ubuntu Dock, which then does what its settings say, as a click of the mouse
     * does. The dock shows an icon for every favorite and running application.
     *
     * @param {string} appId - the ID of the application's desktop file
     * @param {number} button - the mouse button, 1 for the left one and 2 for the middle one
     */
    async clickDockIcon(appId, button = 1) {
        const dock = Main.extensionManager.lookup('ubuntu-dock@ubuntu.com');
        if (!dock)
            throw new Error('No Ubuntu Dock');
        // The same module the dock imported, which holds the running dock.
        const {DockManager} = await import(`file://${dock.path}/docking.js`);
        const icon = DockManager.getDefault().mainDock.dash.getAppIcons().find(i => i.app?.get_id() === appId);
        if (!icon)
            throw new Error(`No dock icon for ${appId}`);
        icon.activate(button);
    }

    /**
     * @returns {Promise<string>} the text in the clipboard, as the next paste would insert it
     */
    clipboardText() {
        return new Promise(resolve => {
            St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => resolve(text));
        });
    }

    /**
     * Runs a command, as the Alt+F2 dialog does.
     *
     * @param {string} commandLine - the command, which is parsed as a shell would
     */
    spawnCommandLine(commandLine) {
        Util.trySpawnCommandLine(commandLine);
    }

    /**
     * Presses and releases a key with modifiers on a virtual keyboard, which goes to the focused window as a key of a
     * real keyboard does.
     *
     * @param {string} key - the name of the key's keysym, such as Return or F2
     * @param {string[]} modifiers - the names of the modifiers' keysyms held meanwhile, such as Control_L
     */
    async pressKey(key, modifiers = []) {
        await this._ensureKeyboard();
        const keyvals = [...modifiers, key].map(name => {
            const keyval = Clutter[`KEY_${name}`];
            if (keyval === undefined)
                throw new Error(`No key ${name}`);
            return keyval;
        });
        const time = () => GLib.get_monotonic_time();
        for (const keyval of keyvals)
            this._keyboard.notify_keyval(time(), keyval, Clutter.KeyState.PRESSED);
        for (const keyval of keyvals.reverse())
            this._keyboard.notify_keyval(time(), keyval, Clutter.KeyState.RELEASED);
    }

    /**
     * @returns {object[]} the open modal dialogs, such as the one asking to confirm logging out, with their title and,
     *     for that one, the applications it lists as busy or with unsaved work
     */
    dialogs() {
        return Main.layoutManager.modalDialogGroup.get_children().filter(d => d.visible && d.state !== undefined).map(d => ({
            type: d.constructor.name,
            state: d.state,
            title: d._messageDialogContent?.title ?? null,
            applications: d._applicationSection?.list.get_children().map(item => item.title) ?? [],
        }));
    }

    /**
     * Confirms the open dialog which asks to confirm logging out, restarting or powering off, as its button does.
     *
     * @param {string} signal - the D-Bus signal the button emits, ConfirmedLogout, ConfirmedReboot or ConfirmedShutdown
     * @returns {boolean} whether such a dialog was open
     */
    confirmEndSession(signal = 'ConfirmedLogout') {
        const dialog = Main.layoutManager.modalDialogGroup.get_children().find(d => d.visible && d._confirm && d._type !== undefined);
        if (!dialog)
            return false;
        dialog._confirm(signal).catch(logError);
        return true;
    }

    /**
     * @param {string} uuid - the extension's UUID
     * @returns {?{state: string, error: string}} the extension's state, such as ACTIVE, and its error, or null when
     *     GNOME Shell does not know the extension
     */
    extensionState(uuid) {
        const extension = Main.extensionManager.lookup(uuid);
        if (!extension)
            return null;
        const name = Object.keys(ExtensionState).find(key => ExtensionState[key] === extension.state) ?? `${extension.state}`;
        return {state: name, error: `${extension.error ?? ''}`};
    }

    /**
     * @returns {object[]} the chrome GNOME Shell tracks, the dock and the top bar for example, each with its position,
     *     its size and whether it reserves space for itself
     */
    trackedChrome() {
        return Main.layoutManager._trackedActors.map(({actor, affectsStruts}) => {
            const [x, y] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            return {name: actor.name ?? null, type: actor.constructor.name, affectsStruts: !!affectsStruts,
                x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height),
                mapped: actor.mapped};
        });
    }

    /**
     * Maximizes a window, as double-clicking its title bar does.
     *
     * @param {number} id - the window's ID
     */
    maximizeWindow(id) {
        windowById(id).maximize(Meta.MaximizeFlags.BOTH);
    }

    /**
     * @returns {{button: ?boolean, open: boolean}} whether the screenshot button of quick settings is visible, null when
     *     there is none, and whether the screenshot UI is open
     */
    screenshotState() {
        const buttons = [];
        const walk = actor => {
            if (actor.constructor.name === 'ScreenshotItem')
                buttons.push(actor);
            actor.get_children().forEach(walk);
        };
        walk(Main.panel.statusArea.quickSettings.menu.actor);
        return {button: buttons.length ? buttons[0].visible : null, open: Main.screenshotUI.visible};
    }

    /**
     * Returns GNOME Shell's lock screen. GNOME Shell creates it only when GDM and logind run, which the test session
     * has neither of, so then one of its own is created here, which locks the screen the same way.
     *
     * @returns {Promise<object>} the lock screen
     */
    async _screenShield() {
        if (Main.screenShield)
            return Main.screenShield;
        if (!this._ownScreenShield) {
            const {ScreenShield} = await import('resource:///org/gnome/shell/ui/screenShield.js');
            this._ownScreenShield = new ScreenShield();
        }
        return this._ownScreenShield;
    }

    /**
     * Unlocks the screen, as authenticating on the lock screen does.
     */
    async unlock() {
        (await this._screenShield()).deactivate(false);
    }

    /**
     * Locks the screen, as Super+L does.
     */
    async lock() {
        (await this._screenShield()).lock(false);
    }

    /**
     * @returns {boolean} whether the screen is locked
     */
    locked() {
        return Main.sessionMode.isLocked;
    }

    /**
     * @returns {object} the global menu in the top bar: whether the extension shows it, the titles of its buttons, the
     *     first being the application's name, the titles of the menus which do not fit and are in the overflow button,
     *     the title of the open menu, which is the label of the overflow button for it, and its items, see
     *     describeItems(), and the label of the item which has the keyboard focus
     */
    globalMenu() {
        this._ensurePointer();
        const buttons = globalMenuButtons();
        if (!buttons)
            return {shown: false, titles: [], overflowed: [], open: null, items: null, focus: null};
        const overflow = globalMenuOverflow();
        const open = [...buttons, overflow].find(button => button?.menu.isOpen);
        const focus = global.stage.get_key_focus();
        return {
            shown: buttons[0].get_parent().get_parent().visible,
            titles: buttons.map(button => button.label.text),
            overflowed: buttons.slice(1).filter(button => !button.reactive).map(button => button.label.text),
            open: open?.label.text ?? null,
            items: open ? describeItems(open.menu) : null,
            layout: open ? describeLayout(open.menu) : null,
            focus: focus?.label?.text ?? null,
        };
    }

    async _ensureKeyboard() {
        if (this._keyboard)
            return;
        const seat = Clutter.get_default_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        // Keys sent before the new device is set up are lost.
        await sleep(500);
    }

    /**
     * Creates the virtual pointer and moves it to the middle of the screen. A pointer created while a menu is open
     * does not click its items, its press closes the menu instead, so the tests of the global menu create it before
     * they open a menu, by asking for its state.
     *
     * @returns {Promise<void>} resolved once the pointer is ready
     */
    _ensurePointer() {
        if (!this._pointerReady) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
            this._pointerReady = sleep(500).then(() => {
                this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), global.stage.width / 2,
                    global.stage.height / 2);
                return sleep(300);
            });
        }
        return this._pointerReady;
    }

    async _click(actor) {
        await this._ensurePointer();
        // A submenu opens with an animation, which moves the items below it, so the pointer goes to an item only
        // once its place stayed the same for a moment.
        let place = null;
        for (let i = 0; i < 30; i++) {
            const current = JSON.stringify([actor.get_transformed_position(), actor.get_transformed_size()]);
            if (current === place && actor.mapped)
                break;
            place = current;
            // eslint-disable-next-line no-await-in-loop
            await sleep(100);
        }
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + width / 2, y + height / 2);
        await sleep(200);
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await sleep(50);
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    }

    /**
     * Clicks a title of the global menu with a virtual pointer, which opens its menu, or closes it when it is open.
     *
     * @param {string} title - the title, or the application's name for its menu
     */
    async clickGlobalMenu(title) {
        const overflow = globalMenuOverflow();
        const button = title === overflow?.label.text ? overflow : globalMenuButtons()?.find(b => b.label.text === title);
        if (!button)
            throw new Error(`No global menu ${title}`);
        // A menu which does not fit is a submenu of the overflow button.
        if (!button.reactive) {
            if (!overflow.menu.isOpen)
                await this._click(overflow);
            await this.clickGlobalMenuItem(title);
            return;
        }
        await this._click(button);
    }

    /**
     * Clicks an item of the open global menu with a virtual pointer, also an item of an open submenu, and clicking a
     * submenu opens it.
     *
     * @param {string} label - the label of the item
     */
    async clickGlobalMenuItem(label) {
        const open = [...globalMenuButtons() ?? [], globalMenuOverflow()].find(button => button?.menu.isOpen);
        let item = open && findItem(open.menu, label);
        // The submenu which has the item can still be opening.
        for (let i = 0; i < 20 && open && !item; i++) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(100);
            item = findItem(open.menu, label);
        }
        if (!item) {
            throw new Error(`No item ${label} in the open global menu, ` +
                `which has ${JSON.stringify(open ? describeItems(open.menu) : null)}`);
        }
        await this._click(item);
    }

    /**
     * Presses a key and releases it later, so that the key is held meanwhile, as pressKey() does not do.
     *
     * @param {string} key - the name of the key's keysym
     * @param {boolean} pressed - whether to press or release it
     */
    async setKey(key, pressed) {
        await this._ensureKeyboard();
        const keyval = Clutter[`KEY_${key}`];
        if (keyval === undefined)
            throw new Error(`No key ${key}`);
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), keyval,
            pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
    }
}

export default class SessionTestExtension extends Extension {
    enable() {
        // Eval works only in unsafe mode, which is otherwise turned on only from Looking Glass.
        global.context.unsafe_mode = true;
        globalThis.sessionTest = new SessionTest();
    }

    disable() {
        delete globalThis.sessionTest;
        global.context.unsafe_mode = false;
    }
}
