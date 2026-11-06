# Discord Integration and TMDB Title Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve more schedule titles automatically (IMDb, then TMDB), post a per-run summary to Discord, and let the owner fix unsure or missing matches with one button click.

**Architecture:** A new `src/resolve.js` replaces `resolveTconst` and returns a confidence and a ranked candidate list. `src/cli.js` posts the summary and picker messages through a thin Discord REST client after `runWeekend`. A second always-on process (`src/bot-main.js`) in the same container listens on the Discord gateway for button clicks, saves a title override, and spawns the existing `movie` command. A lock file on the `/work` volume serialises cron runs and click-fixes.

**Tech Stack:** Node >= 22 ESM, no dependencies, native `fetch` and `WebSocket`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-06-discord-integration-design.md`

## Global Constraints

- Node >= 22, ESM, **no runtime dependencies**; native `fetch` and the built-in `WebSocket` only.
- Dependency injection: `fetchImpl`, `log`, `WebSocketImpl`, `exec` etc. are parameters; tests stub them (`test/helpers.js`: `jsonResponse`, `textResponse`, `imdbStub`).
- Discord is optional: with no Discord env vars, a run behaves exactly as today. A Discord failure is logged and never changes the exit code and is never retried.
- `TMDB_API_KEY` unset => TMDB search is a no-op (returns `[]`).
- Everything downstream keys on an IMDb tconst; TMDB results without an `imdb_id` are discarded.
- Only the configured owner user id can click; clicks are handled one at a time; a click never runs concurrently with a cron `run` (shared lock).
- The bot requests **no privileged intents** (`intents: 0`) and acts only on button interactions in the one configured channel.
- Env var names: `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `DISCORD_OWNER_ID`. Add them to `.env.example` and the `environment:` block of `docker-compose.yml`.
- Picker `custom_id` format: `pick:<pendingId>:<tconst>` or `pick:<pendingId>:none` (under Discord's 100-character limit). At most 5 candidate buttons plus "None of these".
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Existing tests keep passing: `imdb.searchTitle` keeps its return shape `{tconst, title, year}`; existing pipeline test stubs have no `searchCandidates`, so every new call to it is optional (`imdb.searchCandidates?.()`).

## Review Focus

1. A schedule item with **no year** must still be processed (best guess) and be flagged unsure, not crash or fail. (Task 4)
2. TMDB returning a hit **without an `imdb_id`**, an HTTP error, or a missing key must yield no candidates, never an exception that fails the movie. (Task 2)
3. A Discord outage or bad token during summary/picker posting must not change the run's exit code or lose the already-pushed data. (Task 10)
4. **Double-click or two racing clicks** on a picker, a click by a non-owner, and a click on an expired or already-resolved picker must each do nothing harmful. (Task 12)
5. A 15-movie weekend with long failure reasons must not exceed Discord's limits (embed description 4096 characters): truncate with "...and N more", never get rejected. (Task 9)

## File Structure

- `src/titles.js` (modify): add `titleSimilarity`.
- `src/imdb.js`, `src/tmdb.js` (modify): add `searchCandidates`.
- `src/overrides.js` (create): title override file read/write.
- `src/resolve.js` (create): `rateMatch`, `resolveTitle`; replaces `resolveTconst` in `src/pipeline.js`.
- `src/pipeline.js`, `src/publish.js`, `src/args.js`, `src/cli.js` (modify): use the resolver, report `match` on results, `--replaces`, lock, notify.
- `src/lock.js` (create): cross-process lock.
- `src/discord/api.js`, `pending.js`, `format.js`, `notify.js`, `gateway.js`, `bot.js` (create): Discord pieces; `src/bot-main.js` (create): bot entry point.
- `docker/entrypoint.sh`, `docker-compose.yml`, `.env.example`, `README.md` (modify).

---

### Task 1: Title similarity score

**Files:**
- Modify: `src/titles.js`
- Test: `test/titles.test.js`

**Interfaces:**
- Produces: `titleSimilarity(a: string, b: string): number` in `[0, 1]`. `titlesMatch(a, b)` becomes `titleSimilarity(a, b) >= 0.7` with identical behaviour.

- [ ] **Step 1: Write the failing tests** in `test/titles.test.js`: `titleSimilarity('Alligator', 'Alligator') === 1`; `titleSimilarity('The Fly', 'Fly') === 1`; `titleSimilarity('', 'x') === 0`; `titleSimilarity('Alligator', 'Alligator II: The Mutation') < 0.7`; and a loop asserting `titlesMatch(a, b) === (titleSimilarity(a, b) >= 0.7)` over five pairs.
- [ ] **Step 2: Run** `node --test test/titles.test.js`. Expected: FAIL (`titleSimilarity` is not exported).
- [ ] **Step 3: Implement** `titleSimilarity` by lifting the Dice computation out of `titlesMatch`; empty token sets return 0.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(titles): expose titleSimilarity score`.

### Task 2: Candidate search on IMDb and TMDB

**Files:**
- Modify: `src/imdb.js`, `src/tmdb.js`
- Test: `test/imdb.test.js`, `test/sources.test.js`

**Interfaces:**
- Produces: `type Candidate = { tconst: string, title: string, year: number|null, votes: number, source: 'imdb'|'tmdb' }`.
- Produces: `imdb.searchCandidates(term: string): Promise<Candidate[]>` (up to 10, movie/tvMovie/video types, **no title-similarity filter**, series and episodes excluded, most votes first).
- Produces: `tmdb.searchCandidates(term: string): Promise<Candidate[]>` (up to 5). `makeTmdb('')` returns one that resolves `[]`.
- `searchTitle` and `fetchExtras` are unchanged.

- [ ] **Step 1: Write failing tests.** IMDb: a stubbed `MainSearch` with a movie, a series and a video returns the movie and the video only, ordered by votes, each with `source: 'imdb'`. TMDB (fetch stub routing by URL): `/search/movie?query=...` returns three hits; `/movie/{id}/external_ids` returns an `imdb_id` for two and `null` for one; expect two candidates with `source: 'tmdb'`, `votes` from `vote_count`, `year` from `release_date`. Also: an HTTP 401 on search resolves `[]`; an `external_ids` failure for one hit drops only that hit; a missing key resolves `[]` without calling fetch.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.** IMDb reuses `SEARCH_Q` and `MOVIE_TYPES` (factor out the type filter shared with `searchAndMatch`). TMDB uses `getJson`, takes the first 5 search hits, fetches their `external_ids` in parallel, and wraps the whole call in try/catch returning `[]` (per-hit failures dropped individually).
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(imdb,tmdb): candidate search for the picker and TMDB fallback`.

### Task 3: Title overrides file

**Files:**
- Create: `src/overrides.js`
- Test: `test/overrides.test.js`

**Interfaces:**
- Produces: `overrideKey(title: string, year: number|null): string` = `${normalizeTitle(title)}|${year ?? ''}`.
- Produces: `loadOverrides(file: string): { picks: Record<string,string>, dismissed: Record<string,true> }` (missing or corrupt file => both empty).
- Produces: `saveOverride(file: string, key: string, entry: { tconst: string } | { dismissed: true }): void` (creates parent directory, writes pretty JSON with trailing newline).
- File location (decided here): `<repoDir>/overrides/title-overrides.json`, committed with the data. It is outside `data/` so the userscript never sees it.

- [ ] **Step 1: Write failing tests:** key is stable across case, a leading "The" and punctuation (`overrideKey('The Fly!', 1958) === overrideKey('fly', 1958)`) but differs by year; `saveOverride` then `loadOverrides` round-trips a pick and a dismissal; a corrupt file loads as empty (no throw); a second save keeps the first entry.
- [ ] **Step 2: Run** `node --test test/overrides.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the three functions with `node:fs`.
- [ ] **Step 4: Run** the file. Expected: pass.
- [ ] **Step 5: Commit** `feat(overrides): persistent title picks and dismissals`.

### Task 4: Resolver with confidence

**Files:**
- Create: `src/resolve.js`
- Test: `test/resolve.test.js`

**Interfaces:**
- Consumes: `imdb.searchTitle(term, year)`, optional `imdb.searchCandidates(term)`, optional `tmdb.searchCandidates(term)`, `titleVariants`, `titleSimilarity`, `titlesMatch`, `overrideKey`.
- Produces constants `SIMILARITY_STRONG = 0.85`, `LEAD_RATIO = 0.5`.
- Produces: `rateMatch({ scheduleTitle, scheduleYear, matched, pool }): 'confident'|'unsure'` where `matched` and each `pool` entry are `Candidate`. Unsure when: `scheduleYear` is null; or `titleSimilarity(scheduleTitle, matched.title) < SIMILARITY_STRONG` and the match was not an exact alias/variant hit; or some other pool entry is a **rival** (`titlesMatch` with the schedule title, year within 1 of `scheduleYear`, and `votes >= LEAD_RATIO * matched.votes`).
- Produces: `resolveTitle(item, { imdb, tmdb, overrides, log }): Promise<Resolution>` with `Resolution = { tconst: string|null, source: 'override'|'direct'|'imdb'|'tmdb'|null, confidence: 'confident'|'unsure'|'none', matchedTitle: string|null, matchedYear: number|null, candidates: Candidate[] (ranked, max 5), tried: string[] }`. `item` is the existing movie shape `{ title, year, akas, tconst? }`.

Resolution order: `item.tconst` => `direct`/confident. Then `overrides.picks[overrideKey(title, year)]` => `override`/confident. Then the existing IMDb chain (names, then variants), logging the existing "matched on IMDb as ..." line. If the IMDb chain finds nothing, repeat the same term order against `tmdb.searchCandidates`, accepting the most-voted candidate that passes `titlesMatch` and the +-1 year rule (`source: 'tmdb'`). Candidates for the picker are gathered only when the result is unsure or nothing matched: the union of `imdb.searchCandidates` and `tmdb.searchCandidates` over the first two terms, de-duplicated by tconst, ranked by `titleSimilarity` to the item title then votes, top 5.

- [ ] **Step 1: Write failing tests** (stubs for `imdb`/`tmdb`):
  - tconst given => `{ source: 'direct', confidence: 'confident' }` and no search calls.
  - an override pick wins and skips all searches.
  - IMDb exact title+year hit, no rival => `confident`, `source: 'imdb'`.
  - the same hit with `year: null` => `unsure` and still resolved (Review Focus 1).
  - a rival with similar title, year within 1 and 60% of the votes => `unsure`; with 20% of the votes => `confident`.
  - IMDb finds nothing, TMDB has a matching hit => `source: 'tmdb'`; a TMDB hit with the wrong year (off by 3) is not accepted.
  - nothing anywhere => `{ tconst: null, confidence: 'none', tried: [...] }` with `candidates` ranked and capped at 5.
  - `tmdb` stub without `searchCandidates`, and `imdb` stub without `searchCandidates`, do not throw.
  - candidates are not fetched when the result is confident (assert zero `searchCandidates` calls).
- [ ] **Step 2: Run** `node --test test/resolve.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `rateMatch` and `resolveTitle`; move the term-ordering logic out of `pipeline.js` unchanged in behaviour.
- [ ] **Step 4: Run** `npm test`. Expected: all pass (pipeline not yet switched over).
- [ ] **Step 5: Commit** `feat(resolve): resolver with TMDB fallback and match confidence`.

### Task 5: Pipeline uses the resolver; replacing a file

**Files:**
- Modify: `src/pipeline.js`, `src/publish.js`, `src/args.js`
- Test: `test/pipeline.test.js`, `test/args.test.js`, `test/publish.test.js` (create if absent, using `makeGit({ exec })` with a recording stub)

**Interfaces:**
- Consumes: `resolveTitle` (Task 4).
- Produces: every `processMovie` result gains `match: { scheduleTitle, scheduleYear, source, confidence, matchedTitle, matchedYear, candidates }`; `done` results also gain `dataFile: string` (path written; absent in dry run's real dir is fine, use the written path).
- Produces: `deps.overrides` (optional `{picks, dismissed}`) and `deps.replaces` (optional tconst) read by `processMovie`.
- Produces: `git.commitAndPush(filePath: string, message: string, removePaths: string[] = [])` in `src/publish.js`: stages the new file, `git rm -q --ignore-unmatch` each removed path, commits all of them in the same commit, then pushes as today.
- Produces: CLI option `--replaces <tt\d+>` in `parseArgs` (`args.replaces`, default `null`; error message for a malformed value, matching the `--year` style) and in `USAGE`.

- [ ] **Step 1: Write failing tests.** Pipeline: a not-found movie returns `status: 'failed'` with the existing `/not found on IMDb \(tried:/` reason and a `match` carrying candidates; an unsure IMDb match still reaches `done` with `match.confidence === 'unsure'`; a done result has `dataFile` ending in `<tconst>.json`; with `deps.replaces = 'tt0000001'` the git stub's `commitAndPush` receives `[<docPath of tt0000001>]` as its third argument and not otherwise. Publish: the recorded git calls are `add`, `rm -q --ignore-unmatch`, `commit` (pathspecs for both files), `push`, in order. Args: `--replaces tt123` parses; `--replaces nope` errors.
- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement.** Delete `resolveTconst` from `pipeline.js` in favour of `resolveTitle(item, { imdb, tmdb, overrides: deps.overrides ?? { picks: {}, dismissed: {} }, log })`. Existing "not found" reason text and `skipped` reasons are unchanged. `src/cli.js` `movie` command passes `replaces: args.replaces` into deps.
- [ ] **Step 4: Run** `npm test`. Expected: all pass, including the untouched existing pipeline tests.
- [ ] **Step 5: Commit** `feat(pipeline): resolver integration, match info on results, --replaces`.

### Task 6: Cross-process lock

**Files:**
- Create: `src/lock.js`
- Modify: `src/cli.js`
- Test: `test/lock.test.js`

**Interfaces:**
- Produces: `withLock<T>(lockFile: string, fn: () => Promise<T>, opts?: { pollMs?: number, isAlive?: (pid: number) => boolean, sleep?: (ms: number) => Promise<void> }): Promise<T>`. Acquires by creating the file exclusively (`wx`) containing the pid; if it exists and its pid is not alive (default `process.kill(pid, 0)`), removes the stale lock; otherwise polls (default 5000 ms). Always releases in `finally`.

- [ ] **Step 1: Write failing tests:** runs `fn` and removes the file; two concurrent `withLock` calls run strictly one after the other (record start/end order); a lock file naming a dead pid (inject `isAlive: () => false`) is taken over; a lock held by a live pid blocks until released; the lock is released when `fn` throws.
- [ ] **Step 2: Run** `node --test test/lock.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `withLock`; in `src/cli.js` wrap the `run` and `movie` branches (not `--dry-run`, not `backfill-totals`) in `withLock(path.join(repoDir, '.cache', 'run.lock'), ...)`.
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(lock): serialise runs and click-fixes with a pid lock`.

### Task 7: Discord REST client

**Files:**
- Create: `src/discord/api.js`
- Test: `test/discord-api.test.js`

**Interfaces:**
- Produces: `makeDiscordApi({ token, channelId, fetchImpl = fetch }): { postMessage(payload): Promise<{ id: string }>, editMessage(messageId: string, payload): Promise<void>, ackInteraction(interaction, type: 6|7, payload?): Promise<void>, gatewayUrl(): Promise<string> }`. `payload` is the Discord message body (`content`, `embeds`, `components`). Base `https://discord.com/api/v10`, header `Authorization: Bot <token>`, User-Agent `DiscordBot (grindhouse-popup-trivia, 1)`. `ackInteraction` POSTs `/interactions/{id}/{token}/callback` with `{ type, data }` and no auth header. `gatewayUrl` reads `/gateway/bot` and returns `url + '?v=10&encoding=json'`. A non-OK response throws an Error containing the status.

- [ ] **Step 1: Write failing tests** with a recording fetch stub: `postMessage` sends the right URL, method, auth header and JSON body and returns the id; `editMessage` PATCHes `/channels/{c}/messages/{id}`; `ackInteraction` hits the callback URL with `type: 7` and the payload under `data`; a 500 response rejects with the status in the message.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with native `fetch` (reuse the `AbortSignal.timeout(20000)` convention from `src/http.js`).
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(discord): minimal REST client`.

### Task 8: Pending picker state

**Files:**
- Create: `src/discord/pending.js`
- Test: `test/discord-pending.test.js`

**Interfaces:**
- Produces: `makePendingStore(file: string, { newId = () => crypto.randomUUID().slice(0, 8) } = {})` returning `{ add(entry): string, get(id): Entry|null, update(id, patch): Entry|null, list(): Entry[] }`, persisted as JSON at `file` (default location `<repoDir>/.cache/discord-pending.json`, gitignored).
- `Entry = { id, scheduleTitle, scheduleYear, candidates: Candidate[], guessTconst: string|null, guessFile: string|null, messageId: string|null, status: 'open'|'running'|'done'|'failed'|'dismissed'|'expired', createdAt: string }`.

- [ ] **Step 1: Write failing tests:** `add` returns an id and `get` returns the entry with `status: 'open'`; state survives a new store instance on the same file; `update` merges and persists; `get` of an unknown id is `null`; a corrupt file behaves as empty.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with `node:fs` (write via temp file + rename).
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(discord): persistent pending-picker store`.

### Task 9: Message formatting

**Files:**
- Create: `src/discord/format.js`
- Test: `test/discord-format.test.js`

**Interfaces:**
- Consumes: result objects from Task 5, `Entry` from Task 8.
- Produces: `buildSummary(results, { postTitle: string|null }): { embeds: [{ title, description, color }] }`. Order: "Needs a look" (unsure matches and failures, listed first), "Done" (matched title/year, fact count, `via TMDB` marker when `match.source === 'tmdb'`), "Skipped", then a run-stopped note when any result has `stop` (usage limit or publish failure). Description is truncated to at most 4000 characters ending with `...and N more`; "Needs a look" is never the section that gets cut.
- Produces: `buildPicker(entry): { content: string, components: [{ type: 1, components: Button[] }] }`. One button per candidate (max 5) labelled `<title> (<year>) · <source>` truncated to 80 characters, `custom_id` `pick:<entry.id>:<tconst>`, plus a secondary-style "None of these" with `custom_id` `pick:<entry.id>:none`. The candidate equal to `entry.guessTconst` is labelled with a leading "✓ ".
- Produces: `needsPicker(result): boolean` = `match.confidence === 'unsure'`, or `status === 'failed'` with a "not found on IMDb" reason and at least one candidate.
- Produces: `parsePickId(customId: string): { id: string, tconst: string|null } | null` (null for anything not matching `pick:<id>:<tconst|none>`).

- [ ] **Step 1: Write failing tests:** an all-done run yields a summary with no "Needs a look" section; failures and unsure matches appear before done movies; a TMDB match carries the marker; a 15-result run with 400-character reasons produces a description of at most 4000 characters ending in "...and N more" (Review Focus 5); `buildPicker` caps at 5 candidate buttons plus "None of these", every `custom_id` is under 100 characters, the guess is marked; `parsePickId` round-trips and rejects `pick:x`, `foo:a:b` and an empty string.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the four functions as pure functions.
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(discord): summary and picker message builders`.

### Task 10: Notify after a run

**Files:**
- Create: `src/discord/notify.js`
- Modify: `src/cli.js`
- Test: `test/discord-notify.test.js`

**Interfaces:**
- Consumes: Tasks 7-9.
- Produces: `notifyRun({ api, store, results, postTitle, log }): Promise<void>`. Posts the summary, then for each result where `needsPicker(result)` adds a store entry (`guessTconst`/`guessFile` from the result's `tconst`/`dataFile` when it is `done` and unsure, else `null`), posts `buildPicker(entry)` and saves the returned message id on the entry. **Never throws**: any error is caught and logged with `log`.
- `src/cli.js` builds the api and store only when `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` are both set, captures `postTitle` through a wrapper around `fetchWeekendMovies`, and calls `notifyRun` after `runWeekend` returns, before the exit code is set. It is skipped for `--dry-run`. The exit-code logic is unchanged.

- [ ] **Step 1: Write failing tests:** results with one done, one unsure-done and one not-found-with-candidates post one summary and two pickers, and the store holds two open entries with message ids; a run with no problems posts only the summary; `api.postMessage` rejecting on the first call resolves `notifyRun` without throwing and logs the error (Review Focus 3); an unsure-done result stores `guessTconst` and `guessFile`; a failed result with zero candidates gets no picker.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `notifyRun` and the `cli.js` wiring.
- [ ] **Step 4: Run** `npm test`. Expected: pass, then `node --check src/cli.js` prints nothing.
- [ ] **Step 5: Commit** `feat(discord): post run summary and pickers`.

### Task 11: Gateway connection

**Files:**
- Create: `src/discord/gateway.js`
- Test: `test/discord-gateway.test.js`

**Interfaces:**
- Produces: `connectGateway({ token, api, onInteraction, log, WebSocketImpl = WebSocket, setTimeoutImpl = setTimeout, backoffMs = 5000 }): { close(): void }`. Flow: fetch `api.gatewayUrl()`, open the socket, on opcode 10 (HELLO) start the heartbeat at `heartbeat_interval` and send IDENTIFY (opcode 2) with `intents: 0`, properties `{ os: 'linux', browser: 'grindhouse', device: 'grindhouse' }`; on opcode 1 send a heartbeat immediately; on dispatch `INTERACTION_CREATE` call `onInteraction(d)`; on close or error stop the heartbeat and reconnect after `backoffMs` (full re-identify, no resume); `close()` stops reconnecting.

- [ ] **Step 1: Write failing tests** with a fake `WebSocketImpl` that records sent frames and lets the test push messages: HELLO triggers an IDENTIFY frame with `intents: 0` and the token; heartbeats are sent on the interval (fake timers); an `INTERACTION_CREATE` dispatch reaches `onInteraction`; closing the fake socket schedules a reconnect that opens a second socket; `close()` prevents the reconnect.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with only `WebSocket` events (`message`, `close`, `error`), parsing frames as JSON.
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat(discord): gateway client for interactions`.

### Task 12: Click handling and the bot process

**Files:**
- Create: `src/discord/bot.js`, `src/bot-main.js`
- Test: `test/discord-bot.test.js`

**Interfaces:**
- Consumes: Tasks 3, 6, 7, 8, 9, 11, and `makeGit` from `src/publish.js`.
- Produces: `makeInteractionHandler({ api, store, ownerId, channelId, saveChoice, runMovie, log }): (interaction) => Promise<void>` where `saveChoice({ entry, tconst|null }): Promise<void>` and `runMovie({ tconst, replaces }): Promise<{ ok: boolean, reason?: string }>`.
- Handler rules, in order: ignore anything that is not a button (`type !== 3`) or whose `channel_id` differs from `channelId`; a non-owner gets an ephemeral "Only the owner can use this" reply and nothing else; unparseable `custom_id` is ignored; unknown pending id => update the message to say the picker expired; an entry whose `status !== 'open'` is acknowledged with no change (this is the double-click guard, status is set to `running` **before** any await); "None of these" => `saveChoice({ tconst: null })`, status `dismissed`, message edited; a click on the entry's own `guessTconst` => `saveChoice`, status `done`, message edited to "Confirmed", no generation; any other candidate => acknowledge with an update showing "Queued...", set `running`, `saveChoice`, then `runMovie({ tconst, replaces: entry.guessTconst })`, then edit the message to the result (`done` or `failed: <reason>`). Work from clicks is chained on a single in-memory promise so clicks run one at a time.
- `src/bot-main.js` reads the three env vars (exits 0 with a log line if any is missing, so the entrypoint loop does not spin), builds the api, store (`<DATA_REPO_DIR>/.cache/discord-pending.json`), `saveChoice` (inside `withLock`: `git pull`, `saveOverride` using `overrideKey(entry.scheduleTitle, entry.scheduleYear)`, `commitAndPush` of `overrides/title-overrides.json`), and `runMovie` (spawns `node src/cli.js movie <tconst> [--replaces <tt>]` with the container's environment and returns `ok` from exit code 0 or the last log line as `reason`). On start it marks every entry still `running` as `failed` and edits its message to "Interrupted - click again" (the entry returns to `open` so the click can be retried), then connects the gateway.

- [ ] **Step 1: Write failing tests** for `makeInteractionHandler` with fakes: owner click on another candidate calls `saveChoice` once then `runMovie` once with `replaces` equal to the entry's guess, and the final edit mentions success; failure from `runMovie` edits the message with the reason; **two clicks on the same picker in quick succession call `runMovie` once** (Review Focus 4); a non-owner click calls nothing; a click for an unknown id edits to "expired"; a click on `guessTconst` calls `saveChoice` but not `runMovie`; "None of these" saves a dismissal; two different pickers clicked together run sequentially (assert call order with a deferred `runMovie`); an interaction from another channel is ignored.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `makeInteractionHandler` and `src/bot-main.js` as described.
- [ ] **Step 4: Run** `npm test`, then `node --check src/bot-main.js`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(discord): bot process handling picker clicks`.

### Task 13: Container, config and docs

**Files:**
- Modify: `docker/entrypoint.sh`, `docker-compose.yml`, `.env.example`, `README.md`

**Interfaces:**
- Consumes: `src/bot-main.js` (Task 12).

- [ ] **Step 1: Entrypoint.** In the `cron` case, when `DISCORD_BOT_TOKEN` is set, start the bot in a supervising background loop before `exec supercronic`: `( while true; do node /app/src/bot-main.js; sleep 5; done ) &`. With no token, nothing changes. Add a `bot` case for running it alone in the foreground.
- [ ] **Step 2: Compose and env.** Add `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `DISCORD_OWNER_ID` (all defaulting to empty) to `docker-compose.yml` and `.env.example` with a one-line comment each.
- [ ] **Step 3: README.** Add a "Discord" section: create a bot in the Discord developer portal (no privileged intents), invite it to one server with Send Messages permission, copy the channel id and your user id (Developer Mode), set the three variables, and describe what the summary and picker messages look like. Mention that TMDB search needs `TMDB_API_KEY`.
- [ ] **Step 4: Verify.** Run `sh -n docker/entrypoint.sh` (expected: no output) and `npm test` (expected: all pass).
- [ ] **Step 5: Commit** `feat(docker): run the Discord bot beside cron; document setup`.

---

## Self-review notes

- **Spec coverage:** TMDB in lookup and picker (Tasks 2, 4); confidence and unsure handling (Task 4); summary (Tasks 9, 10); click-to-fix with override, replace and dismissal (Tasks 3, 5, 12); lock and queueing (Tasks 6, 12); pending state and restart handling (Tasks 8, 12); no privileged intents (Task 11); config and docs (Task 13).
- **Settled in this plan (builder calls from the spec):** override file at `overrides/title-overrides.json`; confidence constants `SIMILARITY_STRONG = 0.85`, `LEAD_RATIO = 0.5`; replacing a wrong file uses `--replaces` so the deletion lands in the same commit as the new file; "None of these" never deletes a generated best-guess file (the owner removes it by hand).
