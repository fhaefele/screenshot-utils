// SPDX-License-Identifier: GPL-3.0-or-later
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {CAPTURE_SHORTCUTS, usableShortcut} from './shortcuts.js';

// External accelerator grabs atomically reject occupied combinations. Unlike
// addKeybinding(), they do not automatically overwrite another binding when
// the underlying preference changes.
export class ShortcutManager {
    constructor(settings, capture, changed) {
        this._settings = settings;
        this._capture = capture;
        this._changed = changed;
        this.bindings = new Map();
        this._handlers = [];
        this._syncing = false;
        this.epoch = 0;
    }

    enable() {
        this._handlers.push([global.display, global.display.connect('accelerator-activated', (_display, action) => {
            for (const [mode, binding] of this.bindings) {
                if (binding.action === action) {
                    if (this.active && !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter &&
                        Main.modalCount === 0 && this._settings.get_string('shortcut-setup') === 'extension')
                        this._capture(mode);
                    return;
                }
            }
        })]);
        for (const key of ['shortcuts-enabled', 'shortcut-setup', ...CAPTURE_SHORTCUTS.map(shortcut => shortcut.key)])
            this._handlers.push([this._settings, this._settings.connect(`changed::${key}`, () => {
                if (this._syncing)
                    return;
                this.epoch++;
                        this._sync(key);
                this._changed();
            })]);
        this._sync();
    }

    get active() {
        return this._settings.get_boolean('shortcuts-enabled') &&
            this._settings.get_string('shortcut-setup') === 'extension';
    }

    _remove(mode) {
        const binding = this.bindings.get(mode);
        if (!binding)
            return;
        global.display.ungrab_accelerator(binding.action);
        Main.wm.allowKeybinding(binding.name, Shell.ActionMode.NONE);
        // allowKeybinding() has no removal API for external grabs. These unique
        // names belong to us; remove their entries rather than accumulating
        // one disabled entry on every shortcut edit or extension restart.
        delete Main.wm._allowedKeybindings[binding.name];
        this.bindings.delete(mode);
    }

    _sync(changedKey = null) {
        if (this._syncing)
            return;
        this._syncing = true;
        try {
            const statuses = {};
            const active = this.active;
            for (const {mode, key} of CAPTURE_SHORTCUTS) {
                const accelerator = this._settings.get_string(key);
                const previous = this.bindings.get(mode);
                if (!active || !accelerator) {
                    this._remove(mode);
                    continue;
                }
                if (previous?.accelerator === accelerator) {
                    continue;
                }
                let action = Meta.KeyBindingAction.NONE;
                if (usableShortcut(accelerator)) {
                    try {
                        action = global.display.grab_accelerator(accelerator, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT);
                    } catch {
                        // Invalid preferences must not prevent extension startup.
                    }
                }
                if (action === Meta.KeyBindingAction.NONE) {
                    statuses[mode] = 'Unavailable or already used by another system shortcut';
                    if (previous || changedKey === key)
                        this._settings.set_string(key, previous?.accelerator ?? '');
                    continue;
                }
                const name = Meta.external_binding_name_for_action(action);
                // Keep the old assignment until the new combination is reserved.
                this._remove(mode);
                this.bindings.set(mode, {action, name, accelerator});
                Main.wm.allowKeybinding(name, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
            }
            this._settings.set_value('shortcut-status', new GLib.Variant('a{ss}', statuses));
        } finally {
            this._syncing = false;
        }
    }

    destroy() {
        for (const [object, id] of this._handlers)
            object.disconnect(id);
        this._handlers.length = 0;
        for (const mode of [...this.bindings.keys()])
            this._remove(mode);
        this._settings.set_value('shortcut-status', new GLib.Variant('a{ss}', {}));
        this._settings = null;
        this._capture = null;
        this._changed = null;
    }
}
