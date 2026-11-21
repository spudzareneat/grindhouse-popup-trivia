# Published lineup info (everything Coming Attractions displays, resolved once)

Date: 2026-11-21. Status: awaiting approval. Builds on `2026-11-20-published-schedule-design.md` (`schedule/current.json`, schema 1).

## Intent

Coming Attractions (userscript repo `cytube_tv_interface_script`, `tonights-lineup`) opens by running `lookupMovie(title, year)`
for every film (~27) in every viewer's browser: ~27+ Wikipedia searches plus TMDB/IMDb calls per cold cache, each viewer
repeating the same work, and viewers without a TMDB key get worse posters. Do that lookup once, centrally, in this repo's
`schedule` step and publish the result inside `schedule/current.json`, so the screen loads from one small file and every
viewer gets the same TMDB-quality data without a key.

## Goals

- Each published item carries an `info` object with every field Coming Attractions reads from a lookup, in the **same shape and
  priority** `lookupMovie` returns, so a film looks identical whether served from the file or looked up locally.
- Coming Attractions makes no per-film network calls for items that have `info` (file first).
- Items without usable `info` (unresolved film such as Tenebre, a failed fetch) fall back, per item, to the existing
  `lookupMovie` path, so a gap costs one slow tile and never a blank one (decided: option b).
- A Discord pick refreshes that film's `info` along with its id and rating.

## Non-goals / anti-goals

- No change to `lookupMovie` or the Now Playing / main play flow; only `lineupLookupItem` gains a file-first branch.
- No trivia, no image hosting (poster/backdrop stay URLs), no per-viewer behaviour changes.
- Anti-goal: the card or ETAs differing from today because the published data is thinner or shaped differently.
- Anti-goal: a source outage (TMDB, IMDb, Wikipedia, kill-count DB) blanking or aborting the publish.

## Approaches considered

- **A. Look up in the userscript only, with a shared cache**: still N lookups per viewer cold; no shared benefit. Rejected.
- **B. Generator publishes raw per-source blobs, userscript merges**: moves the priority logic and API shapes into two places; larger
  file; rejected.
- **C (chosen). Generator publishes a finished `info` object in `lookupMovie`'s result shape**; the userscript maps it 1:1.
  One place owns the merge/priority logic (TMDB first, then IMDb, as `lookupMovie` does). Additive to schema 1 (older
  userscripts ignore `info`).
- Fallback policy: file only (simplest, but a gap is a blank tile) vs **file-first with per-item fallback (chosen, by the user)**.

## Design

**Item gains `info`** (existing item fields unchanged; `info` is `null` when nothing could be fetched):

```json
"info": { "imdbId": "tt0103327", "cleanTitle": "Zeiram", "cleanYear": 1991, "rating": 6.4, "runtime": 85,
  "genres": ["Action","Horror","Sci-Fi"], "poster": "https://image.tmdb.org/t/p/w342/…", "backdrop": "https://image.tmdb.org/t/p/w780/…",
  "overview": "…", "certificate": "Not Rated",
  "parentalGuide": [{ "category": "Violence & Gore", "severity": "Moderate" }],
  "cast": [{ "name": "…", "nconst": "nm…", "character": "…", "photo": "https://…", "knownFor": [ … ] }],
  "killCount": 12, "links": { "imdb": "https://www.imdb.com/title/tt0103327/", "letterboxd": "https://letterboxd.com/imdb/tt0103327", "wiki": "https://en.wikipedia.org/wiki/Zeiram" } }
```
`runtime` is minutes (rounded) because the ETA model uses it. Priority mirrors `lookupMovie`: TMDB value first, IMDb as fallback
for `cleanTitle/cleanYear/rating/runtime/genres/poster/backdrop/overview`; `certificate`, `parentalGuide`, `cast` are IMDb;
`killCount` is looked up by TMDB id in the same JSONL (`lklynet/Kill-Count`, `killcounts.jsonl`) the userscript uses;
`links.wiki` is the first Wikipedia search hit for `"<title> <year> film"`, as the userscript does. Image sizes match the
userscript (`w342` posters, `w780` backdrops). Cast keeps the top 3 with the same fields the card reads today.

**Generator sources:** a new `src/lineup-info.js` exposing `makeFetchInfo({ imdb, tmdb, wiki, killCounts }) -> (tconst) -> Promise<Info|null>`
(never throws; each source failing nulls only its own fields), backed by: one new compact IMDb GraphQL query (title basics,
certificate, parents guide, principal cast; not the heavy trivia bundle), a TMDB `find` + `movie/{id}` fetch returning
`{ tmdbId, title, year, rating, runtime, genres, poster, backdrop, overview }`, a Wikipedia search helper, and a kill-count loader that downloads the JSONL
once per `schedule` run. TMDB needs the existing `TMDB_API_KEY`; without it the IMDb values stand in (as the userscript does for keyless users).

**Publishing:** `buildScheduleDoc` calls the info fetcher after resolving the id. Same freeze rule as ratings: for the same post
and same `imdbId`, a previously published `info` that is "complete" (has `cleanTitle`) is kept and not refetched; missing or incomplete `info`
is retried on every run. Estimated size ~3 to 4 KB per film, ~100 KB per weekend (acceptable for raw GitHub).

**Discord pick:** `makeSaveChoice` also fetches `info` for the picked tconst (failure non-fatal: `info: null`, filled by the next
`schedule` run), and a dismiss nulls `info`. `applyPick` takes `info` alongside `rating`.

**Userscript:** `lineupLookupItem(item)` first returns a lookup-shaped object built from `item.info` when `item.info?.cleanTitle` is
present (no network, `resolved: true`); otherwise it runs today's lookup chain unchanged. `getTonightsLineup()` and the card
click path are untouched because they consume the same shape. A probe in `scripts/test-lineup-*.mjs` pins the mapping and the fallback.

## Constraints

- `schema` stays 1 (additive); the userscript validator already ignores unknown item fields.
- Container `TMDB_API_KEY` and outbound access to TMDB, IMDb GraphQL, Wikipedia and raw.githubusercontent.com (all already used).
- Never write secrets into the file; the TMDB key is only ever used server-side.
- Runs stay light: no Claude usage; `info` fetched once per film per weekend.

## Left to the builder

The exact GraphQL query text and cast/knownFor mapping (copy the userscript's shape), module/function names beyond those above, how the
Wikipedia helper reuses `src/wiki.js`, the "complete" predicate details, and tests (fakes for each source; no live calls).
