import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const installer = fileURLToPath(new URL('../scripts/install.sh', import.meta.url));
const metadata = JSON.parse(readFileSync(new URL('../metadata.json', import.meta.url), 'utf8'));

function runInstaller({version = 'GNOME Shell 50.1', versionExit = 0, curlExit = 0,
    installExit = 0, missingCurl = false, args = []} = {}) {
    const root = mkdtempSync(join(tmpdir(), 'screenshot-utils installer-'));
    try {
        const bin = join(root, 'bin');
        const downloads = join(root, 'downloads');
        mkdirSync(bin);
        mkdirSync(downloads);
        const stub = (name, source) => writeFileSync(join(bin, name), `#!/bin/sh\n${source}`, {mode: 0o755});
        stub('gnome-shell', 'printf "%s\\n" "$TEST_SHELL_VERSION"\nexit "$TEST_VERSION_EXIT"\n');
        stub('gnome-extensions', `printf '%s\\n' "$@" > "$TEST_INSTALL_ARGS"
if [ "$#" -ne 3 ] || [ "$1" != install ] || [ "$2" != --force ] || [ ! -s "$3" ]; then
    exit 94
fi
exit "$TEST_INSTALL_EXIT"
`);
        if (!missingCurl) {
            stub('curl', `printf '%s\\n' "$@" > "$TEST_CURL_ARGS"
while [ "$#" -gt 0 ]; do
    if [ "$1" = --output ]; then
        archive=$2
        shift 2
    else
        shift
    fi
done
printf 'release archive' > "$archive"
exit "$TEST_CURL_EXIT"
`);
        }
        const result = spawnSync('/bin/bash', [installer, ...args], {encoding: 'utf8', timeout: 5000,
            env: {...process.env, PATH: missingCurl ? bin : `${bin}:${process.env.PATH}`,
                TMPDIR: downloads, TEST_SHELL_VERSION: version, TEST_VERSION_EXIT: String(versionExit),
                TEST_CURL_EXIT: String(curlExit), TEST_INSTALL_EXIT: String(installExit),
                TEST_CURL_ARGS: join(root, 'curl-args'), TEST_INSTALL_ARGS: join(root, 'install-args')}});
        assert.ifError(result.error);
        const recorded = name => existsSync(join(root, name))
            ? readFileSync(join(root, name), 'utf8').trimEnd().split('\n') : null;
        return {...result, curlArgs: recorded('curl-args'), installArgs: recorded('install-args'),
            leftovers: readdirSync(downloads)};
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
}

for (const version of ['42', '43', '44', ...metadata['shell-version']]) {
    test(`GNOME ${version} selects and installs the matching release`, () => {
        const result = runInstaller({version: `GNOME Shell ${version}.1`});
        assert.equal(result.status, 0, result.stderr);
        const asset = Number(version) < 45 ? 'screenshot-utils-gnome42-44.shell-extension.zip'
            : 'screenshot-utils-modern.shell-extension.zip';
        assert.equal(result.curlArgs.at(-1), `https://github.com/fhaefele/screenshot-utils/releases/latest/download/${asset}`);
        assert.equal(result.curlArgs[result.curlArgs.indexOf('--proto') + 1], '=https');
        assert.equal(result.curlArgs[result.curlArgs.indexOf('--proto-redir') + 1], '=https');
        assert.deepEqual(result.installArgs.slice(0, 2), ['install', '--force']);
        assert.equal(result.installArgs[2], result.curlArgs[result.curlArgs.indexOf('--output') + 1]);
        assert.ok(result.installArgs[2].endsWith(`/${asset}`));
        assert.match(result.stdout, /Log out and back in/);
        assert.deepEqual(result.leftovers, []);
    });
}

for (const version of ['GNOME Shell 3.38.6', 'GNOME Shell 41.9', 'GNOME Shell 52.0', 'unknown']) {
    test(`Reject ${version} before downloading or installing`, () => {
        const result = runInstaller({version});
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /unsupported|Unrecognized/);
        assert.equal(result.curlArgs, null);
        assert.equal(result.installArgs, null);
        assert.deepEqual(result.leftovers, []);
    });
}

test('Version detection failure stops before downloading', () => {
    const result = runInstaller({versionExit: 1});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Could not detect/);
    assert.equal(result.curlArgs, null);
    assert.equal(result.installArgs, null);
});

test('Download failure never invokes the installer and removes partial downloads', () => {
    const result = runInstaller({curlExit: 22});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Download failed/);
    assert.equal(result.installArgs, null);
    assert.deepEqual(result.leftovers, []);
});

test('Installation failure reports failure and removes downloaded files', () => {
    const result = runInstaller({installExit: 1});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Installation failed/);
    assert.doesNotMatch(result.stdout, /Installed Screenshot Utils/);
    assert.deepEqual(result.leftovers, []);
});

test('Missing curl fails with a dependency message', () => {
    const result = runInstaller({missingCurl: true});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Required command not found: curl/);
    assert.equal(result.installArgs, null);
});

test('Help works without dependencies or network access', () => {
    const result = runInstaller({missingCurl: true, args: ['--help']});
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.curlArgs, null);
    assert.equal(result.installArgs, null);
});

test('Unexpected arguments fail before downloading', () => {
    const result = runInstaller({args: ['--system']});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.curlArgs, null);
    assert.equal(result.installArgs, null);
});
