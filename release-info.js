// SPDX-License-Identifier: GPL-3.0-or-later
export const REPOSITORY_URL = 'https://github.com/fhaefele/screenshot-utils';
export const RELEASE_API = 'https://api.github.com/repos/fhaefele/screenshot-utils/releases/latest';
const DAY = 24 * 60 * 60 * 1000;

function versionParts(version) {
    if (typeof version !== 'string' || version.length > 16 || !/^\d+\.\d+(?:\.\d+)?$/.test(version))
        return null;
    const parts = version.split('.').map(Number);
    return [parts[0], parts[1], parts[2] ?? 0];
}

export function isNewerRelease(candidate, installed) {
    const next = versionParts(candidate);
    const current = versionParts(installed);
    if (!next || !current)
        return false;
    for (let index = 0; index < next.length; index++) {
        if (next[index] !== current[index])
            return next[index] > current[index];
    }
    return false;
}

export function stableReleaseTag(release) {
    const tag = release?.tag_name;
    return release?.draft === false && release?.prerelease === false &&
        typeof tag === 'string' && tag.startsWith('v') && versionParts(tag.slice(1)) ? tag : null;
}

export function releaseFromMetadata(release, metadata, uuid) {
    const tag = stableReleaseTag(release);
    if (!tag || metadata?.uuid !== uuid || metadata['version-name'] !== tag.slice(1) ||
        !Array.isArray(metadata['shell-version']) || !Array.isArray(release.assets))
        return null;
    const assets = release.assets.filter(asset => asset?.state === 'uploaded').map(asset => asset.name);
    const shellVersions = [];
    if (assets.includes('screenshot-utils-gnome42-44.shell-extension.zip'))
        shellVersions.push('42', '43', '44');
    if (assets.includes('screenshot-utils-modern.shell-extension.zip'))
        shellVersions.push(...metadata['shell-version'].filter(version => typeof version === 'string' && /^\d+$/.test(version) && Number(version) >= 45));
    return {tag, shellVersions};
}

export function availableReleaseLink(release, installed, shellVersion) {
    const tag = release?.tag;
    if (typeof tag !== 'string' || !tag.startsWith('v') || !isNewerRelease(tag.slice(1), installed) ||
        !Array.isArray(release.shellVersions) || !release.shellVersions.includes(shellVersion.split('.')[0]))
        return null;
    return `${REPOSITORY_URL}/releases/tag/${tag}`;
}

export function parseReleaseCache(contents) {
    try {
        const cache = JSON.parse(contents);
        return Number.isFinite(cache?.checkedAt) && cache.checkedAt >= 0 ? cache : null;
    } catch {
        return null;
    }
}

export function releaseCheckDue(cache, now) {
    return !cache || now < cache.checkedAt || now - cache.checkedAt >= DAY;
}

export async function checkRelease({load, save, fetchJSON, uuid, installed, shellVersion,
    onResult, cancelled, now = Date.now}) {
    const cached = parseReleaseCache(await load());
    if (cancelled())
        return;
    onResult(availableReleaseLink(cached?.release, installed, shellVersion));
    if (!releaseCheckDue(cached, now()))
        return;
    const cache = {checkedAt: now(), release: cached?.release ?? null};
    // Record attempts before networking, so closing early or going offline
    // does not cause another request on every preferences opening.
    await save(cache);
    if (cancelled())
        return;
    try {
        const release = await fetchJSON(RELEASE_API);
        if (cancelled())
            return;
        const tag = stableReleaseTag(release);
        const metadata = tag ? await fetchJSON(
            `https://raw.githubusercontent.com/fhaefele/screenshot-utils/${tag}/metadata.json`) : null;
        cache.release = releaseFromMetadata(release, metadata, uuid);
    } catch {
        // Keep the last known release when GitHub is unreachable or rate-limits us.
        return;
    }
    if (cancelled())
        return;
    await save(cache);
    if (!cancelled())
        onResult(availableReleaseLink(cache.release, installed, shellVersion));
}
