import assert from 'node:assert/strict';
import {usableShortcut} from '../shortcuts.js';

for (const accelerator of ['<Control>F10', '<Super>s', '<Alt>Print', '<Ctrl>adiaeresis', 'F12', '<Shift>Print'])
    assert.equal(usableShortcut(accelerator), true, accelerator);
for (const accelerator of ['', 'a', 'space', 'Return', '<Shift>a', 'F36', null, '<Control>' + 'a'.repeat(257)])
    assert.equal(usableShortcut(accelerator), false, String(accelerator));
