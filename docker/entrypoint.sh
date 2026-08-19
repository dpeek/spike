#!/bin/sh
set -eu
# /work is a container tmpfs. The host repository is never mounted.
git clone --quiet --no-checkout /exchange/input/repository.bundle /work/repository
git -C /work/repository checkout --quiet --detach "$SPIKE_INPUT_REVISION"
actual=$(git -C /work/repository rev-parse --verify HEAD^{commit})
[ "$actual" = "$SPIKE_INPUT_REVISION" ]
cd /work/repository
exec "$@"
