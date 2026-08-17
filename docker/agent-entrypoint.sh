#!/usr/bin/env bash
set -euo pipefail

workspace=${AGENT_WORKSPACE:-/workspace}
repo=${AGENT_REPO_DIR:-${workspace}/project}
agent_name=${AGENT_NAME:-default}
agent_branch=${AGENT_BRANCH:-agent/${agent_name}}
agent_dir=${AGENT_STATE_DIR:-/home/node/.pi/agent}

startup_error() {
    echo "agent startup: $1" >&2
    exit 1
}

node_can_read() {
    if [[ $(id -u) -eq 0 ]]; then
        runuser -u node -- test -r "$1"
    else
        test -r "$1"
    fi
}

prepare_runtime_link() {
    local label=$1
    local source=$2
    local destination=$3

    if [[ -z "$source" ]]; then
        # Shared state can outlive its creating machine. Remove only an
        # unavailable symlink here; preserve ordinary worker-owned files.
        if [[ -L "$destination" && ! -e "$destination" ]]; then
            rm -f "$destination" || startup_error "could not remove stale $label link at $destination"
        fi
        return 0
    fi
    if [[ ! -f "$source" ]]; then
        [[ ! -L "$destination" ]] || rm -f "$destination" || true
        startup_error "configured $label source is unavailable: $source"
    fi

    mkdir -p "$(dirname "$destination")" || startup_error "could not create the $label state directory"
    if [[ -L "$destination" && "$(readlink "$destination")" == "$source" ]] && node_can_read "$destination"; then
        return 0
    fi
    rm -rf "$destination" || startup_error "could not replace conflicting $label state at $destination"
    ln -s "$source" "$destination" || startup_error "could not link $label from $source"

    if ! node_can_read "$destination"; then
        rm -f "$destination" || true
        startup_error "configured $label source is not readable by node: $source"
    fi
}

mkdir -p "$workspace" "$agent_dir"

# Both launchers enter as root. Apple volumes need ownership initialization;
# Docker also needs root to repair state containing host-absolute Apple links.
# Drop privileges before repository setup or the requested command starts.
if [[ $(id -u) -eq 0 ]]; then
    chown node:node "$workspace"
    # Apple virtiofs bind mounts map writes to the host owner and reject chown,
    # while named workspace volumes require it. The bind remains writable by
    # the unprivileged process despite reporting root ownership in the guest.
    chown node:node "$agent_dir" 2>/dev/null || true
fi

prepare_runtime_link "Pi auth" "${HOST_PI_AUTH_FILE:-}" "$agent_dir/auth.json"
prepare_runtime_link "Herdr Pi extension" "${HOST_HERDR_PI_EXTENSION:-}" "$agent_dir/extensions/herdr-agent-state.ts"

if [[ $(id -u) -eq 0 ]]; then
    exec runuser -u node --preserve-environment -- "$0" "$@"
fi

bootstrap_recorded=0
bootstrap_error=
requested_commit_type=
head_commit=
configured_base_commit=

durable_base=${SPIKE_BASE_REVISION:-}
requested_base_ref=${AGENT_BASE_REF:-}
if [[ -n "$durable_base" && -n "$requested_base_ref" && "$durable_base" != "$requested_base_ref" ]]; then
    bootstrap_error="SPIKE_BASE_REVISION and AGENT_BASE_REF disagree ($durable_base != $requested_base_ref)"
fi
canonical_base_ref=${durable_base:-${requested_base_ref:-HEAD}}

