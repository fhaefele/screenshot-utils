// SPDX-License-Identifier: GPL-3.0-or-later

// Wrap one operation without changing shared GI prototypes during import.
export function callAsync(target, method, ...args) {
    // GIO's bytes variant shares its finish method with replace_contents_async.
    const finish = method === 'replace_contents_bytes_async' ? 'replace_contents_finish'
        : method.endsWith('_async') ? `${method.slice(0, -5)}finish` : `${method}_finish`;
    return new Promise((resolve, reject) => {
        target[method](...args, (_source, result) => {
            try {
                const value = target[finish](result);
                resolve(Array.isArray(value) && value.length > 1 && value[0] === true ? value.slice(1) : value);
            } catch (error) {
                reject(error);
            }
        });
    });
}
