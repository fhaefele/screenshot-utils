import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';

Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();
imports.package.init({name: 'gnome-shell', prefix: '/usr', libdir: '/usr/lib'});
const path = ARGV[0];
const dir = Gio.File.new_for_path(path);
const [, contents] = dir.get_child('metadata.json').load_contents(null);
const metadata = JSON.parse(new TextDecoder().decode(contents));
const {default: Preferences} = await import(dir.get_child('prefs.js').get_uri());
const {checkPreferences} = await import(Gio.File.new_for_path(`${GLib.getenv('PWD')}/tests/preferences-checks.js`).get_uri());
Adw.init();
const preferences = new Preferences({...metadata, dir, path});
await checkPreferences(preferences);
