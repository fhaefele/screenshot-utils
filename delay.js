// SPDX-License-Identifier: GPL-3.0-or-later
export const DELAY_STEPS = [0, 100, 200, 500, 1000, 2000, 3000, 5000, 10000, 15000, 30000];

export function delayToSlider(milliseconds) {
    let nearest = 0;
    for (let index = 1; index < DELAY_STEPS.length; index++) {
        if (Math.abs(DELAY_STEPS[index] - milliseconds) < Math.abs(DELAY_STEPS[nearest] - milliseconds))
            nearest = index;
    }
    return nearest / (DELAY_STEPS.length - 1);
}

export function sliderToDelay(value) {
    const index = Math.round(Math.max(0, Math.min(1, value)) * (DELAY_STEPS.length - 1));
    return DELAY_STEPS[index];
}

export function formatDelay(milliseconds) {
    return `${milliseconds / 1000} s`;
}

export function parseDelaySeconds(text) {
    const match = text.trim().match(/^(\d+(?:[.,]\d+)?)$/);
    if (!match)
        return null;
    const milliseconds = Number(match[1].replace(',', '.')) * 1000;
    return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= 30000
        ? Math.round(milliseconds) : null;
}
