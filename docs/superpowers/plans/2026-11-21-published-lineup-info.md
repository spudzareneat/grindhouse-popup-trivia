# Published Lineup Info Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish, inside each `schedule/current.json` item, an `info` object holding everything Coming Attractions displays (resolved once, centrally), and make the userscript read it file-first with a per-item fallback to its existing lookup.

**Architecture:** A `makeFetchInfo` function merges IMDb, TMDB, Wikipedia and the kill-count DB into the same shape/priority the userscript's `lookupMovie` returns. `buildScheduleDoc` calls it after resolving each id, keeping already-published complete `info` for the same post and id. A Discord pick refreshes the picked film's `info`. The userscript's `lineupLookupItem` returns the item's `info` when present, else looks up as today.

**Tech Stack:** Node 22 ESM and `node --test` (generator repo `C:\Repos\grindhouse-popup-trivia`); the userscript repo `C:\Repos\cytube_tv_interface_script` uses standalone `scripts/test-*.mjs` probes (slice-and-eval between `// ── test marker: <name> slice start/end ──` comments).

**Spec:** `docs/superpowers/specs/2026-11-21-published-lineup-info-design.md` (builds on `2026-11-20-published-schedule-design.md`).

## Global Constraints

- `schema` stays `1`; `info` is additive. An item has an `info` key **only when a `fetchInfo` was supplied** (keeps existing `buildScheduleDoc` callers/tests unchanged).
- `info` shape (`lookupMovie`'s result subset): `imdbId, cleanTitle, cleanYear (number|null), rating (0-10, 1 decimal), runtime (minutes), genres[], poster, backdrop, overview, certificate, parentalGuide: [{category, severity}]|null, cast: [{name, nconst, character, photo, knownFor: {title, year, tconst}|null}] (top 3), killCount, links: {imdb, letterboxd, wiki}`. Missing values are `null` (genres `[]`).
- Priority mirrors `lookupMovie`: TMDB first, IMDb fallback for `cleanTitle, cleanYear, rating, runtime, genres, poster, backdrop, overview`; backdrop falls back to the IMDb poster; `certificate/parentalGuide/cast` are IMDb. Images: `https://image.tmdb.org/t/p/w342…` posters, `…/w780…` backdrops. TMDB key is server-side only; never written to the file or logs.
- Any source failure nulls only its own fields; nothing aborts a publish. No Claude usage.
- Commits as `spudzareneat`, message ends with the session's Co-Authored-By line; stage files by name (never `git add .`; `export.json` holds credentials). The userscript repo has an unrelated uncommitted `cytube.pc.user.js` rebuild: do not stage it unless the task says so.
- `npm test` (`node --test`) green after every generator task; run `for f in scripts/test-lineup-*.mjs; do node "$f"; done` after every userscript task.

## Review Focus

- TMDB key absent (`fetchLineup` returns null): IMDb values stand in for every merged field (Task 5).
- IMDb, TMDB, Wikipedia or kill-count download failing individually: partial `info`, others intact, publish proceeds (Task 5, 6).
- Same post, same id, complete previous `info`: no refetch and no commit; incomplete or missing `info`: retried; changed id: refetched (Task 6).
- Dismiss nulls `info`; a failed `info` fetch during a pick still saves the pick (Task 7).
- Item with `info` never calls `lookupMovie`; item with no/incomplete `info` (e.g. unresolved Tenebre) falls back to today's chain (Task 9).
- File growth: cast capped at 3, no raw API blobs (Task 4).

---

### Task 1: TMDB lineup fields

**Files:** Modify `src/tmdb.js`; Test `test/sources.test.js`

**Interfaces:**
- Produces: `tmdb.fetchLineup(tconst: string): Promise<{ tmdbId: number, title: string|null, year: number|null, rating: number|null, runtime: number|null, genres: string[], poster: string|null, backdrop: string|null, overview: string|null } | null>` on the object from `makeTmdb`. The no-key object gets `fetchLineup: async () => null`.

- [ ] **Step 1: Failing tests** (route by URL like the existing tmdb tests): `fetchLineup maps find + movie details` (find returns `movie_results:[{id: 603}]`; movie returns `title:'Zeiram', release_date:'1991-12-05', vote_average:6.44, runtime:85, genres:[{name:'Action'}], poster_path:'/p.jpg', backdrop_path:'/b.jpg', overview:'o'`; expect `{ tmdbId: 603, title: 'Zeiram', year: 1991, rating: 6.4, runtime: 85, genres: ['Action'], poster: 'https://image.tmdb.org/t/p/w342/p.jpg', backdrop: 'https://image.tmdb.org/t/p/w780/b.jpg', overview: 'o' }`); `fetchLineup returns null when TMDB has no match`; `fetchLineup is a no-op without a key` (`makeTmdb('')`); `fetchLineup propagates an HTTP failure` (`assert.rejects`).
- [ ] **Step 2:** `node --test test/sources.test.js`; expect the new tests FAIL (`fetchLineup is not a function`).
- [ ] **Step 3:** Implement in `makeTmdb` using the existing `getJson`, `/find/{tconst}?external_source=imdb_id` then `/movie/{id}`; rating `Math.round(vote_average*10)/10` (null if falsy), year `Number(release_date.slice(0,4))||null`.
- [ ] **Step 4:** Run; expect PASS. **Step 5:** Commit `feat(tmdb): fetchLineup`.

### Task 2: Wikipedia link

**Files:** Modify `src/wiki.js`; Test `test/sources.test.js`

**Interfaces:**
- Produces: `wiki.fetchWikipediaUrl(title: string, year: number|null): Promise<string|null>` on the `makeWiki` object.

- [ ] **Step 1: Failing tests:** `fetchWikipediaUrl searches "<title> <year> film" and builds the article URL` (stub asserts the request URL contains `srsearch=Zeiram%201991%20film`, `list=search`, `srlimit=1`; hit `{ title: 'Zeiram (film)' }` gives exactly `https://en.wikipedia.org/wiki/Zeiram_(film)`: spaces become underscores, then `encodeURIComponent`, which leaves the parentheses alone); `no year drops the year from the query`; `no hit returns null`; `a failing request rejects`.
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** Implement with `getJson` against the existing `WP_API` constant. **Step 4:** Run; PASS. **Step 5:** Commit `feat(wiki): fetchWikipediaUrl`.

### Task 3: Kill-count DB

**Files:** Create `src/killcounts.js`; Test `test/killcounts.test.js`

**Interfaces:**
- Produces: `KILLCOUNTS_URL = 'https://raw.githubusercontent.com/lklynet/Kill-Count/main/killcounts.jsonl'`; `parseKillCounts(text: string): Map<string, number>` (key `String(tmdb_id)`, value `count`; skips blank/invalid lines and entries without `tmdb_id`); `fetchKillCounts(fetchImpl = fetch): Promise<Map<string, number>>` (never throws: returns an empty Map on any failure).

- [ ] **Step 1: Failing tests:** `parseKillCounts keys by tmdb id and skips junk lines`; `fetchKillCounts returns the parsed map`; `fetchKillCounts returns an empty map on HTTP failure and on a thrown error`.
- [ ] **Step 2:** `node --test test/killcounts.test.js`; expect FAIL (module missing). **Step 3:** Implement with `getText` from `src/http.js`. **Step 4:** PASS. **Step 5:** Commit `feat: kill-count database loader`.

### Task 4: IMDb lineup fields

**Files:** Modify `src/imdb.js`; Test `test/imdb.test.js`

**Interfaces:**
- Produces: `imdb.fetchLineupInfo(tconst: string): Promise<{ title, year, rating, runtime, overview, poster, genres, certificate, parentalGuide, cast } | null>` where `runtime` is minutes (`Math.round(seconds/60)`), `poster` is the raw `primaryImage.url`, `genres` from `titleGenres.genres[].genre.text`, `parentalGuide` is `[{category, severity}]` or null, `cast` is the top 3 as `{ name, nconst, character, photo, knownFor }` with `photo` = headshot URL with `/\._V1_[^/]*\.jpg$/` replaced by `._V1_UX120_.jpg`, and `knownFor` = the most-voted of the person's 4 known-for titles excluding this tconst, as `{ title, year, tconst }` or null. Cast uses `principalCredits` (billing order) first, falling back to `credits(first: 3)`. Null when the title is unknown. One GraphQL operation named `GHLineup`. Copy the exact field selections from the userscript (`src/pc/shared/imdb-resolve.js` `IMDB_TITLE_FIELDS_QUERY`, and `fetchImdbTitleGuide` in `src/pc/modules/movie-title-links/index.js`).

- [ ] **Step 1: Failing tests** with `imdbStub` (op `GHLineup`): `maps title fields, certificate, parents guide and runtime minutes`; `cast prefers principal credits, caps at 3, shrinks the headshot and picks the most-voted known-for excluding this title`; `falls back to credits when there are no principal credits`; `unknown title returns null`; `a query failure rejects`.
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(imdb): fetchLineupInfo`.

### Task 5: Merge into `info`

**Files:** Create `src/lineup-info.js`; Test `test/lineup-info.test.js`

**Interfaces:**
- Consumes: `imdb.fetchLineupInfo` (T4), `tmdb.fetchLineup` (T1), `wiki.fetchWikipediaUrl` (T2), a lazy kill-count loader (T3).
- Produces: `makeFetchInfo({ imdb, tmdb, wiki, killCounts }): (tconst: string) => Promise<Info | null>` where `killCounts: () => Promise<Map<string, number>>` is called lazily and memoised across calls; `Info` is the shape in Global Constraints. Never throws. Returns `null` only when neither source yields a title.

- [ ] **Step 1: Failing tests** (fakes for every source): `TMDB values win and IMDb fills certificate, parental guide and cast`; `without a TMDB result every merged field comes from IMDb, and backdrop falls back to the IMDb poster`; `kill count is looked up by the TMDB id, null without one`; `links hold the IMDb and Letterboxd URLs and the Wikipedia hit`; `each source failing nulls only its own fields` (IMDb rejects, TMDB rejects, wiki rejects, kill-count loader rejects, one at a time); `returns null when neither IMDb nor TMDB gives a title`; `the kill-count loader runs once across several films`.
- [ ] **Step 2:** `node --test test/lineup-info.test.js`; expect FAIL. **Step 3:** Implement; run the four source calls concurrently per film with individual try/catch. **Step 4:** PASS. **Step 5:** Commit `feat(schedule): merge lineup info from IMDb, TMDB, Wikipedia and kill counts`.

### Task 6: Publish `info`

**Files:** Modify `src/schedule-doc.js`, `src/cli.js`; Test `test/schedule-doc.test.js`

**Interfaces:**
- Consumes: `makeFetchInfo` (T5), `fetchKillCounts` (T3).
- Produces: `buildScheduleDoc({ post, resolveItem, rate, now, previous, fetchInfo })` gains optional `fetchInfo: (tconst) => Promise<Info|null>`. When provided, every item gets an `info` key: `null` without an id; for the same post and same `imdbId` as `previous`, a previous `info` with a truthy `cleanTitle` is kept without calling `fetchInfo`; otherwise `fetchInfo(imdbId)` (a throw or null keeps any previous `info` for that item, else null). `publishSchedule` gains `fetchInfo` and passes it through. `cli.js` builds `fetchInfo = makeFetchInfo({ imdb: deps.imdb, tmdb: deps.tmdb, wiki: deps.wiki, killCounts: () => fetchKillCounts() })` and passes it in the shared `publish` function.

- [ ] **Step 1: Failing tests:** `items gain info when fetchInfo is supplied, and not otherwise`; `an unresolved item has info null and fetchInfo is not called`; `complete previous info for the same post and id is kept and not refetched`; `incomplete previous info (no cleanTitle) is refetched`; `a changed id refetches`; `a failing or null fetchInfo keeps the previous info`; `a different post never reuses previous info`; `publishSchedule commits nothing when only info refresh would change nothing` (second run, `fetchInfo` throwing, no commit).
- [ ] **Step 2:** `node --test test/schedule-doc.test.js`; expect FAIL. **Step 3:** Implement in `buildScheduleDoc`/`publishSchedule`, wire in `cli.js`. **Step 4:** PASS and full suite green. **Step 5:** Commit `feat(schedule): publish per-film info`.

### Task 7: A pick refreshes `info`

**Files:** Modify `src/schedule-doc.js` (`applyPick`), `src/discord/bot.js` (`makeSaveChoice`), `src/bot-main.js`; Test `test/schedule-doc.test.js`, `test/discord-bot.test.js`

**Interfaces:**
- Produces: `applyPick(doc, { title, year, tconst, rating, info })`: when `info !== undefined`, sets each matching item's `info` to `info ?? null`; `changed` also reflects an `info` difference (compare with `JSON.stringify`). `makeSaveChoice({ repoDir, git, lockOpts, imdb, fetchInfo })`: for a pick, calls `fetchInfo(tconst)` in a try/catch (failure gives `info: null`); for a dismiss passes `info: null`. `bot-main.js` builds `fetchInfo` with `makeFetchInfo` (imdb, tmdb via `makeTmdb(process.env.TMDB_API_KEY || '')`, `makeWiki()`, `killCounts: () => fetchKillCounts()`).

- [ ] **Step 1: Failing tests:** `applyPick sets info on the matching item and reports changed`; `applyPick with info undefined leaves info untouched`; `applyPick dismiss nulls info`; `saveChoice writes the fetched info into the schedule file in the same commit`; `a failing info fetch still saves the pick with info null`; `dismiss nulls info and never calls fetchInfo`.
- [ ] **Step 2:** Run both files; expect FAIL. **Step 3:** Implement. **Step 4:** PASS and full suite green. **Step 5:** Commit `feat(discord): a pick also refreshes the published info`.

### Task 8: Ship the generator (no code)

- [ ] **Step 1:** README: add `info` to the "Published schedule" section (fields, TMDB key use, once-per-weekend freeze, size). Commit `docs: describe published info`.
- [ ] **Step 2:** **Ask the user before pushing** (shared branch). Then fast-forward `main`, rebase on any bot data commits, push, and ask the user to redeploy the Portainer stack.
- [ ] **Step 3:** In the container: `node src/cli.js schedule --dry-run`; expect items with `info` (cleanTitle, poster, runtime, cast of 3, certificate), size noted. Run `node src/cli.js schedule`; expect `published`; a second run expects `unchanged`. Fetch the raw URL and confirm 200 and the `info` fields.

### Task 9: Userscript reads `info` file-first (repo `C:\Repos\cytube_tv_interface_script`)

**Files:** Modify `src/pc/modules/tonights-lineup/index.js` (`lineupLookupItem`, new marked slice), `src/pc/manifest.json`, `docs/manifest.json`; Create `scripts/test-lineup-published-info.mjs`

**Interfaces:**
- Consumes: published items with `info` (Task 6).
- Produces: `lineupInfoFromItem(item): LookupShaped | null` in a new `// ── test marker: published-info slice start/end ──` slice: returns `{ ...item.info, imdbId: item.info.imdbId ?? item.imdbId ?? null, resolved: true }` when `item.info && item.info.cleanTitle`, else `null`. `lineupLookupItem(item)` returns `lineupInfoFromItem(item)` first when non-null (no `lookupMovie` call), otherwise runs today's chain unchanged. `lineupBuildItem` and the card path are untouched.

- [ ] **Step 1: Failing probe** `scripts/test-lineup-published-info.mjs` (same slice-and-eval style as `test-lineup-published-schedule.mjs`): `item with complete info maps to a lookup-shaped object (resolved true, imdbId filled from the item)`; `no info, null info, or info without cleanTitle returns null`; `every field lineupBuildItem reads survives the mapping (cleanTitle, cleanYear, poster, backdrop, overview, rating, runtime, genres, parentalGuide, certificate, cast, killCount, imdbId, links)`; `the input item is not mutated`. Run it; expect FAIL (slice missing).
- [ ] **Step 2:** Implement the slice and the one-line branch in `lineupLookupItem`. **Step 3:** Run the new probe and all `scripts/test-lineup-*.mjs`; expect PASS.
- [ ] **Step 4:** Bump `baseVersion` by one in BOTH `src/pc/manifest.json` and `docs/manifest.json` (keep identical, verify with `cmp`); run `node scripts/build-dev-bundle.mjs` and `node --check cytube.pc.dev.user.js`.
- [ ] **Step 5:** Commit the module, both manifests and the probe by name (`feat(tonights-lineup): use published info file-first`); ask the user before pushing; then verify in a real CyTube session that Coming Attractions makes no Wikipedia/TMDB calls for items with `info` (manual).
