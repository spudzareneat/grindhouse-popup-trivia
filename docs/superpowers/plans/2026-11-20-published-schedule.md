# Published Weekend Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the weekend lineup, with resolved IMDb ids and IMDb ratings, as `schedule/current.json` in this repo, keep it in step with Discord picks, and make the userscript's Coming Attractions read it instead of Reddit.

**Architecture:** A new `schedule` command (also called first by `run`) scrapes the lineup with the existing browser fetch, resolves each title through the existing resolver, fetches IMDb ratings, and commits the file only when its content changed. The Discord save-choice path updates the matching item in the same commit as the override. The userscript (second repo) swaps its fetch URL.

**Tech Stack:** Node 22 ESM, `node --test`, existing modules (`reddit-browser.js`, `resolve.js`, `imdb.js`, `publish.js`, `discord/bot.js`), supercronic.

**Spec:** `docs/superpowers/specs/2026-11-20-published-schedule-design.md`

## Global Constraints

- File path `schedule/current.json`, `schema: 1`, shape exactly as in the spec; `year` is a **string or null**; `imdbId`/`imdbRating`/`imdbVotes` are `null` when unknown.
- Never overwrite or commit an empty/partial schedule: a scrape failure leaves the file untouched.
- No commit when only `fetchedAt` would change.
- Dismissed titles stay in the lineup with `imdbId: null`.
- Tests use fakes only (no live Reddit/IMDb); `npm test` (`node --test`) must stay green after every task.
- Commits as `spudzareneat` (repo git config), message ends with the Co-Authored-By line given in the session; never `git add .` (an untracked `export.json` holds credentials).
- Never log cookie values or put secrets in the file.

## Review Focus

- Scrape fails or returns no schedule post: file untouched, no commit, error surfaced (Task 4).
- A title the resolver cannot find: item published with null id/rating, others unaffected (Task 3).
- IMDb rating call throws or the title has no `ratingsSummary` (unreleased/obscure): null rating, run continues (Tasks 1, 3).
- Nothing changed since last publish: no commit (Task 4).
- Discord pick for a film not in the current file, or no schedule file yet: only the override changes (Task 6).
- `run --movies`/`--schedule` (no Reddit post) and `--dry-run`: no publish attempted (Task 5).

---

### Task 1: IMDb rating lookup

**Files:** Modify `src/imdb.js`; Test `test/imdb.test.js`

**Interfaces:**
- Produces: `imdb.fetchRating(tconst: string): Promise<{ rating: number, votes: number } | null>` on the object returned by `makeImdb`.

- [ ] **Step 1: Failing tests** (use `imdbStub`/`makeImdb` like the existing tests): `fetchRating returns rating and votes` (stub op `GHRating` -> `{ title: { ratingsSummary: { aggregateRating: 6.4, voteCount: 3100 } } }` gives `{ rating: 6.4, votes: 3100 }`); `fetchRating returns null when there is no rating` (`ratingsSummary: null`, and `aggregateRating: null`); `fetchRating propagates a query failure` (stub returns `new Error('boom')`, `assert.rejects`).
- [ ] **Step 2:** `node --test test/imdb.test.js`; expect the three new tests FAIL (`fetchRating is not a function`).
- [ ] **Step 3:** Implement `fetchRating` in `makeImdb` using `query('GHRating', 'query GHRating($id: ID!){ title(id:$id){ ratingsSummary{ aggregateRating voteCount } } }', { id: tconst })`, add it to the returned object.
- [ ] **Step 4:** Run the same command; expect PASS.
- [ ] **Step 5:** Commit `feat(imdb): fetchRating`.

### Task 2: Expose the parsed post from the scrape

**Files:** Modify `src/schedule.js` (`scheduleFromEntries`); Test `test/schedule.test.js`, `test/reddit-browser.test.js`

**Interfaces:**
- Produces: `scheduleFromEntries(entries)` result gains `post: { postId: string, title: string, publishedAt: string, weekend: { fri, sat, sun }, days: Day[] }` where `Day = { day, date, sections: [{ name, slug, items: [{ title, year: string|null, display, akas }] }] }`; `date` from `parseDateRange` (`fri`/`sat`/`sun` by day name). Existing fields (`postTitle`, `weekendFri`, `movies`) unchanged. `fetchWeekendMoviesViaBrowser` passes it through unchanged.

