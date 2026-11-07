# Discord integration and TMDB title lookup — design

Date: 2026-11-06

## Intent and why

The generator runs unattended in a Docker container (supercronic, Thursday/Friday). Titles in the weekly r/420Grindhouse schedule post are often imperfect. When a title is not found, or is matched to the wrong film, the run logs it to the container's stdout and moves on. Nobody sees it, and the owner finds out only when the movie starts with no trivia (or wrong trivia).

Goals:
1. Make the pipeline resolve more titles on its own, by using TMDB search alongside IMDb search.
2. Report every run to Discord, so silent failure stops being silent.
3. When the pipeline is unsure about a match, let the owner correct it with one click in Discord.

The owner expects to ignore Discord most of the time (about 9 in 10 runs). Automation is the default; Discord is for exceptions.

## Goals, non-goals, anti-goals

Goals
- More titles resolve with no human involvement.
- One summary message per run, readable at a glance, with problems at the top.
- A click-to-fix picker for unsure or failed matches.

Non-goals
- A picker for confident matches that happen to be wrong. These appear only in the summary (title matched, year), where the owner may spot them.
- Multi-user access, slash commands, or a general Discord bot. One owner, one channel.
- Any change to how facts are researched or validated.

Anti-goals (failure even if it "works")
- Discord being down, or its settings missing, must not stop or change the scraper. With no Discord configuration the run behaves exactly as today.
- A click must never cause two Claude/git sessions to run at once.
- A confident-but-wrong auto-match that nobody can see. Every TMDB-resolved match must be visible in the summary.
- Adding runtime dependencies. The project has none and keeps it that way.

## Constraints

- Node >= 22, ESM, no dependencies. Use native `fetch` and Node 22's built-in `WebSocket`.
- Dependency injection style: `fetchImpl`, `log`, etc. are passed in so tests stub them. Tests use `node --test`.
- The run is a one-shot process (`node src/cli.js run`), started by cron inside the container. `src/cli.js` wires dependencies and is the one place that sees every result.
- Config comes from env only. New variables go in `.env.example` and the `environment:` block of `docker-compose.yml`.
- Everything downstream keys on an IMDb tconst. A TMDB hit with no IMDb id is unusable.
- Existing commit/publish flow: each movie is committed as `data: <title> (<year>) — N facts`.

## Design

### 1. Title resolution (`src/pipeline.js` `resolveTconst`, new TMDB search)

Resolution order stays as today (titles and akas as written, then variants, via IMDb search). If IMDb finds nothing for any term, try TMDB search for the same terms, with the year. For a TMDB result, fetch its IMDb id (`/movie/{id}/external_ids`). Discard results with no IMDb id. `src/tmdb.js` needs a `searchTitle(term, year)` that returns candidates `{tconst, title, year, popularity/votes}`; with no API key it is a no-op, as `fetchExtras` is.

`resolveTconst` returns, in addition to `tconst`: the `source` (`imdb` or `tmdb`), a `confidence` (`confident` or `unsure`), and the ranked `candidates` list (merged from IMDb and TMDB, de-duplicated by tconst).

Confidence (the owner's call: auto-pick, flag if unsure; the thresholds are the designer's choice and are tunable):
- Confident: title similarity passes the existing `titlesMatch` check (Dice >= 0.7), the year is present and within 1 of the schedule year, and the top candidate clearly leads the next (clearly = a margin to be chosen by the builder).
- Unsure: weak title match, no year in the schedule, or two close candidates.
- Not found: no candidates at all from IMDb or TMDB.

### 2. Behaviour per outcome

- Confident: proceed automatically. Summary line shows the matched title/year, with a marker if TMDB found it.
- Unsure: proceed with the best guess immediately (the owner chose this over holding the movie). Summary lists it under "needs a look" at the top. A picker message is posted with the candidates as buttons.
- Not found: status `failed`, as today. Listed in the summary. If any distant candidates exist, post a picker; "None of these" is always offered.

### 3. Click to fix

A Discord bot (token, channel id, owner user id in env) runs as a second always-on process in the existing container, beside supercronic. Picker messages carry one button per candidate (title, year, source) plus "None of these".

