// Shared types for the Codex connector. Kept out of index.ts so the pure
// parsers in parsers.ts can import them without pulling in the runtime
// entry point.

import type { RecordData, StreamScope } from "../../src/connector-runtime.ts";

/**
 * Per-thread fingerprint carried across runs. `updated_at` is the
 * state_5.sqlite#threads.updated_at epoch the connector last emitted
 * for this session. `message_count` and `function_call_count` are the
 * rollout-derived counts at that emit, used as the fallback when a
 * subsequent run's rollout file is unchanged (so the connector doesn't
 * overwrite a real count with null).
 */
export interface ThreadFingerprint {
  function_call_count: number | null;
  message_count: number | null;
  updated_at: number | null;
}

/**
 * Per-rollout-file append-safe source cursor. Replaces the whole-file mtime
 * gate for rollout JSONL files so a long-lived append-only file is tailed from
 * its last committed byte boundary instead of fully reparsed on every append.
 *
 * `offset_bytes` always ends on a line terminator — the byte position after the
 * last fully-parsed `\n`. `line_count`, `session_id`, the two counts, and the
 * ts-range are the parser state at that boundary, carried forward so a suffix
 * parse continues the same record-key sequence and produces prior+delta
 * cumulative counts. `head_sha256` over the first `guard_bytes` of the file is
 * the integrity guard: a rollout file is append-only, so a changed prefix means
 * the file was truncated/replaced and the offset is no longer trustworthy.
 */
export interface RolloutFileCursor {
  first_ts: string | null;
  function_call_count: number;
  guard_bytes: number;
  head_sha256: string;
  last_ts: string | null;
  line_count: number;
  message_count: number;
  mtime_ms: number;
  offset_bytes: number;
  session_id: string | null;
  size_bytes: number;
}

interface RolloutStreamState {
  file_cursors?: Record<string, RolloutFileCursor>;
  file_mtimes?: Record<string, number>;
}

export interface StartMessage {
  scope?: { streams?: readonly StreamScope[] };
  state?: {
    messages?: RolloutStreamState;
    function_calls?: RolloutStreamState;
    sessions?: RolloutStreamState & {
      source_mtime_ms?: number;
      thread_fingerprints?: Record<string, ThreadFingerprint>;
    };
    file_mtimes?: Record<string, number>;
  };
  type: string;
}

export interface RolloutObject {
  payload?: RolloutPayload;
  timestamp?: string;
  type?: string;
}

export interface RolloutPayload {
  arguments?: string | null;
  call_id?: string;
  cli_version?: string;
  // Each content part carries a `type` discriminator on disk
  // (e.g. "input_text" for user/developer turns, "output_text" for
  // assistant turns). extractMessageText only reads `text`, but the type is
  // declared so the real rollout shape — including developer `input_text`
  // parts whose `text` is an empty string — is represented accurately.
  content?: Array<{ type?: string; text?: string }>;
  cwd?: string;
  git?: {
    commit_hash?: string;
    branch?: string;
    repository_url?: string;
  };
  id?: string;
  model_provider?: string;
  name?: string;
  originator?: string;
  output?: string | object;
  role?: string;
  timestamp?: string;
  type?: string;
}

export interface ThreadRow {
  agent_nickname: string | null;
  agent_role: string | null;
  approval_mode: string | null;
  archived: number | boolean | null;
  archived_at: number | null;
  cli_version: string | null;
  created_at: number | null;
  cwd: string | null;
  first_user_message: string | null;
  git_branch: string | null;
  git_origin_url: string | null;
  git_sha: string | null;
  has_user_event: number | null;
  id: string;
  memory_mode: string | null;
  model: string | null;
  model_provider: string | null;
  reasoning_effort: string | null;
  rollout_path: string | null;
  sandbox_policy: string | null;
  source: string | null;
  title: string | null;
  tokens_used: number | null;
  updated_at: number | null;
}

export interface RolloutAggregate {
  firstTs: string | null;
  functionCallCount: number;
  lastTs: string | null;
  messageCount: number;
  meta: RolloutPayload;
  rolloutPath: string;
}

export interface PendingCall extends RecordData {
  arguments: string | null;
  call_id: string;
  id: string;
  name: string | null;
  output_binary_reason?: string | null;
  output_preview: string | null;
  session_id: string;
  timestamp: string | null;
}

export interface ParsedFrontmatter {
  body: string;
  meta: Record<string, string>;
}
