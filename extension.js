// SPDX-License-Identifier: GPL-3.0-or-later
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Tooltip} from 'resource:///org/gnome/shell/ui/screenshot.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {buildFilename} from './filename.js';
import {createNotificationSource, createSecondaryClickBin, showNotification} from './shell-compat.js';
import {AreaSelector, CommandConfirmation, WindowPicker} from './capture-selectors.js';
import {callAsync} from './async-utils.js';
import {ensureDirectory, ensureSaveLocation, getSavePath} from './location.js';
import {delayToSlider, sliderToDelay, formatDelay} from './delay.js';
import {createCaptureIcon} from './capture-icons.js';

const SHELL_MAJOR = Number(Config.PACKAGE_VERSION.split('.')[0]);
const CAPTURE_SOUND = `${global.datadir}/sounds/screen-capture.oga`;
const CAPTURE_INTERFACE = `<node>
    <interface name="dev.fxth.ScreenshotUtils">
        <method name="Capture">
            <arg type="s" name="mode" direction="in"/>
        </method>
    </interface>
</node>`;

const MenuTooltip = GObject.registerClass(
class MenuTooltip extends Tooltip {
    open() {
        Main.uiGroup.set_child_above_sibling(this, null);
        super.open();
    }

    set_position(x, _y) {
        const bounds = this._widget.get_transformed_extents();
        super.set_position(x, Math.min(bounds.get_y() + bounds.get_height() + 6,
            global.stage.height - this.height));
    }
});

