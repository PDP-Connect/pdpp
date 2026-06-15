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
#     [--effort <low|medium|high|xhigh|max>] \
#     [--no-recovery] \
#     [--artifact-root <dir>] \
#     [--interactive] \
#     [--tmux] \
#     [--tmux-session <session>]
#
# Defaults:
#   --model        opus
#   --effort       unset (Claude CLI default)
#   --artifact-root  <git-common-dir>/../tmp/workstreams/claude-wrapper/<lane>/<ts>
#   --tmux-session main   (only relevant when --tmux is given)
#   mode           print  (fire-and-forget; --interactive opts into a live session)
#
# --tmux mode:
#   Re-execs this script (without --tmux) inside a new tmux window named
#   "ws-<lane>" in the target session, then exits 0 immediately. The claude
#   invocation runs inside tmux and survives terminal disconnection, SSH
#   drops, and login-session cleanup. Actual exit code and report state are
#   tracked via status.json and surfaced by `pnpm workstreams:status`.
#
#   The session is created headlessly if it does not already exist. Launch
#   aborts if a window named "ws-<lane>" already exists to avoid clobbering
#   a live prior run.
#
# --interactive mode (opt-in; --print fire-and-forget stays the default):
#   Launches `claude` as a live, resumable session (no --print, session
#   persisted) instead of the default one-shot print run. The prompt is passed
#   as a positional argument (interactive claude reads from the PTY, not piped
#   stdin), so the run MUST go through a tmux window — it owns the TTY and
#   streams live output into the pane. A deterministic --session-id is minted at
#   launch and recorded in status.json (mode:"interactive"), so the owner can
#   steer the live pane (tmux send-keys), gate timing on scripts/wait-worker-idle.sh
#   (JSONL stop_reason:"end_turn"), and resume after the pane exits with
#   `claude --resume <session_id> "<msg>"`. Requires --tmux when launched from a
#   plain shell (the script aborts a bare --interactive that has no PTY); the
#   --tmux path re-execs this script into the window where it runs interactive.
#   Recovery/transient-retry are print-only and do not apply to interactive
#   sessions.
#
# The script is intentionally invocation-only: it does not edit the workstream
# hub under .git/workstreams, and it does not merge. Owner reviews the diff.

set -euo pipefail

# Save original args before `shift` consumes them (needed for --tmux re-exec).
orig_args=("$@")

# ---- arg parsing ------------------------------------------------------------

lane=""
worktree=""
prompt_file=""
report_path=""
model="opus"
effort=""
artifact_root=""
do_recovery=1
use_tmux=0
tmux_session_name="main"
interactive=0
session_id=""

die() {
  echo "claude-workstream: $*" >&2
  exit 2
}

usage() {
  sed -n '2,66p' "$0"
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lane) lane="${2:-}"; shift 2 ;;
    --worktree) worktree="${2:-}"; shift 2 ;;
    --prompt) prompt_file="${2:-}"; shift 2 ;;
    --report) report_path="${2:-}"; shift 2 ;;
    --model) model="${2:-}"; shift 2 ;;
    --effort) effort="${2:-}"; shift 2 ;;
    --artifact-root) artifact_root="${2:-}"; shift 2 ;;
    --no-recovery) do_recovery=0; shift ;;
    --interactive) interactive=1; shift ;;
    --session-id) session_id="${2:-}"; shift 2 ;;
    --tmux) use_tmux=1; shift ;;
    --tmux-session) tmux_session_name="${2:-}"; shift 2 ;;
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

# Interactive claude reads its prompt from the PTY and owns the terminal, so it
# can only run inside a tmux window (which provides the TTY and the live
# stream). Require --tmux UNLESS we are already running inside a tmux pane —
# the --tmux path re-execs this script (without --tmux) into the window, and
# that inner invocation is the legitimate interactive run. Refuse a bare
# --interactive launched from a non-tmux shell rather than silently degrading.
if [[ $interactive -eq 1 && $use_tmux -ne 1 && -z "${TMUX:-}" ]]; then
  die "--interactive requires --tmux (interactive claude needs a tmux PTY to stream into)"
fi

