import assert from 'node:assert/strict';
import {callAsync} from '../async-utils.js';

const result = {};
const cancellable = {};
const target = {
    operation_async(argument, cancel, callback) {
        assert.equal(this, target);
        assert.equal(argument, 42);
        assert.equal(cancel, cancellable);
        queueMicrotask(() => callback(this, result));
    },
    operation_finish(value) {
        assert.equal(this, target);
        assert.equal(value, result);
        return 7;
    },
};
const original = target.operation_async;
assert.equal(await callAsync(target, 'operation_async', 42, cancellable), 7);
assert.equal(target.operation_async, original);

const capture = {
    capture(callback) { callback(null, result); },
    capture_finish() { return [true, 'content', 2]; },
};
assert.deepEqual(await callAsync(capture, 'capture'), ['content', 2]);
capture.capture_finish = () => [false, 'content'];
assert.deepEqual(await callAsync(capture, 'capture'), [false, 'content']);
capture.capture_finish = () => true;
assert.equal(await callAsync(capture, 'capture'), true);
const cancelled = new Error('Cancelled');
capture.capture_finish = () => { throw cancelled; };
await assert.rejects(callAsync(capture, 'capture'), error => error === cancelled);
capture.capture = () => { throw cancelled; };
await assert.rejects(callAsync(capture, 'capture'), error => error === cancelled);

const bytesWriter = {
    replace_contents_bytes_async(...args) { args.at(-1)(this, 'write-result'); },
    replace_contents_finish(result) {
        assert.equal(result, 'write-result');
        return [true, 'new-etag'];
    },
};
assert.deepEqual(await callAsync(bytesWriter, 'replace_contents_bytes_async', 'bytes', null, false, 0, null), ['new-etag']);
