// SPDX-License-Identifier: GPL-3.0-or-later
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {SelectArea} from 'resource:///org/gnome/shell/ui/screenshot.js';
import {connectSecondaryClick} from './shell-compat.js';

/*! SelectArea lifecycle adapted from GNOME Shell, GNOME Shell contributors,
 * licensed GPL-2.0-or-later. Native geometry and input handling remain inherited. */
export const AreaSelector = GObject.registerClass(
class AreaSelector extends SelectArea {
    _init() {
        super._init();
        this.destroyed = false;
        this.connect('destroy', () => { this.destroyed = true; });
    }

    async selectAsync() {
        // Native selectAsync() schedules untracked idle destruction. The caller
        // owns this actor instead, including synchronous destruction on disable.
        if (this.set_cursor_type)
            this.set_cursor_type(Clutter.CursorType.CROSSHAIR);
        else
            global.display.set_cursor(Meta.Cursor.CROSSHAIR);
        Main.uiGroup.set_child_above_sibling(this, null);
        this.show();
        await this._grabHelper.grabAsync({actor: this});
        return this._result;
    }

    cancel() {
        if (this.destroyed)
            return;
        this._grabHelper.ungrab();
        if (!this.set_cursor_type)
            global.display.set_cursor(Meta.Cursor.DEFAULT);
        this.destroy();
    }
});

const CaptureDialog = GObject.registerClass(
class CaptureDialog extends ModalDialog.ModalDialog {
    _init() {
        super._init({shouldFadeIn: false, shouldFadeOut: false, destroyOnClose: false});
        this.destroyed = false;
        this.cancelled = false;
        this.connect('destroy', () => {
            this.destroyed = true;
            this.cancelled = true;
        });
    }

    cancel() {
        if (this.destroyed)
            return;
        this.popModal();
        this.remove_all_transitions();
        this.destroy();
    }
});

export const CommandConfirmation = GObject.registerClass(
class CommandConfirmation extends CaptureDialog {
    populate(mode, onChoice, persistent = false) {
        this.persistent = persistent;
        const subject = {screen: 'your entire screen', selection: 'a selected area', window: 'a selected window'}[mode];
        this.contentLayout.add_child(new St.Label({text: persistent
            ? 'Allow screenshots without asking?' : 'Allow screenshot command?', style_class: 'headline'}));
        const description = new St.Label({text: persistent
            ? 'Any local application can request screenshots without confirmation.\nPermission persists across logins until you turn it off or disable the extension.\nUnrestricted local programs can modify saved permissions.'
            : `A local application requested a screenshot of ${subject}.\nIt may access the saved image. Allow this request?`});
        description.clutter_text.line_wrap = true;
        this.contentLayout.add_child(description);
        this._cancelButton = this.addButton({label: persistent ? 'Keep asking' : 'Cancel', action: () => onChoice(false), key: Clutter.KEY_Escape});
        this._allowButton = this.addButton({label: persistent ? 'Allow commands' : 'Allow', action: () => onChoice(true)});
        this.setInitialKeyFocus(this._cancelButton);
    }
});

export const WindowPicker = GObject.registerClass(
class WindowPicker extends CaptureDialog {
    _init() {
        super._init();
        this.selected = null;
        this.windows = new Map();
        this.connect('destroy', () => {
            this.selected = null;
            this.windows.clear();
        });
    }

    populate(windows, onSelected, onCancel) {
        connectSecondaryClick(this, onCancel);
        Main.layoutManager.connectObject('monitors-changed', onCancel, this);
        const monitor = Main.layoutManager.currentMonitor;
        const columns = Math.max(1, Math.min(4, Math.floor(monitor.width * 0.75 / 240)));
        this.contentLayout.add_child(new St.Label({text: 'Choose a window', style_class: 'headline'}));
        this.contentLayout.add_child(new St.Label({text: 'Esc or right-click to cancel', style_class: 'dim-label'}));
        const scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            style: `max-height: ${Math.floor(monitor.height * 0.6)}px;`,
        });
        const content = new St.BoxLayout();
        // Shell 42-45 inherits St.Bin.set_child(), which bypasses scroll setup.
        if (scroll instanceof St.Bin)
            scroll.add_actor(content);
        else
            scroll.set_child(content);
        this.contentLayout.add_child(scroll);
        const layout = new Clutter.GridLayout({column_spacing: 12, row_spacing: 12});
        const grid = new St.Widget({layout_manager: layout});
        content.add_child(grid);
        windows.forEach((window, index) => {
            const source = window.get_compositor_private();
            const title = window.get_title() || 'Untitled window';
            const card = new St.Button({style_class: 'button', accessible_name: title,
                can_focus: true, reactive: true, style: 'padding: 8px;'});
            const body = new St.Widget({layout_manager: new Clutter.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL, spacing: 8,
            })});
            card.set_child(body);
            const preview = new St.Widget({width: 208, height: 130, clip_to_allocation: true});
            const clone = new Clutter.Clone({source});
            const [width, height] = source.get_size();
            const scale = Math.min(208 / width, 130 / height);
            clone.set_scale(scale, scale);
            clone.set_position((208 - width * scale) / 2, (130 - height * scale) / 2);
            preview.add_child(clone);
            body.add_child(preview);
            const label = new St.Label({text: title, style: 'max-width: 208px;'});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            body.add_child(label);
            card.connect('clicked', () => onSelected(window));
            source.connectObject('destroy', onCancel, this);
            this.windows.set(card, window);
            layout.attach(card, index % columns, Math.floor(index / columns), 1, 1);
        });
        this._closeButton = this.addButton({label: 'Cancel', action: onCancel, key: Clutter.KEY_Escape});
        this.setInitialKeyFocus(this.windows.keys().next().value);
    }

});
