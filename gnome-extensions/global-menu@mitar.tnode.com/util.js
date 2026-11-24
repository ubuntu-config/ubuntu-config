import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Whether each item added by addItem() or addSubmenuItem() has a check or radio mark and an icon, which alignItems()
// reads.
const itemMarks = new WeakMap();

/**
 * Splits a label with a mnemonic, written with an underscore before its letter as GTK and com.canonical.dbusmenu write
 * it, into the text to show and the mnemonic letter. Two underscores stand for one.
 *
 * @param {string} label - the label with its mnemonic
 * @returns {{text: string, mnemonic: string|null}} the text and the lower-case mnemonic letter, or null without one
 */
export function parseMnemonic(label) {
    let text = '';
    let mnemonic = null;
    for (let i = 0; i < label.length; i++) {
        const c = label[i];
        if (c !== '_') {
            text += c;
        } else if (label[i + 1] === '_') {
            text += '_';
            i++;
        } else if (mnemonic === null && i + 1 < label.length) {
            mnemonic = label[i + 1].toLowerCase();
        }
    }
    return {text, mnemonic};
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
 * @param {Gio.Icon|null} [params.icon] - its icon
 * @param {function(Clutter.Event): void} params.onActivate - called when the item is activated
 * @returns {PopupMenu.PopupMenuItem} the item
 */
export function addItem(menu, {text, enabled = true, toggle = null, checked = false, shortcut = null, icon = null,
    onActivate}) {
    const item = new PopupMenu.PopupMenuItem(text);
    if (icon)
        item.insert_child_below(new St.Icon({gicon: icon, style_class: 'popup-menu-icon'}), item.label);
    if (shortcut) {
        item.add_child(new St.Label({
            text: shortcut,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'global-menu-shortcut',
            // Dimmed, so that the shortcut does not compete with the label, in the light style as in the dark one.
            opacity: 160,
        }));
    }
    if (toggle === 'check')
        item.setOrnament(checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    else if (toggle === 'radio')
        item.setOrnament(checked ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
    item.setSensitive(enabled);
    item.connect('activate', (_item, event) => onActivate(event));
    menu.addMenuItem(item);
    itemMarks.set(item, {toggle, icon: !!icon});
    return item;
}

/**
 * Adds an item with a submenu to a menu. The submenu opens below the item, inside the menu.
 *
 * @param {PopupMenu.PopupMenuBase} menu - the menu or section to add the item to
 * @param {object} params - the item
 * @param {string} params.text - the label, without a mnemonic
 * @param {boolean} [params.enabled] - whether it can be opened, true when not given
 * @param {Gio.Icon|null} [params.icon] - its icon
 * @returns {PopupMenu.PopupSubMenuMenuItem} the item, whose menu receives the items of the submenu
 */
export function addSubmenuItem(menu, {text, enabled = true, icon = null}) {
    const item = new PopupMenu.PopupSubMenuMenuItem(text, !!icon);
    if (icon)
        item.icon.gicon = icon;
    item.setSensitive(enabled);
    menu.addMenuItem(item);
    itemMarks.set(item, {toggle: null, icon: !!icon});
    return item;
}

/**
 * Aligns the labels of the items of a menu, and of the items of its submenus, as GTK and macOS do: when an item of a
 * menu has a check or radio mark, every item of the menu has the space of one, and when an item has an icon, every
 * item has the space of one.
 *
 * @param {PopupMenu.PopupMenuBase} menu - the menu, after all its items were added
 */
export function alignItems(menu) {
    const items = menu._getMenuItems().filter(item => !(item instanceof PopupMenu.PopupSeparatorMenuItem));
    const marks = items.some(item => itemMarks.get(item)?.toggle);
    const icons = items.some(item => itemMarks.get(item)?.icon);
    for (const item of items) {
        const kind = itemMarks.get(item);
        if (marks) {
            if (!kind?.toggle)
                item.setOrnament(PopupMenu.Ornament.NONE);
            // GNOME Shell pads the space of a check mark, but not the one of a radio mark.
            item.add_style_class_name('popup-ornamented-menu-item');
        }
        if (icons && !kind?.icon && item.label)
            item.insert_child_below(new St.Widget({style_class: 'global-menu-icon-space'}), item.label);
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
