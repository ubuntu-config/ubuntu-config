import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {addItem, addSeparator, formatGtkAccel, parseMnemonic, trimSeparator} from './util.js';

/**
 * Returns an attribute of a menu item as a JavaScript value.
 *
 * @param {Gio.MenuModel} model - the menu
 * @param {number} index - the index of the item
 * @param {string} name - the name of the attribute
 * @param {string} type - the GVariant type the attribute has to have
 * @returns {*} the value, or null when the item does not have the attribute with this type
 */
function attribute(model, index, name, type) {
    return model.get_item_attribute_value(index, name, new GLib.VariantType(type))?.unpack() ?? null;
}

/**
 * The menu bar of a GTK window, exported as a GMenuModel, with the actions of its application and window exported as
 * GActionGroups, which GTK names through gtk_shell1 and LibreOffice too.
 *
 * The models GLib gives for the D-Bus menus fill only after they are asked for their items, and every submenu and
 * section is a model of its own, so the whole tree is followed from the start, and a change in any part of it emits a
 * signal. The action groups likewise learn their actions only after they are asked for them.
 *
 * Signals: "titles-changed" when the top-level menus change and "content-changed" when anything changes.
 */
export class GtkMenuModel extends Signals.EventEmitter {
    /**
     * @param {string} busName - the unique D-Bus name of the application
     * @param {string} menubarPath - the object path of the menu bar
     * @param {string|null} applicationPath - the object path of the application's actions, with the prefix "app."
     * @param {string|null} windowPath - the object path of the window's actions, with the prefix "win."
     */
    constructor(busName, menubarPath, applicationPath, windowPath) {
        super();
        const bus = Gio.DBus.session;
        this._root = Gio.DBusMenuModel.get(bus, busName, menubarPath);
        this._groups = {};
        this._loaded = {};
        for (const [prefix, path] of [['app', applicationPath], ['win', windowPath]]) {
            if (!path)
                continue;
            const group = Gio.DBusActionGroup.get(bus, busName, path);
            this._groups[prefix] = group;
            for (const signal of ['action-added', 'action-removed', 'action-enabled-changed', 'action-state-changed']) {
                group.connectObject(signal, () => {
                    this._loaded[prefix] = true;
                    this._queueChanged();
                }, this);
            }
            group.list_actions();
        }
        this._models = new Map();
        this._titlesKey = '';
        this._changedId = 0;
        this._track(this._root);
    }

    destroy() {
        for (const [model, id] of this._models)
            model.disconnect(id);
        this._models.clear();
        for (const group of Object.values(this._groups))
            group.disconnectObject(this);
        if (this._changedId)
            GLib.source_remove(this._changedId);
        this._changedId = 0;
    }

    _track(model) {
        if (this._models.has(model))
            return;
        this._models.set(model, model.connect('items-changed', () => {
            this._scan(model);
            this._queueChanged();
        }));
        this._scan(model);
    }

    _scan(model) {
        for (let i = 0; i < model.get_n_items(); i++) {
            for (const link of [Gio.MENU_LINK_SUBMENU, Gio.MENU_LINK_SECTION]) {
                const linked = model.get_item_link(i, link);
                if (linked)
                    this._track(linked);
            }
        }
    }

