import { SCHEMA_VERSION, ICON_KEYS, SOURCE_TYPES, URL_REQUIRED, MAX_TEXT, MIN_T, MIN_GAP, END_MARGIN } from './schema.js';

// The gate between model output and a published file. Never trusts the model:
// drops anything malformed/uncited, clamps times into the movie, enforces spacing.
// peopleImages: { nconst: headshotUrl|null } for the people WE fetched from IMDb --
// a fact's `person` tag is only kept for someone in this map, and its `image` URL
// always comes from here, never from the model.
// maxFacts: keep at most this many, best rank first (scene-anchored before spread on a tie).
export function validateFacts(rawFacts, runtimeSec, peopleImages = {}, maxFacts = Infinity) {
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
        const person = typeof f.person === 'string' && Object.hasOwn(peopleImages, f.person) ? f.person : null;
        const image = person ? peopleImages[person] || null : null;
        kept.push({
            t: Math.min(Math.max(Math.round(f.t), MIN_T), maxT),
            rank: [1, 2, 3].includes(f.rank) ? f.rank : 2,
            anchor: f.anchor === 'scene' ? 'scene' : 'spread',
            text,
            icon: f.icon,
            byline: typeof f.byline === 'string' && f.byline.trim() ? f.byline.trim() : null,
            source: url ? { type, url } : { type },
            ...(person ? { person } : {}),
            ...(image ? { image } : {}),
        });
    }

    const seenText = new Set();
    let unique = kept.filter(f => {
        const key = f.text.toLowerCase();
        if (seenText.has(key)) { drop('duplicate'); return false; }
        seenText.add(key);
        return true;
    });
    if (unique.length > maxFacts) {
        const best = new Set(unique.slice().sort((a, b) => a.rank - b.rank || (a.anchor === 'scene' ? 0 : 1) - (b.anchor === 'scene' ? 0 : 1)).slice(0, maxFacts));
        dropped['over-cap'] = unique.length - maxFacts;
        unique = unique.filter(f => best.has(f));
    }

    unique.sort((a, b) => a.t - b.t || a.rank - b.rank);
    const facts = [];
    for (const f of unique) {
        const prev = facts[facts.length - 1];
        if (prev && f.t - prev.t < MIN_GAP) {
            const shifted = prev.t + MIN_GAP;
            if (shifted > maxT) { drop('no-room'); continue; }
            f.t = shifted;
        }
        facts.push(f);
    }
    return { facts, dropped };
}

export function buildDoc({ imdbId, title, year, runtimeSec, facts, generatedAt }) {
    return { schema: SCHEMA_VERSION, imdbId, title, year, runtimeSec, generatedAt, facts };
}
