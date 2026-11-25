import Clutter from 'gi://Clutter';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Panel} from 'resource:///org/gnome/shell/ui/panel.js';

/**
 * Lays out the top bar so that the menu bar has all the width the status area does not need, while the center box of
 * the top bar is empty, as it is when Just Perfection shows the clock in the status area. The status area then has its
 * natural width at the end of the top bar, and the left box, with the Activities button and the menu bar, the rest.
 * The top bar is laid out again whenever the width of one of them changes, as when an extension adds or removes an
 * indicator, so the menus which fit follow it. When the status area leaves less than the left box needs, the status
 * area keeps its width and the menu bar is clipped. While the center box shows something, the top bar keeps GNOME
 * Shell's layout, where the left box ends before the center box.
 */
export class PanelLayout {
    constructor() {
        this._injections = new InjectionManager();
        this._injections.overrideMethod(Panel.prototype, 'vfunc_allocate', original => function (box) {
            // GNOME Shell gives the left box at most half of the width the center box leaves, as if the center box
            // were in the middle, also when the center box is empty.
            if (this._centerBox.get_children().some(child => child.visible)) {
                original.call(this, box);
                return;
            }
            this.set_allocation(box);
            const width = box.get_width();
            const height = box.get_height();
            const right = Math.min(this._rightBox.get_preferred_width(-1)[1], width);
            const left = Math.min(this._leftBox.get_preferred_width(-1)[1], width - right);
            const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
            const place = (actor, x, actorWidth) => actor.allocate(Clutter.ActorBox.new(x, 0, x + actorWidth, height));
            place(this._leftBox, rtl ? width - left : 0, left);
            place(this._centerBox, rtl ? width - left : left, 0);
            place(this._rightBox, rtl ? 0 : width - right, right);
        });
        Main.panel.queue_relayout();
    }

    /**
     * Gives the top bar GNOME Shell's layout again.
     */
    destroy() {
        this._injections.clear();
        Main.panel.queue_relayout();
    }
}