# ---- tmux launch mode -------------------------------------------------------
# Re-exec self inside a new tmux window so the claude invocation survives
# terminal disconnection or login-session cleanup. Exits 0 immediately;
# actual status is tracked via status.json and `pnpm workstreams:status`.
if [[ $use_tmux -eq 1 ]]; then
  command -v tmux >/dev/null 2>&1 || die "tmux not on PATH (required for --tmux)"
  window_name="ws-$lane"
  script_abs="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

  # For interactive lanes, mint the resumable session id HERE (the outer
  # process) and pass it through so the inner re-exec uses the SAME id — the
  # owner needs a stable handle for `claude --resume` and the JSONL idle probe.
  if [[ $interactive -eq 1 && -z "$session_id" ]]; then
    session_id="$(cat /proc/sys/kernel/random/uuid)"
  fi

  # Rebuild args without --tmux / --tmux-session for the inner invocation.
  passthrough_args=()
  skip_next=0
  for arg in "${orig_args[@]}"; do
    if [[ $skip_next -eq 1 ]]; then skip_next=0; continue; fi
    case "$arg" in
      --tmux) ;;
      --tmux-session) skip_next=1 ;;
      *) passthrough_args+=("$arg") ;;
    esac
  done

  # Carry the minted session id into the inner invocation unless the caller
  # already supplied one (in which case it is already in orig_args/passthrough).
  if [[ $interactive -eq 1 && -n "$session_id" ]]; then
    case " ${orig_args[*]} " in
      *" --session-id "*) ;;
      *) passthrough_args+=(--session-id "$session_id") ;;
    esac
  fi

  # printf %q produces bash-compatible quoting for safe embedding in bash -c.
  quoted_cmd="$(printf '%q ' "$script_abs" "${passthrough_args[@]}")"

  # Create session headlessly if it does not exist.
  tmux new-session -d -s "$tmux_session_name" 2>/dev/null || true

  # Refuse to clobber a live prior run.
  if tmux list-windows -t "$tmux_session_name" -F '#{window_name}' 2>/dev/null \
       | grep -qxF "$window_name"; then
    die "tmux window '${tmux_session_name}:${window_name}' already exists — check 'pnpm workstreams:status' before re-launching"
  fi

  tmux new-window -t "$tmux_session_name" -n "$window_name" -- bash -c "$quoted_cmd"

  echo "claude-workstream: lane=$lane launched in tmux ${tmux_session_name}:${window_name}"
  if [[ $interactive -eq 1 ]]; then
    echo "claude-workstream: mode=interactive session_id=$session_id"
    echo "claude-workstream: idle:    scripts/wait-worker-idle.sh $lane"
    echo "claude-workstream: resume:  claude --resume $session_id \"<msg>\""
  fi
  echo "claude-workstream: monitor: tmux capture-pane -t '${tmux_session_name}:${window_name}' -p -S -50 | tail -20"
  echo "claude-workstream: attach:  tmux attach -t '${tmux_session_name}'"
  echo "claude-workstream: status:  pnpm workstreams:status"
  exit 0
fi

# Defensive: in the inner (non-tmux) path an interactive lane must have a
# session id. The --tmux block always passes one through; this guards against a
# direct interactive invocation slipping past (the guard above forbids it).
if [[ $interactive -eq 1 && -z "$session_id" ]]; then
  session_id="$(cat /proc/sys/kernel/random/uuid)"
fi

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
  # Args: status_value report_state recovered exit_code [exit_class]
  local status_value="$1"
  local report_state="$2"
  local recovered="$3"
  local exit_code="$4"
  local exit_class="${5:-}"
  local head_after transcript_bytes
  head_after="$(git -C "$worktree_abs" rev-parse HEAD 2>/dev/null || echo "unknown")"
  # transcript_bytes: size of the primary transcript (-1 when the file doesn't exist yet).
  # A near-zero value means Claude exited almost immediately and the run is likely useless.
  if [[ -f "$transcript" ]]; then
    transcript_bytes="$(wc -c <"$transcript" 2>/dev/null || echo "-1")"
  else
    transcript_bytes="-1"
  fi
  transcript_bytes="${transcript_bytes//[[:space:]]/}"
  # Derive exit_class on final writes (non-seed) when not explicitly supplied.
  if [[ -z "$exit_class" && "$status_value" != "running" ]]; then
    local rp_flag="0"
    report_present && rp_flag="1"
    exit_class="$(classify_exit "$exit_code" "$transcript" "$rp_flag" "$_abort_signal_seen")"
  fi
  [[ -z "$exit_class" ]] && exit_class="unknown"
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
    --arg effort "$effort" \
    --arg exit_class "$exit_class" \
    --arg mode "$([[ $interactive -eq 1 ]] && echo interactive || echo print)" \
    --arg session_id "$session_id" \
    --argjson recovered "$recovered" \
    --argjson exit_code "$exit_code" \
    --argjson transcript_bytes "$transcript_bytes" \
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
       exit_class: $exit_class,
       transcript_bytes: $transcript_bytes,
       model: $model,
       effort: $effort,
       mode: $mode,
       session_id: $session_id
     }' >"$status_json"
}

