# Node base is immutable; Bun and Pi are exact package versions.
FROM node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b

ARG BUN_VERSION=1.3.14
ARG PI_VERSION=0.73.1
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global "bun@${BUN_VERSION}" "@mariozechner/pi-coding-agent@${PI_VERSION}"

WORKDIR /opt/spike
COPY package.json bun.lock tsconfig.json ./
RUN bun install
COPY bin ./bin
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/spike-worker-entrypoint
RUN chmod 0555 /usr/local/bin/spike-worker-entrypoint
ENTRYPOINT ["/usr/local/bin/spike-worker-entrypoint"]
