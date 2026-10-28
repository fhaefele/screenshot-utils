// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {callAsync} from './async-utils.js';
import {createSwitchRow} from './prefs-compat.js';
import {createCaptureIcon} from './capture-icons.js';
import {CAPTURE_SHORTCUTS, CAPTURE_BUS_PATH, CAPTURE_BUS_INTERFACE, captureCommand, migrateShortcutSettings} from './shortcuts.js';

function createCaptureRow(mode, title, field, action) {
    const row = new Adw.PreferencesRow({title, activatable: false, height_request: 66});
    const content = new Gtk.Box({spacing: 12, margin_top: 10, margin_bottom: 10,
        margin_start: 12, margin_end: 12});
    row.set_child(content);
    content.append(new Gtk.Image({gicon: createCaptureIcon(mode), pixel_size: 28, valign: Gtk.Align.CENTER}));
    const text = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true});
    text.append(new Gtk.Label({label: title, xalign: 0, css_classes: ['caption', 'dim-label']}));
    text.append(field);
    content.append(text);
    action.get_child().pixel_size = 16;
    content.append(action);
    return row;
}

export function fillShortcutPreferences(window, page, settings, handlers) {
    let closed = false;
    migrateShortcutSettings(settings);
    let statusProxy = null;
    const cancellable = new Gio.Cancellable();
    const shortcuts = new Adw.PreferencesGroup({title: 'Keyboard shortcuts'});
    page.add(shortcuts);
    const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
    shortcuts.add(content);
    const options = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    content.append(options);
    const enabled = createSwitchRow(settings, 'shortcuts-enabled', 'Enable keyboard shortcuts');
    options.append(enabled);
    const status = new Gtk.Label({xalign: 0, wrap: true, css_classes: ['dim-label']});
    content.append(status);
    const commands = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    content.append(commands);
    const commandOptions = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    commands.append(commandOptions);
    const permissionRow = createSwitchRow(settings, 'ask-command-confirmation', 'Ask for every request');
    permissionRow.subtitle = 'Confirm each screenshot command. When off, any local application can take screenshots by invoking the commands below.';
    commandOptions.append(permissionRow);
    const noteStyle = {xalign: 0, wrap: true, margin_start: 12, margin_end: 12, css_classes: ['dim-label']};
    const shortcutContent = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 6});
    commands.append(shortcutContent);
    shortcutContent.append(new Gtk.Label({
        label: 'Keyboard settings → View and customize shortcuts → Custom shortcuts → Add.',
        selectable: true, ...noteStyle,
    }));
    const commandRows = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    shortcutContent.append(commandRows);
    for (const {mode, title} of CAPTURE_SHORTCUTS) {
        const command = captureCommand(mode);
        const commandField = new Gtk.Entry({text: command, editable: false, has_frame: false,
            hexpand: true, width_chars: 1, css_classes: ['flat']});
        commandField.update_property([Gtk.AccessibleProperty.LABEL], [`${title} command`]);
        const copy = new Gtk.Button({icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER,
            css_classes: ['flat'], tooltip_text: `Copy ${title.toLowerCase()} command`});
        copy.update_property([Gtk.AccessibleProperty.LABEL], [`Copy ${title.toLowerCase()} command`]);
        copy.connect('clicked', () => {
            window.get_clipboard().set(command);
            window.add_toast(new Adw.Toast({title: 'Command copied', timeout: 2}));
        });
        commandRows.append(createCaptureRow(mode, title, commandField, copy));
    }
    const keyboardSettings = new Gtk.Button({label: 'Keyboard settings', halign: Gtk.Align.END, margin_top: 6});
    keyboardSettings.connect('clicked', () => {
        try {
            const app = Gio.AppInfo.create_from_commandline('gnome-control-center keyboard',
                'Keyboard settings', Gio.AppInfoCreateFlags.SUPPORTS_STARTUP_NOTIFICATION);
            app.launch([], window.get_display().get_app_launch_context());
        } catch (error) {
            console.warn(error);
            window.add_toast(new Adw.Toast({title: 'Could not open keyboard settings'}));
        }
    });
    shortcutContent.append(keyboardSettings);

    const sync = () => {
        migrateShortcutSettings(settings);
        const on = settings.get_boolean('shortcuts-enabled');
        const available = statusProxy?.get_cached_property('Available')?.get_boolean() ?? false;
        commands.visible = on;
        status.label = on && !available ? 'Extension disabled' : '';
        status.visible = !!status.label;
    };
    for (const key of ['shortcuts-enabled', 'shortcut-setup'])
        handlers.push([settings, settings.connect(`changed::${key}`, sync)]);
    sync();
    callAsync(Gio.DBusProxy, 'new_for_bus', Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START,
        null, 'org.gnome.Shell', CAPTURE_BUS_PATH, CAPTURE_BUS_INTERFACE, cancellable).then(proxy => {
        if (closed)
            return;
        statusProxy = proxy;
        handlers.push([proxy, proxy.connect('g-properties-changed', sync)]);
        sync();
    }).catch(error => {
        if (!closed && !cancellable.is_cancelled())
            console.warn(`Could not load shortcut status: ${error.message}`);
    });
    return () => {
        closed = true;
        cancellable.cancel();
        statusProxy = null;
    };
}
