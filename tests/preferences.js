import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function descendants(widget) {
    const result = [widget];
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        result.push(...descendants(child));
    return result;
}

Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();
imports.package.init({name: 'gnome-shell', prefix: '/usr', libdir: '/usr/lib'});
const path = ARGV[0];
const dir = Gio.File.new_for_path(path);
const [, contents] = dir.get_child('metadata.json').load_contents(null);
const metadata = JSON.parse(new TextDecoder().decode(contents));
const {default: Preferences} = await import(dir.get_child('prefs.js').get_uri());
const {buildFilename} = await import(dir.get_child('filename.js').get_uri());
Adw.init();
const preferences = new Preferences({...metadata, dir, path});
const settings = preferences.getSettings();
const previousFolder = settings.get_string('save-location');
const previousTemplate = settings.get_string('filename-template');
const previousDelay = settings.get_int('capture-delay-ms');
const window = new Adw.PreferencesWindow();

try {
    preferences.fillPreferencesWindow(window);
    const widgets = descendants(window);
    assert(widgets.filter(widget => widget instanceof Adw.SwitchRow).length === 4,
        'Preferences contain an obsolete capture switch');
    const folder = widgets.find(widget => widget instanceof Adw.EntryRow && widget.title === 'Screenshot folder');
    const template = widgets.find(widget => widget instanceof Adw.EntryRow && widget.title === 'Filename template');
    const preview = widgets.find(widget => widget instanceof Gtk.Label && widget.label.startsWith('Preview: '));
    assert(folder?.text === previousFolder && folder.text.trim(), 'Folder was not prefilled with the saved path');
    folder.text = '';
    folder.emit('apply');
    assert(folder.text === previousFolder && settings.get_string('save-location') === previousFolder,
        'Empty folder was saved');
    folder.text = '~/Screenshot-test';
    folder.emit('apply');
    assert(settings.get_string('save-location') === '~/Screenshot-test', 'New folder was not applied');
    assert(!widgets.some(widget => widget instanceof Adw.ActionRow && widget.title.startsWith('Tokens:')),
        'Token note is still a preferences row');
    template.text = 'Test-{Y}-{m}-{d}-{N}';
    assert(preview?.label === `Preview: ${buildFilename(template.text, new Date(), 'screen')}`,
        'Filename preview did not expand the edited template');
    const delay = widgets.find(widget => widget instanceof Adw.EntryRow && widget.title === 'Delay (seconds)');
    delay.text = '0.125';
    delay.emit('apply');
    assert(settings.get_int('capture-delay-ms') === 125, 'Preferences did not save a subsecond delay');
    assert(delay.text === '0.125 s', 'Preferences did not display seconds');
    for (const milliseconds of [100, 200, 500]) {
        settings.set_int('capture-delay-ms', milliseconds);
        assert(delay.text === `${milliseconds / 1000} s`, 'Preferences did not display a subsecond delay in seconds');
    }
    settings.set_int('capture-delay-ms', 2500);
    assert(delay.text === '2.5 s', 'Preferences did not reflect an external delay change');
    for (const invalid of ['', '31', '100 ms']) {
        delay.text = invalid;
        delay.emit('apply');
        assert(settings.get_int('capture-delay-ms') === 2500 && delay.text === '2.5 s',
            'Preferences accepted invalid seconds');
    }

    const unchangedPreview = preview.label;
    const loop = new GLib.MainLoop(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1100, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
    assert(preview.label === unchangedPreview, 'Preview refreshed without a template edit');
    print('PASS: GTK folder validation, token note, event-driven filename preview and exact delays');
} finally {
    settings.set_string('save-location', previousFolder);
    settings.set_string('filename-template', previousTemplate);
    settings.set_int('capture-delay-ms', previousDelay);
    window.close();
}
