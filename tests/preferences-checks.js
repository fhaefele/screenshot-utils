import {buildFilename} from '../filename.js';
import {releaseCacheFile} from '../prefs-release.js';
import {callAsync} from '../async-utils.js';
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

function toggleControl(row) {
    return Adw.SwitchRow ? row : descendants(row).find(widget => widget instanceof Gtk.Switch);
}

function clipboardText(window) {
    return new Promise((resolve, reject) => window.get_clipboard().read_text_async(null,
        (clipboard, result) => {
            try {
                resolve(clipboard.read_text_finish(result));
            } catch (error) {
                reject(error);
            }
        }));
}

async function waitUntil(condition, message) {
    const deadline = GLib.get_monotonic_time() + 10_000_000;
    while (!condition()) {
        assert(GLib.get_monotonic_time() < deadline, message);
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
    }
}

function folderChoosers() {
    const windows = Gtk.Window.get_toplevels();
    return Array.from({length: windows.get_n_items()}, (_, index) => windows.get_item(index))
        .filter(window => window instanceof Gtk.FileChooserDialog && window.visible);
}

export async function checkPreferences(preferences) {
    const settings = preferences.getSettings();
    const previousFolder = settings.get_string('save-location');
    const previousTemplate = settings.get_string('filename-template');
    const previousDelay = settings.get_int('capture-delay-ms');
    const previousCommands = settings.get_boolean('shortcuts-enabled');
    const previousSetup = settings.get_string('shortcut-setup');
    const previousAsk = settings.get_boolean('ask-command-confirmation');
    settings.set_string('shortcut-setup', '');
    settings.set_boolean('shortcuts-enabled', false);
    settings.set_boolean('ask-command-confirmation', true);
    const cache = releaseCacheFile(preferences.metadata.uuid);
    const cacheExisted = cache.query_exists(null);
    const previousCache = cacheExisted ? cache.load_contents(null)[1] : null;
    GLib.mkdir_with_parents(cache.get_parent().get_path(), 0o700);
    const fakeRelease = {tag: 'v999.0', shellVersions: Array.from({length: 10}, (_, index) => String(42 + index))};
    await callAsync(cache, 'replace_contents_bytes_async', new GLib.Bytes(JSON.stringify({checkedAt: Date.now(), release: fakeRelease})),
        null, false, Gio.FileCreateFlags.PRIVATE, null);
    const window = new Adw.PreferencesWindow();

    try {
        preferences.fillPreferencesWindow(window);
        const widgets = descendants(window);
        assert(widgets.some(widget => widget instanceof Gtk.Label &&
            widget.label === `Screenshot Utils v${preferences.metadata['version-name']}`), 'Installed release footer is missing');
        const github = widgets.find(widget => widget instanceof Gtk.Label && widget.get_text() === 'fhaefele/screenshot-utils');
        assert(github?.use_markup && github.label.includes('href="https://github.com/fhaefele/screenshot-utils"'),
            'Repository footer is not a native text link');
        const mark = widgets.find(widget => widget instanceof Gtk.Image && widget.gicon instanceof Gio.FileIcon &&
            widget.gicon.get_file().get_basename() === 'github-symbolic.svg' && widget.pixel_size === 16);
        assert(mark?.get_parent() === github.get_parent(), 'GitHub mark is not grouped with the repository link');
        const release = widgets.find(widget => widget instanceof Gtk.Label && widget.get_text().startsWith('latest:'));
        await waitUntil(() => release?.visible, 'Cached release notice did not appear');
        assert(release.use_markup && release.get_text() === 'latest: v999.0' &&
            release.label.includes('href="https://github.com/fhaefele/screenshot-utils/releases/tag/v999.0"'),
            'Latest release is not a native text link to the matching release');
        const footer = github.get_parent().get_parent();
        assert(footer === release.get_parent() && footer.orientation === Gtk.Orientation.HORIZONTAL &&
            footer.halign === Gtk.Align.CENTER, 'Release footer is not a single centered line');
        assert(!widgets.some(widget => widget instanceof Gtk.Button && widget.label === 'Update'),
            'Preferences unexpectedly contain an installer button');
        assert(widgets.filter(widget => Adw.SwitchRow ? widget instanceof Adw.SwitchRow : widget instanceof Gtk.Switch).length === 6,
            'Preferences contain an obsolete capture switch');
        const folder = widgets.find(widget => typeof widget.get_text === 'function' && widget.title === 'Screenshot folder');
        const template = widgets.find(widget => typeof widget.get_text === 'function' && widget.title === 'Filename template');
        const preview = widgets.find(widget => widget instanceof Gtk.Label && widget.label.startsWith('Preview: '));
        assert(folder?.text === previousFolder && folder.text.trim(), 'Folder was not prefilled with the saved path');
        const browse = descendants(folder).find(widget => widget instanceof Gtk.Button && widget.label === 'Browse…');
        window.present();
        await waitUntil(() => window.get_mapped(), 'Preferences did not open');
        assert(window.get_focus() === browse, 'Opening preferences focused an editable field');
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
        const delay = widgets.find(widget => typeof widget.get_text === 'function' && widget.title === 'Delay (seconds)');
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

        const shortcuts = widgets.find(widget => widget instanceof Adw.PreferencesGroup &&
            widget.title === 'Keyboard shortcuts');
        assert(shortcuts, 'Keyboard shortcut instructions are missing');
        const shortcutWidgets = descendants(shortcuts);
        const enableShortcuts = shortcutWidgets.find(widget => widget instanceof Adw.ActionRow &&
            widget.title === 'Enable keyboard shortcuts');
        const commandSwitch = toggleControl(enableShortcuts);
        assert(!shortcutWidgets.some(widget => widget instanceof Adw.ComboRow && widget.title === 'Source'),
            'Removed shortcut source selector is still present');
        assert(!commandSwitch.active, 'Shortcut commands were enabled by default');
        commandSwitch.active = true;
        assert(settings.get_boolean('shortcuts-enabled'), 'Master switch did not enable commands');
        const commandRows = shortcutWidgets.find(widget => widget instanceof Gtk.ListBox &&
            widget.get_first_child()?.title === 'Selection');
        assert(commandRows, 'Screenshot command rows are missing');
        const toasts = [];
        const originalAddToast = window.add_toast;
        window.add_toast = toast => {
            toasts.push(toast.title);
            originalAddToast.call(window, toast);
        };
        for (const [mode, title, icon] of [
            ['selection', 'Selection', 'screenshot-ui-area-symbolic'],
            ['screen', 'Screen', 'screenshot-ui-display-symbolic'],
            ['window', 'Window', 'screenshot-ui-window-symbolic'],
        ]) {
            const row = shortcutWidgets.find(widget => widget instanceof Adw.PreferencesRow && widget.title === title);
            const expectedCommand = `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/shell/extensions/screenshotutils --method dev.fxth.ScreenshotUtils.Capture ${mode}`;
            assert(row, `${title} command row is missing`);
            const rowWidgets = descendants(row);
            const commandField = rowWidgets.find(widget => widget instanceof Gtk.Entry);
            assert(commandField?.text === expectedCommand && !commandField.editable && !commandField.has_frame,
                `${title} command is not a read-only single-line text field`);
            assert(rowWidgets.some(widget => widget instanceof Gtk.Image && widget.gicon instanceof Gio.FileIcon &&
                widget.gicon.get_file().get_uri() === `resource:///org/gnome/shell/icons/scalable/actions/${icon}.svg` &&
                widget.pixel_size === 28), `${title} capture icon is missing`);
            const copy = rowWidgets.find(widget => widget instanceof Gtk.Button && widget.icon_name === 'edit-copy-symbolic');
            assert(copy?.get_child().pixel_size === 16, `${title} command has no small standard copy icon`);
            copy.emit('clicked');
            assert(await clipboardText(window) === expectedCommand,
                `${title} Copy button put the wrong command on the clipboard`);
            assert(toasts.at(-1) === 'Command copied', 'Copy button did not show confirmation');
            commandField.select_region(0, -1);
            commandField.get_delegate().emit('copy-clipboard');
            assert(await clipboardText(window) === expectedCommand,
                `${title} text selection did not copy the complete command`);
        }
        const openKeyboardSettings = shortcutWidgets.find(widget => widget instanceof Gtk.Button &&
            widget.label === 'Keyboard settings');
        assert(openKeyboardSettings, 'Keyboard settings button is missing');
        const originalCreateApp = Gio.AppInfo.create_from_commandline;
        try {
            let launched = false;
            Gio.AppInfo.create_from_commandline = (command, _name, flags) => {
                assert(command === 'gnome-control-center keyboard', 'Wrong Keyboard settings command');
                assert(flags === Gio.AppInfoCreateFlags.SUPPORTS_STARTUP_NOTIFICATION,
                    'Keyboard settings launch has no activation context');
                return {launch: (files, context) => { launched = files.length === 0 && context !== null; }};
            };
            openKeyboardSettings.emit('clicked');
            assert(launched, 'Keyboard settings button did not launch the panel');
            Gio.AppInfo.create_from_commandline = () => { throw new Error('Keyboard settings unavailable in test'); };
            openKeyboardSettings.emit('clicked');
            assert(toasts.at(-1) === 'Could not open keyboard settings', 'Launch failure has no feedback');
        } finally {
            Gio.AppInfo.create_from_commandline = originalCreateApp;
            window.add_toast = originalAddToast;
        }
        print('PASS: GTK shortcut commands copied to clipboard, confirmations and Keyboard settings launch');

        const permissionRow = shortcutWidgets.find(widget => widget instanceof Adw.ActionRow && widget.title === 'Ask for every request');
        const permission = toggleControl(permissionRow);
        assert(!shortcutWidgets.some(widget => widget instanceof Gtk.Label &&
            (widget.name === 'command-approval-scope' || widget.label.startsWith('Current setting:'))),
        'Preferences retained approval scope text');
        assert(permission.active && permissionRow.subtitle.includes('any local application') &&
            permissionRow.subtitle.includes('by invoking the commands below'), 'Command confirmation switch has no explanation');
        const instructions = shortcutWidgets.find(widget => widget instanceof Gtk.Label &&
            widget.label === 'Keyboard settings → View and customize shortcuts → Custom shortcuts → Add.');
        assert(instructions && instructions.get_parent() === commandRows.get_parent() &&
            instructions.get_next_sibling() === commandRows, 'Keyboard instructions are not grouped with the command rows');
        for (const ask of [false, true, false, true]) {
            permission.active = ask;
            assert(settings.get_boolean('ask-command-confirmation') === ask && permission.sensitive,
                'Ask toggle did not save immediately');
        }
        settings.set_boolean('ask-command-confirmation', false);
        assert(!permission.active, 'Ask toggle did not reflect an external settings change');
        commandSwitch.active = false;
        assert(!commandRows.get_parent().get_parent().visible, 'Disabled commands remained visible');
        commandSwitch.active = true;
        assert(commandRows.get_parent().get_parent().visible && !permission.active,
            'Master switch changed the saved Ask choice');
        assert(!shortcutWidgets.some(widget => widget instanceof Adw.PreferencesRow &&
            widget.title === 'Selection shortcut'), 'Removed shortcut recorder is still present');
        settings.set_boolean('shortcuts-enabled', previousCommands);
        print('PASS: GTK command master switch and persistent Ask toggle');

        const unchangedPreview = preview.label;
        const loop = new GLib.MainLoop(null, false);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1100, () => {
            loop.quit();
            return GLib.SOURCE_REMOVE;
        });
        loop.run();
        assert(preview.label === unchangedPreview, 'Preview refreshed without a template edit');
        print('PASS: GTK folder validation, token note, event-driven filename preview and exact delays');

        assert(browse?.tooltip_text === 'Choose screenshot folder', 'Folder Browse button is missing');
        const root = Gio.File.new_for_path(GLib.dir_make_tmp('screenshot-utils-folder-picker-XXXXXX'));
        const chosen = root.get_child('Screenshots ü folder ');
        chosen.make_directory(null);
        const originalFileDialog = Gtk.FileDialog;
        try {
            window.present();
            for (const FileDialog of originalFileDialog ? [originalFileDialog, undefined] : [undefined]) {
                Gtk.FileDialog = FileDialog;
                settings.set_string('save-location', root.get_path());
                browse.emit('clicked');
                browse.emit('clicked');
                assert(!browse.sensitive, 'Browse allowed overlapping folder requests');
                await waitUntil(() => folderChoosers().length === 1, 'Standard folder chooser did not open');
                const chooser = folderChoosers()[0];
                assert(chooser.get_transient_for() === window && chooser.modal &&
                    chooser.get_action() === Gtk.FileChooserAction.SELECT_FOLDER,
                'Folder chooser is not modal and attached to preferences');
                await waitUntil(() => chooser.get_current_folder()?.equal(root), 'Chooser did not start at saved folder');
                // Navigate into the folder: set_file() can race the initial
                // directory model load and lose its pending row selection.
                chooser.set_current_folder(chosen);
                await waitUntil(() => chooser.get_current_folder()?.equal(chosen) && chooser.get_file()?.equal(chosen),
                    'Chooser did not select the requested folder');
                chooser.response(Gtk.ResponseType.ACCEPT);
                await waitUntil(() => browse.sensitive, 'Folder selection did not finish');
                assert(settings.get_string('save-location') === chosen.get_path() && folder.text === chosen.get_path(),
                    'Selected folder was not saved and displayed without URI escaping');

                browse.emit('clicked');
                await waitUntil(() => folderChoosers().length === 1, 'Cancel chooser did not open');
                folderChoosers()[0].response(Gtk.ResponseType.CANCEL);
                await waitUntil(() => browse.sensitive && folderChoosers().length === 0, 'Cancelled chooser did not close');
                assert(settings.get_string('save-location') === chosen.get_path() && folder.text === chosen.get_path(),
                    'Cancel changed the screenshot folder');
                print(`PASS: ${FileDialog ? 'FileDialog' : 'FileChooserNative'} selection, trailing spaces, initial folder and cancellation`);
            }
            Gtk.FileDialog = originalFileDialog;
            browse.emit('clicked');
            await waitUntil(() => folderChoosers().length === 1, 'Close-request chooser did not open');
            window.close();
            await waitUntil(() => folderChoosers().length === 0, 'Closing preferences left a chooser open');
            assert(settings.get_string('save-location') === chosen.get_path(), 'Closing preferences changed the screenshot folder');
            print('PASS: folder picker closes with preferences');
        } finally {
            Gtk.FileDialog = originalFileDialog;
            chosen.delete(null);
            root.delete(null);
        }
    } finally {
        settings.set_string('save-location', previousFolder);
        settings.set_string('filename-template', previousTemplate);
        settings.set_int('capture-delay-ms', previousDelay);
        settings.set_boolean('shortcuts-enabled', previousCommands);
        settings.set_boolean('ask-command-confirmation', previousAsk);
        settings.set_string('shortcut-setup', previousSetup);
        window.close();
        if (cacheExisted)
            cache.replace_contents(previousCache, null, false, Gio.FileCreateFlags.PRIVATE, null);
        else
            cache.delete(null);
    }

}
