export function sanitizeFilename(value) {
    const cleaned = value
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/g, '')
        .trim();
    let result = '';
    let bytes = 0;
    for (const character of cleaned) {
        const point = character.codePointAt(0);
        bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        // Leave space for the collision suffix and .png within NAME_MAX=255.
        if (bytes > 240)
            break;
        result += character;
    }
    return result.replace(/[. ]+$/g, '') || 'Screenshot';
}

export function buildFilename(template, date, kind, suffix = '') {
    const year = String(date.getFullYear()).padStart(4, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');
    const tokens = {
        Y: year,
        m: month,
        d: day,
        H: hour,
        M: minute,
        S: second,
        N: kind,
        date: `${year}-${month}-${day}`,
        time: `${hour}-${minute}-${second}`,
        type: kind,
    };
    const base = template.replace(/\{(date|time|type|[YmdHMSN])\}/g, (_match, token) => tokens[token]);
    return `${sanitizeFilename(base)}${suffix}.png`;
}
