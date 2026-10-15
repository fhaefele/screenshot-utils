// SPDX-License-Identifier: GPL-3.0-or-later
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
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
    populate(mode, onChoice, approval = false, duration = 'persistent') {
        this.approval = approval;
        this.duration = duration;
        this.askSelected = false;
        const subject = {screen: 'your entire screen', selection: 'a selected area', window: 'a selected window'}[mode];
        const content = new Dialog.MessageDialogContent({
            title: approval ? 'Allow screenshots without asking for permission?' : 'Allow screenshot command?',
            description: approval
                ? 'With GNOME keyboard settings as the source, other apps can run these screenshot commands.\n\nChoose <b>Ask for every request</b> to approve each screenshot. Choose <b>Skip confirmation</b> to allow all requests automatically.'
                : `A local application requested a screenshot of ${subject}.\nIt may access the saved image. Allow this request?`,
        });
        const title = content.get_first_child().clutter_text;
        title.line_wrap = true;
        title.ellipsize = Pango.EllipsizeMode.NONE;
        if (approval)
            content.get_last_child().clutter_text.set_markup(content.description);
        this.contentLayout.add_child(content);
        if (approval) {
            this.contentLayout.add_child(new St.Label({text: 'Remember this choice',
                style: 'font-weight: bold; margin-top: 18px; margin-bottom: 8px;'}));
            const options = new St.Widget({layout_manager: new Clutter.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL, spacing: 8, homogeneous: true,
            })});
            this.contentLayout.add_child(options);
            this._durationButtons = new Map();
            this.connect('destroy', () => this._durationButtons.clear());
            this.connect('key-press-event', (_actor, event) => {
                if (event.get_key_symbol() !== Clutter.KEY_Escape)
                    return Clutter.EVENT_PROPAGATE;
                this.cancel();
                return Clutter.EVENT_STOP;
            });
            for (const [value, label] of [['session', 'This session'], ['persistent', 'Always']]) {
                const body = new St.BoxLayout({x_expand: true, style: 'spacing: 12px;'});
                body.add_child(new St.Icon({icon_size: 20, width: 20, height: 20, y_align: Clutter.ActorAlign.CENTER}));
                const text = new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER});
                body.add_child(text);
                const button = new St.Button({child: body, style_class: 'popup-menu-item', toggle_mode: true,
                    style: 'padding: 10px 12px;',
                    can_focus: true, reactive: true, x_expand: true,
                    accessible_role: Atk.Role.RADIO_BUTTON, label_actor: text});
                const select = () => {
                    this.duration = value;
                    updateSelection();
                    button.grab_key_focus();
                };
                button.connect('clicked', select);
                button.connect('key-press-event', (_actor, event) => {
                    if (![Clutter.KEY_Up, Clutter.KEY_Down, Clutter.KEY_Left, Clutter.KEY_Right].includes(event.get_key_symbol()))
                        return Clutter.EVENT_PROPAGATE;
                    const next = value === 'session' ? 'persistent' : 'session';
                    this.duration = next;
                    updateSelection();
                    this._durationButtons.get(next).grab_key_focus();
                    return Clutter.EVENT_STOP;
                });
                this._durationButtons.set(value, button);
                options.add_child(button);
            }
            const hint = new St.Label({style: 'margin-top: 8px;'});
            hint.clutter_text.line_wrap = true;
            this.contentLayout.add_child(hint);
            const updateSelection = () => {
                for (const [value, button] of this._durationButtons) {
                    const selected = value === this.duration;
                    button.checked = selected;
                    // The radio icon carries selection; retain native hover/focus styling.
                    button.remove_style_pseudo_class('checked');
                    const icon = button.get_child().get_first_child();
                    icon.icon_name = selected ? 'radio-checked-symbolic' : 'radio-symbolic';
                }
                hint.text = this.duration === 'session'
                    ? 'You will be asked to choose again after logout or a Shell restart.'
                    : 'This choice applies across logins and Shell restarts.';
            };
            updateSelection();
        }
        this._cancelButton = this.addButton({label: approval ? 'Ask for every request' : 'Cancel',
            action: () => { this.askSelected = approval; onChoice(false); }, key: approval ? null : Clutter.KEY_Escape});
        this._allowButton = this.addButton({label: approval ? 'Skip confirmation' : 'Allow', action: () => onChoice(true)});
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
        this.contentLayout.add_child(new St.Label({text: 'Escape or right-click to cancel', style_class: 'dim-label'}));
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
