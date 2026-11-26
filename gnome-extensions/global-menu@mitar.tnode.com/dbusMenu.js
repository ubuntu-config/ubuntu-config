import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {MenuSpec, formatDbusmenuShortcut, parseMnemonic, syncMenu} from './util.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const INTERFACE = 'com.canonical.dbusmenu';

// How long to wait after a LayoutUpdated signal for another one before reading the layout again, and how long at most
// after the first of them. Electron sets its whole menu again with dozens of signals in a row, which Visual Studio Code
// does whenever one of its menus opens, and a layout read between them can lack items.
const LAYOUT_QUIET_MS = 50;
const LAYOUT_MAX_DELAY_MS = 500;

// How long to wait after an ItemsPropertiesUpdated signal for a LayoutUpdated signal before showing the changed
// properties, see _queuePropertiesChanged().
const PROPERTIES_QUIET_MS = 20;

// How often an item is looked up and activated, and how long to wait between the attempts, see _activateByPath().
const ACTIVATE_ATTEMPTS = 3;
const ACTIVATE_RETRY_MS = 100;

/**
 * Turns a layout of com.canonical.dbusmenu, as recursiveUnpack() returns it, into a tree of nodes.
 *
 * @param {Array} layout - the item ID, its properties and the layouts of its children
 * @returns {{id: number, props: object, children: object[]}} the node
 */
function parseLayout([id, props, children]) {
    return {id, props, children: children.map(parseLayout)};
}

/**
 * Returns whether a node is shown in a menu.
 *
 * @param {{props: object}} node - the node
 * @returns {boolean} whether it is visible
 */
function isVisible(node) {
    return node.props.visible !== false;
}

/**
 * Returns the icon of a node, given by the name of an icon of the icon theme or as the data of a PNG image.
 *
 * @param {{props: object}} node - the node
 * @returns {Gio.Icon|null} the icon, or null without one
 */
function iconOf(node) {
    if (node.props['icon-name'])
        return Gio.ThemedIcon.new(node.props['icon-name']);
    if (node.props['icon-data']?.length)
        return Gio.BytesIcon.new(new GLib.Bytes(node.props['icon-data']));
    return null;
}

/**
 * The menu of a window exported over com.canonical.dbusmenu, by Chromium, Electron, Firefox, Qt and LibreOffice under
 * XWayland. It keeps the whole layout, read again whenever the application announces a change, so that a menu opens
 * with its items at once, and it asks the application to update a menu or submenu right before it opens.
 *
 * Signals: "titles-changed" when the top-level menus change, "content-changed" when anything changes, and
 * "activation-requested" with the index of a top-level menu when the application asks for it to be opened, which Qt
 * asks for Alt and a mnemonic.
 */
export class DbusMenuModel extends Signals.EventEmitter {
    /**
     * @param {string} busName - the D-Bus name of the application
     * @param {string} path - the object path of its menu
     */
    constructor(busName, path) {
        super();
        this._bus = Gio.DBus.session;
        this._busName = busName;
        this._path = path;
        this._cancellable = new Gio.Cancellable();
        this._root = {id: 0, props: {}, children: []};
        this._titlesKey = '';
        // The IDs of the submenus asked to fill themselves, which are asked only once, as an application can leave a
        // submenu empty and announce a new layout each time it is asked.
        this._asked = new Set();
        // The paths of the open menus and submenus, see _pathEntry(), by their JSON. Their submenus can open next, so
        // they are filled whenever the layout is read.
        this._openPaths = new Map();
        this._layoutTimeoutId = 0;
        // The time of the first LayoutUpdated signal since the layout was last read, in microseconds of the monotonic
        // clock.
        this._layoutChangedAt = 0;
        // Each read of the whole layout is numbered, and only the last one started is used, as they can finish out of
        // order.
        this._fetchSerial = 0;
        // The number of reads of the whole layout under way, and the changes of properties announced meanwhile, as
        // [updated, removed] of ItemsPropertiesUpdated, which a read can return without.
        this._fetching = 0;
        this._fetchProperties = [];
        this._propertiesTimeoutId = 0;
        this._subscriptionId = this._bus.signal_subscribe(busName, INTERFACE, null, path, null,
            Gio.DBusSignalFlags.NONE,
            (_bus, _sender, _path, _interface, signal, parameters) => this._onSignal(signal, parameters));
        this._fetch();
    }

    destroy() {
        this._cancellable.cancel();
        this._bus.signal_unsubscribe(this._subscriptionId);
        if (this._layoutTimeoutId)
            GLib.source_remove(this._layoutTimeoutId);
        this._layoutTimeoutId = 0;
        if (this._propertiesTimeoutId)
            GLib.source_remove(this._propertiesTimeoutId);
        this._propertiesTimeoutId = 0;
    }

