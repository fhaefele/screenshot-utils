import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CAPTURE_SHORTCUTS, captureCommand, migrateShortcutSettings} from '../shortcuts.js';

test('GNOME shortcut commands stay unchanged for every capture mode', () => {
    assert.deepEqual(CAPTURE_SHORTCUTS.map(({mode}) => mode), ['selection', 'screen', 'window']);
    for (const {mode} of CAPTURE_SHORTCUTS)
        assert.equal(captureCommand(mode), `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/shell/extensions/screenshotutils --method dev.fxth.ScreenshotUtils.Capture ${mode}`);
});

test('upgrades preserve GNOME permissions and revoke legacy native permissions once', () => {
    for (const source of ['', 'gnome', 'extension']) {
        for (const enabled of [false, true]) {
            for (const ask of [false, true]) {
                const values = {'shortcut-setup': source, 'shortcuts-enabled': enabled, 'ask-command-confirmation': ask};
                const settings = {
                    get_string: key => values[key],
                    set_string: (key, value) => { values[key] = value; },
                    set_boolean: (key, value) => { values[key] = value; },
                };
                migrateShortcutSettings(settings);
                assert.deepEqual(values, {
                    'shortcut-setup': 'gnome',
                    'shortcuts-enabled': source === 'gnome' ? enabled : false,
                    'ask-command-confirmation': source === 'gnome' ? ask : true,
                });
                settings.set_boolean('shortcuts-enabled', true);
                settings.set_boolean('ask-command-confirmation', false);
                migrateShortcutSettings(settings);
                assert.equal(values['shortcuts-enabled'], true);
                assert.equal(values['ask-command-confirmation'], false);
            }
        }
    }
});
