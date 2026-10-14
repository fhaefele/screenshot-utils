// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {callAsync} from './async-utils.js';
import {createSwitchRow} from './prefs-compat.js';
import {createCaptureIcon} from './capture-icons.js';
import {CAPTURE_SHORTCUTS, CAPTURE_BUS_PATH, CAPTURE_BUS_INTERFACE, captureCommand, usableShortcut} from './shortcuts.js';

function shortcutLabel(accelerator) {
    const [valid, key, modifiers] = Gtk.accelerator_parse(accelerator);
    return valid ? Gtk.accelerator_get_label(key, modifiers) : 'Set shortcut…';
}

function shortcutRecorder(parent, title, onSelected) {
    const window = new Gtk.Window({title: `Set ${title.toLowerCase()} shortcut`,
        transient_for: parent, modal: true, default_width: 420, resizable: false});
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18,
        margin_top: 24, margin_bottom: 24, margin_start: 24, margin_end: 24});
    window.set_child(box);
    box.append(new Gtk.Label({label: 'Press a key combination, then Enter to set it. Escape cancels.', wrap: true}));
    const label = new Gtk.ShortcutLabel({disabled_text: 'Waiting for keys…'});
    box.append(label);
    const hint = new Gtk.Label({wrap: true, css_classes: ['dim-label']});
    box.append(hint);
    const buttons = new Gtk.Box({spacing: 12, halign: Gtk.Align.END});
    const cancel = new Gtk.Button({label: 'Cancel'});
    const apply = new Gtk.Button({label: 'Set shortcut', sensitive: false, css_classes: ['suggested-action']});
    buttons.append(cancel);
    buttons.append(apply);
    box.append(buttons);
    let accelerator = '';
    const controller = new Gtk.EventControllerKey();
    controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
        const modifiers = state & Gtk.accelerator_get_default_mod_mask();
        if (keyval === Gdk.KEY_Escape && !modifiers) {
            window.close();
            return true;
        }
        if (!modifiers && (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) && apply.sensitive) {
            (window.get_focus() === cancel ? cancel : apply).emit('clicked');
            return true;
        }
        if (!modifiers && keyval === Gdk.KEY_space && window.get_focus() instanceof Gtk.Button)
            return false;
        if ((keyval === Gdk.KEY_Tab || keyval === Gdk.KEY_ISO_Left_Tab) &&
            !(modifiers & ~Gdk.ModifierType.SHIFT_MASK))
            return false;
        const key = Gdk.keyval_to_lower(keyval);
        const candidate = Gtk.accelerator_name(key, modifiers);
        if (!Gtk.accelerator_valid(key, modifiers) || !usableShortcut(candidate)) {
            hint.label = 'Use Ctrl, Alt or Super with a key, or a function key.';
            apply.sensitive = false;
            return true;
        }
        accelerator = candidate;
        label.accelerator = accelerator;
        hint.label = '';
        apply.sensitive = true;
        apply.grab_focus();
        return true;
    });
    window.add_controller(controller);
    window.connect('map', () => window.get_surface()?.inhibit_system_shortcuts(null));
    window.connect('close-request', () => {
        window.get_surface()?.restore_system_shortcuts();
        return false;
    });
    cancel.connect('clicked', () => window.close());
    apply.connect('clicked', () => {
        onSelected(accelerator);
        window.close();
    });
    window.present();
    return window;
}

