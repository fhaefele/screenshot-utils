import assert from 'node:assert/strict';
import {DELAY_STEPS, delayToSlider, sliderToDelay, formatDelay, parseDelaySeconds} from '../delay.js';

for (const milliseconds of DELAY_STEPS)
    assert.equal(sliderToDelay(delayToSlider(milliseconds)), milliseconds);
assert.equal(sliderToDelay(-1), 0);
assert.equal(sliderToDelay(2), 30000);
assert.equal(sliderToDelay(0.3), 500);
assert.equal(delayToSlider(4000), 0.6);
assert.equal(formatDelay(0), '0 s');
assert.equal(formatDelay(100), '0.1 s');
assert.equal(formatDelay(500), '0.5 s');
assert.equal(formatDelay(1000), '1 s');
assert.equal(formatDelay(1250), '1.25 s');
assert.equal(formatDelay(30000), '30 s');

for (const [text, milliseconds] of [['0', 0], ['0.1', 100], ['0.2', 200], ['0.5', 500],
    ['0.125', 125], ['2.5', 2500], ['2,5', 2500], [' 30 ', 30000]])
    assert.equal(parseDelaySeconds(text), milliseconds);
for (const text of ['', '-1', '31', 'NaN', 'Infinity', '100ms', '2 s', '1e3', '2 seconds'])
    assert.equal(parseDelaySeconds(text), null);
