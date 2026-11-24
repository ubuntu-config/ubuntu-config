import {addItem, addSeparator, trimSeparator} from './util.js';

/**
 * Returns the windows of an application which the dock counts, the ones not skipped by the taskbar.
 *
 * @param {Shell.App} app - the application
 * @returns {Meta.Window[]} the windows
 */
function countedWindows(app) {
    return app.get_windows().filter(window => !window.skip_taskbar);
}

/**
 * Fills the menu of the application's name with the items of the application, the same ones Ubuntu Dock shows for it,
 * then the items of the focused window, then Quit. Quit calls Shell.App.request_quit(), which activates the quit action
 * of an application which exports one, so that an application which restores its windows restores all of them, and
 * closes the windows of any other application.
 *
 * @param {PopupMenu.PopupMenuBase} menu - the menu, which is emptied first
 * @param {Shell.App} app - the application of the focused window
 * @param {Meta.Window|null} window - the focused window
 */
export function fillAppMenu(menu, app, window) {
    menu.removeAll();

    const appInfo = app.get_app_info();
    const actions = appInfo?.list_actions() ?? [];
    if (app.can_open_new_window() && !actions.includes('new-window'))
        addItem(menu, {text: 'New Window', onActivate: () => app.open_new_window(-1)});
    for (const action of actions) {
        addItem(menu, {
            text: appInfo.get_action_name(action),
            onActivate: event => app.launch_action(action, event?.get_time() ?? global.get_current_time(), -1),
        });
    }

    if (window) {
        addSeparator(menu);
        addItem(menu, {
            text: 'Minimize',
            enabled: window.can_minimize(),
            onActivate: () => window.minimize(),
        });
        if (window.is_maximized()) {
            addItem(menu, {text: 'Restore', onActivate: () => window.unmaximize()});
        } else {
            addItem(menu, {
                text: 'Maximize',
                enabled: window.can_maximize(),
                onActivate: () => window.maximize(),
            });
        }
        addItem(menu, {
            text: 'Close',
            enabled: window.can_close(),
            onActivate: event => window.delete(event?.get_time() ?? global.get_current_time()),
        });
    }

    addSeparator(menu);
    const count = countedWindows(app).length;
    addItem(menu, {
        text: count > 1 ? `Quit ${count} Windows` : 'Quit',
        onActivate: () => app.request_quit(),
    });
    trimSeparator(menu);
}
