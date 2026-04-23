// Shared types for the Claude Code connector. Kept out of index.ts so the
// pure parsers in parsers.ts can import them without pulling in the
// runtime entry point.

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

export interface ClaudeCodeState {
  file_mtimes?: Record<string, number>;
  messages?: { file_mtimes?: Record<string, number> };
}

export interface ParsedFrontmatter {
  body: string;
  frontmatter: Record<string, string>;
}
