// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {callAsync} from './async-utils.js';
import {createSwitchRow, createToggleRow} from './prefs-compat.js';
import {createCaptureIcon} from './capture-icons.js';
import {CAPTURE_SHORTCUTS, CAPTURE_BUS_PATH, CAPTURE_BUS_INTERFACE, captureCommand, usableShortcut, resetCommandPreferences} from './shortcuts.js';

function shortcutLabel(accelerator) {
    const [valid, key, modifiers] = Gtk.accelerator_parse(accelerator);
    return valid ? Gtk.accelerator_get_label(key, modifiers) : 'Set shortcut…';
}

function createCaptureRow(mode, title, field, action, inline = false) {
    const row = new Adw.PreferencesRow({title, activatable: false, height_request: 66});
    const content = new Gtk.Box({spacing: 12, margin_top: 10, margin_bottom: 10,
        margin_start: 12, margin_end: 12});
    row.set_child(content);
    content.append(new Gtk.Image({gicon: createCaptureIcon(mode), pixel_size: 28, valign: Gtk.Align.CENTER}));
    if (inline) {
        content.append(new Gtk.Label({label: title, xalign: 0, hexpand: true}));
        content.append(field);
    } else {
        const text = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true});
        text.append(new Gtk.Label({label: title, xalign: 0, css_classes: ['caption', 'dim-label']}));
        text.append(field);
        content.append(text);
    }
    action.get_child().pixel_size = 16;
    content.append(action);
    return row;
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
    let queuedApproval = false;
    let requestedAsk = null;
    let approvalGeneration = 0;
    let requestedGeneration = 0;
    let approvalProxy = null;
    let approvalWait = null;
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
    const sources = ['extension', 'gnome'];
    const setup = new Adw.ComboRow({title: 'Source',
        subtitle: 'Who should manage your keyboard shortcuts?',
        model: Gtk.StringList.new(['Extension', 'GNOME keyboard settings'])});
    options.append(setup);
    content.append(status);
    const commands = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    content.append(commands);
    const commandOptions = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    commands.append(commandOptions);
    const {row: permissionRow, control: permission} = createToggleRow('Ask for every request');
    permissionRow.subtitle = 'Confirm each screenshot command. When off, any local application can take screenshots by invoking the commands below.';
    commandOptions.append(permissionRow);
    const noteStyle = {xalign: 0, wrap: true, margin_start: 12, margin_end: 12, css_classes: ['dim-label']};
    const scope = new Gtk.Label({name: 'command-approval-scope', ...noteStyle});
    commands.append(scope);
    // Settings notifications and D-Bus calls can arrive in either order.
    // Wait for Shell to acknowledge the requested permission state.
    const waitForApprovalReady = () => new Promise((resolve, reject) => {
        let timeoutId = 0;
        const finish = error => {
            approvalWait = null;
            if (timeoutId)
                GLib.source_remove(timeoutId);
            timeoutId = 0;
            if (error)
                reject(error);
            else
                resolve();
        };
        approvalWait = error => {
            if (error) {
                finish(error);
            } else if (closed || !settings.get_boolean('shortcuts-enabled') || settings.get_string('shortcut-setup') !== 'gnome') {
                finish(new Error('Command approval cancelled'));
            } else if (approvalProxy) {
                if (!approvalProxy.get_cached_property('Available')?.get_boolean())
                    finish(new Error('Extension is disabled'));
                else if (approvalProxy.get_cached_property('CommandConfigurationAvailable')?.get_boolean())
                    finish();
            }
        };
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            timeoutId = 0;
            finish(new Error('Shell did not acknowledge command permission'));
            return GLib.SOURCE_REMOVE;
        });
        approvalWait();
    });
    const wantsApproval = () => !closed && settings.get_boolean('shortcuts-enabled') && settings.get_string('shortcut-setup') === 'gnome';
    const requestApproval = async ask => {
        requestedAsk = ask;
        requestedGeneration = approvalGeneration;
        queuedApproval = true;
        if (requestingApproval || closed)
            return;
        requestingApproval = true;
        sync();
        try {
            while (queuedApproval && wantsApproval() && requestedGeneration === approvalGeneration) {
                queuedApproval = false;
                try {
                    const ask = requestedAsk;
                    const generation = requestedGeneration;
                    await waitForApprovalReady();
                    if (queuedApproval || generation !== approvalGeneration)
                        continue;
                    if (!wantsApproval())
                        break;
                    await callAsync(Gio.DBus.session, 'call', 'org.gnome.Shell', CAPTURE_BUS_PATH,
                        CAPTURE_BUS_INTERFACE, 'ConfigureCommandConfirmation', new GLib.Variant('(b)', [ask]), null,
                        Gio.DBusCallFlags.NONE, 5000, cancellable);
                } catch (error) {
                    if (!queuedApproval && requestedGeneration === approvalGeneration && wantsApproval() && !cancellable.is_cancelled()) {
                        console.warn(`Could not request screenshot command approval: ${error.message}`);
                        window.add_toast(new Adw.Toast({title: 'Could not request approval. Make sure the extension is enabled and idle.'}));
                    }
                }
            }
        } finally {
            requestingApproval = false;
            if (!closed)
                sync();
        }
    };
    const chooseSource = source => {
        settings.set_string('shortcut-setup', source);
        if (source === 'extension')
            resetCommandPreferences(settings);
        else if (!settings.get_boolean('ask-command-confirmation'))
            settings.set_boolean('ask-command-confirmation', true);
    };
    setup.connect('notify::selected', () => {
        const source = sources[setup.selected];
        if (!updating && source && settings.get_string('shortcut-setup') !== source)
            chooseSource(source);
    });
    permission.connect('notify::active', () => {
        if (updating)
            return;
        const ask = permission.active;
        if (!requestingApproval && ask === settings.get_boolean('ask-command-confirmation'))
            return;
        if (settings.get_boolean('shortcuts-enabled') && settings.get_string('shortcut-setup') === 'gnome')
            requestApproval(ask);
    });

    const shortcutContent = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 6});
    commands.append(shortcutContent);
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
    shortcutContent.append(new Gtk.Label({
        label: 'Keyboard settings → View and customize shortcuts → Custom shortcuts → Add.',
        selectable: true, ...noteStyle,
    }));
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

    const native = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
    content.append(native);
    const bindings = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
    native.append(bindings);
    for (const {mode, title, key} of CAPTURE_SHORTCUTS) {
        const set = new Gtk.Button({valign: Gtk.Align.CENTER});
        set.update_property([Gtk.AccessibleProperty.LABEL], [`Set ${title.toLowerCase()} shortcut`]);
        const clear = new Gtk.Button({icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER,
            css_classes: ['flat'], tooltip_text: `Clear ${title.toLowerCase()} shortcut`});
        clear.update_property([Gtk.AccessibleProperty.LABEL], [`Clear ${title.toLowerCase()} shortcut`]);
        const row = createCaptureRow(mode, title, set, clear, true);
        row.title = `${title} shortcut`;
        const sync = () => {
            const accelerator = settings.get_string(key);
            set.label = shortcutLabel(accelerator);
            clear.sensitive = !!accelerator;
            set.tooltip_text = settings.get_value('shortcut-status').deep_unpack()[mode] || `Set ${title.toLowerCase()} shortcut`;
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
        if (on && !sources.includes(source)) {
            chooseSource(sources[0]);
            return;
        }
        const ask = settings.get_boolean('ask-command-confirmation');
        const available = approvalProxy?.get_cached_property('Available')?.get_boolean() ?? false;
        updating = true;
        setup.selected = Math.max(0, sources.indexOf(source));
        const pending = requestingApproval && requestedGeneration === approvalGeneration;
        permission.active = pending ? requestedAsk : ask;
        permission.sensitive = !pending;
        updating = false;
        setup.visible = on;
        commands.visible = on && source === 'gnome';
        native.visible = on && source === 'extension';
        scope.visible = true;
        const confirmation = ask ? 'Ask for every request' : 'Skip confirmation';
        const duration = settings.get_string('command-approval-duration') === 'session' ? 'This session' : 'Always';
        scope.label = `Current setting: ${confirmation} · ${duration}`;
        const assigned = CAPTURE_SHORTCUTS.filter(({key}) => settings.get_string(key));
        const warnings = Object.values(settings.get_value('shortcut-status').deep_unpack());
        status.label = !on ? '' : !available ? 'Extension disabled' : source === 'extension'
            ? warnings.length >= assigned.length && assigned.length ? 'No available shortcuts' : warnings.length ? 'Some shortcuts unavailable' : ''
            : '';
        status.visible = !!status.label;
        approvalWait?.();
    };
    for (const key of ['shortcuts-enabled', 'shortcut-setup', 'ask-command-confirmation', 'command-approval-duration', 'shortcut-status',
        ...CAPTURE_SHORTCUTS.map(shortcut => shortcut.key)]) {
        handlers.push([settings, settings.connect(`changed::${key}`, () => {
            if (key === 'shortcuts-enabled' || key === 'shortcut-setup') {
                approvalGeneration++;
                approvalWait?.(new Error('Shortcut setup changed'));
                recorder?.close();
            }
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
        approvalWait?.(error);
        if (!closed && !cancellable.is_cancelled())
            console.warn(`Could not load shortcut status: ${error.message}`);
    });
    return () => {
        closed = true;
        approvalGeneration++;
        approvalWait?.(new Error('Preferences closed'));
        cancellable.cancel();
        approvalProxy = null;
        recorder?.close();
    };
}
