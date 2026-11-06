#!/bin/sh
set -eu

# Deploy key (read-only mount) -> ssh config that git uses for github.com.
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
if [ -f /secrets/deploy_key ]; then
  cp /secrets/deploy_key "$HOME/.ssh/id_ed25519"
  chmod 600 "$HOME/.ssh/id_ed25519"
else
  case "${GIT_REMOTE:-}" in
    git@*)
      echo "entrypoint: /secrets/deploy_key missing (create secrets/deploy_key on the host before 'docker compose up'; see README)" >&2
      exit 1 ;;
  esac
fi
# Pinned GitHub host key (no trust-on-first-use, no dependence on network at boot).
printf '%s\n' 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' > "$HOME/.ssh/known_hosts"

git config --global user.name "${GIT_AUTHOR_NAME:-grindhouse-popup-trivia bot}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-bot@users.noreply.github.com}"

# The data checkout lives on a volume so commits survive container rebuilds.
if [ ! -d /work/.git ]; then
  git clone "${GIT_REMOTE:?set GIT_REMOTE}" /work
fi

# A lock left on the volume by a previous container names a pid that may be reused here; nothing else runs yet.
rm -f "${DATA_REPO_DIR:-/work}/.cache/run.lock"

case "${1:-cron}" in
  cron)
    # Optional Discord bot beside the schedule. DATA_REPO_DIR=/work comes from the image ENV.
    # Restart it if it dies; bot-main exits 0 right away when channel/owner ids are missing,
    # so wait longer after a clean exit than after a crash.
    if [ -n "${DISCORD_BOT_TOKEN:-}" ]; then
      (
        cd /app
        while true; do
          if node /app/src/bot-main.js; then sleep 30; else sleep 5; fi
        done
      ) &
    fi
    exec supercronic /app/docker/crontab ;;
  bot)   exec node /app/src/bot-main.js ;;
  run)   shift; exec node /app/src/cli.js run "$@" ;;
  movie) shift; exec node /app/src/cli.js movie "$@" ;;
  shell) exec /bin/sh ;;
  *)     exec "$@" ;;
esac
