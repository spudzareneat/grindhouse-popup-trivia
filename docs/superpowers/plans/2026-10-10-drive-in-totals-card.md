# Drive-In Totals Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Drive-In Totals:" text bubbles with one MonsterVision-style Drive-In Totals card at 15 s — Joe Bob's counts roll in, then a graphic star rating and his sign-off.

**Architecture:** The generator parses Joe Bob's Totals paragraph deterministically into `{ lines, stars, says, awards }`, writes `lines/stars/says` to a new optional top-level `driveIn` field in each movie JSON (schema stays 1), and only asks Claude for award-nomination bubbles. The userscript's `trivia-popup` module validates `driveIn`, shows the card at `driveIn.t` (synced, all tiers, catch-up for late joiners, once per movie), and holds bubbles while it's up.

**Tech Stack:** Node ≥ 22 ESM, `node --test` (generator). Userscript: IIFE fragments assembled by `scripts/assemble.mjs`, tests are plain `node scripts/test-*.mjs` that slice code between test markers.

**Spec:** `docs/superpowers/specs/2026-10-10-drive-in-totals-card-design.md` (approved mockup: `docs/superpowers/specs/2026-10-10-drive-in-totals-card-mockup.html`, mode A).

**Repos:**
- Generator: `C:\Repos\grindhouse-popup-trivia`, branch `drive-in-totals-card` (exists; spec commits are on it). Tests: `npm test`.
- Userscript: `C:\Repos\cytube_tv_interface_script`, create branch `drive-in-totals-card` from `main`. Tests: `node scripts/test-trivia-timeline.mjs`, `node scripts/test-trivia-icons.mjs`, `node scripts/test-popupvideo-build.mjs`.

## Global Constraints

- Card time: `DRIVEIN_T = 15` seconds (exempt from the 60 s no-fact floor, which still applies to bubbles).
- Contract: optional top-level `"driveIn": { "t": 15, "lines": [string…], "stars": number 0–4 in 0.5 steps | null, "says": string }`; `schema` stays `1`; no Totals or no card lines → no `driveIn` field.
- Look: transparent (no panel); font **Patua One** (Google Fonts) with `Georgia, serif` fallback; header `#a6e27a`, rule `#c8352b`, lines `#f4e8c6`, stars `#f5d76e`; shadows `2px 2px 0 #000` + soft glow; long lines wrap, never ellipsize; overflowing lists scroll (oldest roll off the top).
- Timing: header 0.9 s → one line every 1.1 s → 1.2 s pause → lines out 0.6 s → stars 0.15 s + 4 × 0.28 s → sign-off → 5 s hold → 0.8 s fade. No fixed total length.
- Bubbles never overlap the card; the card shows on every frequency tier, once per movie (seen-list), never while muted, never blocks clicks (`pointer-events: none`), no sound.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Match surrounding code style: 4-space indent, terse comments explaining *why*, no new dependencies.

## Review Focus

1. **A Totals row that yields no card lines** (e.g. the "Scare Package" anthology row) → no `driveIn`, prompt falls back to the old Totals text so Joe Bob still shows up as bubbles. Test: Task 4 Step 1 (second test).
2. **A huge list** (Deathgasm has 48 lines → card ≈ 64 s, ending after the 60 s floor) → bubbles that would land under the card move after it, spacing kept. Test: Task 2 Step 1 (48-line window test).
3. **Hand-edited file with a malformed `driveIn`** (string `t`, empty lines, junk stars) → card ignored or normalized, facts unaffected. Test: Task 6 Step 1.
4. **Backfill run twice** → second run changes and commits nothing. Test: Task 5 Step 1 (`runBackfill` test).
5. **Movie changes or viewer mutes while the card is up** → card removed (instantly on movie change, fade on mute), not replayed. Covered by code in Task 7 Steps 5–6 plus the manual checks in Task 8 Step 5 (DOM code has no unit harness in this repo).

---

## Part 1 — Generator (`C:\Repos\grindhouse-popup-trivia`)

### Task 1: Totals card parser

**Files:**
- Modify: `src/driveintotals.js` (append after `findTotals`)
- Create: `test/fixtures/drivein_totals.csv` (copy of the real CSV)
- Create: `test/driveintotals-card.test.js`

**Interfaces:**
- Consumes: `parseTotals(text)` (existing, `src/driveintotals.js`)
- Produces: `parseTotalsCard(description: string) → { lines: string[], stars: number|null, says: string, awards: string }`; also exported for tests: `splitSentences(text) → string[]`, `leadingNumberToDigits(s) → string`, `titleCase(s) → string`, `cleanLine(sentence) → string`.

- [ ] **Step 1: Copy the real CSV as a fixture**

```bash
mkdir -p test/fixtures && cp /c/Repos/DriveInTotals/drivein_totals.csv test/fixtures/drivein_totals.csv
```

