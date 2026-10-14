// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';

// The record belongs to this installation, so uninstall removes it even when
// GNOME retains extension settings. This follows the user's desktop-settings
// trust model; unrestricted programs running as the user can modify both.
export class ShortcutPermission {
    constructor(settings, directory) {
        this._settings = settings;
        this._file = directory.get_child('.command-approval');
        this._recordPresent = false;
        try {
            const [, contents] = this._file.load_contents(null);
            this._recordPresent = contents.length === 12 && new TextDecoder().decode(contents) === 'approved-v1\n';
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`Could not read screenshot command approval: ${error.message}`);
        }
        if (!this._recordPresent)
            settings.set_boolean('silent-command-approved', false);
    }

    get approved() {
        return this._recordPresent && this._settings.get_boolean('silent-command-approved');
    }

    grant() {
        this._file.replace_contents(new TextEncoder().encode('approved-v1\n'), null, false, Gio.FileCreateFlags.PRIVATE, null);
        this._recordPresent = true;
        this._settings.set_boolean('silent-command-approved', true);
    }

    revoke() {
        // Clear the setting first, so a failed file deletion stays revoked.
        this._recordPresent = false;
        this._settings.set_boolean('silent-command-approved', false);
        try {
            this._file.delete(null);
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`Could not remove screenshot command approval: ${error.message}`);
        }
    }

    destroy() {
        this._settings = this._file = null;
        this._recordPresent = false;
    }
}
