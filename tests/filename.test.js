import assert from 'node:assert/strict';
import {buildFilename, sanitizeFilename} from '../filename.js';

const date = new Date(2026, 9, 12, 8, 5, 9);
assert.equal(buildFilename('{N}-{Y}{m}{d}-{H}{M}{S}', date, 'area'), 'area-20261012-080509.png');
assert.equal(buildFilename('Screenshot-{date}-{time}-{type}', date, 'screen'), 'Screenshot-2026-10-12-08-05-09-screen.png');

assert.equal(sanitizeFilename('../bad:name?'), '..-bad-name-');
assert.equal(sanitizeFilename('   '), 'Screenshot');

for (const character of ['界', '😀', 'é', 'a']) {
    const filename = buildFilename(character.repeat(300), date, 'area', '-1000');
    assert.ok(Buffer.byteLength(filename, 'utf8') <= 255);
    assert.ok(!filename.includes('\ufffd'));
    assert.ok(filename.endsWith('-1000.png'));
}
