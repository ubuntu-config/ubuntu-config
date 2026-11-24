import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Whether each item added by addItem() or addSubmenuItem() has a check or radio mark and an icon, which alignItems()
// reads.
const itemMarks = new WeakMap();

// The text of each label with a mnemonic, and the position of the mnemonic's letter in it.
const labelMnemonics = new WeakMap();

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
    const modifiers = Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
        Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK;
    const unicode = event.get_key_unicode();
    if (!unicode || unicode.trim() === '' || event.get_state() & modifiers)
        return false;
    const letter = unicode.toLowerCase();
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
export function addItem(menu, {
    text, mnemonicIndex = -1, enabled = true, toggle = null, checked = false, shortcut = null, icon = null, onActivate,
}) {
    const item = new PopupMenu.PopupMenuItem(text);
    setLabelMnemonic(item.label, text, mnemonicIndex);
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
 * @param {number} [params.mnemonicIndex] - the position of the letter of its mnemonic in text, -1 without one
 * @param {boolean} [params.enabled] - whether it can be opened, true when not given
 * @param {Gio.Icon|null} [params.icon] - its icon
 * @returns {PopupMenu.PopupSubMenuMenuItem} the item, whose menu receives the items of the submenu
 */
export function addSubmenuItem(menu, {text, mnemonicIndex = -1, enabled = true, icon = null}) {
    const item = new PopupMenu.PopupSubMenuMenuItem(text, !!icon);
    setLabelMnemonic(item.label, text, mnemonicIndex);
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