const CaptureButton = GObject.registerClass(
class CaptureButton extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Screenshot Utils');
        // Retain the actor before populating it so failed enable can clean up.
        extension._button = this;
        this._extension = extension;
        this.add_child(new St.Icon({icon_name: 'camera-photo-symbolic', style_class: 'system-status-icon'}));

        const menuRow = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        menuRow.style = 'padding: 0;';
        const rows = new St.Widget({
            x_expand: true,
            layout_manager: new Clutter.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
            }),
        });
        menuRow.add_child(rows);
        this.menu.addMenuItem(menuRow);
        const captureRow = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        captureRow.x_expand = true;
        rows.add_child(captureRow);
        const captures = new St.Widget({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BoxLayout({spacing: 4, homogeneous: true}),
        });
        captureRow.add_child(captures);
        this._selectionButton = this._addIconButton(captures, createCaptureIcon('selection'),
            'Selection', () => extension._selectArea());
        this._screenButton = this._addIconButton(captures, createCaptureIcon('screen'),
            'Screen', () => extension._capture('screen'));
        this._windowButton = this._addIconButton(captures, createCaptureIcon('window'),
            'Window', () => extension._openWindowUi());

        const tools = new St.Widget({
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                spacing: 4,
                homogeneous: true,
            }),
        });
        captureRow.add_child(tools);
        this._folderButton = this._addIconButton(tools, 'folder-open-symbolic',
            'Open folder', () => extension._openFolder(), true);
        this._preferencesButton = this._addIconButton(tools, 'emblem-system-symbolic',
            'Preferences', () => extension._openPreferences(), true);

        const controlsRow = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        controlsRow.x_expand = true;
        controlsRow.style = 'margin: 0 0 9px; padding-top: 0; padding-bottom: 0;';
        rows.add_child(controlsRow);
        const delayRow = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
        delayRow.x_expand = true;
        // Shell 42-44 reserves an ornament label; newer versions use an icon.
        for (const row of [menuRow, captureRow, controlsRow, delayRow])
            row._ornamentLabel?.hide();
        this._cursorButton = new St.Button({
            style_class: 'button',
            accessible_name: 'Capture mouse cursor',
            toggle_mode: true,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'border-radius: 4px; min-width: 0; min-height: 0; padding: 3px;',
            child: new St.Icon({gicon: createCaptureIcon('cursor'), style_class: 'popup-menu-icon'}),
        });
        controlsRow.add_child(this._cursorButton);
        const cursorTooltip = this._addTooltip(this._cursorButton, 'Capture mouse cursor');
        extension._settings.bind('include-cursor', this._cursorButton, 'checked', Gio.SettingsBindFlags.DEFAULT);
        const syncCursorState = () => {
            this._cursorButton.child.opacity = this._cursorButton.checked ? 255 : 128;
            cursorTooltip.text = `Capture mouse cursor: ${this._cursorButton.checked ? 'on' : 'off'}`;
        };
        this._cursorButton.connect('notify::checked', syncCursorState);
        syncCursorState();
        controlsRow.add_child(delayRow);
        delayRow.add_child(new St.Icon({icon_name: 'alarm-symbolic', style_class: 'popup-menu-icon',
            y_align: Clutter.ActorAlign.CENTER}));
        this._delayLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 2.5em; text-align: right;'});
        delayRow.add_child(this._delayLabel);
        this._delaySlider = new Slider(delayToSlider(extension._settings.get_int('capture-delay-ms')));
        this._delaySlider.accessible_name = 'Screenshot delay';
        this._delayTooltip = this._addTooltip(delayRow, 'Screenshot delay');
        this._delaySlider.label_actor = this._delayTooltip;
        delayRow.add_child(this._delaySlider);
        const syncDelay = () => {
            const milliseconds = extension._settings.get_int('capture-delay-ms');
            // Keep the handle under the pointer when saving its current step.
            if (sliderToDelay(this._delaySlider.value) !== milliseconds) {
                this._syncingDelay = true;
                this._delaySlider.value = delayToSlider(milliseconds);
                this._syncingDelay = false;
            }
            const value = formatDelay(milliseconds);
            const text = `Screenshot delay: ${value}`;
            this._delayLabel.text = value;
            this._delaySlider.accessible_name = text;
            this._delayTooltip.text = text;
        };
        this._delaySlider.connect('notify::value', () => {
            if (this._syncingDelay)
                return;
            const milliseconds = sliderToDelay(this._delaySlider.value);
            if (milliseconds !== extension._settings.get_int('capture-delay-ms'))
                extension._settings.set_int('capture-delay-ms', milliseconds);
        });
        extension._settings.connectObject('changed::capture-delay-ms', syncDelay, this);
        syncDelay();
    }

    _addIconButton(parent, icon, name, action, utility = false) {
        const button = new St.Button({
            style_class: 'button',
            accessible_name: name,
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
            style: utility
                ? 'border-radius: 4px; min-width: 0; min-height: 16px; padding: 3px;'
                : 'border-radius: 8px; min-width: 48px; padding: 8px 12px;',
            child: new St.Icon({...(typeof icon === 'string' ? {icon_name: icon} : {gicon: icon}),
                icon_size: utility ? 16 : 32,
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}),
        });
        button.connect('clicked', action);
        parent.add_child(button);
        this._addTooltip(button, name);
        return button;
    }

    _addTooltip(actor, text) {
        actor.track_hover = true;
        const tooltip = new MenuTooltip(actor, {text, style_class: 'screenshot-ui-tooltip', visible: false});
        actor.label_actor = tooltip;
        Main.uiGroup.add_child(tooltip);
        this.menu.connectObject('open-state-changed', (_menu, open) => {
            if (!open) {
                tooltip.close();
                tooltip.remove_all_transitions();
                tooltip.hide();
            }
        }, tooltip);
        actor.connect('destroy', () => {
            tooltip.close();
            tooltip.destroy();
        });
        return tooltip;
    }
});

