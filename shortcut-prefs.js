// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {callAsync} from './async-utils.js';
import {createSwitchRow, createToggleRow} from './prefs-compat.js';
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
    const cancellable = new Gio.Cancellable();
    const shortcuts = new Adw.PreferencesGroup({title: 'Keyboard Shortcuts'});
    page.add(shortcuts);
    const setup = new Adw.ComboRow({title: 'Shortcut setup',
        model: Gtk.StringList.new(['GNOME Keyboard Settings', 'Extension preferences']),
        selected: settings.get_string('shortcut-setup') === 'extension' ? 1 : 0, use_subtitle: true});
    shortcuts.add(setup);
    const commands = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
    shortcuts.add(commands);
    const commandOptions = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    commands.append(commandOptions);
    const allowCommands = createSwitchRow(settings, 'enable-shortcut-commands', 'Allow shortcut commands');
    allowCommands.subtitle = 'Allows local applications to request screenshots through the commands below.';
    commandOptions.append(allowCommands);
    const {row: ask, control: askControl} = createToggleRow('Ask before screenshots from commands');
    ask.subtitle = 'Turning this off requires approval in GNOME Shell. Any local program can then request screenshots without asking.';
    commandOptions.append(ask);
    commands.append(new Gtk.Label({
        label: 'Session approval resets when permission changes, the extension is disabled or GNOME Shell restarts. Locking may disable the extension.',
        xalign: 0, wrap: true, css_classes: ['dim-label'],
    }));
    const approve = new Gtk.Button({label: 'Approve for this session', halign: Gtk.Align.END});
    commands.append(approve);
    let updatingAsk = false;
    let approvalProxy = null;
    let requestingApproval = false;
    const requestApproval = async () => {
        if (requestingApproval)
            return;
        requestingApproval = true;
        approve.sensitive = false;
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
                syncAsk();
        }
    };
    approve.connect('clicked', requestApproval);
    askControl.connect('notify::active', () => {
        if (updatingAsk)
            return;
        settings.set_boolean('ask-command-confirmation', askControl.active);
        if (!askControl.active && settings.get_boolean('enable-shortcut-commands'))
            requestApproval();
    });
    const syncAsk = () => {
        updatingAsk = true;
        askControl.active = settings.get_boolean('ask-command-confirmation');
        updatingAsk = false;
        ask.sensitive = settings.get_boolean('enable-shortcut-commands');
        approve.visible = !askControl.active && ask.sensitive;
        const approved = approvalProxy?.get_cached_property('SilentCommandsApproved')?.get_boolean() ?? false;
        approve.label = approved ? 'Approved for this session' : 'Approve for this session';
        approve.sensitive = !approved && !requestingApproval;
    };
    for (const key of ['ask-command-confirmation', 'enable-shortcut-commands'])
        handlers.push([settings, settings.connect(`changed::${key}`, syncAsk)]);
    syncAsk();
    callAsync(Gio.DBusProxy, 'new_for_bus', Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START,
        null, 'org.gnome.Shell', CAPTURE_BUS_PATH, CAPTURE_BUS_INTERFACE, cancellable).then(proxy => {
        if (closed)
            return;
        approvalProxy = proxy;
        handlers.push([proxy, proxy.connect('g-properties-changed', syncAsk)]);
        syncAsk();
    }).catch(() => {
        // Preferences can be opened while the extension is disabled. Approval
        // requests report their own failure; the status remains unapproved.
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
    native.append(new Gtk.Label({label: 'GNOME reserves these keys globally. Occupied combinations are rejected. Screenshot commands are disabled in this mode.',
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
    setup.connect('notify::selected', () => settings.set_string('shortcut-setup', setup.selected === 1 ? 'extension' : 'gnome'));
    const syncSetup = () => {
        const extension = settings.get_string('shortcut-setup') === 'extension';
        setup.selected = extension ? 1 : 0;
        commands.visible = !extension;
        native.visible = extension;
        recorder?.close();
    };
    handlers.push([settings, settings.connect('changed::shortcut-setup', syncSetup)]);
    syncSetup();
    return () => {
        closed = true;
        cancellable.cancel();
        approvalProxy = null;
        recorder?.close();
    };
}