export function fillShortcutPreferences(window, page, settings, handlers) {
    let closed = false;
    let recorder = null;
    let updating = false;
    let requestingApproval = false;
    let approvalProxy = null;
    const cancellable = new Gio.Cancellable();
    const shortcuts = new Adw.PreferencesGroup({title: 'Keyboard Shortcuts'});
    page.add(shortcuts);
    const enabled = createSwitchRow(settings, 'shortcuts-enabled', 'Enable keyboard shortcuts');
    shortcuts.add(enabled);
    const status = new Gtk.Label({xalign: 0, wrap: true, css_classes: ['dim-label']});
    shortcuts.add(status);
    const sources = ['gnome', 'extension'];
    const setup = new Adw.ComboRow({title: 'Source',
        subtitle: 'How do you want to manage your Keyboard shortcuts.',
        model: Gtk.StringList.new(['GNOME Keyboard Settings', 'Extension'])});
    shortcuts.add(setup);
    const commands = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
    shortcuts.add(commands);
    const commandOptions = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    commands.append(commandOptions);
    const permission = new Adw.ComboRow({title: 'Command permission',
        model: Gtk.StringList.new(['Ask for every request', 'Allow without asking'])});
    commandOptions.append(permission);
    const disclosure = new Gtk.Label({
        label: 'Any local application can request screenshots without confirmation. Permission persists across logins until you turn it off or disable the extension. Unrestricted local programs can modify saved permissions.',
        xalign: 0, wrap: true,
    });
    commands.append(disclosure);
    const approve = new Gtk.Button({label: 'Approve command access', halign: Gtk.Align.END});
    commands.append(approve);
    const requestApproval = async () => {
        if (requestingApproval || closed)
            return;
        requestingApproval = true;
        sync();
        try {
            await callAsync(Gio.DBus.session, 'call', 'org.gnome.Shell', CAPTURE_BUS_PATH,
                CAPTURE_BUS_INTERFACE, 'ApproveSilentCommands', null, null,
                Gio.DBusCallFlags.NONE, 5000, cancellable);
        } catch (error) {
            if (!closed && !cancellable.is_cancelled()) {
                console.warn(`Could not request screenshot command approval: ${error.message}`);
                window.add_toast(new Adw.Toast({title: 'Could not request approval. Make sure the extension is enabled and idle.'}));
            }
        } finally {
            requestingApproval = false;
            if (!closed)
                sync();
        }
    };
    approve.connect('clicked', requestApproval);
    setup.connect('notify::selected', () => {
        const source = sources[setup.selected];
        if (!updating && source && settings.get_string('shortcut-setup') !== source)
            settings.set_string('shortcut-setup', source);
    });
    permission.connect('notify::selected', () => {
        if (updating)
            return;
        const ask = permission.selected === 0;
        if (ask === settings.get_boolean('ask-command-confirmation'))
            return;
        settings.set_boolean('ask-command-confirmation', ask);
        if (!ask && settings.get_boolean('shortcuts-enabled') && settings.get_string('shortcut-setup') === 'gnome')
            requestApproval();
    });

    const shortcutContent = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
    commands.append(shortcutContent);
    shortcutContent.append(new Gtk.Label({
        label: 'Keyboard Settings → View and Customize Shortcuts → Custom Shortcuts → Add.',
        xalign: 0, wrap: true, selectable: true,
    }));
    const commandRows = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    shortcutContent.append(commandRows);
    for (const {mode, title} of CAPTURE_SHORTCUTS) {
        const command = captureCommand(mode);
        const row = new Adw.PreferencesRow({title, activatable: false});
        const content = new Gtk.Box({spacing: 12, margin_top: 10, margin_bottom: 10,
            margin_start: 12, margin_end: 12});
        row.set_child(content);
        content.append(new Gtk.Image({gicon: createCaptureIcon(mode), pixel_size: 28, valign: Gtk.Align.CENTER}));
        const text = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true});
        text.append(new Gtk.Label({label: title, xalign: 0, css_classes: ['caption', 'dim-label']}));
        const commandField = new Gtk.Entry({text: command, editable: false, has_frame: false,
            hexpand: true, width_chars: 1, css_classes: ['flat']});
        commandField.update_property([Gtk.AccessibleProperty.LABEL], [`${title} command`]);
        text.append(commandField);
        content.append(text);
        const copy = new Gtk.Button({icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER,
            css_classes: ['flat'], tooltip_text: `Copy ${title.toLowerCase()} command`});
        copy.get_child().pixel_size = 16;
        copy.update_property([Gtk.AccessibleProperty.LABEL], [`Copy ${title.toLowerCase()} command`]);
        copy.connect('clicked', () => {
            window.get_clipboard().set(command);
            window.add_toast(new Adw.Toast({title: 'Command copied', timeout: 2}));
        });
        content.append(copy);
        commandRows.append(row);
    }
    const keyboardSettings = new Gtk.Button({label: 'Keyboard Settings', halign: Gtk.Align.END});
    keyboardSettings.connect('clicked', () => {
        try {
            const app = Gio.AppInfo.create_from_commandline('gnome-control-center keyboard',
                'Keyboard Settings', Gio.AppInfoCreateFlags.SUPPORTS_STARTUP_NOTIFICATION);
            app.launch([], window.get_display().get_app_launch_context());
        } catch (error) {
            console.warn(error);
            window.add_toast(new Adw.Toast({title: 'Could not open Keyboard Settings'}));
        }
    });
    shortcutContent.append(keyboardSettings);

    const native = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
    shortcuts.add(native);
    native.append(new Gtk.Label({label: 'Assigned keys take screenshots immediately. Occupied system shortcuts are rejected. External screenshot commands are disabled in this mode.',
        xalign: 0, wrap: true}));
    const bindings = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    native.append(bindings);
    for (const {mode, title, key} of CAPTURE_SHORTCUTS) {
        const row = new Adw.ActionRow({title: `${title} shortcut`});
        const set = new Gtk.Button({valign: Gtk.Align.CENTER});
        set.update_property([Gtk.AccessibleProperty.LABEL], [`Set ${title.toLowerCase()} shortcut`]);
        const clear = new Gtk.Button({icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: `Clear ${title.toLowerCase()} shortcut`});
        clear.update_property([Gtk.AccessibleProperty.LABEL], [`Clear ${title.toLowerCase()} shortcut`]);
        row.add_suffix(set);
        row.add_suffix(clear);
        row.activatable_widget = set;
        const sync = () => {
            const accelerator = settings.get_string(key);
            set.label = shortcutLabel(accelerator);
            clear.sensitive = !!accelerator;
            row.subtitle = settings.get_value('shortcut-status').deep_unpack()[mode] ?? '';
        };
        for (const setting of [key, 'shortcut-status'])
            handlers.push([settings, settings.connect(`changed::${setting}`, sync)]);
        set.connect('clicked', () => {
            if (recorder)
                return;
            recorder = shortcutRecorder(window, title, accelerator => settings.set_string(key, accelerator));
            recorder.connect('close-request', () => { recorder = null; return false; });
        });
        clear.connect('clicked', () => settings.set_string(key, ''));
        sync();
        bindings.append(row);
    }
    const sync = () => {
        const on = settings.get_boolean('shortcuts-enabled');
        const source = settings.get_string('shortcut-setup');
        const ask = settings.get_boolean('ask-command-confirmation');
        const available = approvalProxy?.get_cached_property('Available')?.get_boolean() ?? false;
        const approved = approvalProxy?.get_cached_property('SilentCommandsApproved')?.get_boolean() ?? false;
        updating = true;
        const sourceIndex = sources.indexOf(source);
        setup.selected = sourceIndex < 0 ? Gtk.INVALID_LIST_POSITION : sourceIndex;
        permission.selected = ask ? 0 : 1;
        updating = false;
        setup.visible = on;
        commands.visible = on && source === 'gnome';
        native.visible = on && source === 'extension';
        disclosure.visible = !ask;
        approve.visible = !ask;
        approve.label = approved ? 'Command access approved' : 'Approve command access';
        approve.sensitive = available && !approved && !requestingApproval;
        const assigned = CAPTURE_SHORTCUTS.filter(({key}) => settings.get_string(key));
        const warnings = Object.values(settings.get_value('shortcut-status').deep_unpack());
        status.visible = on;
        status.label = !on ? '' : !available ? 'Extension disabled' : !source ? 'Choose a shortcut source' : source === 'extension'
            ? !assigned.length ? 'No shortcuts assigned' : warnings.length >= assigned.length ? 'No available shortcuts' : warnings.length ? 'Active with shortcut warnings' : 'Active'
            : !ask && !approved ? 'Approval required' : 'Active';
    };
    for (const key of ['shortcuts-enabled', 'shortcut-setup', 'ask-command-confirmation', 'shortcut-status',
        ...CAPTURE_SHORTCUTS.map(shortcut => shortcut.key)]) {
        handlers.push([settings, settings.connect(`changed::${key}`, () => {
            if (key === 'shortcuts-enabled' || key === 'shortcut-setup')
                recorder?.close();
            sync();
        })]);
    }
    sync();
    callAsync(Gio.DBusProxy, 'new_for_bus', Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START,
        null, 'org.gnome.Shell', CAPTURE_BUS_PATH, CAPTURE_BUS_INTERFACE, cancellable).then(proxy => {
        if (closed)
            return;
        approvalProxy = proxy;
        handlers.push([proxy, proxy.connect('g-properties-changed', sync)]);
        sync();
    }).catch(error => {
        if (!closed && !cancellable.is_cancelled())
            console.warn(`Could not load shortcut status: ${error.message}`);
    });
    return () => {
        closed = true;
        cancellable.cancel();
        approvalProxy = null;
        recorder?.close();
    };
}
