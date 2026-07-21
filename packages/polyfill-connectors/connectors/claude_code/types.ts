// Shared types for the Claude Code connector. Kept out of index.ts so the
// pure parsers in parsers.ts can import them without pulling in the
// runtime entry point.

import type { LocalJsonlPhysicalCursorV1 } from "../../src/local-jsonl-cursor.ts";

export interface JsonlObject {
  agentId?: string | null;
  attachment?: {
    hookName?: string | null;
    toolUseID?: string | null;
    content?: unknown;
    toolUseResult?: unknown;
  };
  cwd?: string;
  entrypoint?: string;
  gitBranch?: string;
  isSidechain?: boolean | null;
  message?: unknown;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  type?: string;
  userType?: string;
  uuid?: string;
  version?: string;
}

export interface ContentPart {
  name?: string;
  text?: string;
  type?: string;
}

export interface SessionAccumulator {
  cwd: string | null;
  entrypoint: string | null;
  git_branch: string | null;
  id: string;
  last_event_at: string | null;
  message_count: number;
  project_path: string;
  started_at: string | null;
  user_type: string | null;
  version: string | null;
}

/** Parser continuation at a physical JSONL cursor boundary. */
export interface JsonlObservations {
  cwd: string | null;
  entrypoint: string | null;
  firstTimestamp: string | null;
  gitBranch: string | null;
  lastTimestamp: string | null;
  messageCount: number;
  sessionId: string | null;
  userType: string | null;
  version: string | null;
}

export interface ClaudeChildFileCursorV1 extends LocalJsonlPhysicalCursorV1 {
  current_session_id: string | null;
}

export interface ClaudeSessionFileCursorV1 extends LocalJsonlPhysicalCursorV1 {
  observation: JsonlObservations;
}

export interface ClaudeMessagesCursorV1 {
  fetched_at: string;
  file_cursors: Record<string, ClaudeChildFileCursorV1>;
  file_mtimes: Record<string, number>;
  local_jsonl_cursor_version: 1;
}

export interface ClaudeSessionsCursorV1 {
  fetched_at: string;
  file_cursors: Record<string, ClaudeSessionFileCursorV1>;
  file_mtimes: Record<string, number>;
  local_jsonl_cursor_version: 1;
  session_aggregates: Record<string, SessionAccumulator>;
}

export interface ClaudeCodeState {
  file_mtimes?: Record<string, number>;
  memory_notes?: { file_mtimes?: Record<string, number> };
  messages?: Partial<ClaudeMessagesCursorV1>;
  sessions?: Partial<ClaudeSessionsCursorV1>;
  skills?: { file_mtimes?: Record<string, number> };
  slash_commands?: { file_mtimes?: Record<string, number> };
  // Inventory streams (backup_inventory, cache_inventory, config_inventory,
  // file_history) persist a per-stream fingerprint cursor so an unchanged
  // store does not re-version on every run when only mtime/size ticks.
  [stream: string]: { fingerprints?: Record<string, string>; fetched_at?: string } | unknown;
}

export interface ParsedFrontmatter {
  body: string;
  frontmatter: Record<string, string>;
}
