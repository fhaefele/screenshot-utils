import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'make_directory_async', 'make_directory_finish');

export async function ensureDirectory(directory, cancellable) {
    try {
        await directory.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable);
    } catch (error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return;
        const parent = directory.get_parent();
        if (!parent || !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw error;
        await ensureDirectory(parent, cancellable);
        await ensureDirectory(directory, cancellable);
    }
}

export function ensureSaveLocation(settings) {
    const stored = settings.get_string('save-location');
    let location = stored.trim();
    if (!location || settings.get_user_value('save-location') === null)
        location = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir();
    if (location !== stored)
        settings.set_string('save-location', location);
    return location;
}

export function getSavePath(settings) {
    const expanded = ensureSaveLocation(settings).replace(/^~(?=\/|$)/, GLib.get_home_dir());
    return GLib.path_is_absolute(expanded)
        ? expanded
        : GLib.build_filenamev([GLib.get_home_dir(), expanded]);
}
