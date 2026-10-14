// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {PKGDATADIR} from 'resource:///org/gnome/Shell/Extensions/js/misc/config.js';
import {buildFilename} from './filename.js';
import {createEntryRow, createSwitchRow, selectFolder} from './prefs-compat.js';
import {ensureSaveLocation, getSavePath} from './location.js';
import {formatDelay, parseDelaySeconds} from './delay.js';
import {fillShortcutPreferences} from './shortcut-prefs.js';

Gio.Resource.load(`${PKGDATADIR}/gnome-shell-icons.gresource`)._register();

function commitOnLeave(row, apply, handlers) {
    handlers.push([row, row.connect('apply', apply)]);
    const focus = new Gtk.EventControllerFocus();
    handlers.push([focus, focus.connect('leave', apply)]);
    row.add_controller(focus);
    return focus;
}

export default class ScreenshotUtilsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const handlers = [];
        let closed = false;
        let folderRequest = null;
        let shortcutCleanup = null;
        ensureSaveLocation(settings);
        const page = new Adw.PreferencesPage({title: 'Capture', icon_name: 'camera-photo-symbolic'});
        const files = new Adw.PreferencesGroup({title: 'Files'});
        page.add(files);

        const folder = createEntryRow({title: 'Screenshot folder',
            text: ensureSaveLocation(settings), show_apply_button: true});
        const applyFolder = () => {
            const value = folder.get_text();
            if (value.trim())
                settings.set_string('save-location', value);
            folder.set_text(ensureSaveLocation(settings));
        };
        commitOnLeave(folder, applyFolder, handlers);
        const locationChangedId = settings.connect('changed::save-location',
            () => folder.set_text(ensureSaveLocation(settings)));
        handlers.push([settings, locationChangedId]);
        const browse = new Gtk.Button({label: 'Browse…', valign: Gtk.Align.CENTER,
            tooltip_text: 'Choose screenshot folder'});
        browse.update_property([Gtk.AccessibleProperty.LABEL], ['Choose screenshot folder']);
        folder.add_suffix(browse);
        browse.connect('clicked', async () => {
            if (closed || folderRequest)
                return;
            applyFolder();
            const cancellable = new Gio.Cancellable();
            folderRequest = cancellable;
            browse.sensitive = false;
            try {
                const selected = await selectFolder(window,
                    Gio.File.new_for_path(getSavePath(settings)), cancellable);
                if (closed || cancellable.is_cancelled() || !selected)
                    return;
                const path = selected.get_path();
                if (!path) {
                    window.add_toast(new Adw.Toast({title: 'Choose a folder with a local filesystem path'}));
                    return;
                }
                settings.set_string('save-location', path);
            } catch (error) {
                if (!closed && !cancellable.is_cancelled()) {
                    console.warn(`Could not select screenshot folder: ${error.message}`);
                    window.add_toast(new Adw.Toast({title: 'Could not open folder chooser'}));
                }
            } finally {
                if (folderRequest === cancellable)
                    folderRequest = null;
                if (!closed)
                    browse.sensitive = true;
            }
        });
        const applyEntries = [applyFolder];
        window.connect('close-request', () => {
            closed = true;
            folderRequest?.cancel();
            shortcutCleanup?.();
            for (const apply of applyEntries)
                apply();
            // Focus controllers can emit leave during GTK disposal. Disconnect
            // before destruction so GJS never calls into collected closures.
            for (const [object, id] of handlers)
                object.disconnect(id);
            handlers.length = 0;
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
        const delayFocus = commitOnLeave(delay, applyDelay, handlers);
        handlers.push([delayFocus, delayFocus.connect('enter', syncDelay)]);
        applyEntries.push(applyDelay);
        handlers.push([settings, settings.connect('changed::capture-delay-ms', syncDelay)]);
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

        shortcutCleanup = fillShortcutPreferences(window, page, settings, handlers);
        window.add(page);
    }
}