write_launch_evidence() {
    local launch_status=${1}
    local launch_error=${2:-}
    if [[ -z "${SPIKE_LAUNCH_EVIDENCE_PATH:-}" || -z "${SPIKE_LAUNCH_EVIDENCE_TOKEN:-}" ]]; then
        return 0
    fi
    mkdir -p "$(dirname "$SPIKE_LAUNCH_EVIDENCE_PATH")"
    SPIKE_EVIDENCE_STATUS="$launch_status" \
    SPIKE_EVIDENCE_ERROR="$launch_error" \
    SPIKE_EVIDENCE_HEAD="${head_commit:-}" \
    SPIKE_EVIDENCE_AGENT_BASE="${configured_base_commit:-}" \
    SPIKE_EVIDENCE_COMMIT_TYPE="${requested_commit_type:-}" \
    bun -e 'const { rename, rm } = await import("node:fs/promises");
const path = process.env.SPIKE_LAUNCH_EVIDENCE_PATH;
if (!path) process.exit(0);
const record = {
  schemaVersion: 1,
  token: process.env.SPIKE_LAUNCH_EVIDENCE_TOKEN,
  status: process.env.SPIKE_EVIDENCE_STATUS,
  workerSlug: process.env.AGENT_NAME ?? "default",
  ...(process.env.SPIKE_RUN_ID ? { runId: process.env.SPIKE_RUN_ID } : {}),
  ...(process.env.SPIKE_GOAL_ID ? { goalId: process.env.SPIKE_GOAL_ID } : {}),
  ...(process.env.SPIKE_TICKET_ID ? { ticketId: process.env.SPIKE_TICKET_ID } : {}),
  ...(process.env.SPIKE_BASE_REVISION ? { baseRevision: process.env.SPIKE_BASE_REVISION } : {}),
  ...(process.env.SPIKE_AGENT_CONTAINER ? { container: process.env.SPIKE_AGENT_CONTAINER } : {}),
  ...(process.env.SPIKE_AGENT_STARTED_AT ? { startedAt: process.env.SPIKE_AGENT_STARTED_AT } : {}),
  ...(process.env.SPIKE_AGENT_PID ? { pid: Number(process.env.SPIKE_AGENT_PID) } : {}),
  ...(process.env.SPIKE_EVIDENCE_HEAD ? { head: process.env.SPIKE_EVIDENCE_HEAD } : {}),
  ...(process.env.SPIKE_EVIDENCE_AGENT_BASE ? { agentBase: process.env.SPIKE_EVIDENCE_AGENT_BASE } : {}),
  ...(process.env.SPIKE_EVIDENCE_COMMIT_TYPE ? { commitType: process.env.SPIKE_EVIDENCE_COMMIT_TYPE } : {}),
  recordedAt: new Date().toISOString(),
  ...(process.env.SPIKE_EVIDENCE_ERROR ? { error: process.env.SPIKE_EVIDENCE_ERROR } : {}),
};
const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
try {
  await Bun.write(tmp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmp, path);
} finally {
  await rm(tmp, { force: true }).catch(() => {});
}'
    bootstrap_recorded=1
}

fail_bootstrap() {
    bootstrap_error=${1}
    echo "$bootstrap_error" >&2
    exit 1
}

trap 'status=$?; if [[ $status -ne 0 && $bootstrap_recorded -eq 0 ]]; then write_launch_evidence launch_failed "${bootstrap_error:-agent bootstrap exited with status ${status}}" || true; fi' EXIT

if [[ -n "$bootstrap_error" ]]; then
    fail_bootstrap "$bootstrap_error"
fi

mkdir -p "$workspace" "$agent_dir"
if [[ ! -e "$agent_dir/settings.json" ]]; then
    printf '{\n  "npmCommand": ["bun"],\n  "enableInstallTelemetry": false\n}\n' > "$agent_dir/settings.json"
fi

