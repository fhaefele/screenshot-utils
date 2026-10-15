import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Run separately after packing; ordinary unit tests need no GNOME tools.
const metadata = JSON.parse(readFileSync('metadata.json', 'utf8'));
const schema = readFileSync('schemas/org.gnome.shell.extensions.screenshot-utils.gschema.xml', 'utf8');
const license = readFileSync('LICENSE', 'utf8');
const modernModules = ['delay.js', 'filename.js', 'location.js', 'prefs-compat.js', 'shell-compat.js',
    'capture-selectors.js', 'async-utils.js', 'capture-icons.js', 'shortcuts.js', 'shortcut-manager.js', 'shortcut-prefs.js', 'release-info.js', 'prefs-release.js'];
const supportedVersions = [];
for (const target of ['legacy', 'modern']) {
    const archive = `dist/${target}/${metadata.uuid}.shell-extension.zip`;
    const contents = name => execFileSync('unzip', ['-p', archive, name], {encoding: 'utf8'});
    const files = execFileSync('unzip', ['-Z1', archive], {encoding: 'utf8'})
        .trim().split('\n').filter(name => !name.endsWith('/'));
    const expectedFiles = ['metadata.json', 'extension.js', 'prefs.js', 'LICENSE', 'icons/github-symbolic.svg',
        'schemas/org.gnome.shell.extensions.screenshot-utils.gschema.xml',
        ...(target === 'legacy' ? ['schemas/gschemas.compiled'] : modernModules)];
    assert.deepEqual(files.sort(), expectedFiles.sort(),
        'Upload packages must contain only runtime files, schemas and the license');
    assert.equal(contents('LICENSE'), license);
    assert.equal(contents('icons/github-symbolic.svg'), readFileSync('icons/github-symbolic.svg', 'utf8'));
    const actual = JSON.parse(contents('metadata.json'));
    assert.deepEqual(actual, {...metadata, 'shell-version': target === 'legacy' ? ['42', '43', '44'] : metadata['shell-version']});
    supportedVersions.push(...actual['shell-version']);
    assert.equal(contents('schemas/org.gnome.shell.extensions.screenshot-utils.gschema.xml'), schema);
    if (target === 'legacy')
        assert.ok(execFileSync('unzip', ['-p', archive, 'schemas/gschemas.compiled']).length > 0);
    for (const entry of ['extension.js', 'prefs.js']) {
        const source = contents(entry);
        if (target === 'legacy') {
            new vm.Script(source);
            assert.ok(source.includes(entry === 'extension.js' ? 'function init(extension)' : 'function fillPreferencesWindow(window)'));
            assert.equal(/\bObject\.hasOwn\(/.test(source), false);
        } else {
            assert.equal(source, readFileSync(entry, 'utf8'));
        }
    }
    if (target === 'modern') {
        for (const file of modernModules)
            assert.equal(contents(file), readFileSync(file, 'utf8'));
    }
}

assert.deepEqual(supportedVersions.sort((a, b) => Number(a) - Number(b)),
    Array.from({length: 10}, (_, index) => String(42 + index)),
    'Packages must cover each Shell version from 42 through 51 exactly once');
