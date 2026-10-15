// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';

const names = Object.freeze({
    selection: 'screenshot-ui-area-symbolic',
    screen: 'screenshot-ui-display-symbolic',
    window: 'screenshot-ui-window-symbolic',
    cursor: 'screenshot-ui-show-pointer-symbolic',
});

export function createCaptureIcon(mode) {
    // Pin both renderers to the SVGs used by preferences, bypassing theme lookup.
    return new Gio.FileIcon({file: Gio.File.new_for_uri(
        `resource:///org/gnome/shell/icons/scalable/actions/${names[mode]}.svg`)});
}
