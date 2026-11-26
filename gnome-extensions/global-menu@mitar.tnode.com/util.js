import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Whether each item added by addItem() or addSubmenuItem() has a check or radio mark and an icon, which alignItems()
// reads.
const itemMarks = new WeakMap();

// The icon and the shortcut label of each item added by addItem(), and the function called when it is activated, which
// an update of the item replaces.
const itemParts = new WeakMap();

// The space of an icon which alignItems() added to an item without an icon.
const iconSpaces = new WeakMap();

// The kind and the label of each item which syncMenu() shows, by which it finds the item again.
const itemKeys = new WeakMap();

// The text of each label with a mnemonic, and the position of the mnemonic's letter in it.
const labelMnemonics = new WeakMap();

// The function of each item of addSubmenuItem() which is called when its submenu opens or closes.
const submenuCallbacks = new WeakMap();

/**
 * Splits a label with a mnemonic, written with an underscore before its letter as GTK and com.canonical.dbusmenu write
 * it, into the text to show and the mnemonic letter. Two underscores stand for one.
 *
 * @param {string} label - the label with its mnemonic
 * @returns {{text: string, mnemonic: string|null, index: number}} the text, the lower-case mnemonic letter, or null
 *   without one, and the position of the letter in the text, or -1 without one
 */
export function parseMnemonic(label) {
    let text = '';
    let mnemonic = null;
    let index = -1;
    for (let i = 0; i < label.length; i++) {
        const c = label[i];
        if (c !== '_') {
            text += c;
        } else if (label[i + 1] === '_') {
            text += '_';
            i++;
        } else if (mnemonic === null && i + 1 < label.length) {
            mnemonic = label[i + 1].toLowerCase();
            index = text.length;
        }
    }
    return {text, mnemonic, index};
}

/**
 * Remembers the mnemonic of a label, which setMnemonicShown() underlines.
 *
 * @param {St.Label} label - the label, showing text
 * @param {string} text - its text
 * @param {number} index - the position of the mnemonic's letter in text, or -1 without a mnemonic
 */
export function setLabelMnemonic(label, text, index) {
    if (index >= 0 && index < text.length)
        labelMnemonics.set(label, {text, index});
    else
        labelMnemonics.delete(label);
}

/**
 * Returns the lower-case letter of a label's mnemonic.
 *
 * @param {St.Label|undefined} label - the label
 * @returns {string|null} the letter, or null when the label has no mnemonic
 */
function mnemonicLetter(label) {
    const mnemonic = label && labelMnemonics.get(label);
    return mnemonic ? mnemonic.text[mnemonic.index].toLowerCase() : null;
}

/**
 * Underlines the letter of a label's mnemonic, or shows the label without it.
 *
 * @param {St.Label} label - the label
 * @param {boolean} shown - whether the letter is underlined
 */
export function setMnemonicShown(label, shown) {
    const mnemonic = labelMnemonics.get(label);
    if (!mnemonic)
        return;
    const {text, index} = mnemonic;
    if (shown) {
        const escape = part => GLib.markup_escape_text(part, -1);
        label.clutter_text.set_markup(
            `${escape(text.slice(0, index))}<u>${escape(text[index])}</u>${escape(text.slice(index + 1))}`);
    } else {
        label.clutter_text.use_markup = false;
        label.text = text;
    }
}

/**
 * Underlines the letters of the mnemonics of a menu's items, also in its submenus, or shows the items without them.
 *
 * @param {PopupMenu.PopupMenuBase} menu - the menu
 * @param {boolean} shown - whether the letters are underlined
 */
export function setMenuMnemonicsShown(menu, shown) {
    for (const item of menu._getMenuItems()) {
        if (item.label)
            setMnemonicShown(item.label, shown);
        if (item.menu)
            setMenuMnemonicsShown(item.menu, shown);
    }
}

/**
 * Returns the item of the innermost open submenu of a menu which has the keyboard focus, or whose item has it.
 *
 * @param {PopupMenu.PopupMenuBase} menu - the menu
 * @param {Clutter.Actor|null} focus - the actor with the keyboard focus
 * @returns {PopupMenu.PopupSubMenuMenuItem|null} the item, or null when no open submenu has the focus
 */
