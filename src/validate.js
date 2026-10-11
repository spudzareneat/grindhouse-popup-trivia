import { SCHEMA_VERSION, ICON_KEYS, SOURCE_TYPES, URL_REQUIRED, MAX_TEXT, MIN_T, MIN_GAP, END_MARGIN, cardSeconds } from './schema.js';

// The gate between model output and a published file. Never trusts the model:
// drops anything malformed/uncited, clamps times into the movie, enforces spacing.
// peopleImages: { nconst: headshotUrl|null } for the people WE fetched from IMDb --
// a fact's `person` tag is only kept for someone in this map, and its `image` URL
// always comes from here, never from the model.
// maxFacts: keep at most this many, best rank first (scene-anchored before spread on a tie).
// driveIn: the movie's Drive-In Totals card, if any -- facts are kept out of its time window.
export function validateFacts(rawFacts, runtimeSec, peopleImages = {}, maxFacts = Infinity, driveIn = null) {
    const dropped = {};
    const drop = reason => { dropped[reason] = (dropped[reason] || 0) + 1; };
    const maxT = runtimeSec ? runtimeSec - END_MARGIN : Infinity;
    const kept = [];

    for (const f of Array.isArray(rawFacts) ? rawFacts : []) {
        if (!f || typeof f !== 'object') { drop('malformed'); continue; }
        const text = typeof f.text === 'string' ? f.text.trim().replace(/\s+/g, ' ') : '';
        if (!text) { drop('no-text'); continue; }
        if (text.length > MAX_TEXT) { drop('too-long'); continue; }
        // The card shows the counts and the verdict; a bubble repeating them is the old format.
        if (driveIn && /^drive-in totals\b/i.test(text)) { drop('totals-card'); continue; }
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

    const { facts, noRoom } = spaceFacts(unique, maxT, driveInWindow(driveIn));
    if (noRoom) dropped['no-room'] = (dropped['no-room'] || 0) + noRoom;
    return { facts, dropped };
}

export function driveInWindow(driveIn) {
    return driveIn ? { start: driveIn.t, end: driveIn.t + cardSeconds(driveIn.lines.length) } : null;
}

// Sorts by t and spaces facts MIN_GAP apart; a fact inside the Drive-In Totals card's window moves to its end.
// Mutates t on the facts passed in. Shared with the backfill, which re-spaces already-published facts.
export function spaceFacts(list, maxT, win = null) {
    for (const f of list) if (win && f.t >= win.start && f.t < win.end) f.t = win.end;
    list.sort((a, b) => a.t - b.t || a.rank - b.rank);
    const facts = [];
    let noRoom = 0;
    for (const f of list) {
        const prev = facts[facts.length - 1];
        if (prev && f.t - prev.t < MIN_GAP) f.t = prev.t + MIN_GAP;
        if (f.t > maxT) { noRoom++; continue; }
        facts.push(f);
    }
    return { facts, noRoom };
}

export function buildDoc({ imdbId, title, year, runtimeSec, facts, generatedAt, driveIn = null }) {
    return {
        schema: SCHEMA_VERSION, imdbId, title, year, runtimeSec, generatedAt, facts,
        ...(driveIn ? { driveIn: { t: driveIn.t, lines: driveIn.lines, stars: driveIn.stars, says: driveIn.says } } : {}),
    };
}
