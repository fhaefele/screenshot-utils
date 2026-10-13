import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {bundleLegacy} from '../scripts/pack.js';

const directory = await mkdtemp(join(tmpdir(), 'screenshot-utils-runtime-'));
try {
    const path = join(directory, 'runtime.js');
    await bundleLegacy('legacy-runtime.js', path, 'LegacyRuntime', {
        preamble: 'globalThis.bootstrapReady = true;',
        footer: 'globalThis.bundleReady = typeof LegacyRuntime.Extension === \"function\";',
    });
    const schema = {};
    let loadedDirectory;
    class Settings {
        constructor(properties) { this.schema = properties.settings_schema; }
    }
    const Gio = {Settings, SettingsSchemaSource: {
        get_default: () => 'default',
        new_from_directory: path => { loadedDirectory = path; return {lookup: () => schema}; },
    }};
    const gi = {get Gio() {
        assert.equal(context.bootstrapReady, true, 'Native imports loaded before bootstrap');
        return new Proxy(Gio, {ownKeys() { throw new Error('GI namespace enumerated'); }});
    }};
    const context = vm.createContext({imports: {gi}});
    vm.runInContext(await readFile(path, 'utf8'), context);
    assert.equal(context.bundleReady, true, 'Footer ran before bundle initialization');
    const {Extension, InjectionManager} = context.LegacyRuntime;
    const extension = new Extension({metadata: {uuid: 'test', 'settings-schema': 'test.schema'},
        path: '/extension', dir: {get_child: () => ({get_path: () => '/extension/schemas'})}});
    assert.equal(extension.getSettings().schema, schema);
    assert.equal(loadedDirectory, '/extension/schemas');
    const original = () => 'original';
    const prototype = {method: original};
    const object = Object.create(prototype);
    const other = {method: original};
    const manager = new InjectionManager();
    manager.overrideMethod(object, 'method', fn => () => `${fn()} overridden`);
    manager.overrideMethod(other, 'method', () => () => 'other');
    assert.equal(object.method(), 'original overridden');
    assert.equal(other.method(), 'other');
    manager.overrideMethod(object, 'method', fn => () => `${fn()} again`);
    assert.equal(object.method(), 'original again');
    manager.clear();
    assert.equal(object.method, original);
    assert.equal(Object.hasOwn(object, 'method'), false);
    assert.equal(other.method, original);
    manager.clear();
    manager.overrideMethod(object, 'method', () => () => 're-enabled');
    assert.equal(object.method(), 're-enabled');
    manager.clear();
    assert.equal(object.method, original);
} finally {
    await rm(directory, {recursive: true, force: true});
}