export function focusedSubmenuItem(menu, focus) {
    for (const item of menu._getMenuItems()) {
        if (!item.menu?.isOpen)
            continue;
        if (focus && item.menu.actor.contains(focus))
            return focusedSubmenuItem(item.menu, focus) ?? item;
        if (item === focus)
            return item;
    }
    return null;
}

/**
 * Returns the menu among a menu and its open submenus which has an item as one of its own items.
 *
 * @param {PopupMenu.PopupMenuBase} menu - the menu
 * @param {Clutter.Actor|null} item - the item
 * @returns {PopupMenu.PopupMenuBase|null} the menu, or null when none has the item
 */
function menuOfItem(menu, item) {
    for (const child of menu._getMenuItems()) {
        if (child === item)
            return menu;
        if (child.menu?.isOpen) {
            const found = menuOfItem(child.menu, item);
            if (found)
                return found;
        }
    }
    return null;
}

// The keys which are only modifiers, which are pressed on the way to a shortcut.
const MODIFIER_KEYS = new Set([
    Clutter.KEY_Shift_L, Clutter.KEY_Shift_R, Clutter.KEY_Control_L, Clutter.KEY_Control_R, Clutter.KEY_Alt_L,
    Clutter.KEY_Alt_R, Clutter.KEY_Super_L, Clutter.KEY_Super_R, Clutter.KEY_Meta_L, Clutter.KEY_Meta_R,
    Clutter.KEY_Hyper_L, Clutter.KEY_Hyper_R, Clutter.KEY_ISO_Level3_Shift, Clutter.KEY_ISO_Level5_Shift,
    Clutter.KEY_Caps_Lock, Clutter.KEY_Num_Lock,
]);

// The keys which are shortcuts with Shift alone: Shift+Insert pastes and Shift+Delete cuts in many applications, and
// Shift+Delete deletes files without the trash in file managers.
const SHIFT_SHORTCUT_KEYS = new Set([
    Clutter.KEY_Insert, Clutter.KEY_Delete, Clutter.KEY_KP_Insert, Clutter.KEY_KP_Delete,
]);

/**
 * Returns whether a key pressed in an open menu is a shortcut of the window rather than a key of the menu: a key held
 * with Ctrl or Super, Insert or Delete held with Shift, or a function key other than F10, which opens and closes the
 * menus. Letters, also with Shift, the arrow keys, Return, Escape, Tab and Alt with a letter stay with the menu.
 *
 * @param {Clutter.Event} event - the key press
 * @returns {boolean} whether the key is a shortcut of the window
 */
export function isWindowShortcut(event) {
    const key = event.get_key_symbol();
    if (MODIFIER_KEYS.has(key))
        return false;
    const modifiers = Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.SUPER_MASK |
        Clutter.ModifierType.MOD4_MASK;
    const state = event.get_state();
    if (state & modifiers)
        return true;
    if (state & Clutter.ModifierType.SHIFT_MASK && SHIFT_SHORTCUT_KEYS.has(key))
        return true;
    return key >= Clutter.KEY_F1 && key <= Clutter.KEY_F35 && key !== Clutter.KEY_F10;
}

/**
 * Returns whether a modifier is held with a key, other than Caps Lock and Num Lock, as GNOME Shell's menus check before
 * they act on Space and Return.
 *
 * @param {Clutter.Event} event - the key press
 * @returns {boolean} whether a modifier is held
 */
export function hasModifiers(event) {
    const ignored = Clutter.ModifierType.LOCK_MASK | Clutter.ModifierType.MOD2_MASK;
    return (event.get_state() & ~ignored & Clutter.ModifierType.MODIFIER_MASK) !== 0;
}

/**
 * Returns the letter of a key pressed without Ctrl, Alt or Super, which can be the letter of a mnemonic in an open
 * menu.
 *
 * @param {Clutter.Event} event - the key press
 * @returns {string|null} the lower-case letter, or null for another key or with one of these modifiers held
 */