export default class ScreenshotUtilsExtension extends Extension {
    enable() {
        try {
            this._enable();
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    _enable() {
        this._settings = this.getSettings();
        this._lockdownSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.lockdown'});
        ensureSaveLocation(this._settings);
        this._locationChangedId = this._settings.connect('changed::save-location',
            () => ensureSaveLocation(this._settings));
        this._run = {cancellable: new Gio.Cancellable(), pending: new Set(), commandEpoch: 0};
        this._commandDialog = null;
        this._commandPermissionChangedId = this._settings.connect('changed::enable-shortcut-commands', () => {
            // External false→true changes may be queued together. The current
            // value cannot prove that an approved request stayed authorized.
            this._run.commandEpoch++;
            this._cancelCommandDialog();
            if (this._selector && this._selector.command !== null)
                this._cancelSelector();
            if (this._windowSession && this._windowSession.command !== null)
                this._cancelWindowUi();
            for (const cancel of this._run.pending) {
                if (cancel.command !== null)
                    cancel();
            }
        });
        this._busy = false;
        this._selector = null;
        this._windowSession = null;
        this._notificationSource = null;
        this._button = new CaptureButton(this);
        Main.panel.addToStatusArea(this.uuid, this._button);
        this._injectionManager = new InjectionManager();
        this._patchScreenshotSound();
        this._dbus = Gio.DBusExportedObject.wrapJSObject(CAPTURE_INTERFACE, {
            CaptureAsync: ([mode], invocation) => this._requestCapture(mode, invocation),
        });
        this._dbus.export(Gio.DBus.session, '/org/gnome/shell/extensions/screenshotutils');
    }

    disable() {
        const run = this._run;
        this._run = null;
        this._dbus?.unexport();
        this._dbus = null;
        run?.cancellable.cancel();
        for (const cancel of run?.pending ?? [])
            cancel();
        this._cancelCommandDialog();
        this._cancelSelector();
        this._cancelWindowUi();
        this._notificationSource?.destroy();
        this._notificationSource = null;
        if (this._soundStartupId)
            Main.layoutManager.disconnect(this._soundStartupId);
        this._soundStartupId = 0;
        this._injectionManager?.clear();
        this._injectionManager = null;
        this._button?.destroy();
        this._button = null;
        if (this._locationChangedId)
            this._settings.disconnect(this._locationChangedId);
        if (this._commandPermissionChangedId)
            this._settings.disconnect(this._commandPermissionChangedId);
        this._commandPermissionChangedId = 0;
        this._locationChangedId = 0;
        this._settings = null;
        this._lockdownSettings = null;
        this._busy = false;
    }

    _checkActive(run) {
        if (!run || this._run !== run)
            throw new Error('Capture cancelled');
    }

    _checkCommandAllowed(run, command) {
        this._checkActive(run);
        if (command !== null && (command !== run.commandEpoch ||
            !this._settings.get_boolean('enable-shortcut-commands')))
            throw new Error('Screenshot command permission was revoked');
    }

    _checkCaptureAllowed(run, command = null) {
        this._checkCommandAllowed(run, command);
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
            throw new Error('Screenshot controls are unavailable');
        if (this._lockdownSettings.get_boolean('disable-save-to-disk'))
            throw new Error('Saving screenshots is disabled by system policy');
    }

    _requestCapture(mode, invocation) {
        if (!this._settings?.get_boolean('enable-shortcut-commands')) {
            invocation.return_dbus_error('dev.fxth.ScreenshotUtils.Unavailable',
                'Enable Allow shortcut commands in Screenshot Utils preferences first');
            return;
        }
        if (!['selection', 'screen', 'window'].includes(mode)) {
            invocation.return_dbus_error('dev.fxth.ScreenshotUtils.InvalidMode', 'Use selection, screen or window');
            return;
        }
        if (this._busy || this._selector || this._windowSession || this._commandDialog) {
            invocation.return_dbus_error('dev.fxth.ScreenshotUtils.Busy', 'A screenshot is already in progress');
            return;
        }
        if (!this._run || Main.sessionMode.isLocked || Main.sessionMode.isGreeter ||
            Main.modalCount > (this._button.menu.isOpen ? 1 : 0)) {
            invocation.return_dbus_error('dev.fxth.ScreenshotUtils.Unavailable', 'Screenshot controls are unavailable');
            return;
        }
        if (this._lockdownSettings.get_boolean('disable-save-to-disk')) {
            invocation.return_dbus_error('dev.fxth.ScreenshotUtils.Unavailable',
                'Saving screenshots is disabled by system policy');
            return;
        }
        const run = this._run;
        this._runCommand(mode, run, run.commandEpoch).catch(error => {
            if (this._run === run)
                this._notify(`Screenshot failed: ${error.message}`);
        });
        // Reply immediately; Shell requires a user gesture for each command.
        invocation.return_value(null);
    }

    async _runCommand(mode, run, command) {
        this._busy = true;
        let allowed;
        let dialog = null;
        try {
            await this._prepareCapture(run, command);
            this._checkCaptureAllowed(run, command);
            dialog = new CommandConfirmation();
            this._commandDialog = dialog;
            const choice = new Promise(resolve => {
                dialog.connect('destroy', () => resolve(false));
                dialog.populate(mode, choice => {
                    dialog.cancelled ||= !choice;
                    resolve(choice);
                });
            });
            if (!dialog.open())
                throw new Error('Could not grab screenshot confirmation input');
            allowed = await choice;
            await this._wait(0, run, null, null, null, command);
            this._checkCaptureAllowed(run, command);
            allowed &&= !dialog.cancelled;
        } finally {
            if (this._commandDialog === dialog)
                this._cancelCommandDialog();
            if (this._run === run)
                this._busy = false;
        }
        if (!allowed)
            return;
        if (mode === 'selection')
            await this._selectArea(command);
        else if (mode === 'window')
            await this._openWindowUi(command);
        else
            await this._capture('screen', null, null, command);
    }

    _cancelCommandDialog() {
        const dialog = this._commandDialog;
        this._commandDialog = null;
        dialog?.cancel();
    }

    _wait(milliseconds, run, object = null, signal = null, isReady = null, command = null) {
        return new Promise((resolve, reject) => {
            this._checkActive(run);
            let timeoutId = 0;
            let handlerId = 0;
            const finish = error => {
                if (timeoutId)
                    GLib.source_remove(timeoutId);
                if (handlerId)
                    object.disconnect(handlerId);
                timeoutId = handlerId = 0;
                run.pending.delete(cancel);
                if (error)
                    reject(error);
                else
                    resolve();
            };
            const cancel = () => finish(new Error('Capture cancelled'));
            cancel.command = command;
            run.pending.add(cancel);
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
                timeoutId = 0;
                finish(object ? new Error('Could not focus selected window') : null);
                return GLib.SOURCE_REMOVE;
            });
            if (object) {
                handlerId = object.connect(signal, () => {
                    if (isReady())
                        finish();
                });
                if (isReady())
                    finish();
            }
        });
    }

