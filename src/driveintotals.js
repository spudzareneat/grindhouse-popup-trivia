import { getText } from './http.js';
import { titlesMatch } from './titles.js';

// Joe Bob Briggs' Drive-In Totals, transcribed in spudzareneat/DriveInTotals.
export const TOTALS_CSV_URL = 'https://raw.githubusercontent.com/spudzareneat/DriveInTotals/main/drivein_totals.csv';

// Minimal RFC 4180 parser: quoted fields, "" escapes, embedded commas/newlines, CRLF.
export function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') inQuotes = false;
            else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); rows.push(row); row = []; field = '';
        } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

export function parseTotals(text) {
    const [header, ...rows] = parseCsv(text);
    const col = name => header.indexOf(name);
    const ti = col('title'), yi = col('year'), di = col('description');
    return rows
        .map(r => ({ title: (r[ti] || '').trim(), year: /^\d{4}$/.test((r[yi] || '').trim()) ? Number(r[yi]) : null, description: (r[di] || '').trim() }))
        .filter(r => r.title && r.description && !/^not_found$/i.test(r.description));   // transcription placeholder
}

// With a year: exact year first, then +-1. Without a year: only when exactly one
// row has that title (never guess between e.g. The Fly 1958 and 1986).
export function findTotals(rows, title, year) {
    const hits = rows.filter(r => titlesMatch(r.title, title));
    if (!hits.length) return null;
    if (year) {
        const exact = hits.find(r => r.year === year);
        if (exact) return exact.description;
        const near = hits.find(r => r.year && Math.abs(r.year - year) <= 1);
        return near ? near.description : null;
    }
    return hits.length === 1 ? hits[0].description : null;
}

export async function fetchTotals(fetchImpl = fetch) {
    return parseTotals(await getText(fetchImpl, TOTALS_CSV_URL));
}

// ── Drive-In Totals card ──
// Splits Joe Bob's Totals paragraph for the userscript's Drive-In Totals card, deterministically (no Claude).
// Counts and Fu's -> card lines (MonsterVision style: digits, Title Case); the star verdict -> stars + sign-off;
// award nominations, Hall of Fame, quotes and cast call-outs need context, so they go to Claude as `awards`.

const ABBREV = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'vs', 'etc', 'approx', 'lt', 'sgt', 'capt', 'col', 'gen', 'prof', 'mt']);

// Sentence split that ignores periods inside quotes/parentheses, after abbreviations and initials.
export function splitSentences(text) {
    const out = [];
    let buf = '', depth = 0, inQuote = false;
    for (const c of text) {
        if (c === '(') depth++;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if (c === '"') inQuote = !inQuote;
        else if (c === '\u201c') inQuote = true;
        else if (c === '\u201d') inQuote = false;
        if (/\s/.test(c) && depth === 0 && !inQuote && /[.!?]["'\u201d\u2019)]*$/.test(buf)) {
            const lastWord = (buf.match(/([A-Za-z]+)\.$/) || [])[1];
            const initial = /(^|\s)[A-Z]\.$/.test(buf);
            if (!(lastWord && ABBREV.has(lastWord.toLowerCase())) && !initial) {
                if (buf.trim()) out.push(buf.trim());
                buf = '';
                continue;
            }
        }
        buf += c;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
}

const STAR_WORDS = { zero: 0, no: 0, one: 1, two: 2, three: 3, four: 4 };
const STAR_RE = /\b(zero|no|one|two|three|four|[0-4](?:\.5)?)(\s+and\s+(?:a\s+)?half)?\s+stars?\b/i;
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'n', 'vs']);
const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

// "Seventy-Six breasts" -> "76 breasts". Only the number phrase that starts the line ("Including One With..." stays).
export function leadingNumberToDigits(s) {
    const m = s.match(/^((?:one|a)\s+hundred\s+(?:and\s+)?)?([a-z]+)(?:[-\s]([a-z]+))?\b/i);
    if (!m) return s;
    const hundred = m[1] ? 100 : 0;
    const w1 = m[2].toLowerCase(), w2 = m[3] && m[3].toLowerCase();
    const t = TENS.indexOf(w1), u2 = w2 ? UNITS.indexOf(w2) : -1;
    if (t >= 2 && u2 >= 1 && u2 <= 9) return `${hundred + t * 10 + u2}${s.slice(m[0].length)}`;
    if (t >= 2) return `${hundred + t * 10}${s.slice((m[1] || '').length + m[2].length)}`;
    if (UNITS.includes(w1)) return `${hundred + UNITS.indexOf(w1)}${s.slice((m[1] || '').length + m[2].length)}`;
    return s;
}

// Capitalize each word (and each hyphenated part); small words stay lower mid-line. Never lowercases
// the rest of a word, so "McCoy" and "TV" survive.
export function titleCase(s) {
    let first = true;
    return s.replace(/[A-Za-z][A-Za-z']*/g, (w, off) => {
        const prev = s[off - 1];
        const lead = first || prev === '(' || prev === '-';
        first = false;
        if (!lead && SMALL_WORDS.has(w.toLowerCase())) return w.toLowerCase();
        return w[0].toUpperCase() + w.slice(1);
    });
}

