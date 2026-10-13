import Gio from 'gi://Gio';

// Used only by the Shell 42 build; capture and preferences code stay shared.
export class Extension {
    constructor(extension) {
        this.metadata = extension.metadata ?? extension;
        this.uuid = this.metadata.uuid;
        this.path = extension.path;
        this.dir = extension.dir ?? Gio.File.new_for_path(this.path);
    }

    getSettings() {
        const source = Gio.SettingsSchemaSource.new_from_directory(
            this.dir.get_child('schemas').get_path(), Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup(this.metadata['settings-schema'], true);
        if (!schema)
            throw new Error(`Settings schema missing for ${this.uuid}`);
        return new Gio.Settings({settings_schema: schema});
    }

    openPreferences() {
        return imports.ui.main.extensionManager.openExtensionPrefs(this.uuid, '', {});
    }
}

export class ExtensionPreferences extends Extension {}

export class InjectionManager {
    constructor() {
        this._overrides = new Map();
    }

    overrideMethod(object, name, createOverride) {
        let methods = this._overrides.get(object);
        if (!methods) {
            methods = new Map();
            this._overrides.set(object, methods);
        }
        if (!methods.has(name))
            methods.set(name, {original: object[name], own: Object.prototype.hasOwnProperty.call(object, name)});
        object[name] = createOverride(methods.get(name).original);
    }

    clear() {
        for (const [object, methods] of this._overrides) {
            for (const [name, {original, own}] of methods) {
                if (own)
                    object[name] = original;
                else
                    delete object[name];
            }
        }
        this._overrides.clear();
    }
}
