import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bundleLegacy} from './pack.js';

await mkdir('dist/tests/perf', {recursive: true});
await bundleLegacy('tests/shell.js', resolve('dist/tests/perf/screenshotUtils.js'), 'ScreenshotUtilsTests',
    {footer: 'var METRICS = {};\nfunction run() { return ScreenshotUtilsTests.run(); }\nfunction finish() {}'});
await bundleLegacy('tests/preferences-checks.js', resolve('dist/tests/preferences-legacy.js'), 'ScreenshotUtilsPreferencesChecks', {preamble: `
imports.gi.versions.Gtk = '4.0';
imports.gi.GLib.setenv('GTK_USE_PORTAL', '0', true);
imports.gi.GLib.setenv('ADW_DISABLE_PORTAL', '1', true);
if (imports.gi.Gtk.get_minor_version() >= 18)
    imports.gi.GLib.setenv('GDK_DEBUG', 'no-portals', true);
imports.gi.Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();
imports.searchPath.unshift('resource:///org/gnome/Shell/Extensions/js');
imports.gi.Adw.init();`, footer: `
const directory = imports.gi.Gio.File.new_for_path(ARGV[0]);
const [, contents] = directory.get_child('metadata.json').load_contents(null);
const metadata = JSON.parse(imports.byteArray.toString(contents));
imports.searchPath.unshift(directory.get_parent().get_path());
const Preferences = imports[metadata.uuid].prefs.ScreenshotUtilsPreferencesModule.default;
const preferences = new Preferences({metadata, dir: directory, path: directory.get_path()});
const loop = new imports.gi.GLib.MainLoop(null, false);
ScreenshotUtilsPreferencesChecks.checkPreferences(preferences).then(() => loop.quit(), error => {
    logError(error);
    imports.system.exit(1);
});
loop.run();`});