    async _prepareCapture(run, command = null) {
        this._checkCommandAllowed(run, command);
        // PopupMenu changed close() parameters in Shell 51.
        this._button.menu.close(SHELL_MAJOR >= 51
            ? {animate: false} : 0);
        await this._wait(0, run, null, null, null, command);
        this._checkCommandAllowed(run, command);
    }

    _patchScreenshotSound() {
        const soundPlayer = global.display.get_sound_player();
        if (!soundPlayer) {
            // Shell 42 enables extensions before creating its sound player.
            this._soundStartupId = Main.layoutManager.connect('startup-complete', () => {
                Main.layoutManager.disconnect(this._soundStartupId);
                this._soundStartupId = 0;
                this._patchScreenshotSound();
            });
            return;
        }
        const soundFile = Gio.File.new_for_path(CAPTURE_SOUND);
        for (const method of ['play_from_theme', 'play_from_file']) {
            this._injectionManager.overrideMethod(soundPlayer, method, originalMethod => (sound, ...args) => {
                const isCapture = method === 'play_from_theme' ? sound === 'screen-capture' : sound.equal(soundFile);
                if (isCapture && this._settings?.get_boolean('mute-screenshot-sound'))
                    return;
                return originalMethod.call(soundPlayer, sound, ...args);
            });
        }
    }