- [ ] **Step 2: Write the failing tests** — `test/driveintotals-card.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseTotals, parseTotalsCard, splitSentences, leadingNumberToDigits, titleCase } from '../src/driveintotals.js';

const CARNIVAL = 'No breasts (1962). Nineteen dead bodies. Approximately 15 zombies. One motor vehicle chase, with watery crash. '
    + 'Zombie bus tour. Church organ Fu. Zombie Fu. Drive-In Academy Award nominations for Candace Hilligoss, for saying '
    + '"I don\'t belong in the world"; and Herk Harvey, for producing, directing, and playing the Head Zombie. '
    + 'In the Drive-In Hall of Fame. Four stars. Joe Bob says check it out.';

test('parseTotalsCard: Carnival of Souls -> MonsterVision lines, 4 stars, awards kept for Claude', () => {
    const c = parseTotalsCard(CARNIVAL);
    assert.deepEqual(c.lines, ['No Breasts (1962)', '19 Dead Bodies', 'About 15 Zombies', '1 Motor Vehicle Chase, with Watery Crash',
        'Zombie Bus Tour', 'Church Organ Fu', 'Zombie Fu']);
    assert.equal(c.stars, 4);
    assert.equal(c.says, 'Joe Bob says check it out.');
    assert.match(c.awards, /^Drive-In Academy Award nominations for Candace Hilligoss/);
    assert.match(c.awards, /In the Drive-In Hall of Fame\.$/);
});
test('parseTotalsCard: "We\'ve Got" / "We Have A Total Of" lead-ins, half stars', () => {
    const sea = parseTotalsCard("We've Got Fifteen Complete Kung Fu Fight Scenes, Including Everything From One-On-One to Four-On-One to Eight-On-One. "
        + 'We Got Three Complete Kung Fu Comedy Scenes. No Beasts. Five Corpses. Three and a half stars. Joe Bob says check it out.');
    assert.deepEqual(sea.lines, ['15 Complete Kung Fu Fight Scenes, Including Everything from One-On-One to Four-On-One to Eight-On-One',
        '3 Complete Kung Fu Comedy Scenes', 'No Beasts', '5 Corpses']);
    assert.equal(sea.stars, 3.5);
    const torture = parseTotalsCard('We Have A Total Of Seventy-Six Breasts. Heads Roll (four times). Three and a half stars. Joe Bob says check it out.');
    assert.deepEqual(torture.lines, ['76 Breasts', 'Heads Roll (Four Times)']);
});
test('parseTotalsCard: one long comma list with the rating inline', () => {
    const c = parseTotalsCard('We have 103 dead bodies, one dead Neanderthal, two partial breasts, sword fighting, skeleton food, three stars.');
    assert.deepEqual(c.lines, ['103 Dead Bodies', '1 Dead Neanderthal', '2 Partial Breasts', 'Sword Fighting', 'Skeleton Food']);
    assert.equal(c.stars, 3);
    assert.equal(c.says, '');
});
test('parseTotalsCard: "Drive-Im" typo still starts the awards', () => {
    const c = parseTotalsCard('Five dead bodies. Forhorn fu. Drive-Im academy nominations for: John Karlen. Danielle Ouimet. Four stars. Joe Bob says check it out.');
    assert.deepEqual(c.lines, ['5 Dead Bodies', 'Forhorn Fu']);
    assert.equal(c.awards, 'Drive-Im academy nominations for: John Karlen. Danielle Ouimet.');
});
test('parseTotalsCard: sign-off kept as written, bare "Check it out." normalized', () => {
    assert.equal(parseTotalsCard('Ten dead bodies. Four stars. Outstanding. Joe Bob says check it out.').says, 'Outstanding. Joe Bob says check it out.');
    assert.equal(parseTotalsCard('Two dead bodies. Two stars. Check it out.').says, 'Joe Bob says check it out.');
});
test('parseTotalsCard: quotes and cast call-outs go to awards, not the card', () => {
    const c = parseTotalsCard('Twelve dead bodies. With Bryan Madorsky as the kid who boils a cat. '
        + 'Tripp has the best line: "We accidentally summoned these demons." Two stars.');
    assert.deepEqual(c.lines, ['12 Dead Bodies']);
    assert.match(c.awards, /Bryan Madorsky/);
    assert.match(c.awards, /best line/);
});
test('parseTotalsCard: no verdict / empty input', () => {
    assert.deepEqual(parseTotalsCard('Two dead bodies. Kung fu.'), { lines: ['2 Dead Bodies', 'Kung Fu'], stars: null, says: '', awards: '' });
    assert.deepEqual(parseTotalsCard(''), { lines: [], stars: null, says: '', awards: '' });
});
test('splitSentences ignores periods in quotes, parentheses, abbreviations', () => {
    assert.deepEqual(splitSentences('Mr. T fights. Heads roll (twice. maybe). He said "Stop. Now." Done.'),
        ['Mr. T fights.', 'Heads roll (twice. maybe).', 'He said "Stop. Now."', 'Done.']);
});
test('leadingNumberToDigits converts only the leading number phrase', () => {
    assert.equal(leadingNumberToDigits('Seventy-Six breasts'), '76 breasts');
    assert.equal(leadingNumberToDigits('Twenty dead bodies'), '20 dead bodies');
    assert.equal(leadingNumberToDigits('One hundred and twelve corpses'), '112 corpses');
    assert.equal(leadingNumberToDigits('Including One With a brush'), 'Including One With a brush');
    assert.equal(leadingNumberToDigits('Oneida Fu'), 'Oneida Fu');
});
test('titleCase keeps small words low mid-line and never lowercases', () => {
    assert.equal(titleCase('blood slurpin (with explosions) n burn'), 'Blood Slurpin (With Explosions) n Burn');
    assert.equal(titleCase('TV repairman of the year'), 'TV Repairman of the Year');
});
test('parseTotalsCard: every real Totals row', () => {
    const rows = parseTotals(fs.readFileSync(new URL('./fixtures/drivein_totals.csv', import.meta.url), 'utf8'));
    assert.ok(rows.length > 300);
    const noCard = [];
    for (const r of rows) {
        const c = parseTotalsCard(r.description);
        assert.ok(c.lines.every(l => l.trim()), `${r.title}: empty line`);
        if (/\bstars?\b/i.test(r.description)) assert.notEqual(c.stars, null, `${r.title}: rating not parsed`);
        if (!c.lines.length) noCard.push(r.title);
    }
    assert.ok(noCard.length <= 2, `rows without a card: ${noCard.join(', ')}`);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/driveintotals-card.test.js`
Expected: FAIL — `parseTotalsCard` (and the helpers) are not exported.

- [ ] **Step 4: Implement** — append to `src/driveintotals.js`:

```js
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
        says = normalizeSays([rest, ...sentences.slice(vi + 1)].filter(Boolean).join(' '));
        const before = v.slice(0, m.index).replace(/[\s,;:.-]+$/, '');   // "We have 103 dead bodies, ..., three stars."
        body = [...sentences.slice(0, vi), ...(before ? [before] : [])];
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
            if (line) lines.push(line);
        }
    }
    return { lines, stars, says, awards: awards.join(' ') };
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `node --test test/driveintotals-card.test.js` → all PASS. Then `npm test` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/driveintotals.js test/driveintotals-card.test.js test/fixtures/drivein_totals.csv
git commit -m "feat(totals): parse Drive-In Totals into card lines, stars and awards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Card constants, validator window, `driveIn` in the doc

**Files:**
- Modify: `src/schema.js` (add constants after `WEB_SHARE`)
- Modify: `src/validate.js` (whole spacing tail of `validateFacts`, `buildDoc`)
- Test: `test/validate.test.js` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `schema.js`: `DRIVEIN_T = 15`; `cardSeconds(n: number) → number` = `Math.ceil(11.1 + 1.1 * n)`.
  - `validate.js`: `driveInWindow(driveIn|null) → { start, end } | null`; `spaceFacts(facts, maxT, win|null) → { facts, noRoom }` (mutates `t` on the facts passed in); `validateFacts(rawFacts, runtimeSec, peopleImages = {}, maxFacts = Infinity, driveIn = null)`; `buildDoc({ imdbId, title, year, runtimeSec, facts, generatedAt, driveIn = null })`.
  - `driveIn` shape everywhere: `{ t: number, lines: string[], stars: number|null, says: string }`.

- [ ] **Step 1: Write the failing tests** — append to `test/validate.test.js` (update the import line to `import { validateFacts, buildDoc, spaceFacts, driveInWindow } from '../src/validate.js';` and `import { ICON_KEYS, MODEL_OUTPUT_SCHEMA, cardSeconds, DRIVEIN_T } from '../src/schema.js';`):

```js
const DI = (n) => ({ t: 15, lines: Array(n).fill('19 Dead Bodies'), stars: 4, says: 'Joe Bob says check it out.' });