export function typedLetter(event) {
    const modifiers = Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
        Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK;
    const unicode = event.get_key_unicode();
    if (!unicode || unicode.trim() === '' || event.get_state() & modifiers)
        return null;
    return unicode.toLowerCase();
}

/**
 * Acts on a key pressed in an open menu as GTK and Qt menus act on the letter of a mnemonic: the only item with that
 * mnemonic is activated, or its submenu is opened with the keyboard focus on its first item, and with several such
 * items the keyboard focus moves to the next of them. The items are those of the submenu which has the item with the
 * keyboard focus, or of the menu itself.
 *
 * @param {PopupMenu.PopupMenuBase} menu - the open menu
 * @param {Clutter.Event} event - the key press
 * @returns {boolean} whether the key was the letter of a mnemonic there
 */
export function activateMnemonic(menu, event) {
    const letter = typedLetter(event);
    if (!letter)
        return false;
    const focus = global.stage.get_key_focus();
    const scope = menuOfItem(menu, focus) ?? menu;
    const items = scope._getMenuItems().filter(item => item.visible && item.sensitive &&
        mnemonicLetter(item.label) === letter);
    if (!items.length)
        return false;
    if (items.length > 1) {
        items[(items.indexOf(focus) + 1) % items.length].grab_key_focus();
        return true;
    }
    const [item] = items;
    if (item.menu) {
        item.setSubmenuShown(true);
        item.menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    } else {
        item.activate(event);
    }
    return true;
}

const MODIFIER_NAMES = {
    Control: 'Ctrl',
    Ctrl: 'Ctrl',
    Primary: 'Ctrl',
    Shift: 'Shift',
    Alt: 'Alt',
    Mod1: 'Alt',
    Super: 'Super',
    Meta: 'Meta',
    Hyper: 'Hyper',
};

const KEY_NAMES = {
    plus: '+',
    minus: '-',
    equal: '=',
    comma: ',',
    period: '.',
    slash: '/',
    backslash: '\\',
    semicolon: ';',
    apostrophe: '\'',
    grave: '`',
    bracketleft: '[',
    bracketright: ']',
    space: 'Space',
    Return: 'Enter',
    KP_Enter: 'Enter',
    Escape: 'Esc',
    Delete: 'Del',
    BackSpace: 'Backspace',
    Page_Up: 'Page Up',
    Page_Down: 'Page Down',
};

/**
 * Returns the text shown for a key, given as an X11 key name.
 *
 * @param {string} key - the key name, such as "n", "F11" or "Page_Up"
 * @returns {string} the text, such as "N", "F11" or "Page Up"
 */
function keyText(key) {
    if (KEY_NAMES[key])
        return KEY_NAMES[key];
    if (key.length === 1)
        return key.toUpperCase();
    return key.replaceAll('_', ' ');
}

/**
 * Formats the shortcut property of a com.canonical.dbusmenu item, a list of key combinations each given as a list of
 * modifier names followed by a key name. Only the first combination is shown.
 *
 * @param {string[][]|undefined} shortcut - the property, such as [["Control", "Shift", "n"]]
 * @returns {string|null} the text, such as "Ctrl+Shift+N", or null without a shortcut
 */
export function formatDbusmenuShortcut(shortcut) {
    const keys = shortcut?.[0];
    if (!keys?.length)
        return null;
    const modifiers = keys.slice(0, -1).map(m => MODIFIER_NAMES[m] ?? m);
    return [...modifiers, keyText(keys[keys.length - 1])].join('+');
}

/**
 * Formats the accel attribute of a GMenuModel item, in the format of gtk_accelerator_parse().
 *
 * @param {string|null} accel - the attribute, such as "<Primary><Shift>n"
 * @returns {string|null} the text, such as "Ctrl+Shift+N", or null without an accelerator
 */