    _playCaptureSound() {
        const player = global.display.get_sound_player();
        if (SHELL_MAJOR >= 51)
            player.play_from_file(Gio.File.new_for_path(CAPTURE_SOUND), 'Screenshot taken', null);
        else
            player.play_from_theme('screen-capture', 'Screenshot taken', null);
    }

    _cancelSelector() {
        const selector = this._selector;
        this._selector = null;
        selector?.cancel();
    }

    async _selectArea(command = null) {
        if (!this._run || this._selector || this._busy || this._windowSession || this._commandDialog)
            return;
        const run = this._run;
        const selector = new AreaSelector();
        selector.command = command;
        this._selector = selector;
        let cancelled = false;
        let rect;
        try {
            const hint = createSecondaryClickBin({
                accessible_name: 'Right-click to cancel selection',
            }, async () => {
                cancelled = true;
                try {
                    await this._wait(0, run);
                    if (this._selector === selector)
                        this._cancelSelector();
                } catch {
                    // Disabling already cancels the selector.
                }
            });
            selector.add_child(hint);
            hint.add_constraint(new Clutter.BindConstraint({source: selector, coordinate: Clutter.BindCoordinate.ALL}));
            hint.set_child(new St.Label({
                text: 'Esc or right-click to cancel',
                style_class: 'screenshot-ui-tooltip',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.END,
                x_expand: true,
                y_expand: true,
                translation_y: -24,
            }));
            await this._prepareCapture(run, command);
            this._checkCaptureAllowed(run, command);
            rect = await selector.selectAsync();
            // Finish native input dispatch before destroying the selection actor.
            // Unlike SelectArea's idle, this source is cancelled on disable.
            await this._wait(0, run);
            this._checkCaptureAllowed(run, command);
            // Native geometry can use its initial coordinates when no drag occurred.
            if (cancelled || !selector._rubberband.visible)
                rect = null;
        } catch (error) {
            if (this._run === run)
                this._notify(`Region selection failed: ${error.message}`);
        } finally {
            if (this._selector === selector)
                this._selector = null;
            selector.cancel();
        }
        if (this._run === run && rect?.width > 1 && rect.height > 1)
            await this._capture('area', rect, null, command);
    }

    async _openPreferences() {
        const run = this._run;
        try {
            await this._prepareCapture(run);
            const existing = global.get_window_actors().map(actor => actor.meta_window)
                .find(window => window.get_title() === this.metadata.name &&
                    (window.get_gtk_application_id() === 'org.gnome.Shell.Extensions' ||
                     window.get_wm_class() === 'org.gnome.Shell.Extensions'));
            if (existing)
                existing.activate(global.get_current_time());
            else
                await this.openPreferences();
        } catch (error) {
            if (this._run === run)
                this._notify(`Could not open preferences: ${error.message}`);
        }
    }

    async _chooseWindow(picker, window, run, command = null) {
        if (this._windowSession !== picker || this._run !== run || picker.selected || picker.cancelled)
            return;
        picker.selected = window;
        try {
            // Finish the button event before destroying its actor.
            await this._wait(0, run, null, null, null, command);
            if (this._windowSession !== picker || picker.cancelled)
                return;
            this._cancelWindowUi();
            await this._capture('window', null, window, command);
        } catch (error) {
            if (this._run === run)
                this._notify(`Window selection failed: ${error.message}`);
        }
    }

    async _cancelWindowSelection(picker, run) {
        if (this._windowSession !== picker)
            return;
        picker.cancelled = true;
        picker.selected = null;
        try {
            await this._wait(0, run);
            if (this._windowSession === picker)
                this._cancelWindowUi();
        } catch {
            // Disabling already destroys the picker.
        }
    }

    _cancelWindowUi() {
        const picker = this._windowSession;
        this._windowSession = null;
        picker?.cancel();
    }

