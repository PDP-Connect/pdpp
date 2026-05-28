#!/usr/bin/env bash
#
# claude-workstream.sh — Launch a Claude worker lane with durable artifacts.
#
# Prevents silent failed reports by always writing:
#   - prompt.txt           : exact prompt the worker received
#   - transcript.log       : full stdout/stderr of the Claude invocation
#   - git-status-before.txt / git-status-after.txt
#   - status.json          : lane metadata, exit code, report state, recovery flag
#
# If the required report file is missing or empty after the main run, one
# report-only recovery pass is attempted: Claude is re-invoked with a tightly
# scoped prompt asking it to reconstruct a report from the transcript and
# `git status`. Recovery does NOT touch code (`--disallowedTools` blocks
# write tools). If the report is still absent after recovery, status.json
# is finalized with `status: "failed"` and the script exits non-zero.
#
# Usage:
#   scripts/claude-workstream.sh \
#     --lane <name> \
#     --worktree <path> \
#     --prompt <prompt-file> \
#     --report <report-path-relative-to-worktree-or-absolute> \
#     [--model <alias|model-id>] \
#     [--no-recovery] \
#     [--artifact-root <dir>]
#
# Defaults:
#   --model       opus
#   --artifact-root  <git-common-dir>/../tmp/workstreams/claude-wrapper/<lane>/<ts>
#
# The script is intentionally invocation-only: it does not edit the workstream
# hub under .git/workstreams, and it does not merge. Owner reviews the diff.

set -euo pipefail

# ---- arg parsing ------------------------------------------------------------

lane=""
worktree=""
prompt_file=""
report_path=""
model="opus"
artifact_root=""
do_recovery=1

die() {
  echo "claude-workstream: $*" >&2
  exit 2
}

usage() {
  sed -n '2,40p' "$0"
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lane) lane="${2:-}"; shift 2 ;;
    --worktree) worktree="${2:-}"; shift 2 ;;
    --prompt) prompt_file="${2:-}"; shift 2 ;;
    --report) report_path="${2:-}"; shift 2 ;;
    --model) model="${2:-}"; shift 2 ;;
    --artifact-root) artifact_root="${2:-}"; shift 2 ;;
    --no-recovery) do_recovery=0; shift ;;
    -h|--help) usage ;;
    *) die "unknown arg: $1" ;;
  esac
done

[[ -n "$lane" ]] || die "--lane is required"
[[ -n "$worktree" ]] || die "--worktree is required"
[[ -n "$prompt_file" ]] || die "--prompt is required"
[[ -n "$report_path" ]] || die "--report is required"

[[ -d "$worktree" ]] || die "worktree not found: $worktree"
[[ -f "$prompt_file" ]] || die "prompt file not found: $prompt_file"
command -v claude >/dev/null 2>&1 || die "claude CLI not on PATH"
command -v jq >/dev/null 2>&1 || die "jq required for status.json writes"

