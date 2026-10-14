// SPDX-License-Identifier: GPL-3.0-or-later
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export function createNotificationSource() {
    return MessageTray.Source.prototype.addNotification
        ? new MessageTray.Source({title: 'Screenshot Utils', iconName: 'camera-photo-symbolic'})
        : new MessageTray.Source('Screenshot Utils', 'camera-photo-symbolic');
}

export function showNotification(source, title, body, openFolder) {
    const notification = source.addNotification
        ? new MessageTray.Notification({source, title, body})
        : new MessageTray.Notification(source, title, body);
    notification.addAction('Open Screenshot Folder', openFolder);
    if (source.addNotification)
        source.addNotification(notification);
    else
        source.showNotification(notification);
    return notification;
}

export function createSecondaryClickBin(properties, onClick) {
    // A Button's click gesture can claim primary releases even with a secondary-only mask.
    const bin = new St.Bin({reactive: true, can_focus: false, ...properties});
    connectSecondaryClick(bin, onClick);
    return bin;
}

export function connectSecondaryClick(actor, onClick) {
    // Capture both phases before descendants can start a native drag or selection.
    actor.connect('captured-event', (_actor, event) => {
        const type = event.type();
        if ((type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.BUTTON_RELEASE) ||
            event.get_button() !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;
        if (type === Clutter.EventType.BUTTON_RELEASE)
            onClick();
        return Clutter.EVENT_STOP;
    });
}