    _queueChanged() {
        if (this._changedId)
            return;
        this._changedId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._changedId = 0;
            const titlesKey = JSON.stringify(this._topLevel().map(t => t.label));
            if (titlesKey !== this._titlesKey) {
                this._titlesKey = titlesKey;
                this.emit('titles-changed');
            }
            this.emit('content-changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * The submenus of the menu bar, also those inside its sections, with their labels, their models and the actions
     * which LibreOffice uses to fill a submenu when it opens.
     *
     * @returns {{label: string, model: Gio.MenuModel, submenuAction: string|null}[]} the submenus
     */
    _topLevel(model = this._root) {
        const result = [];
        for (let i = 0; i < model.get_n_items(); i++) {
            const section = model.get_item_link(i, Gio.MENU_LINK_SECTION);
            if (section) {
                result.push(...this._topLevel(section));
                continue;
            }
            const submenu = model.get_item_link(i, Gio.MENU_LINK_SUBMENU);
            if (submenu && !this._hidden(model, i)) {
                result.push({
                    label: attribute(model, i, 'label', 's') ?? '',
                    model: submenu,
                    submenuAction: attribute(model, i, 'submenu-action', 's'),
                });
            }
        }
        return result;
    }

    /**
     * The top-level menus, in their order, with their texts and mnemonics.
     *
     * @type {{text: string, mnemonic: string|null}[]}
     */
    get titles() {
        return this._topLevel().map(t => parseMnemonic(t.label));
    }

    _action(detailedName) {
        const dot = detailedName?.indexOf('.') ?? -1;
        if (dot < 0)
            return [null, null, null];
        const prefix = detailedName.slice(0, dot);
        return [this._groups[prefix] ?? null, detailedName.slice(dot + 1), prefix];
    }

    _hidden(model, index) {
        const hiddenWhen = attribute(model, index, 'hidden-when', 's');
        if (!hiddenWhen)
            return false;
        // This menu bar is in the top bar of the screen, which is what GTK calls a macOS menu bar.
        if (hiddenWhen === 'macos-menubar')
            return true;
        const [group, name, prefix] = this._action(attribute(model, index, 'action', 's'));
        const exists = group?.has_action(name) ?? false;
        if (hiddenWhen === 'action-missing')
            return this._loaded[prefix] && !exists;
        if (hiddenWhen === 'action-disabled')
            return this._loaded[prefix] && (!exists || !group.get_action_enabled(name));
        return false;
    }

    /**
     * Opens a submenu of LibreOffice, which fills it only then. Other applications have nothing to prepare.
     *
     * @param {number} index - the index of the top-level menu
     * @returns {Promise<boolean>} whether the items changed, which LibreOffice reports later with "content-changed"
     */
    async prepare(index) {
        this._setSubmenuAction(index, true);
        return false;
    }

    /**
     * Closes a submenu of LibreOffice again.
     *
     * @param {number} index - the index of the top-level menu
     */
    closed(index) {
        this._setSubmenuAction(index, false);
    }

    _setSubmenuAction(index, open) {
        const [group, name] = this._action(this._topLevel()[index]?.submenuAction);
        group?.change_action_state(name, GLib.Variant.new_boolean(open));
    }

    /**
     * Returns whether a top-level menu has items.
     *
     * @param {number} index - the index of the top-level menu
     * @returns {boolean} whether it has items
     */
    hasItems(index) {
        return (this._topLevel()[index]?.model.get_n_items() ?? 0) > 0;
    }

    /**
     * Returns a text which changes only when the items of a top-level menu change as the user sees them.
     *
     * @param {number} index - the index of the top-level menu
     * @returns {string} the key
     */
    contentKey(index) {
        const describe = model => {
            const items = [];
            for (let i = 0; i < model.get_n_items(); i++) {
                const [group, name] = this._action(attribute(model, i, 'action', 's'));
                const exists = group?.has_action(name) ?? false;
                const links = [Gio.MENU_LINK_SECTION, Gio.MENU_LINK_SUBMENU]
                    .map(link => model.get_item_link(i, link))
                    .map(linked => linked ? describe(linked) : null);
                items.push([attribute(model, i, 'label', 's'), attribute(model, i, 'accel', 's'),
                    exists && group.get_action_enabled(name), exists && group.get_action_state(name)?.print(true),
                    this._hidden(model, i), links]);
            }
            return items;
        };
        const title = this._topLevel()[index];
        return title ? JSON.stringify(describe(title.model)) : '';
    }

    /**
     * Fills a menu with the items of a top-level menu.
     *
     * @param {number} index - the index of the top-level menu
     * @param {PopupMenu.PopupMenuBase} menu - the menu, which is emptied first
     */
    fill(index, menu) {
        menu.removeAll();
        const title = this._topLevel()[index];
        if (title)
            this._fillModel(title.model, menu);
        trimSeparator(menu);
    }

    _fillModel(model, menu) {
        for (let i = 0; i < model.get_n_items(); i++) {
            if (this._hidden(model, i))
                continue;
            const section = model.get_item_link(i, Gio.MENU_LINK_SECTION);
            if (section) {
                // A section with a label starts with a separator showing the label.
                const label = attribute(model, i, 'label', 's');
                if (label) {
                    trimSeparator(menu);
                    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(parseMnemonic(label).text));
                } else {
                    addSeparator(menu);
                }
                this._fillModel(section, menu);
                addSeparator(menu);
                continue;
            }
            const {text} = parseMnemonic(attribute(model, i, 'label', 's') ?? '');
            const submenu = model.get_item_link(i, Gio.MENU_LINK_SUBMENU);
            if (submenu) {
                const item = new PopupMenu.PopupSubMenuMenuItem(text);
                menu.addMenuItem(item);
                this._fillModel(submenu, item.menu);
                trimSeparator(item.menu);
                continue;
            }
            const [group, name, prefix] = this._action(attribute(model, i, 'action', 's'));
            const target = model.get_item_attribute_value(i, 'target', null);
            const exists = group?.has_action(name) ?? false;
            const state = exists ? group.get_action_state(name) : null;
            let toggle = null;
            let checked = false;
            if (state && target) {
                toggle = 'radio';
                checked = state.equal(target);
            } else if (state?.is_of_type(new GLib.VariantType('b'))) {
                toggle = 'check';
                checked = state.get_boolean();
            }
            addItem(menu, {
                text,
                // Until its group has listed its actions, an action is treated as existing and enabled.
                enabled: exists ? group.get_action_enabled(name) : !!group && !this._loaded[prefix],
                toggle,
                checked,
                shortcut: formatGtkAccel(attribute(model, i, 'accel', 's')),
                onActivate: () => group?.activate_action(name, target),
            });
        }
    }
}
