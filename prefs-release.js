// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';
import {PACKAGE_VERSION} from 'resource:///org/gnome/Shell/Extensions/js/misc/config.js';
import {callAsync} from './async-utils.js';
import {checkRelease, REPOSITORY_URL} from './release-info.js';

export function releaseCacheFile(uuid) {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), uuid, 'github-release.json']));
}

async function fetchJSON(session, url, cancellable) {
    const message = Soup.Message.new('GET', url);
    const stream = await callAsync(session, 'send_async', message, GLib.PRIORITY_DEFAULT, cancellable);
    try {
        if (message.status_code !== Soup.Status.OK)
            throw new Error(`Release check returned HTTP ${message.status_code}`);
        const body = new Uint8Array(256 * 1024);
        let length = 0;
        while (true) {
            const bytes = await callAsync(stream, 'read_bytes_async', 8192, GLib.PRIORITY_DEFAULT, cancellable);
            const data = bytes.get_data();
            if (!data.length)
                break;
            if (length + data.length > body.length)
                throw new Error('Release response exceeds 256 KiB');
            body.set(data, length);
            length += data.length;
        }
        return JSON.parse(new TextDecoder().decode(body.subarray(0, length)));
    } finally {
        await callAsync(stream, 'close_async', GLib.PRIORITY_DEFAULT, null);
    }
}

export function addReleaseFooter(page, metadata) {
    const group = new Adw.PreferencesGroup();
    const footer = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2, halign: Gtk.Align.CENTER});
    const details = new Gtk.Box({spacing: 6, halign: Gtk.Align.CENTER});
    details.append(new Gtk.Label({label: `Screenshot Utils v${metadata['version-name']}`,
        css_classes: ['dim-label', 'caption']}));
    details.append(new Gtk.Label({label: '·', css_classes: ['dim-label', 'caption']}));
    const github = new Gtk.LinkButton({label: 'GitHub', uri: REPOSITORY_URL});
    github.add_css_class('caption');
    details.append(github);
    footer.append(details);
    const available = new Gtk.LinkButton({label: 'New release available', visible: false, halign: Gtk.Align.CENTER});
    available.add_css_class('caption');
    footer.append(available);
    group.add(footer);
    page.add(group);

    const cancellable = new Gio.Cancellable();
    const cacheFile = releaseCacheFile(metadata.uuid);
    let session = null;
    checkRelease({
        uuid: metadata.uuid, installed: metadata['version-name'], shellVersion: PACKAGE_VERSION,
        cancelled: () => cancellable.is_cancelled(),
        load: async () => {
            try {
                const [contents] = await callAsync(cacheFile, 'load_contents_async', cancellable);
                return new TextDecoder().decode(contents);
            } catch (error) {
                if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    return '';
                throw error;
            }
        },
        save: async cache => {
            GLib.mkdir_with_parents(cacheFile.get_parent().get_path(), 0o700);
            await callAsync(cacheFile, 'replace_contents_async', new TextEncoder().encode(JSON.stringify(cache)),
                null, false, Gio.FileCreateFlags.PRIVATE, cancellable);
        },
        fetchJSON: url => {
            session ??= new Soup.Session({timeout: 10, user_agent: 'ScreenshotUtils release check'});
            return fetchJSON(session, url, cancellable);
        },
        onResult: uri => {
            if (uri)
                available.uri = uri;
            available.visible = uri !== null;
        },
    }).catch(() => {
        // Offline, cache and cancellation errors must not interrupt preferences.
    }).finally(() => session?.abort());
    return () => {
        cancellable.cancel();
        session?.abort();
    };
}
