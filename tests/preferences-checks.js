import {buildFilename} from '../filename.js';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';

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

// Use the real bus and Shell dialog here, separately from the widget checks.
export async function checkSessionApprovalPreferences(preferences) {
    const settings = preferences.getSettings();
    const previousDelay = settings.get_int('capture-delay-ms');
    const window = new Adw.PreferencesWindow();
    try {
        preferences.fillPreferencesWindow(window);
        window.present();
        const widgets = descendants(window);
        const permission = widgets.find(widget => widget instanceof Adw.ComboRow && widget.title === 'Command permission');
        const approve = widgets.find(widget => widget instanceof Gtk.Button && widget.label === 'Approve command access');
        permission.selected = 1;
        await waitUntil(() => approve.label === 'Command access approved', 'Actual permission choice did not receive Shell approval');
        assert(!approve.sensitive, 'Approved permission still offers redundant approval');
        // Coordinate a runtime stop/start with the Shell integration process.
        settings.set_int('capture-delay-ms', 124);
        await waitUntil(() => approve.label === 'Approve command access' &&
            widgets.some(widget => widget instanceof Gtk.Label && widget.label === 'Extension disabled'),
        'Open preferences did not report the stopped extension');
        settings.set_int('capture-delay-ms', 125);
        await waitUntil(() => approve.label === 'Command access approved',
            'Open preferences did not restore persisted approval after runtime restart');
        settings.set_boolean('ask-command-confirmation', true);
        await waitUntil(() => permission.selected === 0 && !approve.visible && approve.label === 'Approve command access',
            'Actual approval revocation did not update preferences');
        print('PASS: actual preferences permission, Shell dialog and live approval across runtime restart/revocation');
    } finally {
        window.close();
        settings.set_int('capture-delay-ms', previousDelay);
        settings.set_boolean('ask-command-confirmation', true);
    }
}

