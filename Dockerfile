FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl tzdata \
 && rm -rf /var/lib/apt/lists/*

ARG SUPERCRONIC_VERSION=v0.2.49
RUN curl -fsSLo /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
 && chmod +x /usr/local/bin/supercronic

RUN npm install -g @anthropic-ai/claude-code@2.1

# Named volume for the data checkout inherits this ownership on first use, so the
# unprivileged node user can clone/commit into it.
RUN mkdir /work && chown node:node /work

WORKDIR /app
COPY package.json ./
# Chromium for the Reddit schedule scrape (Reddit RSS ended 2026-11-13). Browsers live outside HOME so the node user can read them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install --omit=dev --no-audit --no-fund \
 && npx playwright-core install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/*
COPY src ./src
COPY docker ./docker
RUN chmod +x docker/entrypoint.sh

USER node
ENV DATA_REPO_DIR=/work HOME=/home/node DISABLE_AUTOUPDATER=1 PRUNE_CLAUDE_STATE=1
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["cron"]
