# grindhouse-popup-trivia

Weekly generator of VH1 "Pop-up Video"-style trivia for the r/420Grindhouse CyTube channel.

A Docker job reads the weekend schedule from r/420Grindhouse, researches each movie (IMDb, Wikidata,
Wikipedia, Joe Bob Briggs' Drive-In Totals, and web research via the Claude Code CLI), and publishes
short, cited, timed facts as `data/<imdbId>.json`. The Spuds Grindhouse Experience userscript
(`trivia-popup` module, [cytube_tv_interface_script](https://github.com/spudzareneat/cytube_tv_interface_script))
plays them in sync for everyone in the channel; movies without a file fall back to IMDb trivia.

Design: see `docs/curated-popup-trivia-design.md` (copied from the userscript repo).

## Running it (Ubuntu server, Docker Compose)

1. `git clone https://github.com/spudzareneat/grindhouse-popup-trivia && cd grindhouse-popup-trivia`
2. Deploy key: `mkdir secrets && ssh-keygen -t ed25519 -N "" -f secrets/deploy_key`, then add
   `secrets/deploy_key.pub` at GitHub → repo Settings → Deploy keys, **Allow write access**.
   The container runs as uid 1000; if your user isn't uid 1000, `sudo chown 1000 secrets/deploy_key`.
3. `cp .env.example .env` and fill in `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`).
4. Try one movie without publishing: `docker compose run --rm generator movie tt0055830 --dry-run`
   then look at it: `docker compose run --rm generator shell` → `cat /work/out/tt0055830.json`.
5. Start the schedule: `docker compose up -d --build` (runs Thu & Fri 03:00 in `TZ`). Logs: `docker compose logs -f`.

Manual commands: `docker compose run --rm generator run` (this weekend now), `… movie "Title" --year 1980`,
add `--force` to regenerate an existing file. Exit code 2 = stopped by the Claude usage limit (re-run later).

Hand-editing: files in `data/` are plain JSON — fix or delete a fact on GitHub; the next run skips movies
that already have a file.
