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
COPY src ./src
COPY docker ./docker
RUN chmod +x docker/entrypoint.sh

USER node
ENV DATA_REPO_DIR=/work HOME=/home/node
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["cron"]
