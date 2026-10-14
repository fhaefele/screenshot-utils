import assert from 'node:assert/strict';
import {usableShortcut, displayShortcut} from '../shortcuts.js';

for (const accelerator of ['<Control>F10', '<Super>s', '<Alt>Print', '<Ctrl>adiaeresis', 'F12', '<Shift>Print'])
    assert.equal(usableShortcut(accelerator), true, accelerator);
for (const accelerator of ['', 'a', 'space', 'Return', '<Shift>a', 'F36', null, '<Control>' + 'a'.repeat(257)])
    assert.equal(usableShortcut(accelerator), false, String(accelerator));

assert.equal(displayShortcut('<Control><Ctrl><Shift>c'), 'Ctrl+Shift+C');
assert.equal(displayShortcut('<Control><Shift>F10'), 'Ctrl+Shift+F10');
