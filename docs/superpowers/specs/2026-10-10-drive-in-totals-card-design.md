# Drive-In Totals card — design

Date: 2026-10-10. Spans two repos: this generator, and the userscript's `trivia-popup` module
(`cytube_tv_interface_script/src/pc/modules/trivia-popup`).

## Goal

Movies with Joe Bob Briggs' Drive-In Totals (≈350 in `spudzareneat/DriveInTotals`) currently get the Totals
chopped into 2–4 Pop-up Video bubbles ("Drive-In Totals: …"), with the star verdict as a bubble near the end.
Replace that with one MonsterVision-style **Drive-In Totals card** early in the movie, in true Joe Bob order:
the counts roll in, then the star rating lands as a graphic with his sign-off.

Approved mockup (open in a browser, mode A): `2026-10-10-drive-in-totals-card-mockup.html`.

## Look (approved)

Reference: MonsterVision's on-screen "Drive-In Totals" graphic.

- **Transparent** — no panel; text sits over the video with drop shadows (`2px 2px 0 #000` + soft glow).
- Font: **Patua One** (Google Fonts; free lookalike for ITC La Bamba, which can't be redistributed).
- Header "Drive-In / Totals" in green `#a6e27a`, then a red rule `#c8352b`; count lines in cream `#f4e8c6`,
  centered. Card is right-aligned, about 44% of the picture wide.
- Long counts **wrap** (never ellipsized), with a small gap between counts.
- Lists taller than the area (~10 base lines) **scroll**: lines fill top-down; once full, older lines roll off
  the top under a soft fade mask. Text size is the same for every movie.
- Verdict: counts fade out, then **four stars** stamp in one at a time (gold `#f5d76e`, dark outline);
  half stars are half-filled, unearned stars are empty outlines. The sign-off ("Joe Bob says check it out.")
  fades in below.

## Timing (approved)

- No fixed length. Sequence: header ~0.9 s → one count every 1.1 s → 1.2 s pause → counts out (0.6 s) →
  stars (4 × 0.28 s) → sign-off → 5 s hold → fade. The card is gone only after every count has shown and the
  stars and sign-off have landed.
- Card time `driveIn.t` = 120 s (after the 60 s no-fact zone, before the movie gets going).

## Data contract (generator → userscript)

Optional top-level field on the movie JSON; `schema` stays `1` (the userscript ignores unknown fields, so old
copies just skip the card):

```json
"driveIn": {
  "t": 120,
  "lines": ["No Breasts (1962)", "19 Dead Bodies", "About 15 Zombies", "1 Motor Vehicle Chase, With Watery Crash", "Zombie Bus Tour", "Church Organ Fu", "Zombie Fu"],
  "stars": 4,
  "says": "Joe Bob says check it out."
}
```

- `lines`: 1+ non-empty strings.
- `stars`: number 0–4 in 0.5 steps, or `null` when the verdict couldn't be parsed.
- `says`: the sign-off text, or — when `stars` is null — the verdict sentence(s) as written (may be `""`).
- No Totals for the movie → no `driveIn` field (and no Totals bubbles).

## Generator (this repo)

### Parser — `src/driveintotals.js`

`parseTotalsCard(description) → { lines, stars, says, awards }`, deterministic, no Claude:

1. Split the paragraph into sentences on `. ` / `.` end, respecting quotes and parentheses
   (`"No breasts (1962)."`, quoted award lines with periods).
2. Classify each sentence:
   - **Verdict** — `/(zero|no|one|two|three|four|\d(\.5)?)( and a half)? stars?/i` and anything after it
     ("Joe Bob says check it out.", "Outstanding.", "Check it out."). → `stars` (words → number, "and a half" =
     +0.5), `says` = the sentences after the rating, as written ("Joe Bob says check it out.",
     "Outstanding. Joe Bob says check it out.", or `""`).
   - **Awards** — from the first sentence containing "Academy Award"/"Drive-In Academy"/"Drive-Im academy"
     through the sentence before the verdict, plus "Hall of Fame" sentences. → `awards` (text, for the prompt).
   - **Everything else** → `lines`.
3. Clean each line: strip lead-ins ("We Have A Total Of", "We've Got", "We Got", "We Have"); number words →
   digits ("Nineteen" → 19, "Seventy-Six" → 76, "one" → 1; leave "No"/"Approximately" words alone, except
   "Approximately" → "About"); Title Case (keep small words lower mid-line; keep "Fu", "n", existing caps);
   drop a trailing period. Comma-lists inside a sentence stay one line (it wraps on screen).
4. If no lines survive, the movie gets no card (fallback: awards still go to the prompt).

### Prompt — `src/prompt.js`

Replace the "Joe Bob Briggs' Drive-In Totals" section when Totals exist: tell Claude the counts and the star
verdict are shown on a separate card — **don't** write bubbles for them, don't start bubbles with
"Drive-In Totals:". Give it only `awards`: write the Drive-In Academy Award nominations / Hall of Fame as 1–3
`joebob` bubbles (byline "Joe Bob Briggs", source `driveintotals`), with full names and roles per the existing
standalone rules. No awards → no Joe Bob bubbles from the Totals. The no-Totals branch (search for Joe Bob
coverage online) is unchanged.

### Pipeline / validator

- `pipeline.js` builds `driveIn` from the parser (t = 120) and passes it to `buildDoc`, which writes it when
  present.
- `validateFacts` takes an optional reserved window `[t, t + cardSeconds(lines.length)]` and moves any fact
  inside it to just after the window (then normal spacing applies; drop as `no-room` if it runs off the end).
- `cardSeconds(n)` (in `schema.js`, shared constants with the timing above) = `0.9 + 1.1·n + 1.2 + 0.6 + 1.4 +
  5 + 2` (≈ 11 + 1.1·n), rounded up — an estimate only; the userscript does the real deferral.
- Also drop any model fact whose text starts with "Drive-In Totals:" (belt and braces).

### Backfill — `node src/cli.js backfill-totals`

For each `data/*.json` whose movie matches a Totals row: remove facts that start with "Drive-In Totals:"
**unless** they mention an Academy Award nomination or Hall of Fame (kept as-is); add `driveIn`; re-run the
validator's window shift; write the file. Prints a per-file summary; `--dry-run` writes to `out/` only.
Commits/pushes through the existing publish path. One-off, but kept as a command for future Totals updates.

## Userscript (`trivia-popup`)

- **Validation**: `tpValidateCurated` also returns a validated `driveIn` (t finite ≥ 0; `lines` = non-empty
  trimmed strings, each ≤ 300 chars, max 60; `stars` null or 0–4 rounded to 0.5; `says` string ≤ 120 chars).
  Invalid `driveIn` → ignored, facts unaffected. A doc with a valid `driveIn` but no facts is still usable.
- **When it shows**: in `_tpTimelineTick`, before bubbles: if not muted, not yet seen, and
  `currentTime ≥ driveIn.t` within `TP_TIMELINE_WINDOW_S` → show. Shown on every frequency tier.
- **Catch-up**: missed (joined/seeked past) → show once at the next quiet gap, same gap rules as
  `tpCatchUpFact`, ahead of missed bubbles.
- **Seen**: marked in the same per-movie seen list (key `"driveIn"`), so reloads don't replay it.
- **Bubbles wait**: while the card is up, no bubble pops; due bubbles pop when it's gone (expired ones surface
  via catch-up as today).