- [ ] **Step 1: Failing tests:** in `schedule.test.js`, `scheduleFromEntries exposes the parsed post` (using the existing `FEED` entries: `post.postId === 't3_new'`, `post.weekend` deepEquals `{ fri: '2026-10-03', sat: '2026-10-04', sun: '2026-10-05' }`, `post.days[0].date === '2026-10-03'`, `post.days[0].sections[0].items[0]` deepEquals `{ title: 'Carnival of Souls', year: '1962', display: 'Carnival of Souls (1962)', akas: [] }`, `typeof year === 'string'`); in `reddit-browser.test.js` extend the existing fetch test to assert `r.post.title` equals the post title.
- [ ] **Step 2:** `node --test test/schedule.test.js test/reddit-browser.test.js`; expect FAIL (`post` undefined).
- [ ] **Step 3:** Build `post` inside `scheduleFromEntries` from the selected entry and `parseDateRange`; attach `date` per day by day name.
- [ ] **Step 4:** Run; expect PASS and the full suite green (`node --test`).
- [ ] **Step 5:** Commit `refactor(schedule): expose the parsed post`.

### Task 3: Build the schedule document

**Files:** Create `src/schedule-doc.js`; Test `test/schedule-doc.test.js`

**Interfaces:**
- Consumes: `post` from Task 2; `resolveTitle(item, { imdb, tmdb, overrides, log })` from `src/resolve.js` (returns `{ tconst|null, ... }`); `imdb.fetchRating` from Task 1.
- Produces: `SCHEDULE_FILE = 'schedule/current.json'`; `buildScheduleDoc({ post, resolveItem: (item) => Promise<string|null>, rate: (tconst) => Promise<{rating, votes}|null>, now: string }): Promise<Doc>` (never throws for per-item failures: a failed resolve or rate gives nulls and continues); `sameSchedule(a, b): boolean` (deep-equal ignoring `fetchedAt`; `false` if either is null).

- [ ] **Step 1: Failing tests:** `buildScheduleDoc fills id, rating and votes per item` (fakes resolve `tt1`, rate `{rating: 6.4, votes: 3100}`; doc has `schema: 1`, `fetchedAt === now`, `postId`, `title`, `publishedAt`, `weekend`, same `days` structure, `year` still a string); `an unresolved title keeps null id/rating/votes` (resolve returns null; `rate` not called; other items unaffected); `a throwing resolver or rater yields nulls and does not abort` (resolve throws for one item; rate throws for another); `sameSchedule ignores fetchedAt but not content` (equal docs with different `fetchedAt` true; changed `imdbId` false; `sameSchedule(null, doc)` false).
- [ ] **Step 2:** `node --test test/schedule-doc.test.js`; expect FAIL (module missing).
- [ ] **Step 3:** Implement as specified; items resolved sequentially (IMDb is polite-rate; ~27 films).
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `feat(schedule): build the published schedule document`.

### Task 4: Publish step (write, compare, commit)

**Files:** Modify `src/schedule-doc.js`, `src/publish.js` (`commitAndPush` accepts `string | string[]` for the file argument); Test `test/schedule-doc.test.js`, `test/publish.test.js`

**Interfaces:**
- Consumes: Task 3 functions; `git.pull()`, `git.commitAndPush(filesOrFile, message)`.
- Produces: `publishSchedule({ repoDir, git, fetchPost: () => Promise<Post>, resolveItem, rate, now, log }): Promise<'published' | 'unchanged'>`. Order: `git.pull()`, `fetchPost()` (a rejection propagates; file untouched), build doc, read existing `schedule/current.json` (missing/invalid = null), if `sameSchedule` return `'unchanged'` without writing, else write (pretty JSON + trailing newline, create dir), `git.commitAndPush(SCHEDULE_FILE, 'schedule: <post title>')`, return `'published'`.