export function formatGtkAccel(accel) {
    if (!accel)
        return null;
    const modifiers = [];
    const key = accel.replace(/<([^>]+)>/g, (_match, name) => {
        modifiers.push(MODIFIER_NAMES[name] ?? name);
        return '';
    });
    if (!key)
        return null;
    return [...modifiers, keyText(key)].join('+');
}
/**
 * Shows a new label on an item, keeping whether the letter of its mnemonic is underlined.
 *
 * @param {St.Label} label - the label of the item
 * @param {string} text - the label, without a mnemonic
 * @param {number} mnemonicIndex - the position of the letter of its mnemonic in text, -1 without one
 */
function updateLabel(label, text, mnemonicIndex) {
    const current = labelMnemonics.get(label);
    const index = mnemonicIndex < text.length ? mnemonicIndex : -1;
    if ((current?.text ?? label.text) === text && (current?.index ?? -1) === index)
        return;
    const shown = label.clutter_text.use_markup;
    label.clutter_text.use_markup = false;
    label.text = text;
    setLabelMnemonic(label, text, mnemonicIndex);
    if (shown)
        setMnemonicShown(label, true);
}

/**
 * Shows the state of an item created by addItem(): its label, icon, shortcut, mark and sensitivity, and sets the
 * function called when it is activated. See addItem() for the parameters.
 *
 * @param {PopupMenu.PopupMenuItem} item - the item
 * @param {object} params - the item
 */
