import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {buildFilename} from './filename.js';
import {ensureSaveLocation} from './location.js';
import {formatDelay, parseDelaySeconds} from './delay.js';

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

        const folder = new Adw.EntryRow({title: 'Screenshot folder',
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

        const template = new Adw.EntryRow({title: 'Filename template'});
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
        const delay = new Adw.EntryRow({title: 'Delay (seconds)', show_apply_button: true});
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
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', 0);
            capture.add(row);
        }
        window.add(page);
    }
}
