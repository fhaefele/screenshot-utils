// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import {callAsync} from './async-utils.js';

// Adw 1.1 fallback keeps editing/apply signals and an explicitly labeled entry.
// Apply stays visible; native EntryRow styling and accessibility relations aren't reproduced.
const LegacyEntryRow = GObject.registerClass({
    Signals: {apply: {}, changed: {}},
}, class LegacyEntryRow extends Adw.ActionRow {
    _init({title, text = '', show_apply_button = false}) {
        super._init({title});
        this._entry = new Gtk.Entry({text, hexpand: true, valign: Gtk.Align.CENTER});
        this._entry.update_property([Gtk.AccessibleProperty.LABEL], [title]);
        this.add_suffix(this._entry);
        this.activatable_widget = this._entry;
        this._entry.connect('changed', () => this.emit('changed'));
        this._entry.connect('activate', () => this.emit('apply'));
        if (show_apply_button) {
            const apply = new Gtk.Button({icon_name: 'emblem-ok-symbolic',
                valign: Gtk.Align.CENTER, tooltip_text: 'Apply'});
            apply.connect('clicked', () => this.emit('apply'));
            this.add_suffix(apply);
        }
    }

    get text() { return this._entry.text; }
    set text(value) { this._entry.text = value; }
    get_text() { return this.text; }
    set_text(value) { this.text = value; }
});

export function createEntryRow(properties) {
    return Adw.EntryRow ? new Adw.EntryRow(properties) : new LegacyEntryRow(properties);
}

export function createSwitchRow(settings, key, title) {
    const {row, control} = createToggleRow(title);
    settings.bind(key, control, 'active', 0);
    return row;
}

export function createToggleRow(title) {
    const row = Adw.SwitchRow ? new Adw.SwitchRow({title}) : new Adw.ActionRow({title});
    const control = Adw.SwitchRow ? row : new Gtk.Switch({valign: Gtk.Align.CENTER});
    if (control !== row) {
        row.add_suffix(control);
        row.activatable_widget = control;
    }
    return {row, control};
}

export async function selectFolder(parent, initialFolder, cancellable) {
    if (cancellable.is_cancelled())
        return null;
    if (Gtk.FileDialog) {
        const dialog = new Gtk.FileDialog({title: 'Select screenshot folder',
            accept_label: 'Select', modal: true, initial_folder: initialFolder});
        try {
            return await callAsync(dialog, 'select_folder', parent, cancellable);
        } catch (error) {
            if (cancellable.is_cancelled() ||
                error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) ||
                error.matches?.(Gtk.DialogError, Gtk.DialogError.CANCELLED))
                return null;
            throw error;
        }
    }

    const dialog = new Gtk.FileChooserNative({title: 'Select screenshot folder',
        transient_for: parent, modal: true, action: Gtk.FileChooserAction.SELECT_FOLDER,
        accept_label: 'Select', cancel_label: 'Cancel'});
    return new Promise((resolve, reject) => {
        let responseId = 0;
        let cancelId = 0;
        let settled = false;
        const finish = (file = null, error = null) => {
            if (settled)
                return;
            settled = true;
            if (responseId)
                dialog.disconnect(responseId);
            if (cancelId)
                GObject.Object.prototype.disconnect.call(cancellable, cancelId);
            dialog.destroy();
            if (error)
                reject(error);
            else
                resolve(file);
        };
        try {
            responseId = dialog.connect('response', (self, response) => {
                try {
                    finish(response === Gtk.ResponseType.ACCEPT ? self.get_file() : null);
                } catch (error) {
                    finish(null, error);
                }
            });
            // Cancellable.connect()/disconnect() are different Gio methods.
            cancelId = GObject.Object.prototype.connect.call(cancellable, 'cancelled', () => finish());
            if (cancellable.is_cancelled()) {
                finish();
                return;
            }
            try {
                dialog.set_current_folder(initialFolder);
            } catch {
                // Use the chooser's default if the saved folder is unavailable.
            }
            dialog.show();
        } catch (error) {
            finish(null, error);
        }
    });
}
