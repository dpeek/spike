#!/bin/sh
set -eu
# The host auth file is never mounted. The dispatcher supplies a one-provider
# document only for authenticated Tickets; materialize it on container tmpfs.
if [ -n "${SPIKE_PI_AUTH_B64:-}" ]; then
  umask 077
  mkdir -p "$PI_CODING_AGENT_DIR"
  printf '%s' "$SPIKE_PI_AUTH_B64" | base64 -d > "$PI_CODING_AGENT_DIR/auth.json"
  unset SPIKE_PI_AUTH_B64
fi
# /work is a container tmpfs. The host repository is never mounted.
git clone --quiet --no-checkout /exchange/input/repository.bundle /work/repository
git -C /work/repository checkout --quiet --detach "$SPIKE_INPUT_REVISION"
actual=$(git -C /work/repository rev-parse --verify HEAD^{commit})
[ "$actual" = "$SPIKE_INPUT_REVISION" ]
cd /work/repository
exec "$@"
