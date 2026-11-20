# Published weekend schedule (`schedule/current.json`)

Date: 2026-11-20. Status: awaiting approval.

## Intent

Reddit shut down RSS on 2026-11-13. The userscript's Coming Attractions screen
(`cytube_tv_interface_script`, `src/pc/modules/tonights-lineup`) fetched that feed directly, so it has been
broken since. This repo already obtains the weekend lineup (logged-in headless browser, see README "Reddit session")
and already resolves each title to an IMDb id. Publish that lineup, with IMDb ratings, as a JSON file in this repo
so the userscript reads it from `raw.githubusercontent.com` (as the trivia module already does for `data/`).

## Goals

- Coming Attractions works again, from this repo, with no Reddit access from the userscript.
- The lineup is live as soon as Reddit's post is up (usually Wednesday), not after the 1.5 h research run.
- Each film carries its resolved `imdbId` plus `imdbRating` / `imdbVotes`, so the userscript can skip fuzzy title matching.
- Choosing a different film from the Discord picker updates the published file too.

## Non-goals / anti-goals

- No new data sources beyond IMDb (ratings) and the existing Reddit scrape.
- Never publish an empty or partial schedule: a failed scrape leaves the previous file untouched.
- Never commit noise: no commit when nothing but a timestamp changed.
- The userscript's display of ratings is the userscript's decision; this file only carries the data.
- Out of scope: the Android app (`android_GrindhouseTV`) has the same Reddit dependency; a follow-up.

## Approaches considered

Layout: one `schedule/current.json` overwritten weekly (chosen; git history is the archive and the URL is stable)
vs. per-weekend files plus a pointer (duplicate content, nothing needs the archive).

Publishing:
1. Once at the end of `run`: lineup empty for ~1.5 h, nothing published if the run crashes.
2. Twice per `run` (titles, then ids/ratings): works quickly, but only when `run` starts (Thu 00:00).
3. **Chosen: a separate light `schedule` command** (fetch, resolve ids, rate, publish; no Claude usage; under a
   minute), called first by `run` and also on its own early cron. Decouples the lineup from the research job.

## Design

**File** (`schema: 1`; `days` has the same shape the userscript's `fetchTonightsSchedule()` already returns, plus extras):

```json
{ "schema": 1, "fetchedAt": "ISO", "postId": "t3_…", "title": "Weekend Grindhouse Schedule - Fri 11/20 - Sun 11/22",
  "publishedAt": "ISO", "weekend": { "fri": "2026-11-20", "sat": "2026-11-21", "sun": "2026-11-22" },
  "days": [ { "day": "Friday", "date": "2026-11-20",
    "sections": [ { "name": "…", "slug": "…",
      "items": [ { "title": "Zeiram", "year": "1991", "display": "Zeiram (1991)", "akas": [],
                   "imdbId": "tt0103327", "imdbRating": 6.4, "imdbVotes": 3100 } ] } ] } ] }
```
`year` is a **string** (or `null`), exactly as the userscript's own list parser produces it, so its downstream code is
unchanged (the generator's `flattenMovies` converts to a number internally; publish the pre-conversion value).
`imdbId`, `imdbRating`, `imdbVotes` are `null` when unresolved/unrated. A dismissed title stays in the lineup with
`imdbId: null` (it still airs; "dismissed" only means no trivia is generated).

**`schedule` command** (`node src/cli.js schedule`): under the run lock, `git pull`, scrape (existing
`fetchWeekendMoviesViaBrowser`, extended to return `days`/`postId`/`publishedAt`), resolve each item through the existing
resolver (which already applies `overrides/title-overrides.json`), fetch `ratingsSummary { aggregateRating voteCount }`
from the IMDb GraphQL endpoint already used by `src/imdb.js`, write the file, and commit/push only if the content
(ignoring `fetchedAt`) changed. Commit message `schedule: <post title>`. A rating fetch failure leaves that item's rating null;
it is retried on the next run. Within one weekend's post, ids and ratings already published are kept (a failed or empty lookup
never erases an id, and a rating is fetched once per id, not refreshed), so an IMDb outage cannot blank the file and vote-count
drift never causes a commit. A dismissed title is never re-resolved. `schedule` also pushes any commit stranded by an
earlier failed push before doing anything else. (Added after the final review.) `run` calls the same function before researching.

**Cron:** add `schedule` on Wednesday (my call: 12:00 and 20:00 container time, since the post is "usually Wednesday"),
alongside the existing Thu/Fri `run` entries.

**Discord pick:** `makeSaveChoice` already holds the run lock and commits the override. After saving the override it
also updates the matching item (matched with `overrideKey(title, year)`) in `schedule/current.json` if present: set
`imdbId` (or null on dismiss) and a freshly fetched rating, and commit both files together. A rating fetch failure
there is non-fatal (id is set, rating null until the next `schedule` run). A pick for a film not in the current file
changes only the override. `commitAndPush` is extended to take more than one file.

**Userscript** (`cytube_tv_interface_script`, second repo): `fetchTonightsSchedule()` fetches
`https://raw.githubusercontent.com/spudzareneat/grindhouse-popup-trivia/main/schedule/current.json` instead of the
Reddit feed and returns the same shape, so the cache, expiry (`lineupScheduleExpired`), timing and fallback logic are
untouched. Use `imdbId` for lookups when present. `@connect raw.githubusercontent.com` is already declared; the
`www.reddit.com` entry and the RSS parsing code become dead and can be removed in the same change.
When `run` calls the schedule step it does so inside its existing lock (no second lock acquisition).

## Constraints

- GitHub raw caches for a few minutes; acceptable.
- One more weekly Reddit login (2 scrapes/Wed); low volume.
- Never log cookie values; the file contains no secrets.

## Left to the builder

Names of the new modules/functions, exact refactor of `scheduleFromEntries` to expose `days`, how the userscript surfaces
ratings in its UI, and tests (unit tests with fakes, like the existing suite; no live Reddit/IMDb in tests).
