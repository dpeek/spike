FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

ARG BUN_VERSION=1.3.14
ARG PI_VERSION=0.84.2
ARG AGENT_BROWSER_VERSION=0.34.0
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    BUN_INSTALL=/usr/local \
    PATH=/usr/local/bin:${PATH}

# Small, generally useful CLI baseline. agent-browser adds Chromium's runtime
# libraries below; no compiler toolchain is installed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        chromium \
        curl \
        file \
        git \
        jq \
        less \
        openssh-client \
        procps \
        python3 \
        ripgrep \
        tini \
        tmux \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# Pin the agent-facing JavaScript tooling. Node remains the runtime because both
# pi and agent-browser currently ship Node entrypoints; Bun manages packages.
RUN case "${TARGETARCH}" in \
        amd64) BUN_ARCH=x64; BUN_SHA=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f ;; \
        arm64) BUN_ARCH=aarch64; BUN_SHA=a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b ;; \
        *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/bun.zip \
        "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ARCH}.zip" \
    && echo "${BUN_SHA}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && install -m 0755 "/tmp/bun/bun-linux-${BUN_ARCH}/bun" /usr/local/bin/bun \
    && rm -rf /tmp/bun /tmp/bun.zip \
    && bun install --global \
        "@earendil-works/pi-coding-agent@${PI_VERSION}" \
        "agent-browser@${AGENT_BROWSER_VERSION}" \
    && pi --version \
    && agent-browser --version \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx

# Debian's Chromium supports both amd64 and arm64 (Chrome for Testing does not
# publish Linux arm64 builds). Configure pi before dropping privileges.
RUN mkdir -p /home/node/.pi/agent /workspace \
    && printf '{\n  "npmCommand": ["bun"],\n  "enableInstallTelemetry": false\n}\n' \
        > /home/node/.pi/agent/settings.json \
    && chown -R node:node /home/node /workspace

COPY --chmod=0755 docker/agent-entrypoint.sh /usr/local/bin/agent-entrypoint

ENV HOME=/home/node \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0

# The entrypoint uses a narrowly scoped root phase for mounted-directory
# ownership and portable auth/integration links, then execs every agent command
# as node. Launchers also request root explicitly so older local images repair
# shared state instead of skipping setup.
USER root
WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agent-entrypoint"]
CMD ["pi"]
