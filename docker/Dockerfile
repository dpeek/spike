# Node base is immutable; Bun and Pi are exact package versions.
FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90

ARG BUN_VERSION=1.4.0
ARG PI_VERSION=0.84.2
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ripgrep fd-find curl jq \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global "bun@${BUN_VERSION}" "@earendil-works/pi-coding-agent@${PI_VERSION}"

WORKDIR /opt/spike
COPY package.json bun.lock tsconfig.json ./
RUN bun install
COPY bin ./bin
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/spike-worker-entrypoint
RUN chmod 0555 /usr/local/bin/spike-worker-entrypoint
ENTRYPOINT ["/usr/local/bin/spike-worker-entrypoint"]
