import {build} from 'esbuild';
import {cp, mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist');
const sources = ['extension.js', 'prefs.js', 'filename.js', 'location.js', 'delay.js',
    'shell-compat.js', 'prefs-compat.js', 'capture-selectors.js', 'async-utils.js', 'capture-icons.js',
    'shortcuts.js', 'shortcut-manager.js', 'shortcut-prefs.js'];

// esbuild bundles shared local modules. Only GJS's native imports stay external.
const legacyRequire = `function require(specifier) {
    const prefix = specifier.startsWith('resource:///org/gnome/Shell/Extensions/js/')
        ? 'resource:///org/gnome/Shell/Extensions/js/' : 'resource:///org/gnome/shell/';
    if (!specifier.startsWith(prefix) || !specifier.endsWith('.js'))
        throw new Error('Unsupported GJS import: ' + specifier);
    return specifier.slice(prefix.length, -3).split('/').reduce((module, name) => module[name], imports);
}`;

export async function bundleLegacy(entry, outfile, globalName, {preamble = '', footer = ''} = {}) {
    await build({
        absWorkingDir: root, entryPoints: [entry], outfile, bundle: true,
        format: 'iife', globalName, target: 'firefox91', charset: 'utf8',
        external: ['resource://*'],
        banner: {js: `// SPDX-License-Identifier: GPL-3.0-or-later\n${preamble}\n${legacyRequire}`}, footer: {js: footer},
        plugins: [{name: 'legacy-gjs', setup(builder) {
            // GI namespaces cannot be enumerated by CommonJS interop helpers.
            builder.onResolve({filter: /^gi:\/\//}, args => ({path: args.path, namespace: 'legacy-gi'}));
            builder.onLoad({filter: /.*/, namespace: 'legacy-gi'}, args => {
                const url = new URL(args.path);
                const name = url.hostname;
                const version = url.searchParams.get('version');
                return {contents: (version ? `imports.gi.versions.${name} = ${JSON.stringify(version)};\n` : '') +
                    `export default imports.gi.${name};`, loader: 'js'};
            });
            builder.onResolve({filter: /^resource:\/\/\/org\/gnome\/(shell\/extensions\/extension|Shell\/Extensions\/js\/extensions\/prefs)\.js$/},
                () => ({path: resolve(root, 'legacy-runtime.js'), external: false}));
        }}],
    });
}

async function pack() {
    await mkdir(output, {recursive: true});
    const stage = await mkdtemp(resolve(output, '.pack-'));
    try {
        const metadata = JSON.parse(await readFile(resolve(root, 'metadata.json'), 'utf8'));
        for (const target of ['modern', 'legacy']) {
            const directory = resolve(stage, target);
            await mkdir(directory);
            for (const source of ['schemas', 'LICENSE', 'README.md'])
                await cp(resolve(root, source), resolve(directory, source), {recursive: true});
            const targetMetadata = {...metadata, 'shell-version': target === 'legacy' ? ['42', '43', '44'] : metadata['shell-version']};
            await writeFile(resolve(directory, 'metadata.json'), `${JSON.stringify(targetMetadata, null, 2)}\n`);
            if (target === 'modern') {
                for (const source of sources)
                    await cp(resolve(root, source), resolve(directory, source));
            } else {
                await bundleLegacy('extension.js', resolve(directory, 'extension.js'), 'ScreenshotUtilsExtensionModule',
                    {footer: 'function init(extension) { return new ScreenshotUtilsExtensionModule.default(extension); }'});
                await bundleLegacy('prefs.js', resolve(directory, 'prefs.js'), 'ScreenshotUtilsPreferencesModule',
                    {footer: 'function init() {}\nfunction fillPreferencesWindow(window) {\n' +
                    '    new ScreenshotUtilsPreferencesModule.default(imports.misc.extensionUtils.getCurrentExtension()).fillPreferencesWindow(window);\n}'});
            }
            const targetOutput = resolve(stage, 'packages', target);
            await mkdir(targetOutput, {recursive: true});
            const extras = target === 'modern' ? sources.slice(2) : [];
            execFileSync('gnome-extensions', ['pack', '--force', ...extras.map(source => `--extra-source=${source}`),
                '--extra-source=LICENSE', '--extra-source=README.md', `--out-dir=${targetOutput}`, directory], {stdio: 'inherit'});
            if (target === 'legacy') {
                // Older Shell versions need compiled schemas included in the package.
                execFileSync('glib-compile-schemas', ['--strict', resolve(directory, 'schemas')]);
                execFileSync('zip', ['-q', resolve(targetOutput, `${metadata.uuid}.shell-extension.zip`),
                    'schemas/gschemas.compiled'], {cwd: directory});
            }
            if (target === 'modern') {
                // Old packaging tools compile schemas even for modern targets.
                try {
                    execFileSync('zip', ['-dq', resolve(targetOutput, `${metadata.uuid}.shell-extension.zip`),
                        'schemas/gschemas.compiled'], {stdio: 'pipe'});
                } catch (error) {
                    if (error.status !== 12) // No matching entry is already correct.
                        throw error;
                }
            }
            const destination = resolve(output, target);
            await mkdir(destination, {recursive: true});
            const archive = `${metadata.uuid}.shell-extension.zip`;
            // Installers must never observe an incomplete ZIP during concurrent builds.
            await rename(resolve(targetOutput, archive), resolve(destination, archive));
            console.log(`${target}: ${destination}/${archive}`);
        }
    } finally {
        await rm(stage, {recursive: true, force: true});
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
    await pack();
