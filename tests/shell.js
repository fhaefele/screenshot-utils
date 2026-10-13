import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureDirectory} from '../location.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const UUID = 'screenshot-utils@fxth.dev';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function waitUntil(condition, message) {
    const deadline = GLib.get_monotonic_time() + 5_000_000;
    while (!condition()) {
        assert(GLib.get_monotonic_time() < deadline, typeof message === 'function' ? message() : message);
        await Scripting.sleep(20);
    }
}

function checkPng(directory, name) {
    const file = directory.get_child(name);
    assert(file.query_exists(null), `Missing screenshot: ${name}`);
    const [, contents] = file.load_contents(null);
    assert(contents.length > 24 && contents[0] === 0x89 && contents[1] === 0x50 &&
        contents[2] === 0x4e && contents[3] === 0x47,
    `Invalid PNG: ${name}, ${contents.length} bytes, header ${Array.from(contents.slice(0, 8))}`);
    return contents;
}

function pixelDifferences(directory, firstName, secondName) {
    const first = GdkPixbuf.Pixbuf.new_from_file(directory.get_child(firstName).get_path());
    const second = GdkPixbuf.Pixbuf.new_from_file(directory.get_child(secondName).get_path());
    assert(first.width === second.width && first.height === second.height, 'Cursor changed capture dimensions');
    const firstPixels = new Uint8Array(first.get_pixels());
    const secondPixels = new Uint8Array(second.get_pixels());
    let changed = 0;
    for (let y = 0; y < first.height; y++) {
        for (let x = 0; x < first.width; x++) {
            const firstOffset = y * first.rowstride + x * first.n_channels;
            const secondOffset = y * second.rowstride + x * second.n_channels;
            if ([0, 1, 2].some(channel => firstPixels[firstOffset + channel] !== secondPixels[secondOffset + channel]))
                changed++;
        }
    }
    return {changed, width: first.width, height: first.height};
}

async function preview(name) {
    const path = GLib.getenv('SCREENSHOT_UTILS_TEST_PREVIEW_DIR');
    if (!path)
        return;
    const directory = Gio.File.new_for_path(path);
    try {
        directory.make_directory_with_parents(null);
    } catch (error) {
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw error;
    }
    const stream = directory.get_child(name).replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
    try {
        await new Shell.Screenshot().screenshot(false, stream);
    } finally {
        stream.close(null);
    }
}

async function movePointer(pointer, x, y) {
    // Initial virtual-device motion can race pointer warps in headless Mutter.
    for (let attempt = 0; attempt < 3; attempt++) {
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        await Scripting.sleep(30);
        const [actualX, actualY] = global.get_pointer();
        if (Math.abs(actualX - x) <= 1 && Math.abs(actualY - y) <= 1)
            return;
    }
    throw new Error('Virtual pointer did not reach ' + x + ',' + y + ': ' + global.get_pointer());
}

async function click(pointer, actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    await movePointer(pointer, x + width / 2, y + height / 2);
    await Scripting.sleep(30);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await Scripting.sleep(30);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await Scripting.sleep(30);
}

function requestCapture(mode) {
    return new Promise((resolve, reject) => Gio.DBus.session.call(
        'org.gnome.Shell', '/org/gnome/shell/extensions/screenshotutils', 'dev.fxth.ScreenshotUtils', 'Capture',
        new GLib.Variant('(s)', [mode]), null, Gio.DBusCallFlags.NONE, 5000, null,
        (connection, result) => {
            try {
                resolve(connection.call_finish(result));
            } catch (error) {
                reject(error);
            }
        }));
}