    async _openWindowUi(command = null) {
        if (!this._run || this._busy || this._selector || this._windowSession || this._commandDialog)
            return;
        const run = this._run;
        this._busy = true;
        let picker = null;
        try {
            await this._prepareCapture(run, command);
            this._checkCaptureAllowed(run, command);
            const ui = Main.screenshotUI;
            if (ui.visible || ui._openingCoroutineInProgress || ui._screencastInProgress)
                throw new Error('GNOME screenshot UI is already in use');
            const workspace = global.workspace_manager.get_active_workspace();
            const windows = global.get_window_actors()
                .filter(actor => actor.width > 0 && actor.height > 0)
                .map(actor => actor.meta_window)
                .filter(window => !window.is_override_redirect() && !window.skip_taskbar &&
                    window.located_on_workspace(workspace));
            if (!windows.length)
                throw new Error('No windows available to capture');
            picker = new WindowPicker();
            picker.command = command;
            this._windowSession = picker;
            picker.populate(windows,
                window => this._chooseWindow(picker, window, run, command),
                () => this._cancelWindowSelection(picker, run));
            if (!picker.open())
                throw new Error('Could not grab window selection input');
        } catch (error) {
            if (this._windowSession === picker)
                this._windowSession = null;
            picker?.cancel();
            if (this._run === run)
                this._notify(`Window selection failed: ${error.message}`);
        } finally {
            if (this._run === run)
                this._busy = false;
        }
    }

    async _focusWindow(window, run, command) {
        window.activate(global.get_current_time());
        await this._wait(2000, run, global.display, 'notify::focus-window',
            () => global.display.get_focus_window() === window, command);
        this._checkCaptureAllowed(run, command);
    }

    async _capture(kind, rect = null, selectedWindow = null, command = null) {
        if (!this._run || this._busy || this._selector || this._windowSession || this._commandDialog)
            return;
        const run = this._run;
        const settings = this._settings;
        this._busy = true;
        let countdown = null;
        try {
            this._checkCaptureAllowed(run, command);
            await this._prepareCapture(run, command);
            const delay = settings.get_int('capture-delay-ms');
            if (delay > 0) {
                if (delay >= 1000)
                    countdown = this._notify(`Capturing in ${formatDelay(delay)}…`);
                countdown?.connect('destroy', () => { countdown = null; });
                await this._wait(delay, run, null, null, null, command);
                if (countdown) {
                    countdown.destroy();
                    await this._wait(MessageTray.ANIMATION_TIME, run, null, null, null, command);
                }
            }
            this._checkCaptureAllowed(run, command);
            const screenshot = new Shell.Screenshot();
            const stream = Gio.MemoryOutputStream.new_resizable();
            try {
                if (kind === 'screen') {
                    await callAsync(screenshot, 'screenshot', settings.get_boolean('include-cursor'), stream);
                } else if (kind === 'window') {
                    if (!selectedWindow)
                        throw new Error('Choose a window to capture');
                    await this._focusWindow(selectedWindow, run, command);
                    await callAsync(screenshot, 'screenshot_window',
                        true,
                        settings.get_boolean('include-cursor'), stream);
                } else {
                    if (settings.get_boolean('include-cursor')) {
                        const [content, scale, cursor, point, cursorScale] = await callAsync(screenshot, 'screenshot_stage_to_content');
                        this._checkCaptureAllowed(run, command);
                        const texture = content.get_texture();
                        const x = Math.round(rect.x * scale);
                        const y = Math.round(rect.y * scale);
                        // Round edges together so fractional scaling cannot overrun the texture.
                        const width = Math.min(texture.get_width(), Math.round((rect.x + rect.width) * scale)) - x;
                        const height = Math.min(texture.get_height(), Math.round((rect.y + rect.height) * scale)) - y;
                        await callAsync(Shell.Screenshot, 'composite_to_stream',
                            texture, x, y, width, height, scale,
                            cursor?.get_texture() ?? null,
                            Math.round(point.x * scale), Math.round(point.y * scale), cursorScale, stream);
                    } else {
                        await callAsync(screenshot, 'screenshot_area', rect.x, rect.y, rect.width, rect.height, stream);
                    }
                }
            } finally {
                stream.close(null);
            }
            this._checkCaptureAllowed(run, command);
            const bytes = stream.steal_as_bytes();
            if (bytes.get_size() === 0)
                throw new Error('GNOME returned an empty screenshot');
            const directory = this._getSaveDirectory(settings);
            await ensureDirectory(directory, run.cancellable);
            const {file, stream: output} = await this._createUniqueFile(
                directory, settings.get_string('filename-template'), kind, run, command);
            try {
                this._checkCaptureAllowed(run, command);
                await this._writeBytes(output, bytes, run, command);
                await callAsync(output, 'close_async', GLib.PRIORITY_DEFAULT, run.cancellable);
                this._checkCaptureAllowed(run, command);
            } catch (error) {
                try {
                    await callAsync(output, 'close_async', GLib.PRIORITY_DEFAULT, null);
                } catch (cleanupError) {
                    console.error(`Could not close screenshot file: ${cleanupError.message}`);
                }
                try {
                    await callAsync(file, 'delete_async', GLib.PRIORITY_DEFAULT, null);
                } catch (cleanupError) {
                    console.error(`Could not remove incomplete screenshot: ${cleanupError.message}`);
                }
                throw error;
            }
            let status = 'Screenshot saved';
            try {
                this._playCaptureSound();
            } catch (error) {
                console.warn(`Could not play screenshot sound: ${error.message}`);
            }
            if (settings.get_boolean('copy-to-clipboard')) {
                try {
                    St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
                } catch (error) {
                    status = `Screenshot saved, but clipboard copy failed: ${error.message}`;
                }
            }
            this._notify(status, file.get_path());
        } catch (error) {
            if (this._run === run)
                this._notify(`Screenshot failed: ${error.message}`);
        } finally {
            countdown?.destroy();
            if (this._run === run)
                this._busy = false;
        }
    }

