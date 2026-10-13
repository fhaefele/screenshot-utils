import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {PKGDATADIR} from 'resource:///org/gnome/Shell/Extensions/js/misc/config.js';
import {buildFilename} from './filename.js';
import {createEntryRow, createSwitchRow} from './prefs-compat.js';
import {ensureSaveLocation} from './location.js';
import {formatDelay, parseDelaySeconds} from './delay.js';

Gio.Resource.load(`${PKGDATADIR}/gnome-shell-icons.gresource`)._register();

function commitOnLeave(row, apply) {
    row.connect('apply', apply);
    const focus = new Gtk.EventControllerFocus();
    focus.connect('leave', apply);
    row.add_controller(focus);
    return focus;
}

export default class ScreenshotUtilsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        ensureSaveLocation(settings);
        const page = new Adw.PreferencesPage({title: 'Capture', icon_name: 'camera-photo-symbolic'});
        const files = new Adw.PreferencesGroup({title: 'Files'});
        page.add(files);

        const folder = createEntryRow({title: 'Screenshot folder',
            text: ensureSaveLocation(settings), show_apply_button: true});
        const applyFolder = () => {
            const value = folder.get_text().trim();
            if (value)
                settings.set_string('save-location', value);
            folder.set_text(ensureSaveLocation(settings));
        };
        commitOnLeave(folder, applyFolder);
        const locationChangedId = settings.connect('changed::save-location',
            () => folder.set_text(ensureSaveLocation(settings)));
        const handlers = [locationChangedId];
        const applyEntries = [applyFolder];
        window.connect('close-request', () => {
            for (const apply of applyEntries)
                apply();
            for (const id of handlers)
                settings.disconnect(id);
            return false;
        });
        files.add(folder);

        const template = createEntryRow({title: 'Filename template'});
        template.set_text(settings.get_string('filename-template'));
        template.connect('changed', row => settings.set_string('filename-template', row.get_text()));
        files.add(template);
        const notes = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 8, margin_start: 12, margin_end: 12});
        const preview = new Gtk.Label({xalign: 0, wrap: true, selectable: true, css_classes: ['dim-label']});
        const updatePreview = () => { preview.label = `Preview: ${buildFilename(template.get_text(), new Date(), 'screen')}`; };
        template.connect('changed', updatePreview);
        updatePreview();
        notes.append(preview);
        notes.append(new Gtk.Label({
            label: 'Tokens: {date}, {time}, {type}, {Y}, {m}, {d}, {H}, {M}, {S}, {N}',
            xalign: 0, wrap: true, selectable: true, css_classes: ['dim-label', 'caption'],
        }));
        files.add(notes);

        const capture = new Adw.PreferencesGroup({title: 'Capture'});
        page.add(capture);
        const delay = createEntryRow({title: 'Delay (seconds)', show_apply_button: true});
        const syncDelay = () => {
            const milliseconds = settings.get_int('capture-delay-ms');
            delay.text = delayFocus.contains_focus ? String(milliseconds / 1000) : formatDelay(milliseconds);
        };
        const applyDelay = () => {
            const milliseconds = parseDelaySeconds(delay.text);
            if (milliseconds !== null)
                settings.set_int('capture-delay-ms', milliseconds);
            syncDelay();
        };
        delay.connect('changed', () => {
            if (delayFocus.contains_focus && parseDelaySeconds(delay.text) === null)
                delay.add_css_class('error');
            else
                delay.remove_css_class('error');
        });
        const delayFocus = commitOnLeave(delay, applyDelay);
        delayFocus.connect('enter', syncDelay);
        applyEntries.push(applyDelay);
        handlers.push(settings.connect('changed::capture-delay-ms', syncDelay));
        syncDelay();
        capture.add(delay);

        for (const [key, title] of [
            ['include-cursor', 'Include mouse pointer'],
            ['copy-to-clipboard', 'Copy image to clipboard'],
            ['mute-screenshot-sound', 'Mute screenshot sound'],
            ['show-notifications', 'Show notifications'],
        ]) {
            const row = createSwitchRow(settings, key, title);
            capture.add(row);
        }

        const shortcuts = new Adw.PreferencesGroup({title: 'Keyboard Shortcuts'});
        page.add(shortcuts);
        const shortcutContent = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
        shortcuts.add(shortcutContent);
        shortcutContent.append(new Gtk.Label({
            label: 'Keyboard Settings → View and Customize Shortcuts → Custom Shortcuts → Add.',
            xalign: 0, wrap: true, selectable: true,
        }));
        const commandRows = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list']});
        shortcutContent.append(commandRows);
        Gtk.IconTheme.get_for_display(window.get_display()).add_resource_path('/org/gnome/shell/icons');
        for (const [mode, title, icon] of [
            ['selection', 'Selection', 'screenshot-ui-area-symbolic'],
            ['screen', 'Screen', 'screenshot-ui-display-symbolic'],
            ['window', 'Window', 'screenshot-ui-window-symbolic'],
        ]) {
            const command = `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/shell/extensions/screenshotutils --method dev.fxth.ScreenshotUtils.Capture ${mode}`;
            const row = new Adw.PreferencesRow({title, activatable: false});
            const content = new Gtk.Box({spacing: 12, margin_top: 10, margin_bottom: 10,
                margin_start: 12, margin_end: 12});
            row.set_child(content);
            content.append(new Gtk.Image({icon_name: icon, pixel_size: 28, valign: Gtk.Align.CENTER}));
            const text = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true});
            text.append(new Gtk.Label({label: title, xalign: 0, css_classes: ['caption', 'dim-label']}));
            const commandField = new Gtk.Entry({text: command, editable: false, has_frame: false,
                hexpand: true, width_chars: 1, css_classes: ['flat']});
            commandField.update_property([Gtk.AccessibleProperty.LABEL], [`${title} command`]);
            text.append(commandField);
            content.append(text);
            const copy = new Gtk.Button({icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: `Copy ${title.toLowerCase()} command`});
            copy.get_child().pixel_size = 16;
            copy.update_property([Gtk.AccessibleProperty.LABEL], [`Copy ${title.toLowerCase()} command`]);
            copy.connect('clicked', () => {
                window.get_clipboard().set(command);
                window.add_toast(new Adw.Toast({title: 'Command copied', timeout: 2}));
            });
            content.append(copy);
            commandRows.append(row);
        }
        const keyboardSettings = new Gtk.Button({label: 'Keyboard Settings',
            halign: Gtk.Align.END});
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
        window.add(page);
    }
}