export async function run() {
    await waitUntil(() => Main.panel.statusArea[UUID], () => {
        const extension = Main.extensionManager.lookup(UUID);
        return `Extension did not enable: state=${extension?.state}, error=${extension?.error}, ` +
            `enabled=${global.settings.get_strv('enabled-extensions')}, disabled=${global.settings.get_boolean('disable-user-extensions')}`;
    });
    await waitUntil(() => !Main.layoutManager._startingUp, 'Shell startup did not finish');
    Main.overview.hide();
    await Scripting.sleep(300);
    Main.extensionManager.disableExtension(UUID);
    await waitUntil(() => !Main.panel.statusArea[UUID], 'Extension did not disable for sound checks');
    const player = global.display.get_sound_player();
    const soundCalls = [];
    const originalSounds = {};
    const soundSpies = {};
    for (const method of ['play_from_theme', 'play_from_file']) {
        originalSounds[method] = player[method];
        soundSpies[method] = (...args) => soundCalls.push({method, sound: args[0]});
        player[method] = soundSpies[method];
    }
    Main.extensionManager.enableExtension(UUID);
    await waitUntil(() => Main.panel.statusArea[UUID], 'Extension did not re-enable for sound checks');
    await waitUntil(() => Main.panel.statusArea[UUID].width > 0, 'Panel button was not allocated');
    Main.overview.hide();
    await Scripting.sleep(300);
    let extension = Main.panel.statusArea[UUID]._extension;
    const directory = Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_tmp_dir(), `screenshot-utils-test-${GLib.get_monotonic_time()}`,
    ]));
    directory.make_directory_with_parents(null);
    const settings = extension._settings;
    assert(settings.get_string('save-location').trim(), 'Default screenshot folder is empty');
    settings.set_string('save-location', '   ');
    assert(settings.get_string('save-location').trim(), 'Empty screenshot folder was accepted');
    settings.set_string('save-location', '~/Screenshots');
    assert(extension._getSaveDirectory().get_path() === GLib.build_filenamev([GLib.get_home_dir(), 'Screenshots']),
        'Home-relative screenshot folder was not expanded');
    settings.set_string('save-location', directory.get_path());
    settings.set_string('filename-template', 'Integration-{N}');
    settings.set_int('capture-delay-ms', 1000);
    settings.set_boolean('show-notifications', true);
    settings.set_boolean('copy-to-clipboard', true);
    const seat = (global.stage.context?.get_backend() ?? Clutter.get_default_backend()).get_default_seat();
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    // Initialize away from hot corners, then settle any startup overview transition.
    await movePointer(pointer, global.stage.width / 2, global.stage.height / 2);
    Main.overview.hide();
    await Scripting.waitLeisure();

    // D-Bus activation must use the test tool's isolated settings, just like Shell.
    const environment = Object.fromEntries([
        'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'GSETTINGS_BACKEND', 'WAYLAND_DISPLAY',
    ].map(name => [name, GLib.getenv(name)]).filter(([, value]) => value !== null));
    await new Promise((resolve, reject) => Gio.DBus.session.call(
        'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
        'UpdateActivationEnvironment', new GLib.Variant('(a{ss})', [environment]),
        null, Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
            try {
                connection.call_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        }));

    try {
        const button = Main.panel.statusArea[UUID];
        assert(!button._nativeUiButton, 'Redundant native screenshot UI button is present');
        await click(pointer, button);
        await Scripting.sleep(250);
        assert(button.menu.isOpen && button.menu.actor.visible, 'Panel menu did not remain open');
        await preview('menu-initial.png');
        const themeSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const originalScheme = themeSettings.get_string('color-scheme');
        const controls = [button._selectionButton, button._screenButton, button._windowButton,
            button._folderButton, button._preferencesButton];
        const sizes = controls.map(actor => actor.get_transformed_size());
        const luminance = color => 0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue;
        const supportsColorScheme = Number(Config.PACKAGE_VERSION.split('.')[0]) >= 48;
        try {
            for (const scheme of supportsColorScheme ? ['prefer-light', 'prefer-dark'] : ['native']) {
                if (supportsColorScheme)
                    themeSettings.set_string('color-scheme', scheme);
                await waitUntil(() => controls.every(actor => {
                    const node = actor.get_theme_node();
                    const foreground = luminance(node.get_foreground_color());
                    const background = luminance(node.get_background_color());
                    return supportsColorScheme
                        ? (scheme === 'prefer-light' ? foreground < background : foreground > background)
                        : Math.abs(foreground - background) > 40;
                }), `Capture buttons did not follow ${scheme}`);
                await Scripting.sleep(200);
                controls.forEach((actor, index) => {
                    const [width, height] = actor.get_transformed_size();
                    const iconSize = index < 3 ? 32 : 16;
                    const [iconWidth, iconHeight] = actor.child.get_transformed_size();
                    assert(Math.abs(iconWidth - iconSize) < 1 && Math.abs(iconHeight - iconSize) < 1,
                        `${actor.accessible_name} icon is clipped or resized: ${iconWidth}x${iconHeight}, expected ${iconSize}`);
                    assert(width >= iconSize + 6 && height >= iconSize + 6,
                        `${actor.accessible_name} button clips its icon`);
                    assert(actor.has_style_class_name('button'), 'Capture control does not use native button styling');
                    assert(Math.abs(width - sizes[index][0]) < 1 && Math.abs(height - sizes[index][1]) < 1,
                        'Switching color scheme changed capture control geometry');
                });
                await preview(`menu-${scheme}.png`);
            }
        } finally {
            themeSettings.set_string('color-scheme', originalScheme);
            await Scripting.sleep(200);
        }
        print('PASS: native capture/utility button contrast, supported color schemes and geometry');
        for (const value of [0.163, 0.463, 0.537, 0.663, 0.427]) {
            button._delaySlider.value = value;
            assert(Math.abs(button._delaySlider.value - value) < 0.001,
                'Saving a slider step snapped its handle');
        }
        const slider = button._delaySlider;
        const [sliderX, sliderY] = slider.get_transformed_position();
        const [sliderWidth, sliderHeight] = slider.get_transformed_size();
        assert(sliderWidth > button._delayLabel.get_transformed_size()[0] +
            slider.get_parent().get_children().find(actor => actor.visible && actor instanceof St.Icon).get_transformed_size()[0],
            `Delay controls leave too little room for the slider: slider=${sliderWidth}, ` +
            `label=${button._delayLabel.width}, row=${slider.get_parent().width}, menu=${button.menu.actor.width}`);
        await movePointer(pointer, sliderX + sliderWidth / 2, sliderY + sliderHeight / 2);
        await Scripting.sleep(30);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await Scripting.sleep(30);
        for (const value of [0.163, 0.237, 0.327, 0.463, 0.537, 0.663, 0.427]) {
            const radius = slider._handleRadius ?? slider.get_theme_node().get_length('-slider-handle-radius');
            await movePointer(pointer,
                sliderX + radius + (sliderWidth - 2 * radius) * value, sliderY + sliderHeight / 2);
            await Scripting.sleep(50);
            assert(Math.abs(slider.value - value) < 0.025, 'Slider handle did not follow mouse movement');
            assert(Math.abs(slider.get_transformed_size()[0] - sliderWidth) < 1,
                'Delay labels changed slider width while dragging');
        }
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await Scripting.sleep(30);
        const delayControls = slider.get_parent().get_children().filter(actor => actor.visible);
        assert(delayControls.length === 3 && delayControls[0] instanceof St.Icon &&
            delayControls[1] === button._delayLabel && delayControls[2] === slider,
        'Delay row should contain clock, time and slider');
        const savedDelay = settings.get_int('capture-delay-ms');
        for (const actor of delayControls.slice(0, 2)) {
            assert(!actor.reactive && !actor.can_focus, 'Clock and time must be read-only');
            await click(pointer, actor);
            await click(pointer, actor);
            assert(settings.get_int('capture-delay-ms') === savedDelay && button.menu.isOpen,
                'Clicking clock or time changed the delay or closed the menu');
        }
        print('PASS: smooth mouse dragging and non-clickable clock/time/slider layout');
        button._delaySlider.value = 0.6;
        assert(settings.get_int('capture-delay-ms') === 3000, 'Delay slider did not update settings');
        settings.set_int('capture-delay-ms', 1000);
        await Scripting.sleep(20);
        assert(Math.abs(button._delaySlider.value - 0.4) < 0.001 && button._delayTooltip.text === 'Screenshot delay: 1 s',
            'Preferences delay did not update the panel slider');
        for (const [actor, name] of [[button._folderButton, 'folder'],
            [button._preferencesButton, 'preferences'], [slider, 'delay']]) {
            const [x, y] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            await movePointer(pointer, x + width / 2, y + height / 2);
            const tooltip = actor.label_actor;
            await waitUntil(() => tooltip.visible && tooltip.opacity === 255, `Missing ${name} hover tooltip`);
            assert(tooltip.y >= y + height && tooltip.y > Main.panel.get_transformed_size()[1],
                `${name} tooltip overlaps the top bar or hovered control`);
            const siblings = Main.uiGroup.get_children();
            assert(siblings.indexOf(tooltip) > siblings.indexOf(button.menu.actor),
                `${name} tooltip is behind the menu`);
            await preview(`tooltip-${name}.png`);
        }
        print('PASS: visible hover tooltips');
        await preview('menu.png');
        const realOpenPreferences = extension.openPreferences;
        let preferencesOpened = false;
        extension.openPreferences = () => { preferencesOpened = true; };
        try {
            await click(pointer, button._preferencesButton);
            await waitUntil(() => preferencesOpened, 'Preferences button did not open preferences');
        } finally {
            extension.openPreferences = realOpenPreferences;
        }
        assert(!button.menu.isOpen, 'Preferences action left the menu open');
        assert([button._folderButton, button._preferencesButton, slider].every(actor => !actor.label_actor.visible),
            'A tooltip remained visible after closing the menu');
        print('PASS: icon menu, preferences action and delay slider synchronization');

        const nativeSound = Gio.File.new_for_path(`${global.datadir}/sounds/screen-capture.oga`);
        settings.set_boolean('mute-screenshot-sound', true);
        player.play_from_theme('screen-capture', 'Screenshot', null);
        player.play_from_file(nativeSound, 'Screenshot', null);
        assert(soundCalls.length === 0, 'Native screenshot sound was not muted');
        player.play_from_theme('bell', 'Bell', null);
        player.play_from_file(directory.get_child('screen-capture.oga'), 'Other sound', null);
        assert(soundCalls.length === 2, 'Muting affected unrelated sounds');
        settings.set_boolean('mute-screenshot-sound', false);
        player.play_from_theme('screen-capture', 'Screenshot', null);
        player.play_from_file(nativeSound, 'Screenshot', null);
        assert(soundCalls.length === 4, 'Unmuted native screenshot sound was blocked');
        soundCalls.length = 0;

        const startedAt = GLib.get_monotonic_time();
        await extension._capture('screen');
        assert(GLib.get_monotonic_time() - startedAt >= 1_000_000, 'Capture delay was too short');
        checkPng(directory, 'Integration-screen.png');
        assert(soundCalls.length === 1, 'Extension capture did not play exactly one sound');
        const nested = directory.get_child('missing').get_child('nested');
        settings.set_string('save-location', nested.get_path());
        settings.set_int('capture-delay-ms', 0);
        settings.set_boolean('mute-screenshot-sound', true);
        await extension._capture('screen');
        assert(soundCalls.length === 1, 'Muted extension capture played a sound');
        checkPng(nested, 'Integration-screen.png');
        nested.get_child('Integration-screen.png').delete(null);
        nested.delete(null);
        nested.get_parent().delete(null);
        settings.set_string('save-location', directory.get_path());
        settings.set_int('capture-delay-ms', 1000);
        settings.set_boolean('mute-screenshot-sound', false);
        const cancelled = new Gio.Cancellable();
        cancelled.cancel();
        let cancellationError = null;
        try {
            await ensureDirectory(nested, cancelled);
        } catch (error) {
            cancellationError = error;
        }
        assert(cancellationError?.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) &&
            !nested.get_parent().query_exists(null), 'Cancelled folder creation changed the filesystem');
        print('PASS: native and extension sound muting, nested folders and cancelled creation');
        assert(extension._notificationSource?.notifications.some(n => n.title === 'Screenshot saved'),
            'Successful capture notification was not shown');
        const clipboard = await new Promise(resolve => {
            St.Clipboard.get_default().get_content(St.ClipboardType.CLIPBOARD, 'image/png',
                (_clipboard, bytes) => resolve(bytes ? new Uint8Array(bytes.get_data()) : null));
        });
        assert(clipboard?.length > 24 && clipboard[0] === 0x89 && clipboard[1] === 0x50 &&
            clipboard[2] === 0x4e && clipboard[3] === 0x47,
        'Clipboard does not contain the captured PNG');
        print('PASS: delayed capture, notifications and clipboard');

        extension._notificationSource.destroy();
        assert(extension._notificationSource === null, 'Destroyed notification source remained cached');
        settings.set_int('capture-delay-ms', 0);
        const menu = Main.panel.statusArea[UUID].menu;
        await click(pointer, Main.panel.statusArea[UUID]);
        await Scripting.sleep(200);
        await extension._capture('screen');
        assert(!menu.isOpen && !menu.actor.visible, 'Capture menu remained visible');
        checkPng(directory, 'Integration-screen-2.png');
        assert(extension._notificationSource, 'Notification source was not recreated');
        print('PASS: menu closure, filename collision and notification recreation');
        extension._notificationSource.destroy();
        settings.set_boolean('show-notifications', false);
        settings.set_boolean('copy-to-clipboard', false);

        settings.set_int('capture-delay-ms', 125);
        assert(button._delayTooltip.text === 'Screenshot delay: 0.125 s' && settings.get_int('capture-delay-ms') === 125,
            'Panel synchronization rounded an exact preferences delay');
        const shortDelayStartedAt = GLib.get_monotonic_time();
        await extension._capture('screen');
        assert(GLib.get_monotonic_time() - shortDelayStartedAt >= 125_000,
            'Capture ignored its subsecond delay');
        checkPng(directory, 'Integration-screen-3.png');
        settings.set_int('capture-delay-ms', 0);
        print('PASS: subsecond delay and exact delay preservation');

        const lockdown = extension._lockdownSettings;
        const originalCreateUniqueFile = extension._createUniqueFile;
        settings.set_string('filename-template', 'Restricted-{N}');
        try {
            lockdown.set_boolean('disable-save-to-disk', true);
            await extension._capture('screen');
            assert(!directory.get_child('Restricted-screen.png').query_exists(null),
                'Panel capture ignored the system disk-saving restriction');
            for (const mode of ['selection', 'screen', 'window']) {
                const error = await requestCapture(mode).then(() => null, failure => failure);
                assert(Gio.DBusError.get_remote_error(error) === 'dev.fxth.ScreenshotUtils.Unavailable',
                    `${mode} command ignored the system disk-saving restriction`);
            }
            assert(!extension._selector && !extension._windowSession && !extension._busy,
                'Restricted command opened capture controls');
            lockdown.set_boolean('disable-save-to-disk', false);
            settings.set_int('capture-delay-ms', 200);
            const delayed = extension._capture('screen');
            await Scripting.sleep(50);
            lockdown.set_boolean('disable-save-to-disk', true);
            await delayed;
            assert(!directory.get_child('Restricted-screen.png').query_exists(null),
                'Delayed capture ignored a policy change');
            lockdown.set_boolean('disable-save-to-disk', false);
            settings.set_int('capture-delay-ms', 0);
            extension._createUniqueFile = async (...args) => {
                const output = await originalCreateUniqueFile.call(extension, ...args);
                lockdown.set_boolean('disable-save-to-disk', true);
                return output;
            };
            await extension._capture('screen');
            assert(!directory.get_child('Restricted-screen.png').query_exists(null),
                'Policy change left an incomplete screenshot file');
        } finally {
            extension._createUniqueFile = originalCreateUniqueFile;
            lockdown.set_boolean('disable-save-to-disk', false);
            settings.set_int('capture-delay-ms', 0);
            settings.set_string('filename-template', 'Integration-{N}');
        }
        print('PASS: disk-saving policy blocks panel/API captures, delayed saves and incomplete files');

        await Scripting.createTestWindow({width: 400, height: 300});
        await Scripting.createTestWindow({width: 600, height: 400});
        await Scripting.waitTestWindows();
        await waitUntil(() => global.get_window_actors().length >= 2, 'Test windows did not map');
        const nativeKeys = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        const originalPrint = nativeKeys.get_strv('show-screenshot-ui');
        for (const flag of ['isLocked', 'isGreeter']) {
            const original = Main.sessionMode[flag];
            try {
                Main.sessionMode[flag] = true;
                const error = await requestCapture('screen').then(() => null, failure => failure);
                assert(Gio.DBusError.get_remote_error(error) === 'dev.fxth.ScreenshotUtils.Unavailable',
                    `Capture API ignored ${flag}`);
            } finally {
                Main.sessionMode[flag] = original;
            }
        }
        const modal = new St.Widget({reactive: true});
        Main.uiGroup.add_child(modal);
        const grab = Main.pushModal(modal);
        try {
            assert(grab, 'Test could not grab modal input');
            const error = await requestCapture('screen').then(() => null, failure => failure);
            assert(Gio.DBusError.get_remote_error(error) === 'dev.fxth.ScreenshotUtils.Unavailable',
                'Capture API interrupted another modal');
        } finally {
            if (grab)
                Main.popModal(grab);
            modal.destroy();
        }
        print('PASS: capture API rejects locked, greeter and modal states');
        const invalidMode = await requestCapture('invalid').then(() => null, error => error);
        assert(Gio.DBusError.get_remote_error(invalidMode) === 'dev.fxth.ScreenshotUtils.InvalidMode',
            'Capture API accepted an invalid mode');
        settings.set_string('filename-template', 'Shortcut-{N}');
        settings.set_int('capture-delay-ms', 1000);
        const shortcutCommand = Gio.Subprocess.new([
            'gdbus', 'call', '--session', '--dest', 'org.gnome.Shell',
            '--object-path', '/org/gnome/shell/extensions/screenshotutils',
            '--method', 'dev.fxth.ScreenshotUtils.Capture', 'screen',
        ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const [, commandOutput, commandError] = await new Promise((resolve, reject) =>
            shortcutCommand.communicate_utf8_async(null, null, (process, result) => {
                try {
                    resolve(process.communicate_utf8_finish(result));
                } catch (error) {
                    reject(error);
                }
            }));
        assert(shortcutCommand.get_successful() && commandOutput.trim() === '()',
            `Documented shortcut command failed: ${commandError}`);
        assert(extension._busy && !directory.get_child('Shortcut-screen.png').query_exists(null),
            'Shortcut command waited for delayed capture to finish');
        const busyError = await requestCapture('screen').then(() => null, error => error);
        assert(Gio.DBusError.get_remote_error(busyError) === 'dev.fxth.ScreenshotUtils.Busy',
            'Capture API accepted overlapping captures');
        await waitUntil(() => !extension._busy, 'Shortcut screen capture did not finish');
        checkPng(directory, 'Shortcut-screen.png');
        settings.set_int('capture-delay-ms', 0);
        await requestCapture('selection');
        await waitUntil(() => extension._selector?._grabHelper.grabbed, 'Shortcut did not open Selection');
        await movePointer(pointer, 100, 100);
        await Scripting.sleep(30);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await Scripting.sleep(30);
        await movePointer(pointer, 200, 180);
        await Scripting.sleep(30);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await waitUntil(() => !extension._selector && !extension._busy, 'Shortcut selection did not finish');
        checkPng(directory, 'Shortcut-area.png');
        await requestCapture('window');
        await waitUntil(() => extension._windowSession && Main.screenshotUI.visible &&
            !Main.screenshotUI._panel.visible, 'Shortcut did not open Window');
        await Scripting.sleep(250);
        await click(pointer, Main.screenshotUI._windowSelectors.flatMap(selector => selector.windows())[0]);
        await waitUntil(() => !extension._windowSession && !extension._busy, 'Shortcut window capture did not finish');
        checkPng(directory, 'Shortcut-window.png');
        assert(JSON.stringify(nativeKeys.get_strv('show-screenshot-ui')) === JSON.stringify(originalPrint),
            'System shortcut commands changed Print Screen');
        settings.set_string('filename-template', 'Integration-{N}');
        print('PASS: system shortcut commands, all modes, immediate reply, busy rejection and unchanged Print Screen');
        const preferencesTest = Gio.Subprocess.new([
            'gjs', ...(GLib.getenv('SCREENSHOT_UTILS_LEGACY_TESTS') ? [] : ['-m']),
            GLib.getenv('SCREENSHOT_UTILS_LEGACY_TESTS') ?? GLib.build_filenamev([GLib.getenv('PWD'), 'tests', 'preferences.js']), extension.path,
        ], Gio.SubprocessFlags.NONE);
        await new Promise((resolve, reject) => preferencesTest.wait_check_async(null, (process, result) => {
            try {
                process.wait_check_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        }));
        await extension._openPreferences();
        let prefsWindow;
        await waitUntil(() => {
            prefsWindow = global.get_window_actors().map(actor => actor.meta_window)
                .find(window => window.get_title() === 'Screenshot Utils');
            return prefsWindow;
        }, 'Actual preferences window did not open');
        await waitUntil(() => global.display.get_focus_window() === prefsWindow,
            'New preferences window did not receive focus');
        await Scripting.sleep(250);
        await preview('preferences.png');
        const otherWindow = global.get_window_actors().map(actor => actor.meta_window)
            .find(window => window !== prefsWindow);
        otherWindow.activate(global.get_current_time());
        await waitUntil(() => global.display.get_focus_window() === otherWindow,
            'Could not move focus away from preferences');
        await click(pointer, Main.panel.statusArea[UUID]);
        await Scripting.sleep(200);
        await click(pointer, Main.panel.statusArea[UUID]._preferencesButton);
        await waitUntil(() => global.display.get_focus_window() === prefsWindow,
            'Preferences button did not raise the existing window');
        assert(global.get_window_actors().filter(actor => actor.meta_window.get_title() === 'Screenshot Utils').length === 1,
            'Preferences button created a duplicate window');
        prefsWindow.delete(global.get_current_time());
        await waitUntil(() => !global.get_window_actors().some(actor => actor.meta_window === prefsWindow),
            'Preferences did not close');
        print('PASS: real preferences window opening and focus restoration');
        const nativeUi = Main.screenshotUI;
        const originalSave = nativeUi._saveScreenshot;
        const originalCapture = nativeUi._onCaptureButtonClicked;
        const originalConstraints = nativeUi._closeButton.get_constraints();
        await click(pointer, Main.panel.statusArea[UUID]);
        await Scripting.sleep(200);
        await click(pointer, Main.panel.statusArea[UUID]._windowButton);
        await waitUntil(() => extension._windowSession && nativeUi.visible && nativeUi._windowButton.checked,
            'Window action did not open GNOME window overview');
        await Scripting.sleep(250);
        assert(!nativeUi._panel.visible && nativeUi._closeButton.visible,
            'Window picker did not hide the toolbar and retain its X');
        const thumbnails = nativeUi._windowSelectors.flatMap(selector => selector.windows());
        assert(thumbnails.length >= 2, 'GNOME window overview did not show both windows');
        const thumbnail = thumbnails.find(window => !window.checked);
        assert(thumbnail, 'No alternative window available to select');
        const chosenWindow = extension._windowSession.windows.get(thumbnail);
        const chosenActor = global.get_window_actors().find(actor => actor.meta_window === chosenWindow);
        assert(thumbnail.boundingBox.width === chosenWindow.get_frame_rect().width &&
            thumbnail.boundingBox.height === chosenWindow.get_frame_rect().height,
        'Window thumbnail was mapped to a different window');
        // Native window captures include the buffer's shadows, beyond the frame rectangle.
        const expectedWidth = Math.round(chosenWindow.get_buffer_rect().width * chosenActor.get_resource_scale());
        await preview('window-overview.png');
        settings.set_int('capture-delay-ms', 1000);
        const windowStartedAt = GLib.get_monotonic_time();
        await click(pointer, thumbnail);
        await waitUntil(() => !extension._windowSession && !extension._busy, 'Window capture did not finish');
        const windowPng = checkPng(directory, 'Integration-window.png');
        const actualWidth = ((windowPng[16] * 256 + windowPng[17]) * 256 + windowPng[18]) * 256 + windowPng[19];
        assert(actualWidth === expectedWidth,
            `Window overview captured the wrong window: PNG width ${actualWidth}, expected ${expectedWidth}`);
        assert(GLib.get_monotonic_time() - windowStartedAt >= 1_000_000, 'Window capture ignored delay');
        assert(extension._notificationSource === null, 'Disabled notifications were shown');
        assert(nativeUi._saveScreenshot === originalSave, 'Window picker changed the native save workflow permanently');
        assert(nativeUi._onCaptureButtonClicked === originalCapture && nativeUi._panel.visible,
            'Window picker did not restore native controls');
        assert(nativeUi._closeButton.get_constraints().every((constraint, index) => constraint === originalConstraints[index]),
            'Window picker did not restore close-button constraints');
        print('PASS: window-only overview, thumbnail click, delay and native control restoration');

        settings.set_int('capture-delay-ms', 0);
        await extension._openWindowUi();
        await Scripting.sleep(250);
        await click(pointer, nativeUi._windowSelectors.flatMap(selector => selector.windows())[0]);
        await waitUntil(() => !extension._windowSession && !extension._busy, 'Immediate window capture did not finish');
        checkPng(directory, 'Integration-window-2.png');
        print('PASS: immediate window thumbnail capture');

        await extension._openWindowUi();
        for (const key of [Clutter.KEY_c, Clutter.KEY_v]) {
            keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
            keyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
            await Scripting.sleep(30);
            assert(nativeUi._windowButton.checked && nativeUi._shotButton.checked && nativeUi._windowButton.reactive,
                'Native keyboard shortcut switched the window-only picker mode');
        }
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
        await waitUntil(() => !extension._windowSession, 'Escape did not cancel window selection');
        assert(!directory.get_child('Integration-window-3.png').query_exists(null), 'Window picker Escape took a screenshot');
        assert(nativeUi._saveScreenshot === originalSave, 'Window picker Escape leaked the save override');
        print('PASS: native window picker Escape');

        await extension._openWindowUi();
        await Scripting.sleep(250);
        await click(pointer, nativeUi._closeButton);
        await waitUntil(() => !extension._windowSession, 'X did not cancel window selection');
        assert(!directory.get_child('Integration-window-3.png').query_exists(null), 'Window picker X took a screenshot');
        assert(nativeUi._panel.visible && nativeUi._onCaptureButtonClicked === originalCapture,
            'Window picker X leaked native control changes');
        print('PASS: window picker mouse cancellation');

        const nativeParents = nativeUi._windowSelectors.map(selector => selector.get_parent());
        for (const onThumbnail of [true, false]) {
            await extension._openWindowUi();
            await Scripting.sleep(250);
            let x = 50;
            let y = 50;
            if (onThumbnail) {
                const window = nativeUi._windowSelectors.flatMap(selector => selector.windows())[0];
                const [windowX, windowY] = window.get_transformed_position();
                const [width, height] = window.get_transformed_size();
                x = windowX + width / 2;
                y = windowY + height / 2;
            }
            await movePointer(pointer, x, y);
            await Scripting.sleep(30);
            pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.PRESSED);
            await Scripting.sleep(30);
            pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.RELEASED);
            await waitUntil(() => !extension._windowSession, 'Right-click did not cancel window selection');
            assert(!directory.get_child('Integration-window-3.png').query_exists(null), 'Window right-click took a screenshot');
            assert(nativeUi._windowSelectors.every((selector, index) => selector.get_parent() === nativeParents[index]),
                'Window right-click did not restore native actor parents');
        }
        print('PASS: window right-click cancels on thumbnails and background');

        await nativeUi.open();
        await Scripting.sleep(250);
        assert(nativeUi._panel.visible, 'Standard GNOME screenshot toolbar stayed hidden');
        nativeUi.close(true);
        print('PASS: standard GNOME screenshot UI restoration');

        const modalCount = Main.modalCount;
        let selection = extension._selectArea();
        await waitUntil(() => extension._selector?._grabHelper.grabbed, 'Region selector did not grab input');
        await Scripting.sleep(50);
        await preview('selection.png');
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
        await waitUntil(() => !extension._selector, 'Escape did not cancel region selection');
        await selection;
        assert(Main.modalCount === modalCount, 'Region selection leaked a modal grab');
        assert(!directory.get_child('Integration-area.png').query_exists(null), 'Escape took a screenshot');
        print('PASS: native region selector Escape');

        selection = extension._selectArea();
        await waitUntil(() => extension._selector?._grabHelper.grabbed, 'Region selector did not grab input');
        await movePointer(pointer, 100, 100);
        await Scripting.sleep(30);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await Scripting.sleep(30);
        await movePointer(pointer, 200, 180);
        await Scripting.sleep(30);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await waitUntil(() => !extension._selector && !extension._busy, 'Region drag did not finish capture');
        await selection;
        checkPng(directory, 'Integration-area.png');
        assert(Main.modalCount === modalCount, 'Region capture leaked a modal grab');
        print('PASS: native region drag and capture');

        settings.set_boolean('include-cursor', true);
        settings.set_int('capture-delay-ms', 500);
        selection = extension._selectArea();
        await waitUntil(() => extension._selector?._grabHelper.grabbed, 'Cursor region selector did not grab input');
        await movePointer(pointer, 100, 100);
        await Scripting.sleep(30);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await Scripting.sleep(30);
        await movePointer(pointer, 200, 180);
        await Scripting.sleep(30);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await waitUntil(() => !extension._selector && extension._busy, 'Delayed cursor capture did not begin');
        await movePointer(pointer, 150, 140);
        await selection;
        checkPng(directory, 'Integration-area-2.png');
        const delayedCursor = pixelDifferences(directory, 'Integration-area.png', 'Integration-area-2.png');
        assert(delayedCursor.changed > 10 && delayedCursor.changed < 2000,
            `Delayed region did not include only the cursor: ${delayedCursor.changed} changed pixels`);
        const cursorRect = {x: 100, y: 100, width: delayedCursor.width, height: delayedCursor.height};
        settings.set_int('capture-delay-ms', 0);
        await extension._capture('area', cursorRect);
        assert(pixelDifferences(directory, 'Integration-area.png', 'Integration-area-3.png').changed > 10,
            'Immediate region capture did not include the cursor');
        await movePointer(pointer, 300, 140);
        await Scripting.sleep(50);
        await extension._capture('area', cursorRect);
        assert(pixelDifferences(directory, 'Integration-area.png', 'Integration-area-4.png').changed === 0,
            'Region capture drew a cursor outside its bounds');
        await movePointer(pointer, 150, 140);
        await Scripting.sleep(50);
        settings.set_boolean('include-cursor', false);
        await extension._capture('area', cursorRect);
        assert(pixelDifferences(directory, 'Integration-area.png', 'Integration-area-5.png').changed === 0,
            'Region capture included a cursor when disabled');
        print('PASS: delayed and immediate region cursor pixels, bounds and disabled setting');

        for (const delay of [0, 500]) {
            settings.set_int('capture-delay-ms', delay);
            selection = extension._selectArea();
            await waitUntil(() => extension._selector?._grabHelper.grabbed, 'Click-cancel selector did not grab input');
            await movePointer(pointer, 250, 190);
            await Scripting.sleep(30);
            pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            await Scripting.sleep(30);
            pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            await selection;
            assert(!extension._selector && !extension._busy && Main.modalCount === modalCount,
                'A click without dragging did not cancel selection');
            assert(!directory.get_child('Integration-area-6.png').query_exists(null),
                'A click without dragging captured an area');
        }
        print('PASS: selection click without dragging cancels, including after previous captures');

        selection = extension._selectArea();
        await waitUntil(() => extension._selector?._grabHelper.grabbed, 'Right-click selector did not grab input');
        await movePointer(pointer, 250, 190);
        await Scripting.sleep(30);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.PRESSED);
        await Scripting.sleep(30);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.RELEASED);
        await selection;
        assert(!extension._selector && !extension._busy && Main.modalCount === modalCount,
            'Right-click did not cancel selection');
        assert(!directory.get_child('Integration-area-6.png').query_exists(null), 'Right-click captured an area');
        print('PASS: selection right-click cancellation');

        settings.set_string('filename-template', 'Cancelled');
        settings.set_int('capture-delay-ms', 30000);
        const oldRun = extension._run;
        const pending = extension._capture('screen');
        await waitUntil(() => oldRun.pending.size > 0, 'Delayed capture did not begin');
        await Scripting.sleep(50);
        Main.extensionManager.disableExtension(UUID);
        await waitUntil(() => !Main.panel.statusArea[UUID], 'Extension did not disable');
        Main.extensionManager.enableExtension(UUID);
        await waitUntil(() => Main.panel.statusArea[UUID], 'Extension did not re-enable');
        await pending;
        extension = Main.panel.statusArea[UUID]._extension;
        assert(oldRun.pending.size === 0, 'Disabled extension retained pending callbacks');
        assert(!extension._busy, 'Old capture changed the new extension state');
        assert(!directory.get_child('Cancelled.png').query_exists(null), 'Disabled capture wrote a file');
        print('PASS: pending capture cancellation across disable/re-enable');

        settings.set_int('capture-delay-ms', 0);
        selection = extension._selectArea();
        await waitUntil(() => extension._selector?._grabHelper.grabbed, 'Region selector did not grab input');
        Main.extensionManager.disableExtension(UUID);
        await waitUntil(() => !Main.panel.statusArea[UUID], 'Extension did not disable');
        await selection;
        const disabledError = await requestCapture('screen').then(() => null, error => error);
        assert(disabledError && extension._dbus === null, 'Disable left screenshot commands available');
        assert(Main.modalCount === modalCount, 'Disable leaked the region modal grab');
        print('PASS: active region cancellation on disable');

        Main.extensionManager.enableExtension(UUID);
        await waitUntil(() => Main.panel.statusArea[UUID], 'Extension did not re-enable');
        extension = Main.panel.statusArea[UUID]._extension;
        await extension._openWindowUi();
        assert(extension._windowSession && nativeUi.visible, 'Window picker did not reopen');
        Main.extensionManager.disableExtension(UUID);
        await waitUntil(() => !Main.panel.statusArea[UUID], 'Extension did not disable');
        assert(!nativeUi.visible && !extension._windowSession, 'Disable left the window overview open');
        assert(nativeUi._saveScreenshot === originalSave, 'Disable leaked the native save override');
        assert(nativeUi._onCaptureButtonClicked === originalCapture && nativeUi._panel.visible,
            'Disable leaked native control changes');
        assert(Main.modalCount === modalCount, 'Disable leaked the window picker modal grab');
        for (const method of Object.keys(soundSpies))
            assert(player[method] === soundSpies[method], `Disable did not restore ${method}`);
        print('PASS: active window picker cancellation on disable');
    } finally {
        Main.extensionManager.disableExtension(UUID);
        for (const method of Object.keys(originalSounds))
            player[method] = originalSounds[method];
        await Scripting.destroyTestWindows();
        const files = directory.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info; (info = files.next_file(null));)
            directory.get_child(info.get_name()).delete(null);
        files.close(null);
        directory.delete(null);
    }
}
