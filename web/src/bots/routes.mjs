/** Adjacent AI pages keep the desktop pager; settings/history/schedules do not. */
export function isAiPagerHash(hash) {
    return /^#\/(?:chat|bots)(?:\/|$|\?)/.test(hash ?? '');
}

export function botsSessionFromHash(hash = globalThis.location?.hash ?? '') {
    const match = String(hash).match(/^#\/bots\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : undefined;
}
