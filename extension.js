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
import {SelectArea, Tooltip} from 'resource:///org/gnome/shell/ui/screenshot.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {buildFilename} from './filename.js';
import {ensureDirectory, ensureSaveLocation, getSavePath} from './location.js';
import {delayToSlider, sliderToDelay, formatDelay} from './delay.js';

const SHELL_MAJOR = Number(Config.PACKAGE_VERSION.split('.')[0]);
const CAPTURE_SOUND = `${global.datadir}/sounds/screen-capture.oga`;

for (const method of ['screenshot', 'screenshot_window', 'screenshot_area', 'screenshot_stage_to_content'])
    Gio._promisify(Shell.Screenshot.prototype, method);
Gio._promisify(Shell.Screenshot, 'composite_to_stream');
Gio._promisify(Gio.File.prototype, 'create_async', 'create_finish');
Gio._promisify(Gio.File.prototype, 'delete_async', 'delete_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');
Gio._promisify(Gio.OutputStream.prototype, 'close_async', 'close_finish');

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
        this._selectionButton = this._addIconButton(captures, 'screenshot-ui-area-symbolic',
            'Selection', () => extension._selectArea());
        this._screenButton = this._addIconButton(captures, 'screenshot-ui-display-symbolic',
            'Screen', () => extension._capture('screen'));
        this._windowButton = this._addIconButton(captures, 'screenshot-ui-window-symbolic',
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

        const delayRow = new PopupMenu.PopupBaseMenuItem({activate: false});
        delayRow.x_expand = true;
        delayRow.style = 'margin: 0 12px 9px;';
        rows.add_child(delayRow);
        delayRow.add_child(new St.Icon({icon_name: 'alarm-symbolic', style_class: 'popup-menu-icon'}));
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
            style: utility ? 'border-radius: 4px; min-width: 0; min-height: 0; padding: 3px;' : 'border-radius: 8px; min-width: 48px; padding: 8px 12px;',
            child: new St.Icon({icon_name: icon, icon_size: utility ? 16 : 32}),
        });
        button.connect('clicked', action);
        parent.add_child(button);
        this._addTooltip(button, name);
        return button;
    }

    _addTooltip(actor, text) {
        const tooltip = new MenuTooltip(actor, {text, style_class: 'screenshot-ui-tooltip', visible: false});
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
        this._settings = this.getSettings();
        ensureSaveLocation(this._settings);
        this._locationChangedId = this._settings.connect('changed::save-location',
            () => ensureSaveLocation(this._settings));
        this._run = {cancellable: new Gio.Cancellable(), pending: new Set()};
        this._busy = false;
        this._selector = null;
        this._windowSession = null;
        this._notificationSource = null;
        this._button = new CaptureButton(this);
        Main.panel.addToStatusArea(this.uuid, this._button);
        this._injectionManager = new InjectionManager();
        this._patchScreenshotSound();
    }

    disable() {
        const run = this._run;
        this._run = null;
        run?.cancellable.cancel();
        for (const cancel of run?.pending ?? [])
            cancel();
        this._cancelSelector();
        this._cancelWindowUi();
        this._notificationSource?.destroy();
        this._notificationSource = null;
        this._injectionManager?.clear();
        this._injectionManager = null;
        this._button?.destroy();
        this._button = null;
        this._settings?.disconnect(this._locationChangedId);
        this._locationChangedId = 0;
        this._settings = null;
    }

    _checkActive(run) {
        if (!run || this._run !== run)
            throw new Error('Capture cancelled');
    }

    _wait(milliseconds, run, object = null, signal = null, isReady = null) {
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

    async _prepareCapture(run) {
        this._checkActive(run);
        // PopupMenu changed close() parameters in Shell 51.
        this._button.menu.close(SHELL_MAJOR >= 51
            ? {animate: false} : 0);
        await this._wait(0, run);
        this._checkActive(run);
    }

    _patchScreenshotSound() {
        const soundPlayer = global.display.get_sound_player();
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
        if (!this._selector)
            return;
        // selectAsync() owns destruction; ungrab settles its promise and restores input.
        this._selector._grabHelper.ungrab();
        this._selector.hide();
    }

    async _selectArea() {
        if (!this._run || this._selector || this._busy || this._windowSession)
            return;
        const run = this._run;
        const selector = new SelectArea();
        let cancelled = false;
        const hint = new St.Button({
            layout_manager: new Clutter.BinLayout(),
            reactive: true, can_focus: false,
            button_mask: St.ButtonMask.THREE,
            accessible_name: 'Right-click to cancel selection',
        });
        hint.connect('clicked', async () => {
            cancelled = true;
            try {
                await this._wait(0, run);
                if (this._selector === selector)
                    this._cancelSelector();
            } catch {
                // Disabling already cancels the selector.
            }
        });
        hint.add_constraint(new Clutter.BindConstraint({source: selector, coordinate: Clutter.BindCoordinate.ALL}));
        hint.add_child(new St.Label({
            text: 'Esc or right-click to cancel',
            style_class: 'screenshot-ui-tooltip',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
            translation_y: -24,
        }));
        selector.add_child(hint);
        this._selector = selector;
        let selecting = false;
        let rect;
        try {
            await this._prepareCapture(run);
            selecting = true;
            rect = await selector.selectAsync();
            this._checkActive(run);
            // Native geometry can use its initial coordinates when no drag occurred.
            if (cancelled || !selector._rubberband.visible)
                rect = null;
        } catch (error) {
            if (this._run === run)
                this._notify(`Region selection failed: ${error.message}`);
        } finally {
            hint.destroy();
            if (this._selector === selector)
                this._selector = null;
            if (!selecting)
                selector.destroy();
        }
        if (this._run === run && rect?.width > 1 && rect.height > 1)
            await this._capture('area', rect);
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

    _releaseWindowSession(session) {
        session.manager.clear();
        for (const [object, id] of session.signals)
            object.disconnect(id);
        session.signals = [];
        for (const wrapper of session.cancelWrappers ?? []) {
            if (wrapper.destroyed)
                continue;
            wrapper.button.set_child(null);
            wrapper.parent.insert_child_at_index(wrapper.selector, wrapper.index);
            wrapper.button.destroy();
        }
        session.cancelWrappers = [];
        if (session.controls) {
            const {panelVisible, constraints, properties} = session.controls;
            session.ui._panel.visible = panelVisible;
            session.ui._closeButton.set(properties);
            for (const constraint of constraints)
                session.ui._closeButton.add_constraint(constraint);
            session.controls = null;
        }
        if (session.closedId)
            session.ui.disconnect(session.closedId);
        session.closedId = 0;
        if (this._windowSession === session)
            this._windowSession = null;
    }

    async _chooseWindow(session, window, run) {
        if (this._windowSession !== session || this._run !== run || session.selected || session.cancelled || !window)
            return;
        session.selected = window;
        try {
            // Finish the thumbnail's input event before close() destroys it.
            await this._wait(0, run);
            if (this._windowSession === session)
                session.ui.close(true);
        } catch {
            // Disabling the extension cancels the pending selection.
        }
    }

    async _cancelWindowSelection(session, run) {
        session.cancelled = true;
        session.selected = null;
        try {
            await this._wait(0, run);
            if (this._windowSession === session)
                session.ui.close(true);
        } catch {
            // Disabling already closes the picker.
        }
    }

    _cancelWindowUi() {
        const session = this._windowSession;
        if (!session)
            return;
        this._releaseWindowSession(session);
        // open() still owns its frozen actors until its snapshot await finishes.
        if (!session.ui._openingCoroutineInProgress)
            session.ui.close(true);
    }

    async _openWindowUi() {
        if (!this._run || this._busy || this._selector || this._windowSession)
            return;
        const run = this._run;
        this._busy = true;
        let session = null;
        try {
            await this._prepareCapture(run);
            const ui = Main.screenshotUI;
            if (ui.visible || ui._openingCoroutineInProgress || ui._screencastInProgress)
                throw new Error('GNOME screenshot UI is already in use');
            const workspace = global.workspace_manager.get_active_workspace();
            const windows = global.get_window_actors().map(actor => actor.meta_window)
                .filter(window => !window.is_override_redirect() && window.located_on_workspace(workspace));
            session = {ui, manager: new InjectionManager(), windows: new Map(), selected: null, closedId: 0, signals: []};
            this._windowSession = session;
            session.manager.overrideMethod(ui, '_onCaptureButtonClicked', () => async () => {
                const selected = ui._windowSelectors.flatMap(selector => selector.windows())
                    .find(window => window.checked);
                await this._chooseWindow(session, session.windows.get(selected), run);
            });
            session.closedId = ui.connect('closed', () => {
                const selected = session.selected;
                this._releaseWindowSession(session);
                if (this._run === run && selected)
                    this._capture('window', null, selected);
            });
            // Native capture() creates thumbnails synchronously in window-actor order.
            // Map them before awaiting open(), while the window list cannot change.
            const opening = ui.open();
            let mappingError = null;
            for (const selector of ui._windowSelectors) {
                const originals = windows.filter(window => window.get_monitor() === selector._monitorIndex);
                const thumbnails = selector.windows();
                if (originals.length !== thumbnails.length) {
                    mappingError = new Error('GNOME window selector changed; cannot identify the selected window');
                    break;
                }
                thumbnails.forEach((thumbnail, index) => session.windows.set(thumbnail, originals[index]));
            }
            await opening;
            this._checkActive(run);
            if (mappingError)
                throw mappingError;
            if (!ui.visible || !ui._windowButton.reactive)
                throw new Error('No windows available to capture');
            ui._showPointerButton.checked = this._settings.get_boolean('include-cursor');
            ui._windowButton.checked = true;
            session.cancelWrappers = [];
            for (const selector of ui._windowSelectors) {
                const parent = selector.get_parent();
                const index = parent.get_children().indexOf(selector);
                parent.remove_child(selector);
                const button = new St.Button({child: selector,
                    reactive: true, can_focus: false, button_mask: St.ButtonMask.THREE,
                    x_expand: true, y_expand: true, accessible_name: 'Right-click to cancel window selection'});
                const wrapper = {selector, parent, index, button, destroyed: false};
                button.connect('destroy', () => { wrapper.destroyed = true; });
                button.connect('clicked', () => this._cancelWindowSelection(session, run));
                parent.insert_child_at_index(button, index);
                session.cancelWrappers.push(wrapper);
            }
            // Keep native keyboard shortcuts from switching this window-only picker.
            for (const button of [ui._selectionButton, ui._screenButton, ui._castButton]) {
                const id = button.connect('notify::checked', () => {
                    if (!button.checked)
                        return;
                    ui._shotButton.checked = true;
                    ui._windowButton.checked = true;
                });
                session.signals.push([button, id]);
            }
            const close = ui._closeButton;
            session.controls = {
                panelVisible: ui._panel.visible,
                constraints: close.get_constraints(),
                properties: {
                    x_align: close.x_align, y_align: close.y_align,
                    x_expand: close.x_expand, y_expand: close.y_expand,
                    translation_y: close.translation_y,
                    button_mask: close.button_mask,
                },
            };
            ui._panel.hide();
            close.clear_constraints();
            close.set({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END,
                x_expand: true, y_expand: true, translation_y: -24,
                button_mask: close.button_mask | St.ButtonMask.THREE});
            for (const [thumbnail, window] of session.windows) {
                thumbnail.button_mask |= St.ButtonMask.THREE;
                thumbnail.connect('clicked', (_thumbnail, button) => {
                    if (button === Clutter.BUTTON_SECONDARY)
                        this._cancelWindowSelection(session, run);
                    else
                        this._chooseWindow(session, window, run);
                });
            }
        } catch (error) {
            if (session) {
                this._releaseWindowSession(session);
                session.ui.close(true);
            }
            if (this._run === run)
                this._notify(`Window selection failed: ${error.message}`);
        } finally {
            if (this._run === run)
                this._busy = false;
        }
    }

    async _focusWindow(window, run) {
        window.activate(global.get_current_time());
        await this._wait(2000, run, global.display, 'notify::focus-window',
            () => global.display.get_focus_window() === window);
        this._checkActive(run);
    }

    async _capture(kind, rect = null, selectedWindow = null) {
        if (!this._run || this._busy || this._selector || this._windowSession)
            return;
        const run = this._run;
        const settings = this._settings;
        this._busy = true;
        let countdown = null;
        try {
            await this._prepareCapture(run);
            const delay = settings.get_int('capture-delay-ms');
            if (delay > 0) {
                if (delay >= 1000)
                    countdown = this._notify(`Capturing in ${formatDelay(delay)}…`);
                countdown?.connect('destroy', () => { countdown = null; });
                await this._wait(delay, run);
                if (countdown) {
                    countdown.destroy();
                    await this._wait(MessageTray.ANIMATION_TIME, run);
                }
            }
            this._checkActive(run);
            const screenshot = new Shell.Screenshot();
            const stream = Gio.MemoryOutputStream.new_resizable();
            try {
                if (kind === 'screen') {
                    await screenshot.screenshot(settings.get_boolean('include-cursor'), stream);
                } else if (kind === 'window') {
                    if (!selectedWindow)
                        throw new Error('Choose a window to capture');
                    await this._focusWindow(selectedWindow, run);
                    await screenshot.screenshot_window(
                        true,
                        settings.get_boolean('include-cursor'), stream);
                } else {
                    if (settings.get_boolean('include-cursor')) {
                        const [content, scale, cursor, point, cursorScale] = await screenshot.screenshot_stage_to_content();
                        this._checkActive(run);
                        const texture = content.get_texture();
                        const x = Math.round(rect.x * scale);
                        const y = Math.round(rect.y * scale);
                        // Round edges together so fractional scaling cannot overrun the texture.
                        const width = Math.min(texture.get_width(), Math.round((rect.x + rect.width) * scale)) - x;
                        const height = Math.min(texture.get_height(), Math.round((rect.y + rect.height) * scale)) - y;
                        await Shell.Screenshot.composite_to_stream(
                            texture, x, y, width, height, scale,
                            cursor?.get_texture() ?? null,
                            Math.round(point.x * scale), Math.round(point.y * scale), cursorScale, stream);
                    } else {
                        await screenshot.screenshot_area(rect.x, rect.y, rect.width, rect.height, stream);
                    }
                }
            } finally {
                stream.close(null);
            }
            this._checkActive(run);
            const bytes = stream.steal_as_bytes();
            if (bytes.get_size() === 0)
                throw new Error('GNOME returned an empty screenshot');
            const directory = this._getSaveDirectory(settings);
            await ensureDirectory(directory, run.cancellable);
            const {file, stream: output} = await this._createUniqueFile(
                directory, settings.get_string('filename-template'), kind, run);
            try {
                this._checkActive(run);
                await this._writeBytes(output, bytes, run);
                await output.close_async(GLib.PRIORITY_DEFAULT, run.cancellable);
                this._checkActive(run);
            } catch (error) {
                try {
                    await output.close_async(GLib.PRIORITY_DEFAULT, null);
                } catch (cleanupError) {
                    console.error(`Could not close screenshot file: ${cleanupError.message}`);
                }
                try {
                    await file.delete_async(GLib.PRIORITY_DEFAULT, null);
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

    async _writeBytes(output, bytes, run) {
        const size = bytes.get_size();
        for (let offset = 0; offset < size;) {
            this._checkActive(run);
            // GBytes keeps the buffer alive throughout asynchronous writes.
            const remaining = offset ? GLib.Bytes.new_from_bytes(bytes, offset, size - offset) : bytes;
            const written = await output.write_bytes_async(remaining, GLib.PRIORITY_DEFAULT, run.cancellable);
            if (written <= 0)
                throw new Error('Screenshot write made no progress');
            offset += written;
        }
    }

    _getSaveDirectory(settings = this._settings) {
        return Gio.File.new_for_path(getSavePath(settings));
    }

    async _createUniqueFile(directory, template, kind, run) {
        const now = new Date();
        for (let index = 0; index < 1000; index++) {
            this._checkActive(run);
            const suffix = index ? `-${index + 1}` : '';
            const file = directory.get_child(buildFilename(template, now, kind, suffix));
            try {
                const stream = await file.create_async(Gio.FileCreateFlags.PRIVATE, GLib.PRIORITY_DEFAULT, run.cancellable);
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
            const source = new MessageTray.Source({title: 'Screenshot Utils', iconName: 'camera-photo-symbolic'});
            source.connect('destroy', () => {
                if (this._notificationSource === source)
                    this._notificationSource = null;
            });
            Main.messageTray.add(source);
            this._notificationSource = source;
        }
        const notification = new MessageTray.Notification({source: this._notificationSource, title, body});
        notification.addAction('Open Screenshot Folder', () => this._openFolder());
        this._notificationSource.addNotification(notification);
        return notification;
    }
}
