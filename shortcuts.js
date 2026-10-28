// SPDX-License-Identifier: GPL-3.0-or-later
export const CAPTURE_SHORTCUTS = Object.freeze([
    Object.freeze({mode: 'selection', title: 'Selection'}),
    Object.freeze({mode: 'screen', title: 'Screen'}),
    Object.freeze({mode: 'window', title: 'Window'}),
]);

export const CAPTURE_BUS_PATH = '/org/gnome/shell/extensions/screenshotutils';
export const CAPTURE_BUS_INTERFACE = 'dev.fxth.ScreenshotUtils';

export function migrateShortcutSettings(settings) {
    // Retain the old source key only to migrate upgrades. Native-key opt-in
    // never grants permission to the command API that replaces it.
    if (settings.get_string('shortcut-setup') !== 'gnome') {
        settings.set_boolean('shortcuts-enabled', false);
        settings.set_boolean('ask-command-confirmation', true);
        settings.set_string('shortcut-setup', 'gnome');
    }
}

export function captureCommand(mode) {
    return `gdbus call --session --dest org.gnome.Shell --object-path ${CAPTURE_BUS_PATH} --method ${CAPTURE_BUS_INTERFACE}.Capture ${mode}`;
}