- [ ] **Step 1: Failing tests:** `publishSchedule writes the file and commits it` (fake git records calls; assert file content parses to the doc and the commit message is `schedule: Weekend Grindhouse Schedule - Fri 11/20 - Sun 11/22`); `unchanged content is not rewritten or committed` (second call with a later `now` returns `'unchanged'`, no second commit, file mtime/`fetchedAt` unchanged); `a failing fetchPost leaves the existing file untouched and does not commit` (`assert.rejects`, file bytes identical); in `publish.test.js`, `commitAndPush with several files adds and commits them together` (exec log: one `add` with both paths, one `commit ... -- a b`, then push).
- [ ] **Step 2:** `node --test test/schedule-doc.test.js test/publish.test.js`; expect FAIL.
- [ ] **Step 3:** Implement `publishSchedule`; in `makeGit.commitAndPush` normalise the file argument to an array for `add` and for the pathspec after `--`.
- [ ] **Step 4:** Run; expect PASS; full suite green.
- [ ] **Step 5:** Commit `feat(schedule): publish schedule/current.json`.

### Task 5: `schedule` command, `run` integration, cron, docs

**Files:** Modify `src/cli.js`, `src/args.js` (USAGE only, if `schedule` needs listing), `docker/crontab`, `README.md`; Test `test/cli.test.js`, `test/args.test.js` if USAGE is asserted

**Interfaces:**
- Consumes: `publishSchedule` (Task 4), `fetchWeekendMoviesViaBrowser` (its `post`), `resolveTitle`, `loadOverrides`, `imdb.fetchRating`.
- Produces: `node src/cli.js schedule` (takes the run lock; no Claude usage; exits non-zero on failure; posts the existing `notifyFailure` to Discord when Discord is configured and not dry-run). `run` calls the same publish first, inside its existing lock, **best effort**: a publish failure is logged and does not stop the run. `run` skips the publish for `--movies`, `--schedule` and `--dry-run`; `schedule --dry-run` builds and logs the doc without writing or committing.

- [ ] **Step 1: Failing tests** (follow the existing `cli.test.js` style for `main`/deps injection; extract a small `publishScheduleStep(deps, args)` helper if needed to make it testable): `run publishes the schedule before researching` (order of fake calls: publish then first `processMovie`); `a publish failure does not stop run` (publish rejects, movies still processed, error logged); `run --movies, run --schedule and run --dry-run do not publish`; `schedule command runs only the publish and exits 1 on failure`.
- [ ] **Step 2:** `node --test test/cli.test.js`; expect FAIL.
- [ ] **Step 3:** Implement: add the `schedule` command branch beside `run`/`movie`; share one `makePublishDeps` for both. Add to `docker/crontab` (comment: Wednesday, container time): `0 12 * * 3 cd /app && node src/cli.js schedule` and `0 20 * * 3 cd /app && node src/cli.js schedule`. README: document the command, the file, its shape, and the cron slots.
- [ ] **Step 4:** Run; expect PASS; full suite green.
- [ ] **Step 5:** Commit `feat(schedule): schedule command, run integration and Wednesday cron`.

### Task 6: Discord pick updates the published file

**Files:** Modify `src/schedule-doc.js` (add `applyPick`), `src/discord/bot.js` (`makeSaveChoice`), `src/bot-main.js` (pass `imdb`); Test `test/schedule-doc.test.js`, `test/discord-bot.test.js`

**Interfaces:**
- Produces: `applyPick(doc, { title, year, tconst: string|null, rating: {rating, votes}|null }): { doc, changed: boolean }` (matches every item whose `overrideKey(item.title, item.year ? Number(item.year) : null)` equals `overrideKey(title, year)`; sets `imdbId` to `tconst` (null on dismiss) and `imdbRating`/`imdbVotes` from `rating` (null when absent); never mutates the input). `makeSaveChoice({ repoDir, git, lockOpts, imdb })` additionally, after saving the override: if `schedule/current.json` exists and `applyPick(...).changed`, write it and commit it together with the override file in one `commitAndPush([overrideFile, scheduleFile], message)`; a rating fetch failure is caught and yields `rating: null`.