function updateItem(item, {
    text, mnemonicIndex = -1, enabled = true, toggle = null, checked = false, shortcut = null, icon = null, onActivate,
}) {
    let parts = itemParts.get(item);
    if (!parts) {
        parts = {icon: null, shortcut: null, onActivate: null};
        itemParts.set(item, parts);
        item.connect('activate', (_item, event) => parts.onActivate(event));
    }
    updateLabel(item.label, text, mnemonicIndex);
    if (icon) {
        if (!parts.icon) {
            parts.icon = new St.Icon({style_class: 'popup-menu-icon'});
            item.insert_child_below(parts.icon, item.label);
        }
        if (!parts.icon.gicon?.equal(icon))
            parts.icon.gicon = icon;
    } else {
        parts.icon?.destroy();
        parts.icon = null;
    }
    if (shortcut) {
        if (!parts.shortcut) {
            parts.shortcut = new St.Label({
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'global-menu-shortcut',
                // Dimmed, so that the shortcut does not compete with the label, in the light style as in the dark one.
                opacity: 160,
            });
            item.add_child(parts.shortcut);
        }
        parts.shortcut.text = shortcut;
    } else {
        parts.shortcut?.destroy();
        parts.shortcut = null;
    }
    if (toggle === 'check')
        item.setOrnament(checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    else if (toggle === 'radio')
        item.setOrnament(checked ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
    else
        item.setOrnament(PopupMenu.Ornament.HIDDEN);
    item.setSensitive(enabled);
    parts.onActivate = onActivate;
    itemMarks.set(item, {toggle, icon: !!icon});
}

/**
 * Adds an item to a menu. An item with a shortcut shows it at its right end, a check or radio item shows its state
 * with an ornament, and an item with an icon shows it before its label.
 *
 * @param {PopupMenu.PopupMenuBase} menu - the menu or section to add the item to
 * @param {object} params - the item
 * @param {string} params.text - the label, without a mnemonic
 * @param {boolean} [params.enabled] - whether it can be activated, true when not given
 * @param {string|null} [params.toggle] - "check" or "radio" for an item with a state, otherwise null
 * @param {boolean} [params.checked] - the state of a check or radio item
 * @param {string|null} [params.shortcut] - the text of its shortcut
 * @param {number} [params.mnemonicIndex] - the position of the letter of its mnemonic in text, -1 without one
 * @param {Gio.Icon|null} [params.icon] - its icon
 * @param {function(Clutter.Event): void} params.onActivate - called when the item is activated
 * @returns {PopupMenu.PopupMenuItem} the item
 */
export function addItem(menu, params) {
    const item = new PopupMenu.PopupMenuItem(params.text);
    item.label.add_style_class_name('global-menu-item-label');
    updateItem(item, params);
    menu.addMenuItem(item);
    return item;
}

/**
 * Shows the state of an item created by addSubmenuItem(): its label, icon and sensitivity, and sets the function called
 * when its submenu opens or closes. See addSubmenuItem() for the parameters.
 *
 * @param {PopupMenu.PopupSubMenuMenuItem} item - the item
 * @param {object} params - the item
 */
function updateSubmenuItem(item, {text, mnemonicIndex = -1, enabled = true, icon = null, onOpenStateChanged = null}) {
    updateLabel(item.label, text, mnemonicIndex);
    if (icon && !item.icon.gicon?.equal(icon))
        item.icon.gicon = icon;
    item.setSensitive(enabled);
    itemMarks.set(item, {toggle: null, icon: !!icon});
    submenuCallbacks.set(item, onOpenStateChanged);
}

/**
 * Adds an item with a submenu to a menu. The submenu opens below the item, inside the menu.
 *
 * @param {PopupMenu.PopupMenuBase} menu - the menu or section to add the item to
 * @param {object} params - the item
 * @param {string} params.text - the label, without a mnemonic
 * @param {number} [params.mnemonicIndex] - the position of the letter of its mnemonic in text, -1 without one
 * @param {boolean} [params.enabled] - whether it can be opened, true when not given
 * @param {Gio.Icon|null} [params.icon] - its icon
 * @param {function(boolean): void} [params.onOpenStateChanged] - called with true when the submenu opens and with false
 *   when it closes
 * @returns {PopupMenu.PopupSubMenuMenuItem} the item, whose menu receives the items of the submenu
 */
export function addSubmenuItem(menu, params) {
    const item = new PopupMenu.PopupSubMenuMenuItem(params.text, !!params.icon);
    item.label.add_style_class_name('global-menu-item-label');
    item.menu.connect('open-state-changed', (_menu, open) => submenuCallbacks.get(item)?.(open));
    updateSubmenuItem(item, params);
    menu.addMenuItem(item);
    return item;
}

/**
 * The items of a menu, described before they are shown, which syncMenu() shows in a menu. The parameters of its items
 * are those of addItem() and addSubmenuItem().
 */
export class MenuSpec {
    constructor() {
        this.entries = [];
    }

    /**
     * Adds an item, see addItem().
     *
     * @param {object} params - the item
     */
    addItem(params) {
        this.entries.push({kind: 'item', params});
    }

    /**
     * Adds an item with a submenu, see addSubmenuItem().
     *
     * @param {object} params - the item
     * @returns {MenuSpec} the submenu, which receives its items
     */
    addSubmenu(params) {
        const menu = new MenuSpec();
        this.entries.push({kind: 'submenu', params, menu});
        return menu;
    }

    /**
     * Adds a separator. A separator without a label is left out at the start and after another separator.
     *
     * @param {string|null} [label] - the label of the separator
     */
    addSeparator(label = null) {
        const last = this.entries[this.entries.length - 1];
        if (label === null && (!last || last.kind === 'separator'))
            return;
        this.entries.push({kind: 'separator', label});
    }

    /**
     * Removes a separator at the end.
     */
    trimSeparator() {
        if (this.entries[this.entries.length - 1]?.kind === 'separator')
            this.entries.pop();
    }
}

/**
 * Shows the items of a MenuSpec in a menu, and in the submenus of its items. An item which the menu shows already, with
 * the same kind and label, is kept and updated, so that an item under the pointer or with the keyboard focus stays
 * there and an open submenu stays open, while an application changes its menu. The other items are added or removed.
 * The labels are aligned with alignItems().
 *
 * @param {PopupMenu.PopupMenuBase} menu - the menu, empty or last filled by syncMenu()
 * @param {MenuSpec} spec - its items
 */
export function syncMenu(menu, spec) {
    syncItems(menu, spec);
    alignItems(menu);
}

function syncItems(menu, spec) {
    const keyOf = entry => JSON.stringify([entry.kind, entry.kind === 'separator' ? entry.label : entry.params.text]);
    // The items shown now, by their keys, in their order, so that of several items with the same key each keeps its
    // place among them.
    const shown = new Map();
    for (const item of menu._getMenuItems()) {
        const key = itemKeys.get(item);
        if (key === undefined) {
            item.destroy();
            continue;
        }
        if (!shown.has(key))
            shown.set(key, []);
        shown.get(key).push(item);
    }
    const items = spec.entries.map(entry => {
        const key = keyOf(entry);
        let item = shown.get(key)?.shift() ?? null;
        // A submenu item has an icon only when it was created with one.
        if (item && entry.kind === 'submenu' && !!item.icon !== !!entry.params.icon) {
            item.destroy();
            item = null;
        }
        if (!item) {
            if (entry.kind === 'item')
                item = addItem(menu, entry.params);
            else if (entry.kind === 'submenu')
                item = addSubmenuItem(menu, entry.params);
            else
                menu.addMenuItem(item = new PopupMenu.PopupSeparatorMenuItem(entry.label ?? ''));
            itemKeys.set(item, key);
        } else if (entry.kind === 'item') {
            updateItem(item, entry.params);
        } else if (entry.kind === 'submenu') {
            updateSubmenuItem(item, entry.params);
        }
        if (entry.kind === 'submenu')
            syncItems(item.menu, entry.menu);
        return item;
    });
    for (const rest of shown.values()) {
        for (const item of rest)
            item.destroy();
    }

    // The items are put in the order of the spec, each submenu right after its item, moving only what is out of place.
    const order = items.flatMap(item => item instanceof PopupMenu.PopupSubMenuMenuItem ? [item.actor, item.menu.actor]
        : [item.actor]);
    const current = menu.box.get_children().filter(actor => order.includes(actor));
    if (current.some((actor, i) => actor !== order[i])) {
        let previous = null;
        for (const actor of order) {
            if (previous)
                menu.box.set_child_above_sibling(actor, previous);
            else
                menu.box.set_child_below_sibling(actor, null);
            previous = actor;
        }
    }
}

/**
 * Aligns the labels of the items of a menu, and of the items of its submenus, as GTK and macOS do: when an item of a
 * menu has a check or radio mark, every item of the menu has the space of one, and when an item has an icon, every
 * item has the space of one. It can be called again after items changed.
 *
 * @param {PopupMenu.PopupMenuBase} menu - the menu, after all its items were added
 */
export function alignItems(menu) {
    const items = menu._getMenuItems().filter(item => !(item instanceof PopupMenu.PopupSeparatorMenuItem));
    const marks = items.some(item => itemMarks.get(item)?.toggle);
    const icons = items.some(item => itemMarks.get(item)?.icon);
    for (const item of items) {
        const kind = itemMarks.get(item);
        if (!kind?.toggle)
            item.setOrnament(marks ? PopupMenu.Ornament.NONE : PopupMenu.Ornament.HIDDEN);
        // GNOME Shell pads the space of a check mark, but not the one of a radio mark.
        if (marks)
            item.add_style_class_name('popup-ornamented-menu-item');
        else
            item.remove_style_class_name('popup-ornamented-menu-item');
        const space = iconSpaces.get(item);
        if (icons && !kind?.icon && item.label) {
            if (!space) {
                const widget = new St.Widget({style_class: 'global-menu-icon-space'});
                item.insert_child_below(widget, item.label);
                iconSpaces.set(item, widget);
            }
        } else if (space) {
            space.destroy();
            iconSpaces.delete(item);
        }
        if (item.menu)
            alignItems(item.menu);
    }
}

/**
 * Adds a separator to a menu, unless the menu is empty or already ends with one.
 *
 * @param {PopupMenu.PopupMenuBase} menu - the menu or section
 */
export function addSeparator(menu) {
    const items = menu._getMenuItems();
    const last = items[items.length - 1];
    if (!last || last instanceof PopupMenu.PopupSeparatorMenuItem)
        return;
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
}

/**
 * Removes a separator at the end of a menu.
 *
 * @param {PopupMenu.PopupMenuBase} menu - the menu or section
 */
export function trimSeparator(menu) {
    const items = menu._getMenuItems();
    const last = items[items.length - 1];
    if (last instanceof PopupMenu.PopupSeparatorMenuItem)
        last.destroy();
}
