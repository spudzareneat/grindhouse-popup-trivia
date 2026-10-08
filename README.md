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
   The key must exist before `docker compose up` (otherwise Docker creates an empty directory there).
3. `cp .env.example .env` and fill in `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) — compose reads `.env` for variable substitution.
4. Try one movie without publishing: `docker compose run --rm generator movie tt0055830 --dry-run`
   then look at it: `docker compose run --rm generator shell` → `cat /work/out/tt0055830.json`.
5. Start the schedule: `docker compose up -d --build` (runs at midnight ending Wed, Thu 06:00 and Fri 00:01 in `TZ`). Logs: `docker compose logs -f`.

### Portainer

1. On the server: `sudo mkdir -p /opt/grindhouse-popup-trivia && sudo ssh-keygen -t ed25519 -N "" -f /opt/grindhouse-popup-trivia/deploy_key && sudo chown 1000 /opt/grindhouse-popup-trivia/deploy_key`;
   add `deploy_key.pub` as a GitHub deploy key with **Allow write access**.
2. Stacks → Add stack → **Repository**: URL `https://github.com/spudzareneat/grindhouse-popup-trivia`,
   reference `refs/heads/main`, compose path `docker-compose.yml`.
3. Environment variables: `CLAUDE_CODE_OAUTH_TOKEN=<from claude setup-token>`,
   `DEPLOY_KEY_PATH=/opt/grindhouse-popup-trivia/deploy_key`, `TZ=America/Los_Angeles`
   (optional: `CLAUDE_MODEL`, `TMDB_API_KEY`, `OPENSUBTITLES_API_KEY` / `_USERNAME` / `_PASSWORD`, `MOVIE_DELAY_SEC`, `CLAUDE_TIMEOUT_MIN`). Deploy.
4. Test: container → Console (user `node`, `/bin/sh`) → `cd /app && node src/cli.js movie tt0055830 --dry-run`
   then `cat /work/out/tt0055830.json`. The same console runs `node src/cli.js run` / `movie …` by hand.

Manual commands: `docker compose run --rm generator run` (this weekend now), `… movie "Title" --year 1980`,
add `--force` to regenerate an existing file. Don't run a manual `docker compose run … movie` while a scheduled
run is in progress — they share the `/work` checkout.

Exit codes: 0 ok, 1 failures / feed error, 2 Claude usage limit or auth failure (re-run later / fix the token),
3 git push failed (run stopped; the commit stays local and is pushed by the next run), 64 bad command line.

Hand-editing: files in `data/` are plain JSON — fix or delete a fact on GitHub; the next run skips movies
that already have a file.