- **Mute**: muting hides it immediately (fade); a muted viewer never sees it.
- **Interaction**: `pointer-events: none` — player controls under it keep working.
- **Font**: inject the Patua One Google Fonts `<link>` the first time a card is built (same pattern as Inter
  in `14-chat-panel-chrome.js`); fallback `Georgia, serif`.
- **Placement**: inside the same usable video area `_tpUsableArea`/`_tpPictureRect` uses, right-aligned;
  sizes scale with the picture (clamp-based, like the mockup).
- **No sound** for the card.

## Testing

Generator (`node --test`):
- `parseTotalsCard` fixtures: Carnival of Souls, Daughters of Darkness ("Drive-Im" typo), Sea Girls ("We've
  Got…" lead-ins), The Incredible Torture Show ("We Have A Total Of"), a "Four stars. Outstanding." verdict,
  a row with no verdict.
- Sweep test over the real CSV snapshot (fixture copy): every row parses without throwing; every row whose text
  contains a rating gets non-null `stars`; no line is empty.
- `validateFacts` reserved window: facts inside shift past it; spacing preserved; `no-room` at the end.
- Prompt: Totals branch contains the awards and the "don't write bubbles for counts/stars" rule, not the counts.
- Backfill: fixture doc with old Totals bubbles → counts/verdict removed, award bubble kept, `driveIn` added.

Userscript (`scripts/test-trivia-timeline.mjs`, extending the curated-timeline slice):
- `driveIn` validation (good / bad fields ignored / missing).
- Card due at t, not before; not when seen; catch-up after seek; bubbles held while card active.
- Live check on cytu.be with the dev override key and a sample doc with `driveIn` (short list and long list).

## Out of scope

Sound effects, Joe Bob host transcripts, the standalone Pop-up Video userscript, changing other bubbles' look.