export function cleanLine(sentence) {
    let s = sentence.trim().replace(/\.+$/, '').trim();
    s = s.replace(/^(?:we(?:'ve)?\s+(?:got|have)\s+(?:a\s+total\s+of\s+)?|we're\s+talking\s+|there\s+(?:are|is|were|was)\s+)/i, '');
    s = s.replace(/^approximately\b/i, 'About');
    return titleCase(leadingNumberToDigits(s));
}

// Cast call-outs and quoted lines need context -- they go to Claude with the awards, not on the card.
const isAwardish = s => /hall of fame/i.test(s) || /["\u201c]/.test(s) || /^(?:and\s+)?with\s.+\sas\s/i.test(s) || /^for\s/i.test(s);
const startsAwards = s => /academy|drive-im|\bdiaa\b/i.test(s);

function normalizeSays(says) {
    const t = says.trim();
    return /^(?:joe bob says? )?check it out\.?$/i.test(t) ? 'Joe Bob says check it out.' : t;
}

// The userscript's limits (tpValidateDriveIn) -- enforced here so the client never has to cut anything.
const MAX_LINES = 60, MAX_LINE = 300, MAX_SAYS = 120;
// "I give it about, oh, two stars." -- the words that lead into the rating aren't a count.
const RATING_LEADIN = /(?:^|\s)(?:don't get your hopes up--)?(?:i(?:'ll)?\s+give\s+(?:it|this(?:\s+\w+)?)(?:\s+about)?(?:,?\s*oh)?|we're\s+talking|a\s+definite)$/i;
const CONNECTIVE = /^(?:and|but|also|plus|so)$/i;
const SIGN_OFF = /check (?:it|this) out|joe bob/i;
const trimTail = s => s.replace(/[\s,;:.-]+$/, '');
function clip(s, max) {
    if (s.length <= max) return s;
    const cut = s.lastIndexOf(' ', max - 1);
    return trimTail(s.slice(0, cut > 0 ? cut : max - 1)) + '…';
}

export function parseTotalsCard(description) {
    const sentences = splitSentences(description || '');
    let vi = -1;
    for (let i = sentences.length - 1; i >= 0; i--) if (STAR_RE.test(sentences[i])) { vi = i; break; }
    let stars = null, says = '', body = sentences;
    if (vi >= 0) {
        const v = sentences[vi], m = v.match(STAR_RE);
        const w = m[1].toLowerCase();
        const n = (w in STAR_WORDS ? STAR_WORDS[w] : Number(w)) + (m[2] ? 0.5 : 0);
        stars = Math.min(4, Math.max(0, Math.round(n * 2) / 2));
        const rest = v.slice(m.index + m[0].length).replace(/^[\s.,;:!-]+/, '');
        // The sign-off is the "check it out" sentence (plus one short remark before it, e.g. "Outstanding.").
        // Counts that follow a mid-paragraph rating ("Three and a half stars. Heads roll. ...") stay counts.
        const after = sentences.slice(vi + 1);
        const k = after.findIndex(s => SIGN_OFF.test(s));
        let signOff = [], extra = [];
        if (k >= 0 && k <= 1) { signOff = after.slice(0, k + 1); extra = after.slice(k + 1); }
        else if (k > 1) { signOff = [after[k]]; extra = [...after.slice(0, k), ...after.slice(k + 1)]; }
        else if (after.length <= 1) signOff = after;
        else extra = after;
        says = normalizeSays([rest, ...signOff].filter(Boolean).join(' '));
        if (says.length > MAX_SAYS) says = clip(normalizeSays(signOff.at(-1) || rest), MAX_SAYS);
        // "We have 103 dead bodies, ..., three stars." -- an inline list is one count per item.
        const before = trimTail(trimTail(v.slice(0, m.index)).replace(RATING_LEADIN, ''));
        // "I give it about ... three stars." splits at the "...", leaving the lead-in as the sentence before.
        const prior = sentences.slice(0, vi);
        while (prior.length && !trimTail(prior.at(-1))) prior.pop();   // ". . ." pieces
        const lead = prior.length ? trimTail(prior.at(-1)) : '';
        if (!before && RATING_LEADIN.test(lead)) {
            const last = trimTail(lead.replace(RATING_LEADIN, ''));
            if (last) prior[prior.length - 1] = last; else prior.pop();
        }
        body = [...prior, ...(before ? before.split(/,\s+(?:and\s+)?/) : []), ...extra];
    }
    const lines = [], awards = [];
    let inAwards = false;
    for (const s of body) {
        if (startsAwards(s)) inAwards = true;
        if (inAwards || isAwardish(s)) { awards.push(s); continue; }
        // A long comma list ("103 dead bodies, one dead Neanderthal, ...") is one count per item;
        // a short one ("One motor vehicle chase, with watery crash") stays a single line.
        const parts = s.split(/,\s+(?:and\s+)?/);
        for (const part of parts.length >= 4 ? parts : [s]) {
            const line = cleanLine(part);
            if (line && !CONNECTIVE.test(line)) lines.push(clip(line, MAX_LINE));
        }
    }
    return { lines: lines.slice(0, MAX_LINES), stars, says, awards: awards.join(' ') };
}
