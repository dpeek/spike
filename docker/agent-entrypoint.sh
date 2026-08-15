#!/usr/bin/env bash
set -euo pipefail

workspace=${AGENT_WORKSPACE:-/workspace}
repo=${AGENT_REPO_DIR:-${workspace}/project}
agent_name=${AGENT_NAME:-default}
agent_branch=${AGENT_BRANCH:-agent/${agent_name}}
agent_dir=/home/node/.pi/agent

# Apple container volumes are fresh ext4 filesystems owned by root. Its launcher
# starts this entrypoint as root so it can hand only the mounted directories to
# the unprivileged runtime user, then immediately drops privileges.
if [[ $(id -u) -eq 0 ]]; then
    mkdir -p "$workspace" "$agent_dir"
    if [[ -n "${HOST_PI_AUTH_FILE:-}" && -f "$HOST_PI_AUTH_FILE" ]]; then
        rm -f "$agent_dir/auth.json"
        ln -s "$HOST_PI_AUTH_FILE" "$agent_dir/auth.json"
    fi
    if [[ -n "${HOST_HERDR_PI_EXTENSION:-}" && -f "$HOST_HERDR_PI_EXTENSION" ]]; then
        mkdir -p "$agent_dir/extensions"
        rm -f "$agent_dir/extensions/herdr-agent-state.ts"
        ln -s "$HOST_HERDR_PI_EXTENSION" "$agent_dir/extensions/herdr-agent-state.ts"
    fi
    chown node:node "$workspace"
    # Apple virtiofs bind mounts map writes to the host owner and reject chown,
    # while named workspace volumes require it. The bind remains writable by
    # the unprivileged process despite reporting root ownership in the guest.
    chown node:node "$agent_dir" 2>/dev/null || true
    exec runuser -u node --preserve-environment -- "$0" "$@"
fi

mkdir -p "$workspace" "$agent_dir"
if [[ ! -e "$agent_dir/settings.json" ]]; then
    printf '{\n  "npmCommand": ["bun"],\n  "enableInstallTelemetry": false\n}\n' > "$agent_dir/settings.json"
fi

if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    if [[ -d "$repo" && -n "$(find "$repo" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
        echo "Repository directory is non-empty but is not a Git repository: $repo" >&2
        echo "Remove the agent workspace volume to initialize it again." >&2
        exit 1
    fi

    if [[ -n "${REPOSITORY_URL:-}" ]]; then
        source_repo=$REPOSITORY_URL
    elif git -c safe.directory=/seed -C /seed rev-parse --git-dir >/dev/null 2>&1; then
        source_repo=/seed
    else
        echo "No repository is available to clone." >&2
        echo "Run from a Git repository, set REPO_SEED, or set REPOSITORY_URL." >&2
        exit 1
    fi

    echo "Initializing agent '$agent_name' from $source_repo"
    if [[ "$source_repo" == /seed ]]; then
        git -c safe.directory=/seed clone --no-hardlinks "$source_repo" "$repo"
    else
        git clone "$source_repo" "$repo"
    fi
fi

cd "$repo"

git config user.name "${GIT_USER_NAME:-Pi Agent ${agent_name}}"
git config user.email "${GIT_USER_EMAIL:-${agent_name}@pi-agent.local}"

if [[ -n "$agent_branch" ]]; then
    if git show-ref --verify --quiet "refs/heads/$agent_branch"; then
        git switch "$agent_branch" >/dev/null
    elif git show-ref --verify --quiet "refs/remotes/origin/$agent_branch"; then
        git switch --track "origin/$agent_branch" >/dev/null
    else
        git switch -c "$agent_branch" "${AGENT_BASE_REF:-HEAD}" >/dev/null
    fi
fi

exec "$@"