export async function checkPreferences(preferences) {
    const settings = preferences.getSettings();
    const previousFolder = settings.get_string('save-location');
    const previousTemplate = settings.get_string('filename-template');
    const previousDelay = settings.get_int('capture-delay-ms');
    const previousCommands = settings.get_boolean('shortcuts-enabled');
    const previousSetup = settings.get_string('shortcut-setup');
    const previousAsk = settings.get_boolean('ask-command-confirmation');
    const previousBindings = ['shortcut-selection', 'shortcut-screen', 'shortcut-window']
        .map(key => [key, settings.get_string(key)]);
    settings.set_string('shortcut-setup', '');
    settings.set_boolean('shortcuts-enabled', false);
    settings.set_boolean('ask-command-confirmation', true);
    const window = new Adw.PreferencesWindow();

    try {
        preferences.fillPreferencesWindow(window);
        const widgets = descendants(window);
        assert(widgets.filter(widget => Adw.SwitchRow ? widget instanceof Adw.SwitchRow : widget instanceof Gtk.Switch).length === 5,
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
            widget.title === 'Keyboard Shortcuts');
        assert(shortcuts, 'Keyboard shortcut instructions are missing');
        const shortcutWidgets = descendants(shortcuts);
        const enableShortcuts = shortcutWidgets.find(widget => widget instanceof Adw.ActionRow &&
            widget.title === 'Enable screenshot shortcuts');
        const commandSwitch = Adw.SwitchRow ? enableShortcuts : descendants(enableShortcuts).find(widget => widget instanceof Gtk.Switch);
        const setup = shortcutWidgets.find(widget => widget instanceof Adw.ComboRow && widget.title === 'Shortcut source');
        assert(!commandSwitch.active && !setup.visible && setup.selected === 0,
            'Disabled shortcuts showed or preselected a source');
        commandSwitch.active = true;
        assert(settings.get_boolean('shortcuts-enabled') && setup.visible && setup.selected === 0,
            'Master switch did not reveal explicit source selection');
        setup.selected = 1;
        assert(settings.get_string('shortcut-setup') === 'gnome', 'GNOME source choice was not saved');
        const instructions = shortcutWidgets.find(widget => widget instanceof Gtk.Label &&
            widget.label.startsWith('Keyboard Settings →'));
        assert(instructions && !instructions.has_css_class('caption') && !instructions.has_css_class('dim-label'),
            'Keyboard shortcut instructions are missing or styled as a small note');
        const commandRows = instructions.get_next_sibling();
        assert(instructions.get_parent().get_first_child() === instructions && commandRows instanceof Gtk.ListBox,
            'Keyboard shortcut instructions are not directly above the commands');
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
            widget.label === 'Keyboard Settings');
        assert(openKeyboardSettings, 'Keyboard Settings button is missing');
        const originalCreateApp = Gio.AppInfo.create_from_commandline;
        try {
            let launched = false;
            Gio.AppInfo.create_from_commandline = (command, _name, flags) => {
                assert(command === 'gnome-control-center keyboard', 'Wrong Keyboard Settings command');
                assert(flags === Gio.AppInfoCreateFlags.SUPPORTS_STARTUP_NOTIFICATION,
                    'Keyboard Settings launch has no activation context');
                return {launch: (files, context) => { launched = files.length === 0 && context !== null; }};
            };
            openKeyboardSettings.emit('clicked');
            assert(launched, 'Keyboard Settings button did not launch the panel');
            Gio.AppInfo.create_from_commandline = () => { throw new Error('Keyboard Settings unavailable in test'); };
            openKeyboardSettings.emit('clicked');
            assert(toasts.at(-1) === 'Could not open Keyboard Settings', 'Launch failure has no feedback');
        } finally {
            Gio.AppInfo.create_from_commandline = originalCreateApp;
            window.add_toast = originalAddToast;
        }
        print('PASS: GTK shortcut commands copied to clipboard, confirmations and Keyboard Settings launch');

        const permission = shortcutWidgets.find(widget => widget instanceof Adw.ComboRow && widget.title === 'Command permission');
        const approve = shortcutWidgets.find(widget => widget instanceof Gtk.Button && widget.label === 'Approve command access');
        assert(shortcutWidgets.some(widget => widget instanceof Gtk.Label && widget.label.includes('Any local application') &&
            widget.label.includes('persists across logins')), 'Persistent command access has no scope disclosure');
        const bus = Gio.DBus.session;
        const originalCall = bus.call;
        const originalFinish = bus.call_finish;
        try {
            let approvals = 0;
            bus.call = (destination, path, iface, method, _parameters, _replyType, _flags, _timeout, _cancellable, callback) => {
                assert(destination === 'org.gnome.Shell' && path === '/org/gnome/shell/extensions/screenshotutils' &&
                    iface === 'dev.fxth.ScreenshotUtils' && method === 'ApproveSilentCommands', 'Wrong session approval request');
                approvals++;
                callback(bus, null);
            };
            bus.call_finish = () => new GLib.Variant('()', []);
            commandSwitch.active = true;
            permission.selected = 1;
            await waitUntil(() => approvals >= 1 && approve.sensitive, 'Approval request did not finish');
            assert(!settings.get_boolean('ask-command-confirmation') && approvals === 1 && approve.visible,
                `Silent permission request mismatch: requests=${approvals}, asking=${settings.get_boolean('ask-command-confirmation')}, visible=${approve.visible}`);
            approve.emit('clicked');
            await waitUntil(() => approvals >= 2 && approve.sensitive, 'Command reapproval did not finish');
            assert(approvals === 2, 'Session reapproval button did not request approval');
            settings.set_boolean('ask-command-confirmation', true);
            assert(permission.selected === 0 && !approve.visible, 'Confirmation preference did not sync');
        } finally {
            bus.call = originalCall;
            bus.call_finish = originalFinish;
        }
        setup.selected = 2;
        assert(settings.get_string('shortcut-setup') === 'extension' && !instructions.get_parent().get_parent().visible,
            'Extension setup did not hide command instructions');
        const selectionShortcut = shortcutWidgets.find(widget => widget instanceof Adw.ActionRow && widget.title === 'Selection shortcut');
        const shortcutButtons = descendants(selectionShortcut).filter(widget => widget instanceof Gtk.Button);
        const setShortcut = shortcutButtons.find(widget => !widget.icon_name);
        const clearShortcut = shortcutButtons.find(widget => widget.icon_name === 'edit-clear-symbolic');
        setShortcut.emit('clicked');
        const recorder = Array.from({length: Gtk.Window.get_toplevels().get_n_items()}, (_, index) =>
            Gtk.Window.get_toplevels().get_item(index)).find(candidate => candidate.title === 'Set selection shortcut');
        assert(recorder?.modal && recorder.transient_for === window, 'Shortcut recorder is not modal');
        const controllers = recorder.observe_controllers();
        const keyController = Array.from({length: controllers.get_n_items()}, (_, index) => controllers.get_item(index))
            .find(controller => controller instanceof Gtk.EventControllerKey);
        keyController.emit('key-pressed', Gdk.KEY_F11, 95, Gdk.ModifierType.CONTROL_MASK);
        keyController.emit('key-pressed', Gdk.KEY_Return, 36, 0);
        assert(settings.get_string('shortcut-selection') === '<Control>F11', 'Recorder did not save captured keys');
        assert(!shortcutWidgets.some(widget => widget instanceof Gtk.Button && widget.label?.includes('Activate shortcuts')) &&
            !permission.get_parent().get_parent().visible, 'Native mode exposed command permission or approval controls');
        clearShortcut.emit('clicked');
        assert(settings.get_string('shortcut-selection') === '' && !clearShortcut.sensitive, 'Clear did not remove the shortcut');
        setShortcut.emit('clicked');
        const cancelledRecorder = Array.from({length: Gtk.Window.get_toplevels().get_n_items()}, (_, index) =>
            Gtk.Window.get_toplevels().get_item(index)).find(candidate => candidate.title === 'Set selection shortcut');
        const cancelledControllers = cancelledRecorder.observe_controllers();
        const cancelledKeys = Array.from({length: cancelledControllers.get_n_items()}, (_, index) => cancelledControllers.get_item(index))
            .find(controller => controller instanceof Gtk.EventControllerKey);
        cancelledKeys.emit('key-pressed', Gdk.KEY_F12, 96, Gdk.ModifierType.CONTROL_MASK);
        descendants(cancelledRecorder).find(widget => widget instanceof Gtk.Button && widget.label === 'Cancel').grab_focus();
        cancelledKeys.emit('key-pressed', Gdk.KEY_Return, 36, 0);
        assert(settings.get_string('shortcut-selection') === '', 'Keyboard Cancel saved a shortcut');
        setup.selected = 1;
        assert(instructions.get_parent().get_parent().visible, 'GNOME setup did not restore command instructions');
        settings.set_boolean('shortcuts-enabled', previousCommands);
        print('PASS: GTK master switch, source choice, persistent command approval and direct native key setup');

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
        for (const [key, value] of previousBindings)
            settings.set_string(key, value);
        window.close();
    }

}
