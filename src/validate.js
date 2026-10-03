import { SCHEMA_VERSION, ICON_KEYS, SOURCE_TYPES, URL_REQUIRED, MAX_TEXT, MIN_T, MIN_GAP, END_MARGIN } from './schema.js';

// The gate between model output and a published file. Never trusts the model:
// drops anything malformed/uncited, clamps times into the movie, enforces spacing.
export function validateFacts(rawFacts, runtimeSec) {
    const dropped = {};
    const drop = reason => { dropped[reason] = (dropped[reason] || 0) + 1; };
    const maxT = runtimeSec ? runtimeSec - END_MARGIN : Infinity;
    const kept = [];

    for (const f of Array.isArray(rawFacts) ? rawFacts : []) {
        if (!f || typeof f !== 'object') { drop('malformed'); continue; }
        const text = typeof f.text === 'string' ? f.text.trim().replace(/\s+/g, ' ') : '';
        if (!text) { drop('no-text'); continue; }
        if (text.length > MAX_TEXT) { drop('too-long'); continue; }
        if (!ICON_KEYS.includes(f.icon)) { drop('bad-icon'); continue; }
        const type = f.source && f.source.type;
        if (!SOURCE_TYPES.includes(type)) { drop('bad-source'); continue; }
        const url = typeof f.source.url === 'string' && /^https?:\/\//i.test(f.source.url) ? f.source.url : null;
        if (URL_REQUIRED.has(type) && !url) { drop('uncited'); continue; }
        if (typeof f.t !== 'number' || !Number.isFinite(f.t)) { drop('bad-t'); continue; }
        kept.push({
            t: Math.min(Math.max(Math.round(f.t), MIN_T), maxT),
            rank: [1, 2, 3].includes(f.rank) ? f.rank : 2,
            anchor: f.anchor === 'scene' ? 'scene' : 'spread',
            text,
            icon: f.icon,
            byline: typeof f.byline === 'string' && f.byline.trim() ? f.byline.trim() : null,
            source: url ? { type, url } : { type },
        });
    }

    kept.sort((a, b) => a.t - b.t || a.rank - b.rank);
    const facts = [];
    const seenText = new Set();
    for (const f of kept) {
        const key = f.text.toLowerCase();
        if (seenText.has(key)) { drop('duplicate'); continue; }
        const prev = facts[facts.length - 1];
        if (prev && f.t - prev.t < MIN_GAP) {
            const shifted = prev.t + MIN_GAP;
            if (shifted > maxT) { drop('no-room'); continue; }
            f.t = shifted;
        }
        seenText.add(key);
        facts.push(f);
    }
    return { facts, dropped };
}

export function buildDoc({ imdbId, title, year, runtimeSec, facts, generatedAt }) {
    return { schema: SCHEMA_VERSION, imdbId, title, year, runtimeSec, generatedAt, facts };
}
