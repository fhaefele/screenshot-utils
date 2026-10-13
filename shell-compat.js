import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export function connectWindowClosed(ui, callback) {
    if (GObject.signal_lookup('closed', ui.constructor.$gtype))
        return ui.connect('closed', callback);
    return ui.connect('notify::visible', () => {
        if (!ui.visible)
            callback();
    });
}

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
    bin.connect('button-release-event', (_bin, event) => {
        if (event.get_button() !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;
        onClick();
        return Clutter.EVENT_STOP;
    });
    return bin;
}
