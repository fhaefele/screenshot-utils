import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const installer = fileURLToPath(new URL('../scripts/install.sh', import.meta.url));
const metadata = JSON.parse(readFileSync(new URL('../metadata.json', import.meta.url), 'utf8'));
const uuid = metadata.uuid;
const python = execFileSync('/bin/sh', ['-c', 'command -v python3'], {encoding: 'utf8'}).trim();

function runInstaller({version = 'GNOME Shell 50.1', versionExit = 0, curlExit = 0,
    installExit = 0, uninstallExit = 0, settingsExit = 0, missingCurl = false, args = ['--yes'],
    installed = null, latest = '2.4', enabled = false, globallyDisabled = false,
    answers = null, piped = false, badArchive = false, archiveUuid = uuid} = {}) {
    const root = mkdtempSync(join(tmpdir(), 'screenshot-utils installer-'));
    try {
        const bin = join(root, 'bin');
        const downloads = join(root, 'downloads');
        const data = join(root, 'data');
        const extension = join(data, 'gnome-shell/extensions', uuid);
        mkdirSync(bin);
        mkdirSync(downloads);
        if (installed !== null) {
            mkdirSync(extension, {recursive: true});
            writeFileSync(join(extension, 'metadata.json'), JSON.stringify({...metadata, 'version-name': installed}));
        }
        const fixture = join(root, 'release.zip');
        const release = {...metadata, uuid: archiveUuid, 'version-name': latest,
            'shell-version': Number(version.match(/Shell (\d+)/)?.[1]) < 45 ? ['42', '43', '44'] : metadata['shell-version']};
        execFileSync(python, ['-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z: z.writestr("metadata.json", sys.argv[2])',
            fixture, JSON.stringify(release)]);
        if (badArchive) writeFileSync(fixture, 'not a ZIP');
        const settingsPath = join(root, 'settings.json');
        writeFileSync(settingsPath, JSON.stringify({
            'enabled-extensions': ['other-enabled@test', ...(enabled ? [uuid] : [])],
            'disabled-extensions': ['other-disabled@test', ...(!enabled ? [uuid] : [])],
            'disable-user-extensions': globallyDisabled,
        }));
        const stub = (name, source, interpreter = '/bin/sh') =>
            writeFileSync(join(bin, name), `#!${interpreter}\n${source}`, {mode: 0o755});
        stub('gnome-shell', 'printf "%s\\n" "$TEST_SHELL_VERSION"\nexit "$TEST_VERSION_EXIT"\n');
        stub('gnome-extensions', `case "$1" in
install)
    printf '%s\\n' "$@" > "$TEST_INSTALL_ARGS"
    test "$#" -eq 3 && test "$2" = --force && test -s "$3" || exit 94
    exit "$TEST_INSTALL_EXIT" ;;
uninstall)
    printf '%s\\n' "$@" > "$TEST_UNINSTALL_ARGS"
    exit "$TEST_UNINSTALL_EXIT" ;;
*) exit 95 ;;
esac
`);
        stub('gsettings', `import ast,json,os,sys
if os.environ['TEST_SETTINGS_EXIT'] != '0': sys.exit(1)
p=os.environ['TEST_SETTINGS']; data=json.load(open(p))
if sys.argv[1]=='get': print(repr(data[sys.argv[3]]).lower() if isinstance(data[sys.argv[3]],bool) else repr(data[sys.argv[3]]))
else:
    data[sys.argv[3]]=ast.literal_eval(sys.argv[4])
    with open(p,'w') as f: json.dump(data,f)
`, python);
        stub('dconf', 'printf "%s\\n" "$@" > "$TEST_RESET_ARGS"\n');
        if (!missingCurl) {
            stub('curl', `printf '%s\\n' "$@" > "$TEST_CURL_ARGS"
while [ "$#" -gt 0 ]; do
    if [ "$1" = --output ]; then archive=$2; shift 2; else shift; fi
done
cp "$TEST_RELEASE" "$archive"
exit "$TEST_CURL_EXIT"
`);
        } else {
            for (const command of ['python3', 'mktemp', 'rm']) {
                const path = execFileSync('/bin/sh', ['-c', `command -v ${command}`], {encoding: 'utf8'}).trim();
                symlinkSync(path, join(bin, command));
            }
        }
        const env = {...process.env, PATH: missingCurl ? bin : `${bin}:${process.env.PATH}`,
            XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
            TMPDIR: downloads, TEST_SHELL_VERSION: version, TEST_VERSION_EXIT: String(versionExit),
            TEST_CURL_EXIT: String(curlExit), TEST_INSTALL_EXIT: String(installExit), TEST_UNINSTALL_EXIT: String(uninstallExit),
            TEST_SETTINGS_EXIT: String(settingsExit), TEST_SETTINGS: settingsPath, TEST_RELEASE: fixture,
            TEST_CURL_ARGS: join(root, 'curl-args'), TEST_INSTALL_ARGS: join(root, 'install-args'),
            TEST_UNINSTALL_ARGS: join(root, 'uninstall-args'), TEST_RESET_ARGS: join(root, 'reset-args'), TEST_INSTALLER: installer};
        const interactive = answers !== null;
        const result = interactive
            ? spawnSync('script', ['-qefc', piped ? 'cat "$TEST_INSTALLER" | bash' : 'bash "$TEST_INSTALLER"', '/dev/null'],
                {encoding: 'utf8', timeout: 10000, env, input: answers})
            : spawnSync('/bin/bash', [installer, ...args], {encoding: 'utf8', timeout: 10000, env});
        assert.ifError(result.error);
        const recorded = name => existsSync(join(root, name))
            ? readFileSync(join(root, name), 'utf8').trimEnd().split('\n') : null;
        return {...result, output: result.stdout + result.stderr, curlArgs: recorded('curl-args'),
            installArgs: recorded('install-args'), uninstallArgs: recorded('uninstall-args'), resetArgs: recorded('reset-args'),
            settings: JSON.parse(readFileSync(settingsPath)), installedFiles: existsSync(extension), leftovers: readdirSync(downloads)};
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
}

for (const version of ['42', '43', '44', ...metadata['shell-version']]) {
    test(`GNOME ${version} installs the matching release and enables with --yes`, () => {
        const result = runInstaller({version: `GNOME Shell ${version}.1`});
        assert.equal(result.status, 0, result.output);
        const asset = Number(version) < 45 ? 'screenshot-utils-gnome42-44.shell-extension.zip' : 'screenshot-utils-modern.shell-extension.zip';
        assert.equal(result.curlArgs.at(-1), `https://github.com/fhaefele/screenshot-utils/releases/latest/download/${asset}`);
        assert.equal(result.curlArgs[result.curlArgs.indexOf('--proto') + 1], '=https');
        assert.equal(result.curlArgs[result.curlArgs.indexOf('--proto-redir') + 1], '=https');
        assert.deepEqual(result.installArgs.slice(0, 2), ['install', '--force']);
        assert.equal(result.installArgs[2], result.curlArgs[result.curlArgs.indexOf('--output') + 1]);
        assert.match(result.stdout, /Installed Screenshot Utils v2.4/);
        assert.match(result.stdout, /Log out and back in/);
        assert.deepEqual(result.settings['enabled-extensions'], ['other-enabled@test', uuid]);
        assert.deepEqual(result.settings['disabled-extensions'], ['other-disabled@test']);
        assert.equal(result.resetArgs, null);
        assert.deepEqual(result.leftovers, []);
    });
}

for (const version of ['GNOME Shell 3.38.6', 'GNOME Shell 41.9', 'GNOME Shell 52.0', 'unknown']) {
    test(`Reject ${version} before downloading or installing`, () => {
        const result = runInstaller({version});
        assert.notEqual(result.status, 0);
        assert.match(result.output, /unsupported|Unrecognized/);
        assert.equal(result.curlArgs, null);
        assert.equal(result.installArgs, null);
    });
}

test('Help needs no interactive terminal', () => {
    const result = runInstaller({missingCurl: true, args: ['--help']});
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /--yes/);
    assert.equal(result.curlArgs, null);
});
test('Without a terminal the installer refuses implicit defaults', () => {
    const result = runInstaller({args: []});
    assert.notEqual(result.status, 0);
    assert.match(result.output, /No interactive terminal/);
    assert.equal(result.curlArgs, null);
    assert.equal(result.installArgs, null);
});
test('Unexpected arguments stop before changes', () => {
    const result = runInstaller({args: ['--system']});
    assert.notEqual(result.status, 0);
    assert.equal(result.curlArgs, null);
});
test('Missing curl fails with a dependency message', () => {
    const result = runInstaller({missingCurl: true});
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Required command not found: curl/);
});
test('Version detection failure stops before downloading', () => {
    const result = runInstaller({versionExit: 1});
    assert.notEqual(result.status, 0);
    assert.equal(result.curlArgs, null);
});
for (const options of [{curlExit: 22}, {badArchive: true}, {archiveUuid: 'wrong@example.com'}, {latest: 'not-a-version'}, {installExit: 1}]) {
    test(`Failure preserves settings and cleans download: ${JSON.stringify(options)}`, () => {
        const result = runInstaller(options);
        assert.notEqual(result.status, 0);
        assert.deepEqual(result.settings['enabled-extensions'], ['other-enabled@test']);
        assert.equal(result.resetArgs, null);
        assert.deepEqual(result.leftovers, []);
    });
}