# Sanitize lane for use as a path segment.
case "$lane" in
  */*|*..*|"") die "invalid lane name: $lane" ;;
esac

worktree_abs="$(cd "$worktree" && pwd)"
prompt_abs="$(cd "$(dirname "$prompt_file")" && pwd)/$(basename "$prompt_file")"

# Resolve report path: relative paths anchor to the worktree.
if [[ "$report_path" = /* ]]; then
  report_abs="$report_path"
else
  report_abs="$worktree_abs/$report_path"
fi
mkdir -p "$(dirname "$report_abs")"

# ---- artifact directory -----------------------------------------------------

if [[ -z "$artifact_root" ]]; then
  common_git_dir="$(git -C "$worktree_abs" rev-parse --git-common-dir)"
  # git-common-dir may be relative; resolve against the worktree.
  if [[ "$common_git_dir" != /* ]]; then
    common_git_dir="$worktree_abs/$common_git_dir"
  fi
  repo_root="$(cd "$common_git_dir/.." && pwd)"
  artifact_root="$repo_root/tmp/workstreams/claude-wrapper/$lane"
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
artifact_dir="$artifact_root/$ts"
mkdir -p "$artifact_dir"

prompt_copy="$artifact_dir/prompt.txt"
transcript="$artifact_dir/transcript.log"
git_before="$artifact_dir/git-status-before.txt"
git_after="$artifact_dir/git-status-after.txt"
status_json="$artifact_dir/status.json"
recovery_transcript="$artifact_dir/recovery.log"
mcp_config="$artifact_dir/mcp-empty.json"

cp "$prompt_abs" "$prompt_copy"
printf '{"mcpServers":{}}\n' >"$mcp_config"

# ---- snapshot pre-state -----------------------------------------------------

git -C "$worktree_abs" status --short >"$git_before" 2>&1 || true
head_before="$(git -C "$worktree_abs" rev-parse HEAD 2>/dev/null || echo "unknown")"
branch="$(git -C "$worktree_abs" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"

write_status() {
  # Args: status_value report_state recovered exit_code
  local status_value="$1"
  local report_state="$2"
  local recovered="$3"
  local exit_code="$4"
  local head_after
  head_after="$(git -C "$worktree_abs" rev-parse HEAD 2>/dev/null || echo "unknown")"
  jq -n \
    --arg lane "$lane" \
    --arg worktree "$worktree_abs" \
    --arg branch "$branch" \
    --arg head_before "$head_before" \
    --arg head_after "$head_after" \
    --arg prompt "$prompt_copy" \
    --arg transcript "$transcript" \
    --arg report "$report_abs" \
    --arg artifact_dir "$artifact_dir" \
    --arg started_at "$ts" \
    --arg ended_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg status "$status_value" \
    --arg report_state "$report_state" \
    --arg model "$model" \
    --argjson recovered "$recovered" \
    --argjson exit_code "$exit_code" \
    '{
       lane: $lane,
       worktree: $worktree,
       branch: $branch,
       head_before: $head_before,
       head_after: $head_after,
       prompt_file: $prompt,
       transcript_file: $transcript,
       report_file: $report,
       artifact_dir: $artifact_dir,
       started_at: $started_at,
       ended_at: $ended_at,
       status: $status,
       report_state: $report_state,
       recovered: $recovered,
       exit_code: $exit_code,
       model: $model
     }' >"$status_json"
}

# Seed status.json early so a hard crash still leaves a trace.
write_status "running" "absent" false -1

report_present() {
  [[ -s "$report_abs" ]]
}

# ---- main invocation --------------------------------------------------------

# The wrapper prompt: original prompt + an explicit, non-overridable contract
# that the worker MUST write its final report to $report_abs. This is the
# single load-bearing line the recovery pass leans on.
main_prompt="$(cat "$prompt_copy")
---

WORKSTREAM CONTRACT (added by claude-workstream.sh — do not omit):

- Lane: $lane
- Worktree: $worktree_abs
- You MUST write your final report to: $report_abs
- The report must follow the playbook Report Format (Status, Branch, Commit,
  Files changed, What changed, Validation, Residual risks, Next slice, and
  \`git status --short\`).
- Do not merge to main. Commit only verified-green tranches.
- If you cannot finish, write a partial report at the same path with
  Status: blocked and the reason."

echo "claude-workstream: lane=$lane worktree=$worktree_abs"
echo "claude-workstream: artifact_dir=$artifact_dir"
echo "claude-workstream: report=$report_abs"
echo "claude-workstream: invoking claude (model=$model)…"

main_exit=0
(
  cd "$worktree_abs"
  claude \
    --print \
    --model "$model" \
    --no-session-persistence \
    --strict-mcp-config \
    --mcp-config "$mcp_config" \
    --dangerously-skip-permissions \
    --append-system-prompt "Worker lane '$lane'. Write the required report to $report_abs before ending. Follow docs/agent-workstream-playbook.md." \
    "$main_prompt"
) >"$transcript" 2>&1 || main_exit=$?

git -C "$worktree_abs" status --short >"$git_after" 2>&1 || true

# ---- evaluate report --------------------------------------------------------

recovered=false
report_state="present"

if report_present; then
  report_state="present"
else
  report_state="absent"
  if [[ $do_recovery -eq 1 ]]; then
    echo "claude-workstream: report missing — attempting one recovery pass" >&2
    recovery_prompt="The previous worker lane '$lane' finished without writing its
required report to: $report_abs

Your ONLY job now is to reconstruct that report from the existing evidence.
Do not modify code, run builds, or make commits.

Read:
- Transcript: $transcript
- Prompt:     $prompt_copy
- git status (after): $git_after
- git diff main..HEAD inside $worktree_abs (read-only)

Write the report to $report_abs using the playbook Report Format. If the
evidence does not support a 'complete' status, write Status: blocked and
state what is missing. End with the verbatim \`git status --short\` output."

    recovery_exit=0
    (
      cd "$worktree_abs"
      claude \
        --print \
        --model "$model" \
        --no-session-persistence \
        --strict-mcp-config \
        --mcp-config "$mcp_config" \
        --dangerously-skip-permissions \
        --disallowedTools "Edit" "MultiEdit" "Write(!$report_abs)" "NotebookEdit" \
        --append-system-prompt "Recovery pass for lane '$lane'. Report-only. The only file you may write is $report_abs." \
        "$recovery_prompt"
    ) >"$recovery_transcript" 2>&1 || recovery_exit=$?

    if report_present; then
      report_state="recovered"
      recovered=true
    else
      report_state="absent"
    fi
    echo "claude-workstream: recovery exit=$recovery_exit report_state=$report_state" >&2
  fi
fi

# ---- finalize status --------------------------------------------------------

if [[ "$report_state" = "absent" ]]; then
  final_status="failed"
  final_exit=1
else
  final_status="complete"
  final_exit=$main_exit
fi

write_status "$final_status" "$report_state" "$recovered" "$final_exit"

echo "claude-workstream: status=$final_status report_state=$report_state recovered=$recovered exit=$final_exit"
echo "claude-workstream: status.json=$status_json"

exit "$final_exit"
