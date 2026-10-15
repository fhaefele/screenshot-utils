// SPDX-License-Identifier: GPL-3.0-or-later
export const CAPTURE_SHORTCUTS = Object.freeze([
    Object.freeze({mode: 'selection', title: 'Selection', key: 'shortcut-selection'}),
    Object.freeze({mode: 'screen', title: 'Screen', key: 'shortcut-screen'}),
    Object.freeze({mode: 'window', title: 'Window', key: 'shortcut-window'}),
]);

export const CAPTURE_BUS_PATH = '/org/gnome/shell/extensions/screenshotutils';
export const CAPTURE_BUS_INTERFACE = 'dev.fxth.ScreenshotUtils';

export function resetCommandPreferences(settings) {
    if (!settings.get_boolean('ask-command-confirmation'))
        settings.set_boolean('ask-command-confirmation', true);
}

export function usableShortcut(accelerator) {
    // Reject plain typing keys even when preferences are written externally.
    // Mutter still parses the complete accelerator and checks its reservation.
    return typeof accelerator === 'string' && accelerator.length <= 256 &&
        (/<(?:Control|Ctrl|Ctl|Primary|Alt|Mod1|Super|Meta|Hyper)>/i.test(accelerator) ||
            /^(?:<Shift>)?(?:F(?:[1-9]|[12][0-9]|3[0-5])|Print)$/i.test(accelerator));
}

export function captureCommand(mode) {
    return `gdbus call --session --dest org.gnome.Shell --object-path ${CAPTURE_BUS_PATH} --method ${CAPTURE_BUS_INTERFACE}.Capture ${mode}`;
}