    /**
     * The top-level menus, in their order, with their texts and mnemonics.
     *
     * @type {{text: string, mnemonic: string|null, index: number}[]}
     */
    get titles() {
        return this._topLevel().map(node => parseMnemonic(node.props.label ?? ''));
    }

    _topLevel() {
        return this._root.children.filter(node => isVisible(node) && node.props.type !== 'separator');
    }

    async _call(method, parameters, replyType = null) {
        return this._bus.call(this._busName, this._path, INTERFACE, method, parameters,
            replyType ? new GLib.VariantType(replyType) : null, Gio.DBusCallFlags.NO_AUTO_START, -1,
            this._cancellable);
    }

    async _getLayout(parentId) {
        const reply = await this._call('GetLayout', new GLib.Variant('(iias)', [parentId, -1, []]),
            '(u(ia{sv}av))');
        const [_revision, layout] = reply.recursiveUnpack();
        return parseLayout(layout);
    }

    async _fetch() {
        const serial = ++this._fetchSerial;
        this._fetching++;
        try {
            const root = await this._getLayout(0);
            // Only the menus which can open next are filled: the top-level menus, and the submenus of the open menus
            // and submenus, which an application which sets its menu again, as Electron does, sends empty again.
            await this._fillEmptySubmenus(root);
            for (const path of this._openPaths.values()) {
                const node = this._lookup(root, path);
                if (node)
                    await this._fillEmptySubmenus(node);
            }
            if (serial !== this._fetchSerial)
                return;
            // A change announced while the layout was read can be missing from it, and applying again one which it
            // has changes nothing.
            for (const [updated, removed] of this._fetchProperties)
                this._applyProperties(root, updated, removed);
            this._root = root;
        } catch (error) {
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            console.debug(`global-menu: reading the menu of ${this._busName} failed: ${error.message}`);
            // The changes of properties which waited for the read are shown without it.
            if (serial === this._fetchSerial)
                this._changed();
            return;
        } finally {
            if (--this._fetching === 0)
                this._fetchProperties = [];
        }
        this._changed();
    }

    /**
     * Reads the items of the submenus of a node which come without items. Electron fills a submenu only when it is
     * about to be shown (AboutToShow), and Firefox only when it is told that the submenu opened, as with the folders of
     * its Bookmarks menu, so both are sent, as KDE Plasma sends them, and the submenu is closed again. A menu without
     * items does not open, and the items have to be there for the keyboard to reach them.
     *
     * @param {{id: number, props: object, children: object[]}} node - the node whose submenus are filled
     * @returns {Promise<boolean>} whether a submenu received items
     */
    async _fillEmptySubmenus(node) {
        let filled = false;
        for (const child of node.children) {
            if (child.props['children-display'] !== 'submenu' || child.children.length || this._asked.has(child.id))
                continue;
            this._asked.add(child.id);
            await this._call('AboutToShow', new GLib.Variant('(i)', [child.id]), '(b)');
            await this._notify(child.id, 'opened');
            child.children = (await this._getLayout(child.id)).children;
            this._notify(child.id, 'closed');
            filled ||= child.children.length > 0;
        }
        return filled;
    }

    /**
     * Returns the node at a path in a layout, without asking the application to fill the submenus on the way, which
     * _findByPath() does.
     *
     * @param {{id: number, props: object, children: object[]}} root - the layout
     * @param {{label: string, nth: number}[]} path - the path, see _findByPath()
     * @returns {object|null} the node, or null when the layout has no such node
     */
    _lookup(root, path) {
        let node = root;
        for (const {label, nth} of path) {
            node = node.children.filter(child => child.props.label === label)[nth];
            if (!node)
                return null;
        }
        return node;
    }

    // Forgets an open menu or submenu, and the open submenus inside it, whose paths start with its path.
    _forgetOpen(path) {
        const prefix = JSON.stringify(path).slice(0, -1);
        for (const key of [...this._openPaths.keys()]) {
            if (key.startsWith(prefix))
                this._openPaths.delete(key);
        }
    }

    _changed() {
        // The IDs are left out, so the titles of a menu which the application renumbered stay the same.
        const titlesKey = JSON.stringify(this._topLevel().map(node => [node.props.label, node.props.enabled]));
        if (titlesKey !== this._titlesKey) {
            this._titlesKey = titlesKey;
            this.emit('titles-changed');
        }
        this.emit('content-changed');
    }