# Seed status.json early so a hard crash still leaves a trace.
write_status "running" "absent" false -1

# A report is present only if it is non-empty AND has meaningful content
# (>= 200 bytes). A file written by a panicking recovery or interrupted Claude
# that contains only a partial heading is not a usable report.
report_present() {
  local sz
  [[ -f "$report_abs" ]] || return 1
  sz=$(wc -c <"$report_abs" 2>/dev/null | tr -d ' ')
  [[ -n "$sz" && "$sz" -ge 200 ]]
}

# ---- signal handling --------------------------------------------------------
# On catchable termination write status:aborted and exit non-zero.
# SIGKILL cannot be caught; a killed process leaves status:"running" in the
# artifact until the owner runs `pnpm workstreams:status` and notices.
_abort_signal_seen=""
_signal_trap() {
  _abort_signal_seen="$1"
  local rs="absent"
  report_present && rs="present"
  write_status "aborted" "$rs" false 130
  git -C "$worktree_abs" status --short >"$git_after" 2>&1 || true
  echo "claude-workstream: aborted by signal $1 (status.json updated)" >&2
  exit 130
}
trap '_signal_trap INT'  INT
trap '_signal_trap TERM' TERM
trap '_signal_trap HUP'  HUP
trap '_signal_trap QUIT' QUIT

thinking_block_replay_error() {
  local file="$1"
  [[ -f "$file" ]] \
    && grep -q '`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified' "$file"
}

# Returns 0 (true) when the transcript looks like an immediate execution failure
# that is likely transient: the file is under 100 bytes and contains a known
# error marker, or the file is completely empty despite the process exiting non-zero.
#
# Recognized patterns (checked within the first 500 bytes of the transcript):
#   - empty transcript on non-zero exit (process-level crash)
#   - "Execution error"  : CLI-level crash before any work
#   - "overloaded_error" : Anthropic API 529
#   - "529"              : HTTP overloaded
#   - "503"              : HTTP service unavailable
#   - "500"              : HTTP internal server error
#   - "rate limit"       : API rate-limit response
#   - "ECONNRESET"       : TCP connection reset by peer
#   - "ECONNREFUSED"     : connection refused (proxy / firewall)
#   - "ETIMEDOUT"        : network timeout before first token
transient_execution_error() {
  local file="$1"
  local ec="$2"
  [[ $ec -eq 0 ]] && return 1
  local sz=0
  [[ -f "$file" ]] && sz=$(wc -c <"$file" 2>/dev/null | tr -d ' ')
  [[ -z "$sz" ]] && sz=0
  # Empty transcript on non-zero exit is almost always a process-level failure.
  [[ $sz -eq 0 ]] && return 0
  # Short transcript: check for known transient-error patterns.
  if [[ $sz -lt 500 ]]; then
    grep -qiE 'Execution error|overloaded_error|rate.?limit|ECONNRESET|ECONNREFUSED|ETIMEDOUT' "$file" 2>/dev/null && return 0
    grep -qE '(^|[^0-9])(500|503|529)([^0-9]|$)' "$file" 2>/dev/null && return 0
  fi
  return 1
}

# Returns a short string classifying why a run ended. Used in status.json as
# exit_class for owner triage. Values:
#   api_error      — transient API/network failure (recognized pattern)
#   quick_exit     — non-zero exit with thin transcript but no known API pattern
#   report_missing — ran to completion but report was not written
#   signal         — killed by a catchable signal
#   success        — exited 0 and report is present
classify_exit() {
  local exit_code="$1"
  local transcript_file="$2"
  local report_ok="$3"   # "1" = report present, "0" = absent
  local signal_seen="$4" # non-empty = signal name
  if [[ -n "$signal_seen" ]]; then
    echo "signal"; return
  fi
  if [[ "$report_ok" = "1" && $exit_code -eq 0 ]]; then
    echo "success"; return
  fi
  if transient_execution_error "$transcript_file" "$exit_code"; then
    echo "api_error"; return
  fi
  local sz=0
  [[ -f "$transcript_file" ]] && sz=$(wc -c <"$transcript_file" 2>/dev/null | tr -d ' ')
  sz="${sz//[[:space:]]/}"
  [[ -z "$sz" ]] && sz=0
  if [[ $exit_code -ne 0 && $sz -lt 200 ]]; then
    echo "quick_exit"; return
  fi
  echo "report_missing"
}

