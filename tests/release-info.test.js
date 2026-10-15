import assert from 'node:assert/strict';
import test from 'node:test';
import {availableReleaseLink, checkRelease, isNewerRelease, parseReleaseCache,
    RELEASE_API, releaseCheckDue, releaseFromMetadata, stableReleaseTag} from '../release-info.js';

const uuid = 'screenshot-utils@fxth.dev';
const now = 1_800_000_000_000;
const day = 24 * 60 * 60 * 1000;
const release = {tag_name: 'v2.4', draft: false, prerelease: false, assets: [
    {name: 'screenshot-utils-modern.shell-extension.zip', state: 'uploaded'},
    {name: 'screenshot-utils-gnome42-44.shell-extension.zip', state: 'uploaded'},
]};
const metadata = {uuid, 'version-name': '2.4', 'shell-version': ['46', '50', '51']};
const candidate = releaseFromMetadata(release, metadata, uuid);
const link = 'https://github.com/fhaefele/screenshot-utils/releases/tag/v2.4';

async function runCheck({cache = null, failure = false, cancelled = () => false, installed = '2.3.2',
    clock = () => now, onSave = () => {}, onFetch = () => {}} = {}) {
    const requests = [];
    const saves = [];
    const results = [];
    await checkRelease({uuid, installed, shellVersion: '50.1', now: clock, cancelled,
        load: async () => cache === null ? '' : JSON.stringify(cache),
        save: async value => {
            saves.push(JSON.parse(JSON.stringify(value)));
            onSave();
        },
        fetchJSON: async url => {
            requests.push(url);
            onFetch();
            if (failure)
                throw new Error('Offline or rate-limited');
            return url === RELEASE_API ? release : metadata;
        },
        onResult: value => results.push(value)});
    return {requests, saves, results};
}

test('Compare numeric releases, including two-part versions', () => {
    assert.ok(isNewerRelease('2.10', '2.9.9'));
    assert.ok(isNewerRelease('2.3.2', '2.3'));
    assert.ok(isNewerRelease('3.0', '2.99.99'));
    assert.equal(isNewerRelease('2.3.0', '2.3'), false);
    assert.equal(isNewerRelease('2.3.1', '2.3.2'), false);
    for (const invalid of ['', 'v2.4', '2.4-beta', '../2.4', null, '2.4.0.1']) {
        assert.equal(isNewerRelease(invalid, '2.3'), false);
        assert.equal(isNewerRelease('2.4', invalid), false);
    }
});

test('Only stable releases with matching metadata and uploaded assets qualify', () => {
    assert.deepEqual(candidate, {tag: 'v2.4', shellVersions: ['42', '43', '44', '46', '50', '51']});
    assert.equal(stableReleaseTag({...release, prerelease: true}), null);
    assert.equal(stableReleaseTag({...release, draft: true}), null);
    assert.equal(stableReleaseTag({...release, tag_name: 'v2.4/../../main'}), null);
    assert.equal(releaseFromMetadata(release, {...metadata, uuid: 'another@example.com'}, uuid), null);
    assert.equal(releaseFromMetadata(release, {...metadata, 'version-name': '2.3'}, uuid), null);
    assert.equal(releaseFromMetadata(release, null, uuid), null);
    assert.equal(availableReleaseLink(candidate, '2.3.2', '50.1'), link);
    assert.equal(availableReleaseLink(candidate, '2.4', '50.1'), null);
    assert.equal(availableReleaseLink(candidate, '2.3.2', '45.6'), null);
    assert.equal(availableReleaseLink(candidate, '2.3.2', '52.0'), null);
    assert.equal(availableReleaseLink(candidate, '2.3.2', '42.9'), link);
    const modernOnly = releaseFromMetadata({...release, assets: release.assets.slice(0, 1)}, metadata, uuid);
    assert.equal(availableReleaseLink(modernOnly, '2.3.2', '42.9'), null);
    const unavailable = releaseFromMetadata({...release, assets: release.assets.map(asset => ({...asset, state: 'new'}))}, metadata, uuid);
    assert.equal(availableReleaseLink(unavailable, '2.3.2', '50.1'), null);
});

test('Cache parsing rejects invalid timestamps and handles clock rollback', () => {
    for (const contents of ['', '{', 'null', '[]', '{"checkedAt":-1}', '{"checkedAt":"123"}'])
        assert.equal(parseReleaseCache(contents), null);
    const cache = parseReleaseCache(JSON.stringify({checkedAt: now, release: candidate}));
    assert.equal(releaseCheckDue(cache, now + day - 1), false);
    assert.equal(releaseCheckDue(cache, now + day), true);
    assert.equal(releaseCheckDue(cache, now - 1), true);
    assert.equal(releaseCheckDue(null, now), true);
});

test('Fresh cache shows the release link without networking or writes', async () => {
    const result = await runCheck({cache: {checkedAt: now - day + 1, release: candidate}});
    assert.deepEqual(result.requests, []);
    assert.deepEqual(result.saves, []);
    assert.deepEqual(result.results, [link]);
});

test('Expired cache checks release metadata and records the daily attempt first', async () => {
    const result = await runCheck({cache: {checkedAt: now - day, release: null}});
    assert.deepEqual(result.requests, [RELEASE_API,
        'https://raw.githubusercontent.com/fhaefele/screenshot-utils/v2.4/metadata.json']);
    assert.deepEqual(result.saves, [{checkedAt: now, release: null}, {checkedAt: now, release: candidate}]);
    assert.deepEqual(result.results, [null, link]);
});

test('Offline checks retain the cached link and wait a day before retrying', async () => {
    const failed = await runCheck({cache: {checkedAt: now - day, release: candidate}, failure: true});
    assert.deepEqual(failed.results, [link]);
    assert.deepEqual(failed.saves, [{checkedAt: now, release: candidate}]);
    const reopened = await runCheck({cache: failed.saves[0]});
    assert.deepEqual(reopened.requests, []);
    assert.deepEqual(reopened.results, [link]);
});

test('Updating the installed version hides a cached release notice', async () => {
    const result = await runCheck({cache: {checkedAt: now, release: candidate}, installed: '2.4'});
    assert.deepEqual(result.results, [null]);
    assert.deepEqual(result.requests, []);
});

test('Closing preferences prevents networking and late UI updates', async () => {
    let closed = false;
    const result = await runCheck({cancelled: () => closed, onSave: () => { closed = true; }});
    assert.deepEqual(result.requests, []);
    assert.deepEqual(result.results, [null]);
    assert.equal(result.saves.length, 1);
    const alreadyClosed = await runCheck({cancelled: () => true});
    assert.deepEqual(alreadyClosed.results, []);
    assert.deepEqual(alreadyClosed.saves, []);
});

test('Closing during the first response skips the metadata request and late updates', async () => {
    let closed = false;
    const result = await runCheck({cancelled: () => closed, onFetch: () => { closed = true; }});
    assert.deepEqual(result.requests, [RELEASE_API]);
    assert.deepEqual(result.results, [null]);
    assert.equal(result.saves.length, 1);
});