- [ ] **Step 1: Failing tests:** `applyPick sets id and rating on the matching item only`; `applyPick on dismiss nulls the id and rating`; `applyPick for a film not in the file reports changed false`; `year string vs number match by overrideKey` ("Black Cobra Woman" "1976" matches pick year 1976); in `discord-bot.test.js`, `saveChoice updates the schedule file in the same commit` (fake git captures `commitAndPush` files array of length 2), `saveChoice with no schedule file commits only the override` (single-element or string call), `a failing rating lookup still saves the pick` (imdb.fetchRating rejects; override saved, item `imdbId` set, `imdbRating` null).
- [ ] **Step 2:** `node --test test/schedule-doc.test.js test/discord-bot.test.js`; expect FAIL.
- [ ] **Step 3:** Implement `applyPick` and extend `makeSaveChoice`; wire `imdb: makeImdb()` into the `makeSaveChoice` call in `src/bot-main.js`.
- [ ] **Step 4:** Run; expect PASS; full suite green.
- [ ] **Step 5:** Commit `feat(discord): a pick also updates the published schedule`.

### Task 7: Ship and verify this repo (no code)

- [ ] **Step 1:** Push to `main` (rebase on bot data commits if rejected). Redeploy from `main` (the user does this in Portainer; the compose file is unchanged).
- [ ] **Step 2:** In the container, run `node src/cli.js schedule --dry-run` and check the logged doc (27 films, ids and ratings populated, no cookie values); then `node src/cli.js schedule`; confirm `schedule/current.json` lands on `main` and `https://raw.githubusercontent.com/spudzareneat/grindhouse-popup-trivia/main/schedule/current.json` serves it.

### Task 8: Userscript reads the published file (repo `C:\Repos\cytube_tv_interface_script`)

**Files:** Modify `src/pc/modules/tonights-lineup/index.js` (`fetchTonightsSchedule`, remove the now-dead RSS parsing and `LINEUP_FEED_URL`), `src/pc/manifest.json` if it lists the `www.reddit.com` connect, `cytube.pc.user.js` header (`// @connect www.reddit.com` removal) via `scripts/assemble.mjs`; Test `scripts/test-lineup-parse-schedule.mjs` (update or retire), plus a new probe script in the repo's `scripts/test-*.mjs` style

**Interfaces:**
- Consumes: the published JSON (Task 7 URL).
- Produces: `fetchTonightsSchedule()` returns `{ postId, title, publishedAt, days }` with `days` exactly as before (`day`, `date`, `sections[{name, slug, items[{title, year, display, akas, imdbId, imdbRating, imdbVotes}]}]`), so `lineupEnsureSchedule`, the cache (`sc_lineup_cache_v1`), expiry and timing code are untouched. It throws on a non-200, invalid JSON, `schema !== 1`, or zero days (same failure behaviour as today).

- [ ] **Step 1:** Write a probe (`scripts/test-lineup-published-schedule.mjs`, same style as the existing probes) that feeds a sample published document through the new parsing/validation and asserts the returned shape, the throw on `schema: 2`, and on empty `days`. Run it; expect FAIL.
- [ ] **Step 2:** Replace the fetch with `lineupGmFetch(<raw URL>)` + `JSON.parse` + validation; where `lookupMovie(item.title, item.year)` is called for lineup items (around lines 1099-1106), prefer a lookup by `item.imdbId` when present if `lookupMovie` supports it, otherwise keep title/year and pass the id only where the existing code can use it (do not change `lookupMovie`'s behaviour for other callers). Remove the dead RSS parsing and `www.reddit.com` from `@connect`.
- [ ] **Step 3:** Run the new probe and the existing `scripts/test-lineup-*.mjs` probes; expect PASS (retire or update any that exercised the removed RSS parser). Run `node scripts/assemble.mjs` as the repo documents and confirm `cytube.pc.user.js` regenerates without the reddit `@connect`.
- [ ] **Step 4:** Manual check in a real CyTube session: Coming Attractions shows the current weekend from the published file with day tabs and posters (cannot be automated).
- [ ] **Step 5:** Commit in that repo, following its commit style (`feat(tonights-lineup): read the schedule from the published file`).
