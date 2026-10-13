import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

// Match EntryRow's editing and apply signals on libadwaita 1.1.
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
    const row = Adw.SwitchRow ? new Adw.SwitchRow({title}) : new Adw.ActionRow({title});
    const control = Adw.SwitchRow ? row : new Gtk.Switch({valign: Gtk.Align.CENTER});
    if (control !== row) {
        row.add_suffix(control);
        row.activatable_widget = control;
    }
    settings.bind(key, control, 'active', 0);
    return row;
}