    async _writeBytes(output, bytes, run, command = null) {
        const size = bytes.get_size();
        for (let offset = 0; offset < size;) {
            this._checkCaptureAllowed(run, command);
            // GBytes keeps the buffer alive throughout asynchronous writes.
            const remaining = offset ? GLib.Bytes.new_from_bytes(bytes, offset, size - offset) : bytes;
            const written = await callAsync(output, 'write_bytes_async', remaining, GLib.PRIORITY_DEFAULT, run.cancellable);
            if (written <= 0)
                throw new Error('Screenshot write made no progress');
            offset += written;
        }
    }

    _getSaveDirectory(settings = this._settings) {
        return Gio.File.new_for_path(getSavePath(settings));
    }

    async _createUniqueFile(directory, template, kind, run, command = null) {
        const now = new Date();
        for (let index = 0; index < 1000; index++) {
            this._checkCaptureAllowed(run, command);
            const suffix = index ? `-${index + 1}` : '';
            const file = directory.get_child(buildFilename(template, now, kind, suffix));
            try {
                const stream = await callAsync(file, 'create_async', Gio.FileCreateFlags.PRIVATE, GLib.PRIORITY_DEFAULT, run.cancellable);
                return {file, stream};
            } catch (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    throw error;
            }
        }
        throw new Error('Could not find an unused screenshot filename');
    }

    async _openFolder() {
        const run = this._run;
        try {
            await this._prepareCapture(run);
            const directory = this._getSaveDirectory();
            await ensureDirectory(directory, run.cancellable);
            this._checkActive(run);
            Gio.AppInfo.launch_default_for_uri(directory.get_uri(), global.create_app_launch_context(0, -1));
        } catch (error) {
            if (this._run === run)
                this._notify(`Could not open screenshot folder: ${error.message}`);
        }
    }

    _notify(title, body = '') {
        if (!this._settings?.get_boolean('show-notifications'))
            return null;
        if (!this._notificationSource) {
            const source = createNotificationSource();
            source.connect('destroy', () => {
                if (this._notificationSource === source)
                    this._notificationSource = null;
            });
            Main.messageTray.add(source);
            this._notificationSource = source;
        }
        return showNotification(this._notificationSource, title, body, () => this._openFolder());
    }
}