test('--yes updates an older version, keeps settings and existing enabled state', () => {
    const result = runInstaller({installed: '2.3.2', enabled: true});
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /Updated Screenshot Utils v2.3.2 to v2.4/);
    assert.equal(result.resetArgs, null);
    assert.deepEqual(result.settings['enabled-extensions'], ['other-enabled@test', uuid]);
});
test('--yes skips reinstall and downgrade', () => {
    for (const installed of ['2.4', '2.5']) {
        const result = runInstaller({installed, enabled: true});
        assert.equal(result.status, 0, result.output);
        assert.equal(result.installArgs, null);
        assert.equal(result.resetArgs, null);
    }
});
test('Global extension disable remains unchanged and is explained', () => {
    const result = runInstaller({globallyDisabled: true});
    assert.equal(result.status, 0, result.output);
    assert.equal(result.settings['disable-user-extensions'], true);
    assert.match(result.output, /all user extensions turned off/);
});
test('Fresh install defaults Yes and enable can be declined', () => {
    const result = runInstaller({answers: '\n\nn\n'});
    assert.equal(result.status, 0, result.output);
    assert.ok(result.installArgs);
    assert.match(result.output, /Install Screenshot Utils v2.4\? \[Y\/n\]/);
    assert.deepEqual(result.settings['enabled-extensions'], ['other-enabled@test']);
});
test('Piped script reads interactive answers from terminal, not script input', () => {
    const result = runInstaller({answers: '\n\n\n', piped: true});
    assert.equal(result.status, 0, result.output);
    assert.ok(result.installArgs);
    assert.deepEqual(result.settings['enabled-extensions'], ['other-enabled@test', uuid]);
});
test('Current version defaults to no reinstall but still offers enable', () => {
    const result = runInstaller({installed: '2.4', answers: '\n\n\n'});
    assert.equal(result.status, 0, result.output);
    assert.equal(result.installArgs, null);
    assert.equal(result.resetArgs, null);
    assert.match(result.output, /Reinstall v2.4\? \[y\/N\]/);
    assert.deepEqual(result.settings['enabled-extensions'], ['other-enabled@test', uuid]);
});
test('Update defaults to preserving settings', () => {
    const result = runInstaller({installed: '2.3.2', enabled: true, answers: '\n\n\n'});
    assert.equal(result.status, 0, result.output);
    assert.ok(result.installArgs);
    assert.equal(result.resetArgs, null);
});
test('Explicit reinstall can reset only this extension namespace', () => {
    const result = runInstaller({installed: '2.4', enabled: true, answers: '\ny\ny\n'});
    assert.equal(result.status, 0, result.output);
    assert.ok(result.installArgs);
    assert.match(result.output, /Reinstalled Screenshot Utils v2.4/);
    assert.deepEqual(result.resetArgs, ['reset', '-f', '/org/gnome/shell/extensions/screenshot-utils/']);
});
test('Disable defaults No, explicit Yes preserves unrelated extensions', () => {
    const kept = runInstaller({installed: '2.4', enabled: true, answers: '2\n\n'});
    assert.equal(kept.status, 0, kept.output);
    assert.deepEqual(kept.settings['enabled-extensions'], ['other-enabled@test', uuid]);
    const disabled = runInstaller({installed: '2.4', enabled: true, answers: '2\ny\n'});
    assert.equal(disabled.status, 0, disabled.output);
    assert.deepEqual(disabled.settings['enabled-extensions'], ['other-enabled@test']);
    assert.deepEqual(disabled.settings['disabled-extensions'], ['other-disabled@test', uuid]);
    assert.equal(disabled.curlArgs, null);
});
test('Reset defaults No; explicit Yes clears only owned preferences', () => {
    const kept = runInstaller({installed: '2.4', answers: '3\n\n'});
    assert.equal(kept.status, 0, kept.output);
    assert.equal(kept.resetArgs, null);
    const reset = runInstaller({installed: '2.4', answers: '3\ny\n'});
    assert.equal(reset.status, 0, reset.output);
    assert.deepEqual(reset.resetArgs, ['reset', '-f', '/org/gnome/shell/extensions/screenshot-utils/']);
    assert.equal(reset.curlArgs, null);
});
test('Uninstall defaults No and performs no download', () => {
    const result = runInstaller({installed: '2.4', answers: '4\n\n'});
    assert.equal(result.status, 0, result.output);
    assert.equal(result.uninstallArgs, null);
    assert.equal(result.resetArgs, null);
    assert.equal(result.curlArgs, null);
});
test('Confirmed uninstall preserves settings unless reset explicitly accepted', () => {
    for (const reset of [false, true]) {
        const result = runInstaller({installed: '2.4', enabled: true, answers: `4\ny\n${reset ? 'y' : ''}\n`});
        assert.equal(result.status, 0, result.output);
        assert.deepEqual(result.uninstallArgs, ['uninstall', uuid]);
        assert.equal(!!result.resetArgs, reset);
        assert.deepEqual(result.settings['enabled-extensions'], ['other-enabled@test']);
        assert.deepEqual(result.settings['disabled-extensions'], ['other-disabled@test']);
        assert.equal(result.curlArgs, null);
    }
});
test('Unregistered or unavailable Shell falls back to removing only owned files', () => {
    const result = runInstaller({installed: '2.4', enabled: true, uninstallExit: 1, answers: '4\ny\n'});
    assert.equal(result.status, 0, result.output);
    assert.equal(result.resetArgs, null);
    assert.equal(result.installedFiles, false);
    assert.deepEqual(result.settings['enabled-extensions'], ['other-enabled@test']);
});
test('Unreadable GNOME settings stops before installation', () => {
    const result = runInstaller({installed: '2.4', settingsExit: 1});
    assert.notEqual(result.status, 0);
    assert.equal(result.installArgs, null);
});
test('Quit and invalid menu choices change nothing', () => {
    for (const answer of ['q\n', 'invalid\n']) {
        const result = runInstaller({answers: answer});
        assert.equal(result.installArgs, null);
        assert.equal(result.resetArgs, null);
        assert.equal(result.curlArgs, null);
    }
});