When the owner clicks a candidate:
1. Save the choice as a title override, so the same schedule title resolves directly next time (a small overrides file committed with the data; format and location left to the builder).
2. Run the single-movie generation for that tconst (the existing `movie` command path).
3. If the original run had generated a file for a different, wrong best guess, delete that file, in the same commit that adds the new one.
4. Edit the picker message to show progress, then the result (done, or failed with the reason).

"None of these" records that the title was dismissed (so it is not asked about again) and, if a best-guess file was generated, leaves it for the owner to remove by hand. (Left to the builder: whether to also delete it.)

Rules:
- Only the configured owner user id can click; other users' interactions are ignored.
- Clicks that arrive while a scheduled run or another click is in progress are queued and run one at a time. The queue does not run concurrently with cron's `run`.
- The bot uses Discord's gateway (WebSocket) for interactions, with REST calls for posting/editing. No public HTTP endpoint is needed.

### 4. Summary message

Posted by `src/cli.js` after `runWeekend` returns (the one point that has all results, including failed and stopped runs). Contents, in order:
1. "Needs a look": unsure matches and failures (with picker buttons right below, or linked).
2. Done: one line per movie, with the matched title/year and fact count; TMDB-resolved ones marked.
3. Skipped (already had a file, TV).
4. A run-stopped note if the run ended early (Claude usage limit, publish failure), using the existing exit-code reasons.

If every movie was confident and done, the summary is a short one and posts without picker messages.

### 5. Config

New env vars (names left to the builder): bot token, channel id, owner user id. Absent => all Discord code is skipped. `TMDB_API_KEY` already exists and now also enables TMDB search.

## Left to the builder

- Margin used for "clearly leads", and any extra confidence signals (vote counts, popularity).
- Overrides file format and where it is read in `resolveTconst`.
- How the bot process and cron coexist in the container (entrypoint change, process supervision), and the queue/locking mechanism between them.
- Discord message formatting limits (embeds, 5 buttons per row, 25 per message) and how to degrade when there are more candidates.
- What "None of these" does with an already-generated best-guess file.
- Message edits when the container restarts mid-click (resume or fail cleanly).
- Tests: stub fetch and WebSocket following the existing helpers.

## Decisions made by the owner

- Click-to-fix in Discord, not copy-paste commands.
- TMDB search in both the automatic lookup and the picker.
- Auto-accept confident matches, flag unsure ones in the summary.
- For unsure matches, generate with the best guess right away and replace the file if a different pick is clicked.

## Decisions made by the designer (check these)

- Confidence thresholds as described above.
- Bot lives in the existing container, with the gateway over native WebSocket and no Discord library.
- Choices are saved as persistent title overrides.
- Owner-only clicks; serialised work.

### Settled after the builder check (designer's calls)

- **One process owner for git/Claude.** The bot runs in the same container, same `/work` checkout, same deploy key and Claude OAuth token as cron. On a click it spawns the existing CLI (`node src/cli.js movie <tt>`) as a child process; it does not reimplement generation. Cron's `run` and the bot's child take one shared lock (a lock file on the `/work` volume); whoever arrives second waits. Claude is never used by two processes at once.
- **State that ties a picker to its file.** Pending pickers are stored in a state file on the `/work` volume (outside git), keyed by a pending id: schedule title, year, candidate list, the best-guess tconst and its data file (if one was generated), and the Discord message id. It survives container restarts. If a restarted bot finds a picker whose state is gone, it edits the message to say it has expired.
- **Deleting a wrong file.** If the wrong file was already pushed, the fix deletes it and adds the new file in one follow-up commit. No history rewriting.
- **Message layout.** One picker message per unsure or failed title, posted right after the summary. The summary lists those titles but carries no buttons. Button `custom_id` is `pick:<pendingId>:<tconst>` (or `none`), which fits Discord's 100-character limit because the rest lives in the state file. Candidates are capped at the top 5 per picker (one button row) plus "None of these".
- **Override key.** Normalised schedule title plus year (year may be empty). It is applied before any search in `resolveTconst`, so a remake with a different year is unaffected. A "dismissed" entry only suppresses future pickers for that key; generation still proceeds as it does today.
- **Failure handling.** If a Discord call fails at summary or picker time, log it and carry on: no retry, exit code unchanged. If `TMDB_API_KEY` is missing, TMDB search is a no-op and resolution is IMDb-only as today.
- **Gateway scope.** The bot handles button interactions in the one configured channel only. It requests no privileged intents (no message content, no DMs).