invoke_claude_main() {
  local output_file="$1"
  local exit_code=0
  local effort_args=()
  [[ -n "$effort" ]] && effort_args=(--effort "$effort")
  (
    trap - INT TERM HUP QUIT
    cd "$worktree_abs"
    printf '%s' "$main_prompt" | \
    claude \
      --print \
      --model "$model" \
      "${effort_args[@]}" \
      --no-session-persistence \
      --setting-sources user \
      --strict-mcp-config \
      --mcp-config "$mcp_config" \
      --dangerously-skip-permissions
  ) >"$output_file" 2>&1 || exit_code=$?
  return "$exit_code"
}

invoke_claude_interactive() {
  # Live, resumable session mirroring invoke_claude_main() BUT:
  #   - no --print (interactive REPL)
  #   - no --no-session-persistence (the session must survive for --resume)
  #   - +--session-id (deterministic resume handle) and +--name (display label)
  #   - prompt passed as a POSITIONAL arg (interactive claude reads the PTY, not
  #     piped stdin)
  #   - NO output redirect: claude owns the PTY and streams live into the pane.
  #     A full transcript is captured by `tmux pipe-pane` into $1 when given.
  # Runs in the foreground of the current (tmux) shell so the pane shows it live.
  local pipe_target="${1:-}"
  local exit_code=0
  local effort_args=()
  [[ -n "$effort" ]] && effort_args=(--effort "$effort")

  # Also tee the live pane to a transcript file when a target is given and we
  # are inside tmux, so the durable-artifact contract still holds.
  if [[ -n "$pipe_target" && -n "${TMUX:-}" ]]; then
    tmux pipe-pane -o "cat >> $(printf '%q' "$pipe_target")" 2>/dev/null || true
  fi

  cd "$worktree_abs"
  claude \
    --model "$model" \
    "${effort_args[@]}" \
    --session-id "$session_id" \
    --name "$lane" \
    --setting-sources user \
    --strict-mcp-config \
    --mcp-config "$mcp_config" \
    --dangerously-skip-permissions \
    "$main_prompt" || exit_code=$?
  return "$exit_code"
}