test('cardSeconds / driveInWindow', () => {
    assert.equal(DRIVEIN_T, 15);
    assert.equal(cardSeconds(7), 19);
    assert.equal(cardSeconds(48), 64);
    assert.deepEqual(driveInWindow(DI(7)), { start: 15, end: 34 });
    assert.equal(driveInWindow(null), null);
});
test('Drive-In card window: a 48-line card pushes facts past it, spacing kept', () => {
    const { facts } = validateFacts([F(60, 'a'), F(100, 'b'), F(300, 'c')], 4680, {}, Infinity, DI(48));
    assert.deepEqual(facts.map(f => [f.t, f.text]), [[79, 'a'], [124, 'b'], [300, 'c']]);
});
test('with a card, old-style "Drive-In Totals:" bubbles are dropped; without one they stay', () => {
    const raw = [F(200, 'Drive-In Totals: Nineteen dead bodies.'), F(400, 'ok')];
    const withCard = validateFacts(raw, 4680, {}, Infinity, DI(3));
    assert.deepEqual(withCard.facts.map(f => f.text), ['ok']);
    assert.equal(withCard.dropped['totals-card'], 1);
    assert.equal(validateFacts(raw, 4680).facts.length, 2);
});
test('spaceFacts: a fact pushed past the end by the window is dropped as no room', () => {
    const { facts, noRoom } = spaceFacts([{ ...F(60, 'a'), rank: 1 }], 70, { start: 15, end: 79 });
    assert.deepEqual(facts, []);
    assert.equal(noRoom, 1);
});
test('buildDoc writes driveIn (only the card fields) when present, omits it otherwise', () => {
    const base = { imdbId: 'tt1', title: 'X', year: 1962, runtimeSec: 4680, facts: [], generatedAt: 'now' };
    assert.equal('driveIn' in buildDoc(base), false);
    const doc = buildDoc({ ...base, driveIn: { ...DI(1), awards: 'secret' } });
    assert.deepEqual(doc.driveIn, { t: 15, lines: ['19 Dead Bodies'], stars: 4, says: 'Joe Bob says check it out.' });
    assert.deepEqual(Object.keys(doc).slice(-2), ['facts', 'driveIn']);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/validate.test.js`
Expected: FAIL — `cardSeconds`, `spaceFacts`, `driveInWindow` not exported.

- [ ] **Step 3: Implement**

`src/schema.js`, after the `WEB_SHARE` line:

```js
export const DRIVEIN_T = 15;   // the Drive-In Totals card plays over the opening of the movie (exempt from MIN_T)
// Roughly how long the userscript's card stays up for n count lines (header, 1.1 s a line, stars, 5 s hold,
// fade) plus slack. Only keeps bubbles out of its way here; the userscript also holds bubbles while it's up.
export const cardSeconds = n => Math.ceil(11.1 + 1.1 * n);
```

`src/validate.js`: change the import to
`import { SCHEMA_VERSION, ICON_KEYS, SOURCE_TYPES, URL_REQUIRED, MAX_TEXT, MIN_T, MIN_GAP, END_MARGIN, cardSeconds } from './schema.js';`

Change the signature and add the drop right after the `too-long` check:

```js
export function validateFacts(rawFacts, runtimeSec, peopleImages = {}, maxFacts = Infinity, driveIn = null) {
```
```js
        if (text.length > MAX_TEXT) { drop('too-long'); continue; }
        // The card shows the counts and the verdict; a bubble repeating them is the old format.
        if (driveIn && /^drive-in totals:/i.test(text)) { drop('totals-card'); continue; }
```

Update the header comment's last line to add: `// driveIn: the movie's Drive-In Totals card, if any -- facts are kept out of its time window.`

Replace the tail of `validateFacts` (from `unique.sort(...)` through `return { facts, dropped };`) with:

```js
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
```

Replace `buildDoc`:

```js
export function buildDoc({ imdbId, title, year, runtimeSec, facts, generatedAt, driveIn = null }) {
    return {
        schema: SCHEMA_VERSION, imdbId, title, year, runtimeSec, generatedAt, facts,
        ...(driveIn ? { driveIn: { t: driveIn.t, lines: driveIn.lines, stars: driveIn.stars, says: driveIn.says } } : {}),
    };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test` → all PASS (the existing `no-room` test at `test/validate.test.js:46` must still pass unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/schema.js src/validate.js test/validate.test.js
git commit -m "feat(validate): keep bubbles out of the Drive-In Totals card window; driveIn in the doc

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Prompt — awards only when there's a card

**Files:**
- Modify: `src/prompt.js` (the `## Joe Bob Briggs' Drive-In Totals` section of `buildPrompt`)
- Test: `test/claude.test.js` (append)

**Interfaces:**
- Consumes: the card object from Task 1 (`{ lines, stars, says, awards }`).
- Produces: `buildPrompt({ imdb, wikidata, wikipedia, related, transcript, totals, card, tmdb })` — new optional `card` (the parsed card, or `null` when there is no card). `buildTopUpPrompt(material, …)` passes `material` through unchanged, so it inherits this.

- [ ] **Step 1: Commit the pending unnamed-critic rule first.** `src/prompt.js` already has an uncommitted change from earlier in this session (the "Opinions need a name" rule). Keep it and commit it on its own:

```bash
git add src/prompt.js
git commit -m "prompt: opinions must name the critic and outlet

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Write the failing tests** — append to `test/claude.test.js`:

```js
test('buildPrompt with a Drive-In card: awards only, no counts, no card bubbles', () => {
    const card = { lines: ['19 Dead Bodies'], stars: 4, says: 'Joe Bob says check it out.', awards: 'Drive-In Academy Award nominations for Candace Hilligoss.' };
    const p = buildPrompt({ imdb: BUNDLE, wikidata: null, wikipedia: null, totals: 'Nineteen dead bodies. Four stars.', card, tmdb: null });
    assert.match(p, /Drive-In Totals card/);
    assert.match(p, /Do NOT write bubbles for the counts or the star rating/);
    assert.match(p, /AWARDS: Drive-In Academy Award nominations for Candace Hilligoss\./);
    assert.doesNotMatch(p, /Nineteen dead bodies|19 Dead Bodies/);
    assert.doesNotMatch(p, /TOTALS:/);
});
test('buildPrompt with a card but no awards asks for no Joe Bob bubbles', () => {
    const card = { lines: ['19 Dead Bodies'], stars: 4, says: '', awards: '' };
    assert.match(buildPrompt({ imdb: BUNDLE, wikidata: null, wikipedia: null, totals: 'x', card, tmdb: null }), /no award nominations to turn into bubbles/);
});
test('buildPrompt with Totals but no card keeps the old Totals bubbles', () => {
    assert.match(buildPrompt({ imdb: BUNDLE, wikidata: null, wikipedia: null, totals: 'Nineteen dead bodies.', card: null, tmdb: null }), /TOTALS: Nineteen dead bodies\./);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/claude.test.js`
Expected: the first two FAIL (no card branch yet); the third PASSES already.

- [ ] **Step 4: Implement** — in `src/prompt.js`:

Change the destructuring: `export function buildPrompt({ imdb, wikidata, wikipedia, related, transcript, totals, card, tmdb }) {`

Add above `buildPrompt`:

```js
function joeBobSection(totals, card) {
    if (card) {
        return `Joe Bob's counts and his star rating for this film are shown on their own Drive-In Totals card over the opening of the movie.
Do NOT write bubbles for the counts or the star rating, and never start a bubble with "Drive-In Totals:".
${card.awards
        ? `From his Drive-In Academy Award nominations, Hall of Fame mentions and quotes below, write 1–3 bubbles (icon joebob, byline "Joe Bob Briggs", source driveintotals), spread across the movie. Name each nominee with their role per the rules above (e.g. "Joe Bob Briggs nominated Candace Hilligoss (Mary Henry) for a Drive-In Academy Award for 'I don't belong in the world.'").
AWARDS: ${card.awards}`
        : 'There are no award nominations to turn into bubbles.'}`;
    }
    if (totals) {
        return `Split this into 2–4 bubbles that start with "Drive-In Totals:" (icon joebob, byline "Joe Bob Briggs", source driveintotals), spread across the movie.
If it ends with Joe Bob's verdict ("Four stars. Joe Bob says check it out."), put that as its own bubble in the last 10 minutes.
TOTALS: ${totals}`;
    }
    return 'No Drive-In Totals found for this film. If you find Joe Bob Briggs coverage online (MonsterVision, The Last Drive-In, his columns), include it with its URL.';
}
```

Replace the body of the `## Joe Bob Briggs' Drive-In Totals` section (the whole `${totals ? `…` : '…'}` expression) with `${joeBobSection(totals, card)}`.

- [ ] **Step 5: Run to verify they pass**

Run: `npm test` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/prompt.js test/claude.test.js
git commit -m "feat(prompt): with a Drive-In card, Claude writes only the award bubbles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Pipeline wiring

**Files:**
- Modify: `src/pipeline.js` (`processMovie`)
- Test: `test/pipeline.test.js` (edit first test, append one)

**Interfaces:**
- Consumes: `parseTotalsCard` (Task 1), `DRIVEIN_T` (Task 2), `validateFacts(…, driveIn)` and `buildDoc({ …, driveIn })` (Task 2), `buildPrompt({ …, card })` (Task 3).
- Produces: published docs carry `driveIn` when the movie has a card.

- [ ] **Step 1: Write the failing tests** — in `test/pipeline.test.js`, first test (`processMovie: researches, validates, writes …`), replace the line
`assert.match(prompts[0], /Nineteen dead bodies/);   // totals reached the prompt` with:

```js
    assert.deepEqual(doc.driveIn, { t: 15, lines: ['19 Dead Bodies'], stars: null, says: '' });
    assert.match(prompts[0], /Drive-In Totals card/);        // the card replaced the Totals bubbles
    assert.doesNotMatch(prompts[0], /Nineteen dead bodies/);
```

Append:

```js
test('processMovie: Totals that make no card fall back to Totals bubbles, no driveIn', async () => {
    const { deps, prompts } = makeDeps({ totalsRows: [{ title: 'Carnival of Souls', year: 1962, description: '"Cold Open" - Two dead bodies.' }] });
    const r = await processMovie({ title: 'Carnival of Souls', year: 1962 }, deps);
    assert.equal(r.status, 'done');
    const doc = JSON.parse(fs.readFileSync(path.join(deps.dataDir, 'tt0055830.json'), 'utf8'));
    assert.equal('driveIn' in doc, false);
    assert.match(prompts[0], /TOTALS: "Cold Open" - Two dead bodies\./);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/pipeline.test.js`
Expected: FAIL — `doc.driveIn` is undefined.

- [ ] **Step 3: Implement** — in `src/pipeline.js`:

Imports:
```js
import { MODEL_OUTPUT_SCHEMA, MIN_FACTS, WEB_SHARE, DRIVEIN_T } from './schema.js';
import { findTotals, parseTotalsCard } from './driveintotals.js';
```

Right after the `const totals = …` line:
```js
    // Joe Bob's counts and verdict go on the userscript's Drive-In Totals card; Claude only gets the awards.
    const parsed = totals ? parseTotalsCard(totals) : null;
    const card = parsed && parsed.lines.length ? parsed : null;
    const driveIn = card ? { t: DRIVEIN_T, lines: card.lines, stars: card.stars, says: card.says } : null;
    const material = { imdb: bundle, wikidata, wikipedia, related, transcript, totals, card, tmdb: tmdbExtras };
```
(delete the old `const material = …` line).

In the `log(\`  researching …\`)` line, replace `totals: ${totals ? 'yes' : 'no'}` with
`totals: ${card ? \`card (${card.lines.length} lines)\` : totals ? 'yes (no card)' : 'no'}`.

Both validator calls get the card:
```js
        const v = validateFacts(r.facts, bundle.runtimeSec, peopleImages, cap, driveIn);
```
```js
            const merged = validateFacts([...best.facts, ...r.facts], bundle.runtimeSec, peopleImages, cap, driveIn);
```

And the doc:
```js
    const doc = buildDoc({ imdbId: tconst, title: bundle.title, year: bundle.year, runtimeSec: bundle.runtimeSec, facts: best.facts, generatedAt: now(), driveIn });
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.js test/pipeline.test.js
git commit -m "feat(pipeline): publish the Drive-In Totals card as driveIn

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `backfill-totals` command

**Files:**
- Create: `src/backfill.js`
- Modify: `src/cli.js` (usage comment, command check, new branch), `src/args.js` (`USAGE`)
- Create: `test/backfill.test.js`
- Modify: `README.md` (Manual commands paragraph)

**Interfaces:**
- Consumes: `findTotals`, `parseTotalsCard` (Task 1); `DRIVEIN_T`, `END_MARGIN` (schema); `spaceFacts`, `driveInWindow` (Task 2); `writeDoc` (publish.js).
- Produces: `backfillDoc(doc, totals) → { doc, removed } | null`; `runBackfill({ dataDir, outDir, totalsRows, git, dryRun, force, log }) → Array<{ imdbId, removed, lines }>`.

- [ ] **Step 1: Write the failing tests** — `test/backfill.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backfillDoc, runBackfill } from '../src/backfill.js';
import { writeDoc } from '../src/publish.js';

const f = (t, text) => ({ t, rank: 2, anchor: 'spread', text, icon: 'joebob', byline: 'Joe Bob Briggs', source: { type: 'driveintotals' } });
const TOTALS = 'Nineteen dead bodies. Zombie Fu. Drive-In Academy Award nominations for Candace Hilligoss. Four stars. Joe Bob says check it out.';
const DOC = {
    schema: 1, imdbId: 'tt0055830', title: 'Carnival of Souls', year: 1962, runtimeSec: 4680, generatedAt: 'x',
    facts: [
        f(300, 'Drive-In Totals: No breasts (1962). Nineteen dead bodies.'),
        f(900, 'Drive-In Totals: Drive-In Academy Award nominations for Candace Hilligoss.'),
        { ...f(1200, 'Herk Harvey made industrial films.'), icon: 'reel', person: 'nm0367547', image: 'https://m.media-amazon.com/images/M/x.jpg' },
        f(4500, 'Drive-In Totals: Four stars. Joe Bob says check it out.'),
    ],
};

function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-bf-'));
    const dataDir = path.join(root, 'data');
    writeDoc(dataDir, DOC);
    writeDoc(dataDir, { ...DOC, imdbId: 'tt1', title: 'No Totals Movie', year: 1999 });
    const commits = [];
    const deps = {
        dataDir, outDir: path.join(root, 'out'),
        totalsRows: [{ title: 'Carnival of Souls', year: 1962, description: TOTALS }],
        git: { commitAndPush: (p, m) => commits.push({ p, m }) },
        dryRun: false, force: false, log: () => {},
    };
    return { deps, commits, dataDir };
}

test('backfillDoc: drops count/verdict bubbles, keeps awards and other facts untouched, adds driveIn', () => {
    const r = backfillDoc(DOC, TOTALS);
    assert.equal(r.removed, 2);
    assert.deepEqual(r.doc.facts.map(x => x.t), [900, 1200]);
    assert.equal(r.doc.facts[1].person, 'nm0367547');           // headshot fields survive (no re-validation)
    assert.deepEqual(r.doc.driveIn, { t: 15, lines: ['19 Dead Bodies', 'Zombie Fu'], stars: 4, says: 'Joe Bob says check it out.' });
    assert.deepEqual(Object.keys(r.doc).slice(-2), ['facts', 'driveIn']);
    assert.equal(DOC.facts.length, 4);                            // input not mutated
    assert.equal(DOC.facts[0].t, 300);
});
test('backfillDoc: Totals that make no card -> null', () => {
    assert.equal(backfillDoc(DOC, ''), null);
});
test('runBackfill: updates + commits matching files once; a second run is a no-op', () => {
    const { deps, commits, dataDir } = setup();
    assert.equal(runBackfill(deps).length, 1);
    assert.equal(commits.length, 1);
    assert.match(commits[0].m, /Carnival of Souls \(1962\) — Drive-In Totals card/);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'tt0055830.json'), 'utf8'));
    assert.equal(saved.driveIn.lines.length, 2);
    assert.equal(runBackfill(deps).length, 0);
    assert.equal(commits.length, 1);
});
test('runBackfill --dry-run writes to out/ and commits nothing', () => {
    const { deps, commits, dataDir } = setup();
    assert.equal(runBackfill({ ...deps, dryRun: true }).length, 1);
    assert.equal(commits.length, 0);
    assert.equal('driveIn' in JSON.parse(fs.readFileSync(path.join(dataDir, 'tt0055830.json'), 'utf8')), false);
    assert.ok(fs.existsSync(path.join(deps.outDir, 'tt0055830.json')));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/backfill.test.js`
Expected: FAIL — `Cannot find module '../src/backfill.js'`.

- [ ] **Step 3: Implement** — `src/backfill.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { findTotals, parseTotalsCard } from './driveintotals.js';
import { DRIVEIN_T, END_MARGIN } from './schema.js';
import { spaceFacts, driveInWindow } from './validate.js';
import { writeDoc } from './publish.js';

const OLD_TOTALS = /^drive-in totals:/i;
const AWARDISH = /academy|hall of fame|nominat/i;

// Moves an already-published doc to the Drive-In Totals card: drops the old count/verdict bubbles (award
// nominations stay), adds driveIn and clears the card's window. Facts aren't re-validated, so headshots stay.
// null = the Totals don't make a card.
export function backfillDoc(doc, totals) {
    const card = parseTotalsCard(totals);
    if (!card.lines.length) return null;
    const driveIn = { t: DRIVEIN_T, lines: card.lines, stars: card.stars, says: card.says };
    const keep = doc.facts.filter(f => !OLD_TOTALS.test(f.text) || AWARDISH.test(f.text)).map(f => ({ ...f }));
    const maxT = doc.runtimeSec ? doc.runtimeSec - END_MARGIN : Infinity;
    const { facts } = spaceFacts(keep, maxT, driveInWindow(driveIn));
    return { doc: { ...doc, facts, driveIn }, removed: doc.facts.length - keep.length };
}

// Every data/*.json with Totals and no card yet (or all of them with force); one commit per file.
export function runBackfill({ dataDir, outDir, totalsRows, git, dryRun, force, log }) {
    const results = [];
    for (const name of fs.readdirSync(dataDir).filter(n => n.endsWith('.json')).sort()) {
        const doc = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
        if (doc.driveIn && !force) continue;
        const totals = findTotals(totalsRows, doc.title, doc.year);
        if (!totals) continue;
        const r = backfillDoc(doc, totals);
        if (!r) { log(`  ${doc.title} (${doc.year}): Totals don't make a card — left as is`); continue; }
        const file = writeDoc(dryRun ? outDir : dataDir, r.doc);
        log(`  ${doc.title} (${doc.year}): card with ${r.doc.driveIn.lines.length} lines, ${r.doc.driveIn.stars ?? 'no'} stars; removed ${r.removed} old Totals bubbles`);
        if (!dryRun) git.commitAndPush(file, `data: ${doc.title} (${doc.year}) — Drive-In Totals card\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
        results.push({ imdbId: doc.imdbId, removed: r.removed, lines: r.doc.driveIn.lines.length });
    }
    return results;
}
```

`src/args.js` — `USAGE`:
```js
export const USAGE = 'usage: cli.js run [--dry-run] [--force] | cli.js movie <tt…|"Title"> [--year N] [--dry-run] [--force] | cli.js backfill-totals [--dry-run] [--force]';
```

`src/cli.js`:
- Usage comment: add `//   node src/cli.js backfill-totals [--dry-run] [--force]   (add the Drive-In Totals card to published files)`.
- Import: `import { runBackfill } from './backfill.js';`
- Command check: `if (args.error || !(command === 'run' || command === 'backfill-totals' || (command === 'movie' && target))) {`
- Before the final `} else {` (the `movie` branch), add:

```js
    } else if (command === 'backfill-totals') {
        if (!deps.totalsRows.length) { log('No Drive-In Totals loaded — nothing to backfill'); process.exitCode = 1; return; }
        try {
            deps.git.pull();
            const results = runBackfill(deps);
            log(`backfill-totals: ${results.length} file(s) updated${args.dryRun ? ' (dry run, written to out/)' : ''}`);
            process.exitCode = 0;
        } catch (e) {
            log(`backfill-totals failed: ${e.message}`);
            process.exitCode = 1;
        }
```

`README.md` — in the "Manual commands:" paragraph, add: `` `docker compose run --rm generator backfill-totals` adds the Drive-In Totals card to files published before it existed (`--dry-run` writes to `out/`). ``

- [ ] **Step 4: Run to verify they pass**

Run: `npm test` → all PASS.

- [ ] **Step 5: Dry-run against the real data (read-only)**

Run: `node src/cli.js backfill-totals --dry-run`
Expected: about 7 lines like `Carnival of Souls (1962): card with 7 lines, 4 stars; removed N old Totals bubbles`, then `backfill-totals: 7 file(s) updated (dry run, written to out/)`. Open `out/tt0055830.json` and check: `driveIn` matches the Carnival lines from Task 1, the award bubbles are still in `facts`, and no fact text starts with `Drive-In Totals: Four stars`. Do **not** run without `--dry-run` here — that happens on `main` in Task 9.

- [ ] **Step 6: Commit**

```bash
git add src/backfill.js src/cli.js src/args.js test/backfill.test.js README.md
git commit -m "feat(cli): backfill-totals adds the Drive-In Totals card to published files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Part 2 — Userscript (`C:\Repos\cytube_tv_interface_script`)

### Task 6: Pure helpers — validate the card, decide when it shows, star fills

**Files:**
- Modify: `src/pc/modules/trivia-popup/index.js` — inside the curated-timeline test-marker slice, right after `tpCatchUpFact` and before `// ── test marker: curated-timeline slice end ──`
- Test: `scripts/test-trivia-timeline.mjs`

**Interfaces:**
- Consumes: `TP_TIMELINE_WINDOW_S`, `TP_CATCHUP_MIN_GAP_S` (already in the slice).
- Produces (all inside the slice): `TP_DRIVEIN_SEEN_KEY = '[drive-in-totals card]'`; `tpValidateDriveIn(doc) → { t, lines, stars, says } | null`; `tpDriveInAction(card, currentTime, seenTexts, secsSinceLastPop) → 'due' | 'catchup' | null`; `tpStarFills(stars) → number[4]`.

- [ ] **Step 1: Branch, then write the failing tests**

```bash
cd /c/Repos/cytube_tv_interface_script && git switch -c drive-in-totals-card
```

In `scripts/test-trivia-timeline.mjs`, extend the slice import (both the destructuring and the `return { … }` inside the `new Function` string) with `tpValidateDriveIn, tpDriveInAction, tpStarFills, TP_DRIVEIN_SEEN_KEY`. Then add before the final `if (failed) …` line:

```js
/* ---- Drive-In Totals card --------------------------------------------- */

const DI = { t: 15, lines: ['19 Dead Bodies', 'Zombie Fu'], stars: 4, says: 'Joe Bob says check it out.' };
eq('driveIn: valid card normalized',
    tpValidateDriveIn(doc([F(100, 'a')], { driveIn: { ...DI, lines: [' 19 Dead Bodies ', '', 42, 'Zombie Fu'], stars: 3.7 } })),
    { t: 15, lines: ['19 Dead Bodies', 'Zombie Fu'], stars: 3.5, says: 'Joe Bob says check it out.' });
eq('driveIn: missing -> null', tpValidateDriveIn(doc([F(100, 'a')])), null);
eq('driveIn: bad t -> null', tpValidateDriveIn(doc([], { driveIn: { ...DI, t: 'soon' } })), null);
eq('driveIn: negative t -> null', tpValidateDriveIn(doc([], { driveIn: { ...DI, t: -1 } })), null);
eq('driveIn: no usable lines -> null', tpValidateDriveIn(doc([], { driveIn: { ...DI, lines: ['', '  '] } })), null);
eq('driveIn: lines not an array -> null', tpValidateDriveIn(doc([], { driveIn: { ...DI, lines: '19 Dead Bodies' } })), null);
eq('driveIn: stars clamped; junk stars -> null, junk says -> ""',
    [tpValidateDriveIn(doc([], { driveIn: { ...DI, stars: 9 } })).stars, tpValidateDriveIn(doc([], { driveIn: { ...DI, stars: 'four', says: 7 } }))],
    [4, { t: 15, lines: DI.lines, stars: null, says: '' }]);
eq('driveIn: max 60 lines, over-long lines dropped',
    [tpValidateDriveIn(doc([], { driveIn: { ...DI, lines: Array(80).fill('x') } })).lines.length,
     tpValidateDriveIn(doc([], { driveIn: { ...DI, lines: ['x'.repeat(301), 'ok'] } })).lines],
    [60, ['ok']]);
eq('driveIn field does not change the facts',
    tpValidateCurated(doc([F(100, 'a')], { driveIn: DI }), 'tt0055830'), tpValidateCurated(doc([F(100, 'a')]), 'tt0055830'));

eq('card: not before t', tpDriveInAction(DI, 14, [], 999), null);
eq('card: due at t and through the window',
    [tpDriveInAction(DI, 15, [], 0), tpDriveInAction(DI, 15 + TP_TIMELINE_WINDOW_S, [], 0)], ['due', 'due']);
eq('card: missed -> catch-up only after a quiet gap',
    [tpDriveInAction(DI, 600, [], 10), tpDriveInAction(DI, 600, [], 45)], [null, 'catchup']);
eq('card: seen -> never', tpDriveInAction(DI, 15, [TP_DRIVEIN_SEEN_KEY], 999), null);
eq('card: none -> null', tpDriveInAction(null, 15, [], 999), null);
eq('card: bad currentTime -> null', tpDriveInAction(DI, NaN, [], 999), null);
eq('stars: fill per slot',
    [tpStarFills(4), tpStarFills(3.5), tpStarFills(0), tpStarFills(1.5)],
    [[1, 1, 1, 1], [1, 1, 1, 0.5], [0, 0, 0, 0], [1, 0.5, 0, 0]]);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/test-trivia-timeline.mjs`
Expected: FAIL (a `ReferenceError` for `tpValidateDriveIn` when the slice is evaluated).

- [ ] **Step 3: Implement** — insert after `tpCatchUpFact` (still inside the slice):

```js
    // Drive-In Totals card: one per movie, from the doc's optional `driveIn`
    // (Joe Bob's counts, then his star rating -- see _tpShowDriveInCard).
    // Shown on every frequency tier; remembered in the seen list under
    // TP_DRIVEIN_SEEN_KEY so a reload doesn't replay it. A bad `driveIn` is
    // just ignored -- the facts don't depend on it.
    const TP_DRIVEIN_SEEN_KEY = '[drive-in-totals card]';
    function tpValidateDriveIn(doc) {
        const d = doc && doc.driveIn;
        if (!d || typeof d !== 'object') return null;
        if (typeof d.t !== 'number' || !Number.isFinite(d.t) || d.t < 0) return null;
        if (!Array.isArray(d.lines)) return null;
        const lines = d.lines.filter(l => typeof l === 'string').map(l => l.trim()).filter(l => l && l.length <= 300).slice(0, 60);
        if (!lines.length) return null;
        const stars = typeof d.stars === 'number' && Number.isFinite(d.stars) ? Math.min(4, Math.max(0, Math.round(d.stars * 2) / 2)) : null;
        const says = typeof d.says === 'string' ? d.says.trim().slice(0, 120) : '';
        return { t: d.t, lines, stars, says };
    }

    // 'due' at its moment (within the same window as timed facts), 'catchup'
    // once missed and the last pop was a while ago (same gap rule as
    // tpCatchUpFact), else null.
    function tpDriveInAction(card, currentTime, seenTexts, secsSinceLastPop) {
        if (!card || typeof currentTime !== 'number' || !Number.isFinite(currentTime)) return null;
        if (seenTexts.includes(TP_DRIVEIN_SEEN_KEY) || currentTime < card.t) return null;
        if (currentTime - card.t <= TP_TIMELINE_WINDOW_S) return 'due';
        return secsSinceLastPop >= TP_CATCHUP_MIN_GAP_S ? 'catchup' : null;
    }

    // Four star slots: 1 full, 0.5 half, 0 empty outline.
    function tpStarFills(stars) {
        return [0, 1, 2, 3].map(k => Math.max(0, Math.min(1, stars - k)));
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node scripts/test-trivia-timeline.mjs` → `PASS: trivia-popup — curated timeline helpers, all assertions green`.

- [ ] **Step 5: Commit**

```bash
git add src/pc/modules/trivia-popup/index.js scripts/test-trivia-timeline.mjs
git commit -m "feat(trivia-popup): validate the Drive-In Totals card and decide when it shows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Play the card

**Files:**
- Modify: `src/pc/modules/trivia-popup/index.js` (state vars, `fetchCuratedTrivia`, `_tpResetForNewMovie`, `_tpRecheckCurated`, `_tpTimelineTick`, `_tpSetMuted`, new card UI section after `_tpDismissBubble`)
- Modify: `src/pc/modules/trivia-popup/style.css` (append)

**Interfaces:**
- Consumes: Task 6 helpers; existing `_tpPictureRect`, `_tpUsableArea`, `_escHtml`, `_tpMarkSeen`, `_tpLoadSeenTexts`.
- Produces: `fetchCuratedTrivia(id) → Promise<{ facts, driveIn } | null>` (was `facts | null`); `_tpShowDriveInCard(card)`, `_tpHideDriveInCard(instant)`; state `_tpDriveIn`, `_tpCardEl`.

- [ ] **Step 1: State** — next to `let _tpTimeline = null;` add:

```js
    let _tpDriveIn = null;   // the current movie's validated Drive-In Totals card, or null
```

- [ ] **Step 2: Fetch returns the card too.** Add just above `fetchCuratedTrivia`:

```js
    // { facts, driveIn } for a usable curated doc, else null.
    function _tpCurated(doc, id) {
        const facts = tpValidateCurated(doc, id);
        return facts ? { facts, driveIn: tpValidateDriveIn(doc) } : null;
    }
```

In `fetchCuratedTrivia`:
- dev override: `try { return Promise.resolve(_tpCurated(JSON.parse(devRaw), null)); }`
- cache read: `if (cached && (cached.curated || Date.now() - cached.at < TP_CURATED_RECHECK_MS)) return Promise.resolve(cached.curated);`
- `onload`:
```js
                onload: r => {
                    const ok = r.status >= 200 && r.status < 300;
                    let curated = null;
                    if (ok) { try { curated = _tpCurated(JSON.parse(r.responseText), id); } catch (e) {} }
                    if (ok || r.status === 404) _tpCuratedCache[id] = { curated, at: Date.now() };
                    resolve(curated);
                },
```
- In the cache comment above `TP_CURATED_RECHECK_MS`, change `{ facts, at }` to `{ curated, at }`.

- [ ] **Step 3: Reset and recheck pick up the card.** In `_tpResetForNewMovie`, after `_tpDismissBubble(true); …`:

```js
        _tpHideDriveInCard(true);
        _tpDriveIn = null;
```
and replace its `.then` body:
```js
        fetchCuratedTrivia(id).then(curated => {
            if (id !== _tpLastImdbId) return; // movie changed again while this was in flight
            if (curated) { _tpTimeline = curated.facts; _tpDriveIn = curated.driveIn; return; }
            _tpStartImdbQueue(id);
        });
```
In `_tpRecheckCurated`:
```js
        fetchCuratedTrivia(id).then(curated => {
            if (!curated || id !== _tpLastImdbId || _tpTimeline) return;
            clearTimeout(_tpPopTimer); _tpPopTimer = null;
            _tpQueue = [];
            _tpExhausted = true;
            _tpTimeline = curated.facts;
            _tpDriveIn = curated.driveIn;
        });
```

- [ ] **Step 4: Card UI.** Insert after `_tpDismissBubble` (before the QUICK-TOGGLE BUTTON section):

```js
    /* ==========================================================
       DRIVE-IN TOTALS CARD -- MonsterVision-style: transparent over
       the picture, "Drive-In Totals" header, Joe Bob's counts rolling
       in one at a time (long lists scroll, oldest off the top), then
       his star rating and sign-off. No fixed length: it stays until
       every count has shown and the verdict has held. Bubbles wait
       while it's up (_tpTimelineTick). Design + mockup:
       grindhouse-popup-trivia docs/superpowers/specs/2026-10-10-drive-in-totals-card-*.
    ========================================================== */

    const TP_CARD_MS = { header: 900, line: 1100, pause: 1200, clear: 600, starStart: 150, star: 280, says: 300, hold: 5000, fade: 800 };
    const TP_CARD_FONT_LINK_ID = 'sc-tp-card-font';
    const TP_STAR_PATH = 'M12 1.8l3.1 6.6 7.1.8-5.3 4.9 1.4 7.1L12 17.6l-6.3 3.6 1.4-7.1L1.8 9.2l7.1-.8z';
    let _tpCardEl = null;
    let _tpCardTimers = [];

    // Patua One: free stand-in for ITC La Bamba, MonsterVision's face. Loaded
    // on first use, like core's Inter; Georgia until it arrives.
    function _tpEnsureCardFont() {
        if (document.getElementById(TP_CARD_FONT_LINK_ID)) return;
        const link = document.createElement('link');
        link.id = TP_CARD_FONT_LINK_ID;
        link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=Patua+One&display=swap';
        document.head.appendChild(link);
    }

    function _tpStarSvg(fill, k) {
        const id = `sc-tp-star-clip-${k}`;
        return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="${id}"><rect x="0" y="0" width="${24 * fill}" height="24"/></clipPath></defs>`
            + `<path d="${TP_STAR_PATH}" fill="rgba(20,20,20,.35)" stroke="#f5d76e" stroke-width="1.2"/>`
            + `<path d="${TP_STAR_PATH}" fill="#f5d76e" stroke="#7a5a10" stroke-width=".6" clip-path="url(#${id})"/></svg>`;
    }

    function _tpCardLater(ms, fn) { _tpCardTimers.push(setTimeout(fn, ms)); }

    function _tpShowDriveInCard(card) {
        _tpHideDriveInCard(true);
        _tpEnsureCardFont();
        // Right side of the actual picture, sized from it (fonts too) so it
        // reads the same in any layout or window size.
        const P = _tpPictureRect(_tpUsableArea());
        const el = document.createElement('div');
        el.id = 'sc-tp-card';
        el.style.setProperty('left', (P.left + P.width * 0.51) + 'px', 'important');
        el.style.setProperty('top', (P.top + P.height * 0.07) + 'px', 'important');
        el.style.setProperty('width', (P.width * 0.44) + 'px', 'important');
        el.style.setProperty('--sc-tp-head', Math.max(18, P.height * 0.09) + 'px');
        el.style.setProperty('--sc-tp-line', Math.max(12, P.height * 0.046) + 'px');
        el.innerHTML = `
            <div class="sc-tp-card-h">Drive-In<br>Totals</div>
            <div class="sc-tp-card-rule"></div>
            <div class="sc-tp-card-lines"><div class="sc-tp-card-track"></div></div>
            <div class="sc-tp-card-verdict">
                ${card.stars !== null ? `<div class="sc-tp-card-stars">${tpStarFills(card.stars).map(_tpStarSvg).join('')}</div>` : ''}
                <div class="sc-tp-card-says">${_escHtml(card.says)}</div>
            </div>`;
        document.body.appendChild(el);
        _tpCardEl = el;
        const linesEl = el.querySelector('.sc-tp-card-lines');
        const track = el.querySelector('.sc-tp-card-track');

        requestAnimationFrame(() => el.classList.add('sc-tp-card-on'));
        let t = TP_CARD_MS.header;
        for (const text of card.lines) {
            _tpCardLater(t, () => {
                const line = document.createElement('div');
                line.className = 'sc-tp-card-line';
                line.textContent = text;
                track.appendChild(line);
                requestAnimationFrame(() => line.classList.add('sc-tp-card-in'));
                // Fill top-down; once full, roll the oldest counts off the top.
                const over = track.offsetHeight - linesEl.clientHeight;
                if (over > 0) {
                    linesEl.classList.add('sc-tp-card-scrolling');
                    track.style.setProperty('transform', `translateY(${-over}px)`, 'important');
                }
            });
            t += TP_CARD_MS.line;
        }
        if (card.stars !== null || card.says) {
            t += TP_CARD_MS.pause;
            _tpCardLater(t, () => linesEl.classList.add('sc-tp-card-gone'));
            t += TP_CARD_MS.clear;
            const verdict = el.querySelector('.sc-tp-card-verdict');
            _tpCardLater(t, () => verdict.classList.add('sc-tp-card-on'));
            const stars = el.querySelectorAll('.sc-tp-card-stars svg');
            stars.forEach((s, k) => _tpCardLater(t + TP_CARD_MS.starStart + k * TP_CARD_MS.star, () => s.classList.add('sc-tp-card-in')));
            t += TP_CARD_MS.starStart + stars.length * TP_CARD_MS.star + TP_CARD_MS.says;
            const says = el.querySelector('.sc-tp-card-says');
            _tpCardLater(t, () => says.classList.add('sc-tp-card-on'));
        }
        t += TP_CARD_MS.hold;
        _tpCardLater(t, () => _tpHideDriveInCard(false));
    }

    // _tpCardEl stays set through the fade, so bubbles wait until it's gone.
    function _tpHideDriveInCard(instant) {
        _tpCardTimers.forEach(clearTimeout);
        _tpCardTimers = [];
        if (!_tpCardEl) return;
        const el = _tpCardEl;
        const done = () => {
            el.remove();
            if (_tpCardEl === el) { _tpCardEl = null; _tpLastPopAt = Date.now(); }
        };
        if (instant) { done(); return; }
        el.classList.add('sc-tp-card-out');
        _tpCardTimers.push(setTimeout(done, TP_CARD_MS.fade));
    }
```

- [ ] **Step 5: Tick — card first, bubbles wait.** Replace the body of `_tpTimelineTick` after the two guard lines:

```js
        if (_tpCardEl) return; // bubbles wait for the Drive-In Totals card
        if (_tpBubbleEl) return; // let the current bubble finish; the next fact's 20s window usually outlasts it
        const v = getPlayerVideoEl();
        const tier = getKey(LS_TRIVIA_POPUP_FREQUENCY) || TP_FREQUENCY_DEFAULT;
        const seen = _tpLoadSeenTexts(_tpLastImdbId);
        const sinceLastPop = (Date.now() - _tpLastPopAt) / 1000;
        if (tpDriveInAction(_tpDriveIn, v.currentTime, seen, sinceLastPop)) {
            _tpShowDriveInCard(_tpDriveIn);
            _tpMarkSeen(_tpLastImdbId, TP_DRIVEIN_SEEN_KEY);
            return;
        }
        const fact = tpDueFact(_tpTimeline, v.currentTime, tier, seen)
            || tpCatchUpFact(_tpTimeline, v.currentTime, tier, seen, sinceLastPop);
        if (!fact) return;
        showTriviaBubble(fact);
        _tpMarkSeen(_tpLastImdbId, fact.text);
        _tpLastPopAt = Date.now();
```
Update the comment above `_tpTimelineTick` to start: `// Timeline mode's whole scheduler: every heartbeat, show the Drive-In Totals card when it's due (or missed), else pop whichever curated fact is due …`.

- [ ] **Step 6: Mute fades the card.** In `_tpSetMuted`:

```js
        if (_tpMuted) {
            _tpDismissBubble(true); // yank any bubble that's currently up
            _tpHideDriveInCard(false);
        } else if (!_tpTimeline) {
```

- [ ] **Step 7: CSS** — append to `src/pc/modules/trivia-popup/style.css` (same 12-space indent as the file):

```css
            /* ===== DRIVE-IN TOTALS CARD ===== */
            /* MonsterVision's on-screen Drive-In Totals: no panel, shadowed
               text right over the picture. left/top/width and the two font
               sizes (--sc-tp-head / --sc-tp-line) are set inline by
               _tpShowDriveInCard() from the picture's size. */
            #sc-tp-card {
                position: fixed !important;
                z-index: 15400 !important; /* just under the bubble */
                pointer-events: none !important;
                text-align: center !important;
                font-family: 'Patua One', Georgia, serif !important;
                font-weight: 400 !important;
                opacity: 1 !important;
                transition: opacity 0.8s ease !important;
            }
            #sc-tp-card.sc-tp-card-out { opacity: 0 !important; }
            #sc-tp-card .sc-tp-card-h {
                color: #a6e27a !important;
                font-size: var(--sc-tp-head) !important;
                line-height: 1.02 !important;
                text-shadow: 2px 2px 0 #10140c, 0 0 10px rgba(0,0,0,0.75) !important;
                opacity: 0 !important;
                transition: opacity 0.6s !important;
            }
            #sc-tp-card .sc-tp-card-rule {
                height: 3px !important;
                width: 0 !important;
                margin: 8px auto 10px !important;
                background: #c8352b !important;
                box-shadow: 1px 1px 0 #000 !important;
                transition: width 0.6s 0.2s !important;
            }
            #sc-tp-card.sc-tp-card-on .sc-tp-card-h { opacity: 1 !important; }
            #sc-tp-card.sc-tp-card-on .sc-tp-card-rule { width: 80% !important; }
            #sc-tp-card .sc-tp-card-lines {
                position: relative !important;
                overflow: hidden !important;
                font-size: var(--sc-tp-line) !important;
                height: calc(var(--sc-tp-line) * 10.5) !important;
                transition: opacity 0.5s !important;
            }
            #sc-tp-card .sc-tp-card-lines.sc-tp-card-scrolling {
                -webkit-mask-image: linear-gradient(transparent 0, #000 14%) !important;
                mask-image: linear-gradient(transparent 0, #000 14%) !important;
            }
            #sc-tp-card .sc-tp-card-lines.sc-tp-card-gone { opacity: 0 !important; }
            #sc-tp-card .sc-tp-card-track {
                position: absolute !important;
                left: 0 !important;
                right: 0 !important;
                top: 0 !important;
                transition: transform 0.45s ease !important;
            }
            /* Long counts wrap (balanced), never ellipsized. */
            #sc-tp-card .sc-tp-card-line {
                color: #f4e8c6 !important;
                line-height: 1.22 !important;
                margin-top: 0.32em !important;
                text-wrap: balance !important;
                text-shadow: 2px 2px 0 #000, 0 0 6px rgba(0,0,0,0.85) !important;
                opacity: 0 !important;
                transform: translateY(8px) !important;
                transition: opacity 0.35s, transform 0.35s !important;
            }
            #sc-tp-card .sc-tp-card-line.sc-tp-card-in { opacity: 1 !important; transform: none !important; }
            #sc-tp-card .sc-tp-card-verdict {
                position: absolute !important;
                left: 0 !important;
                right: 0 !important;
                top: 46% !important;
                opacity: 0 !important;
                transition: opacity 0.4s !important;
            }
            #sc-tp-card .sc-tp-card-verdict.sc-tp-card-on { opacity: 1 !important; }
            #sc-tp-card .sc-tp-card-stars { display: flex !important; justify-content: center !important; gap: 4% !important; }
            #sc-tp-card .sc-tp-card-stars svg {
                width: 17% !important;
                height: auto !important;
                filter: drop-shadow(2px 2px 0 #000) drop-shadow(0 0 6px rgba(0,0,0,0.6)) !important;
                transform: scale(0) !important;
                transition: transform 0.35s cubic-bezier(.3,1.6,.5,1) !important;
            }
            #sc-tp-card .sc-tp-card-stars svg.sc-tp-card-in { transform: scale(1) !important; }
            #sc-tp-card .sc-tp-card-says {
                color: #f4e8c6 !important;
                font-size: calc(var(--sc-tp-line) * 1.1) !important;
                margin-top: 10px !important;
                text-shadow: 2px 2px 0 #000, 0 0 6px rgba(0,0,0,0.85) !important;
                opacity: 0 !important;
                transition: opacity 0.5s !important;
            }
            #sc-tp-card .sc-tp-card-says.sc-tp-card-on { opacity: 1 !important; }
```

- [ ] **Step 8: Run all trivia tests + both builds**

```bash
node scripts/test-trivia-timeline.mjs && node scripts/test-trivia-icons.mjs && node scripts/test-popupvideo-build.mjs && node scripts/build-dev-bundle.mjs && node scripts/build-popupvideo.mjs
```
Expected: three PASS lines, then `Wrote …cytube.pc.dev.user.js …` and `Wrote …cytube.popupvideo.user.js (v1.0.0)`. Then `node --check cytube.pc.dev.user.js && node --check cytube.popupvideo.user.js` (syntax only) → no output.

- [ ] **Step 9: Commit** (the dev bundle is untracked; don't add it)

```bash
git add src/pc/modules/trivia-popup/index.js src/pc/modules/trivia-popup/style.css
git commit -m "feat(trivia-popup): MonsterVision-style Drive-In Totals card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Sample doc, setting note, standalone release, live check

**Files:**
- Modify: `docs/popup-trivia-sample.json` (add `driveIn`)
- Modify: `src/pc/modules/trivia-popup/index.js` (the `sc-input-triviapopup` setting `note`)
- Modify: `scripts/build-popupvideo.mjs` (`POPUPVIDEO_VERSION`), `cytube.popupvideo.user.js` (rebuilt)

**Interfaces:**
- Consumes: everything above.
- Produces: a releasable standalone build and a sample doc for the dev override.

- [ ] **Step 1: Sample doc** — in `docs/popup-trivia-sample.json`, add after the `facts` array (keep valid JSON; comma after `]`):

```json
  "driveIn": {
    "t": 15,
    "lines": ["No Breasts (1962)", "19 Dead Bodies", "About 15 Zombies", "1 Motor Vehicle Chase, with Watery Crash", "Zombie Bus Tour", "Church Organ Fu", "Zombie Fu"],
    "stars": 4,
    "says": "Joe Bob says check it out."
  }
```
Verify: `node -e "JSON.parse(require('fs').readFileSync('docs/popup-trivia-sample.json','utf8'))"` → no output.

- [ ] **Step 2: Setting note** — in the `sc-input-triviapopup` `note`, after the sentence ending `…the ones you missed show up in the gaps.` insert: ` Movies Joe Bob Briggs reviewed open with his Drive-In Totals card — the counts, then his star rating.`

- [ ] **Step 3: Bump and rebuild the standalone** — in `scripts/build-popupvideo.mjs` set `export const POPUPVIDEO_VERSION = '1.1.0';`, then:

```bash
node scripts/build-popupvideo.mjs && node scripts/test-popupvideo-build.mjs && node scripts/test-trivia-timeline.mjs
```
Expected: `Wrote …cytube.popupvideo.user.js (v1.1.0)` and PASS lines.

- [ ] **Step 4: Commit**

```bash
git add docs/popup-trivia-sample.json src/pc/modules/trivia-popup/index.js scripts/build-popupvideo.mjs cytube.popupvideo.user.js
git commit -m "feat(popupvideo): Drive-In Totals card in the sample doc and standalone 1.1.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Live check (the user does this in their browser)** — install `cytube.pc.dev.user.js` in Tampermonkey, open the channel on cytu.be with Pop-up trivia on, and in DevTools run
`localStorage.setItem('sc_trivia_curated_dev', JSON.stringify(<contents of docs/popup-trivia-sample.json>))`; reload and play any movie from the start. Check:
  1. At 0:15 the card appears on the right of the picture: green "Drive-In Totals", red rule, cream counts one per ~1.1 s, then four gold stars stamp in and "Joe Bob says check it out." — Patua One font, no background, nothing cut off.
  2. Player controls under the card still work.
  3. Long list: put 30 copies of `"Gratuitous Lizard-Tail Eating"` in `driveIn.lines` → counts scroll up with a fade at the top; the card leaves only after the stars.
  4. Mute mid-card → it fades; unmute → it doesn't come back.
  5. Change the movie mid-card → it disappears instantly.
  6. Reload after it played → it doesn't replay. Seek back to 0:10 → it doesn't replay.
  7. Remove the key: `localStorage.removeItem('sc_trivia_curated_dev')`.

---

## Part 3 — Rollout

### Task 9: Merge, backfill, release

**Files:** none new.

- [ ] **Step 1: Generator** — full suite, then merge to `main` and push (the server's cron pulls `main`):

```bash
cd /c/Repos/grindhouse-popup-trivia && npm test && git switch main && git pull --rebase && git merge --no-ff drive-in-totals-card -m "Merge: Drive-In Totals card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push
```

- [ ] **Step 2: Backfill the published files** (on `main`, one commit + push per file):

```bash
node src/cli.js backfill-totals
```
Expected: about 7 `card with N lines` log lines, then `backfill-totals: 7 file(s) updated`. Check `git log --oneline -8` shows the `— Drive-In Totals card` commits and `git status` is clean.

- [ ] **Step 3: Userscript** — merge `drive-in-totals-card` into `main` and push (only after the Task 8 Step 5 live check passes).

```bash
cd /c/Repos/cytube_tv_interface_script && git switch main && git pull --rebase && git merge --no-ff drive-in-totals-card -m "Merge: Drive-In Totals card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push
```

- [ ] **Step 4: Server** — redeploy the generator stack (Portainer "Pull and redeploy", or `docker compose up -d --build`) so the next scheduled run uses the new prompt and writes `driveIn`.