    _onSignal(signal, parameters) {
        if (signal === 'LayoutUpdated') {
            // The read of the layout shows the changed properties too.
            if (this._propertiesTimeoutId)
                GLib.source_remove(this._propertiesTimeoutId);
            this._propertiesTimeoutId = 0;
            const now = GLib.get_monotonic_time();
            if (this._layoutTimeoutId)
                GLib.source_remove(this._layoutTimeoutId);
            else
                this._layoutChangedAt = now;
            const left = LAYOUT_MAX_DELAY_MS - (now - this._layoutChangedAt) / 1000;
            const delay = Math.max(0, Math.min(LAYOUT_QUIET_MS, left));
            this._layoutTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._layoutTimeoutId = 0;
                this._fetch();
                return GLib.SOURCE_REMOVE;
            });
        } else if (signal === 'ItemsPropertiesUpdated') {
            const [updated, removed] = parameters.recursiveUnpack();
            this._applyProperties(this._root, updated, removed);
            if (this._fetching)
                this._fetchProperties.push([updated, removed]);
            this._queuePropertiesChanged();
        } else if (signal === 'ItemActivationRequested') {
            const [id] = parameters.deepUnpack();
            const index = this._topLevel().findIndex(node => this._find(id, node));
            if (index >= 0)
                this.emit('activation-requested', index);
        }
    }

    _applyProperties(root, updated, removed) {
        for (const [id, props] of updated) {
            const node = this._find(id, root);
            if (node)
                Object.assign(node.props, props);
        }
        for (const [id, names] of removed) {
            const node = this._find(id, root);
            for (const name of names)
                delete node?.props[name];
        }
    }

    // Shows changed properties once no LayoutUpdated signal followed them within PROPERTIES_QUIET_MS, and no read of
    // the layout is pending, which shows them itself. An application which moves its items sends the new labels with
    // ItemsPropertiesUpdated and the new order with LayoutUpdated, and the new labels shown in the old order would put
    // the items in a wrong order for a moment. Firefox lists the entries of its History menu again each time the menu
    // opens, and gives them the items it gave the old entries, in the reverse order.
    _queuePropertiesChanged() {
        if (this._propertiesTimeoutId)
            return;
        this._propertiesTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROPERTIES_QUIET_MS, () => {
            this._propertiesTimeoutId = 0;
            if (!this._layoutTimeoutId && !this._fetching)
                this._changed();
            return GLib.SOURCE_REMOVE;
        });
    }

    _find(id, node = this._root) {
        if (node.id === id)
            return node;
        for (const child of node.children) {
            const found = this._find(id, child);
            if (found)
                return found;
        }
        return null;
    }

    /**
     * Finds an item in a layout by its path, filling the submenus on the way which come without items.
     *
     * @param {{id: number, props: object, children: object[]}} root - the layout
     * @param {{label: string, nth: number}[]} path - the label of each item on the way, and which of the items with
     *   that label among its siblings it is
     * @returns {Promise<object|null>} the node of the item, or null when the layout has no such item
     */
    async _findByPath(root, path) {
        let node = root;
        for (const {label, nth} of path) {
            if (node !== root && !node.children.length) {
                await this._call('AboutToShow', new GLib.Variant('(i)', [node.id]), '(b)');
                node.children = (await this._getLayout(node.id)).children;
            }
            node = node.children.filter(child => child.props.label === label)[nth];
            if (!node)
                return null;
        }
        return node;
    }

    /**
     * Asks the application to update a top-level menu, which is about to open, and reads its items again when the
     * application says they changed.
     *
     * @param {number} index - the index of the top-level menu
     * @returns {Promise<boolean>} whether the items changed
     */
    async prepare(index) {
        const node = this._topLevel()[index];
        if (!node)
            return false;
        const path = [this._pathEntry(this._root, node)];
        this._openPaths.set(JSON.stringify(path), path);
        let needUpdate = false;
        try {
            [needUpdate] = (await this._call('AboutToShow', new GLib.Variant('(i)', [node.id]), '(b)')).deepUnpack();
            this._notify(node.id, 'opened');
            if (needUpdate)
                node.children = (await this._getLayout(node.id)).children;
            // The submenus of the menu can open next.
            if (await this._fillEmptySubmenus(node))
                needUpdate = true;
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`global-menu: updating a menu of ${this._busName} failed: ${error.message}`);
            return false;
        }
        return needUpdate;
    }

    /**
     * Tells the application that a top-level menu closed.
     *
     * @param {number} index - the index of the top-level menu
     */
    closed(index) {
        const node = this._topLevel()[index];
        if (!node)
            return;
        this._forgetOpen([this._pathEntry(this._root, node)]);
        this._notify(node.id, 'closed');
    }

    _event(id, eventId, timestamp = 0) {
        return this._call('Event', new GLib.Variant('(isvu)', [id, eventId, new GLib.Variant('i', 0), timestamp]));
    }

    // Tells the application about a menu which opened or closed, which it can ignore, so an error, as when it set its
    // menu again in between or dropped it, changes nothing.
    async _notify(id, eventId) {
        try {
            await this._event(id, eventId);
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`global-menu: telling ${this._busName} that a menu ${eventId} failed: ${error.message}`);
        }
    }

    /**
     * Returns whether a top-level menu has items.
     *
     * @param {number} index - the index of the top-level menu
     * @returns {boolean} whether it has items
     */
    hasItems(index) {
        return !!this._topLevel()[index]?.children.length;
    }

    /**
     * Returns a text which changes only when the items of a top-level menu change as the user sees them. The IDs of
     * the items are left out, so a menu which the application renumbered keeps its key.
     *
     * @param {number} index - the index of the top-level menu
     * @returns {string} the key
     */
    contentKey(index) {
        const describe = node => [node.props.label, node.props.enabled, node.props.visible, node.props.type,
            node.props['toggle-type'], node.props['toggle-state'], node.props.shortcut, node.props['icon-name'],
            node.props['icon-data']?.length, node.children.map(describe)];
        const node = this._topLevel()[index];
        return node ? JSON.stringify(describe(node)) : '';
    }

    /**
     * Shows the items of a top-level menu in a menu, with syncMenu(), which keeps the items the menu shows already.
     *
     * @param {number} index - the index of the top-level menu
     * @param {PopupMenu.PopupMenuBase} menu - the menu, empty or last filled by fill()
     */
    fill(index, menu) {
        const spec = new MenuSpec();
        const node = this._topLevel()[index];
        if (node)
            this._fillChildren(node, spec, [this._pathEntry(this._root, node)]);
        syncMenu(menu, spec);
    }

    _pathEntry(parent, node) {
        const label = node.props.label;
        return {label, nth: parent.children.filter(child => child.props.label === label).indexOf(node)};
    }

    _fillChildren(parent, spec, parentPath) {
        for (const node of parent.children) {
            const props = node.props;
            if (!isVisible(node))
                continue;
            if (props.type === 'separator') {
                spec.addSeparator();
                continue;
            }
            const {text, index} = parseMnemonic(props.label ?? '');
            const path = [...parentPath, this._pathEntry(parent, node)];
            if (props['children-display'] === 'submenu' || node.children.length) {
                const submenu = spec.addSubmenu({
                    text, mnemonicIndex: index, enabled: props.enabled !== false, icon: iconOf(node),
                    onOpenStateChanged: open => this._submenuOpenStateChanged(path, open),
                });
                this._fillChildren(node, submenu, path);
                continue;
            }
            const toggleType = props['toggle-type'];
            spec.addItem({
                text,
                mnemonicIndex: index,
                enabled: props.enabled !== false,
                toggle: toggleType === 'checkmark' ? 'check' : toggleType === 'radio' ? 'radio' : null,
                checked: props['toggle-state'] === 1,
                shortcut: formatDbusmenuShortcut(props.shortcut),
                icon: iconOf(node),
                onActivate: event => this._activate(path, event),
            });
        }
        spec.trimSeparator();
    }

    // Tells the application about a submenu which opened or closed, as prepare() and closed() do for a top-level
    // menu, so that it can update the submenu, as Firefox does with the History and Bookmarks submenus. The layout is
    // read again then, which also fills the empty submenus of an opened submenu, so that they can open too. The
    // submenu is looked up by its path, as _activate() looks up an item.
    async _submenuOpenStateChanged(path, open) {
        if (open)
            this._openPaths.set(JSON.stringify(path), path);
        else
            this._forgetOpen(path);
        try {
            const node = await this._findByPath(await this._getLayout(0), path);
            if (!node)
                return;
            if (!open) {
                await this._notify(node.id, 'closed');
                return;
            }
            await this._call('AboutToShow', new GLib.Variant('(i)', [node.id]), '(b)');
            await this._notify(node.id, 'opened');
            await this._fetch();
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`global-menu: updating a submenu of ${this._busName} failed: ${error.message}`);
        }
    }

    async _activate(path, event) {
        // Electron renumbers all items whenever it sets its menu again, which Visual Studio Code does whenever one of
        // its windows gains the focus or one of its menus opens, so the item is looked up in the current layout, by its
        // path, right before it is activated, and never by an ID read before.
        await this._activateByPath(path, event?.get_time() ?? global.get_current_time(), ACTIVATE_ATTEMPTS);
    }

    // Electron answers with an error when it set its menu again between the lookup and the activation, and the item is
    // then looked up and activated once more, until attempts are used up.
    async _activateByPath(path, timestamp, attempts) {
        try {
            const node = await this._findByPath(await this._getLayout(0), path);
            if (node)
                await this._event(node.id, 'clicked', timestamp);
            return;
        } catch (error) {
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            console.debug(`global-menu: activating an item of ${this._busName} failed: ${error.message}`);
        }
        if (attempts <= 1)
            return;
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ACTIVATE_RETRY_MS, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
        await this._activateByPath(path, timestamp, attempts - 1);
    }
}