invoke_claude_recovery() {
  local output_file="$1"
  local prompt="$2"
  local exit_code=0
  local effort_args=()
  [[ -n "$effort" ]] && effort_args=(--effort "$effort")
  (
    trap - INT TERM HUP QUIT
    cd "$worktree_abs"
    printf '%s' "$prompt" | \
    claude \
      --print \
      --model "$model" \
      "${effort_args[@]}" \
      --no-session-persistence \
      --setting-sources user \
      --strict-mcp-config \
      --mcp-config "$mcp_config" \
      --dangerously-skip-permissions \
      --disallowedTools "Edit" "MultiEdit" "Write(!$report_abs)" "NotebookEdit"
  ) >"$output_file" 2>&1 || exit_code=$?
  return "$exit_code"
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
if [[ -n "$effort" ]]; then
  echo "claude-workstream: invoking claude (model=$model effort=$effort)…"
else
  echo "claude-workstream: invoking claude (model=$model)…"
fi

# ---- interactive dispatch ---------------------------------------------------
# Live, resumable session: runs in the foreground of this tmux window (it owns
# the PTY and streams live), then finalizes status.json with the resume handle.
# The print-only retry/recovery machinery below does not apply — an interactive
# session is steered/resumed by the owner, not auto-reconstructed.
if [[ $interactive -eq 1 ]]; then
  echo "claude-workstream: mode=interactive session_id=$session_id"
  echo "claude-workstream: idle-probe: scripts/wait-worker-idle.sh $lane"
  echo "claude-workstream: resume:     claude --resume $session_id \"<msg>\""
  interactive_exit=0
  invoke_claude_interactive "$transcript" || interactive_exit=$?

  trap - INT TERM HUP QUIT
  git -C "$worktree_abs" status --short >"$git_after" 2>&1 || true

  report_state="absent"
  report_present && report_state="present"

  if [[ -n "$_abort_signal_seen" ]]; then
    final_status="aborted"
  elif [[ $interactive_exit -ne 0 ]]; then
    final_status="failed"
  else
    final_status="complete"
  fi
  write_status "$final_status" "$report_state" false "$interactive_exit"
  echo "claude-workstream: status=$final_status report_state=$report_state mode=interactive session_id=$session_id exit=$interactive_exit"
  echo "claude-workstream: status.json=$status_json"
  exit "$interactive_exit"
fi

main_exit=0
invoke_claude_main "$transcript" || main_exit=$?

retry_transcript="$artifact_dir/transcript-retry-1.log"
main_retried=false
if [[ $main_exit -ne 0 ]] && thinking_block_replay_error "$transcript"; then
  echo "claude-workstream: thinking-block replay API error — retrying with clean setting sources" >&2
  main_retried=true
  main_exit=0
  invoke_claude_main "$retry_transcript" || main_exit=$?
  {
    printf '\n--- retry transcript (%s) ---\n' "$retry_transcript"
    cat "$retry_transcript"
  } >>"$transcript"
fi

# Bounded retry for transient execution failures (empty transcript or known
# "Execution error" crash pattern). One attempt only; if the retry also fails
# instantly the likely cause is a config/env problem, not a transient fault.
transient_retry_transcript="$artifact_dir/transcript-transient-retry-1.log"
if [[ $main_exit -ne 0 ]] && ! report_present && transient_execution_error "$transcript" "$main_exit"; then
  echo "claude-workstream: transient execution error detected — retrying once" >&2
  prev_exit=$main_exit
  main_exit=0
  invoke_claude_main "$transient_retry_transcript" || main_exit=$?
  {
    printf '\n--- transient-retry transcript (prev_exit=%s) ---\n' "$prev_exit"
    cat "$transient_retry_transcript"
  } >>"$transcript"
  echo "claude-workstream: transient retry exit=$main_exit" >&2
fi

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
    invoke_claude_recovery "$recovery_transcript" "$recovery_prompt" || recovery_exit=$?

    retry_recovery_transcript="$artifact_dir/recovery-retry-1.log"
    recovery_retried=false
    if [[ $recovery_exit -ne 0 ]] && thinking_block_replay_error "$recovery_transcript"; then
      echo "claude-workstream: recovery thinking-block replay API error — retrying with clean setting sources" >&2
      recovery_retried=true
      recovery_exit=0
      invoke_claude_recovery "$retry_recovery_transcript" "$recovery_prompt" || recovery_exit=$?
      {
        printf '\n--- recovery retry transcript (%s) ---\n' "$retry_recovery_transcript"
        cat "$retry_recovery_transcript"
      } >>"$recovery_transcript"
    fi

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
# Disable signal traps so normal finalization is not mis-classified as aborted.
trap - INT TERM HUP QUIT

# If the claude child exited due to a catchable signal (bash exit 128+signum),
# treat the run as aborted even if the trap did not fire directly (e.g. bash
# suppresses INT traps when the interrupted command appears in an || chain).
# 129=HUP 130=INT 131=QUIT 143=TERM
_exited_by_signal() {
  case "$main_exit" in
    129|130|131|143) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ -n "$_abort_signal_seen" ]] || _exited_by_signal; then
  final_status="aborted"
  final_exit="${main_exit:-130}"
  local_report_state="absent"
  report_present && local_report_state="present"
  write_status "$final_status" "$local_report_state" false "$final_exit"
  echo "claude-workstream: aborted (signal=$_abort_signal_seen exit=$final_exit)" >&2
  exit "$final_exit"
fi

if [[ "$report_state" = "absent" ]]; then
  final_status="failed"
  final_exit=1
elif [[ $main_exit -ne 0 ]]; then
  final_status="failed"
  final_exit="$main_exit"
else
  final_status="complete"
  final_exit=$main_exit
fi

write_status "$final_status" "$report_state" "$recovered" "$final_exit"

echo "claude-workstream: status=$final_status report_state=$report_state recovered=$recovered exit=$final_exit"
echo "claude-workstream: status.json=$status_json"

exit "$final_exit"
