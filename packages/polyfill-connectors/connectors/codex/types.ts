// Shared types for the Codex connector. Kept out of index.ts so the pure
// parsers in parsers.ts can import them without pulling in the runtime
// entry point.

import type { StreamScope } from "../../src/connector-runtime.ts";

export interface StartMessage {
  scope?: { streams?: readonly StreamScope[] };
  state?: {
    messages?: { file_mtimes?: Record<string, number> };
    function_calls?: { file_mtimes?: Record<string, number> };
    sessions?: { file_mtimes?: Record<string, number> };
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
  content?: Array<{ text?: string }>;
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

export interface PendingCall {
  arguments: string | null;
  call_id: string;
  id: string;
  name: string | null;
  output_preview: string | null;
  session_id: string;
  timestamp: string | null;
}

export interface ParsedFrontmatter {
  body: string;
  meta: Record<string, string>;
}