if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    if [[ -d "$repo" && -n "$(find "$repo" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
        fail_bootstrap "Repository directory is non-empty but is not a Git repository: $repo"
    fi

    if [[ -n "${REPOSITORY_URL:-}" ]]; then
        source_repo=$REPOSITORY_URL
    elif git -c safe.directory=/seed -C /seed rev-parse --git-dir >/dev/null 2>&1; then
        source_repo=/seed
    else
        fail_bootstrap "No repository is available to clone. Run from a Git repository, set REPO_SEED, or set REPOSITORY_URL."
    fi

    echo "Initializing agent '$agent_name' from $source_repo"
    if [[ "$source_repo" == /seed ]]; then
        if ! git -c safe.directory=/seed clone --no-hardlinks "$source_repo" "$repo"; then
            fail_bootstrap "Could not clone agent repository from $source_repo"
        fi
    else
        if ! git clone "$source_repo" "$repo"; then
            fail_bootstrap "Could not clone agent repository from $source_repo"
        fi
    fi
fi

cd "$repo"

git config user.name "${GIT_USER_NAME:-Pi Agent ${agent_name}}"
git config user.email "${GIT_USER_EMAIL:-${agent_name}@pi-agent.local}"

if [[ -n "$durable_base" ]]; then
    requested_commit_type=$(git cat-file -t "${durable_base}^{commit}" 2>/dev/null || true)
    if [[ -z "$requested_commit_type" ]]; then
        fail_bootstrap "Durable base $durable_base is not available in the worker clone"
    fi
    if [[ "$requested_commit_type" != "commit" ]]; then
        fail_bootstrap "Durable base $durable_base is not a commit object"
    fi
fi

if [[ -n "$agent_branch" ]]; then
    if git show-ref --verify --quiet "refs/heads/$agent_branch"; then
        if ! git switch "$agent_branch" >/dev/null; then
            fail_bootstrap "Could not switch to worker branch $agent_branch"
        fi
    elif git show-ref --verify --quiet "refs/remotes/origin/$agent_branch"; then
        base_commit=$(git rev-parse "refs/remotes/origin/$agent_branch^{commit}" 2>/dev/null || true)
        if [[ -z "$base_commit" ]]; then
            fail_bootstrap "Could not resolve origin/$agent_branch as a commit"
        fi
        if ! git switch --track "origin/$agent_branch" >/dev/null; then
            fail_bootstrap "Could not track worker branch origin/$agent_branch"
        fi
        if ! git config --local spike.agentBase "$base_commit"; then
            fail_bootstrap "Could not record spike.agentBase for $agent_branch"
        fi
    else
        base_commit=$(git rev-parse "${canonical_base_ref}^{commit}" 2>/dev/null || true)
        if [[ -z "$base_commit" ]]; then
            fail_bootstrap "Requested agent base ${canonical_base_ref} is not available as a commit"
        fi
        if ! git switch -c "$agent_branch" "$base_commit" >/dev/null; then
            fail_bootstrap "Could not create worker branch $agent_branch from $base_commit"
        fi
        if ! git config --local spike.agentBase "$base_commit"; then
            fail_bootstrap "Could not record spike.agentBase for $agent_branch"
        fi
    fi

    # Workspaces created before branch publication was added do not have the
    # explicit base. Their clone's immutable origin default is the safest
    # derivation of the original seed divergence point.
    if ! git config --local --get spike.agentBase >/dev/null 2>&1; then
        origin_head=$(git rev-parse --verify 'refs/remotes/origin/HEAD^{commit}' 2>/dev/null || true)
        if [[ -n "$origin_head" ]]; then
            base_commit=$(git merge-base HEAD "$origin_head" 2>/dev/null || true)
            if [[ -n "$base_commit" ]]; then
                git config --local spike.agentBase "$base_commit"
            fi
        fi
    fi
fi

head_commit=$(git rev-parse 'HEAD^{commit}' 2>/dev/null || true)
configured_base_commit=$(git config --local --get spike.agentBase 2>/dev/null || true)
if [[ -n "$durable_base" ]]; then
    if [[ -z "$head_commit" ]]; then
        fail_bootstrap "Could not resolve worker HEAD as a commit"
    fi
    if [[ "$head_commit" != "$durable_base" ]]; then
        fail_bootstrap "Worker HEAD $head_commit does not match durable base $durable_base"
    fi
    if [[ -z "$configured_base_commit" ]]; then
        fail_bootstrap "Worker spike.agentBase is not configured for durable base $durable_base"
    fi
    if [[ "$configured_base_commit" != "$durable_base" ]]; then
        fail_bootstrap "Worker spike.agentBase $configured_base_commit does not match durable base $durable_base"
    fi
fi

write_launch_evidence ready ""
exec "$@"
