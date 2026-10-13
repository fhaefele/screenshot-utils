import GObject from 'gi://GObject';
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
