// Parsed shapes for the ChatGPT connector. Extracted from index.ts so
// parsers.ts and tests can import them without pulling in the Playwright-
// flavored runtime entry.

// ─── API response shapes (loose by design) ─────────────────────────────

// The JSON bodies vary by endpoint; we deliberately keep these loose but typed.
export interface ChatGptJson {
  about_model_message?: string | null;
  about_user?: string | null;
  about_user_message?: string | null;
  create_time?: number | string | null;
  current_node?: string | null;
  cursor?: string | null;
  enabled?: boolean | null;
  gizmo_id?: string | null;
  gizmos?: unknown[];
  is_archived?: boolean | null;
  is_starred?: boolean | null;
  items?: unknown[];
  mapping?: Record<string, ChatGptNode>;
  memories?: unknown[];
  response_style?: string | null;
  title?: string | null;
  update_time?: number | string | null;
  update_time_detail?: number | string | null;
  updated_at?: number | string | null;
  workspace_id?: string | null;
  [field: string]: unknown;
}

// ChatGPT message `content` — an algebraic data type keyed by `content_type`.
// Each branch supplies a different subset of fields; keep the union wide but
// typed so parsers.ts can destructure without `any`.
export interface ChatGptContent {
  assets?: unknown;
  content?: string;
  content_type?: string;
  domain?: string;
  language?: string;
  model_set_context?: string;
  name?: string;
  parts?: unknown[];
  repo_summary?: string;
  repository?: string;
  result?: string;
  summary?: string;
  tether_id?: string;
  text?: string;
  thoughts?: unknown[];
  title?: string;
  url?: string;
  user_instructions?: string;
  user_profile?: string;
  [field: string]: unknown;
}

export interface ChatGptMessage {
  author?: { role?: string | null };
  content?: ChatGptContent;
  create_time?: number | string | null;
  end_turn?: boolean;
  id?: string;
  metadata?: {
    model_slug?: string | null;
    finish_details?: { type?: string | null };
    citations?: unknown[];
    tool_calls?: unknown[];
    attachments?: Array<{ id?: string }>;
    invoked_plugin?: unknown;
    [field: string]: unknown;
  };
  recipient?: string;
  [field: string]: unknown;
}

export interface ChatGptNode {
  children?: string[];
  message?: ChatGptMessage;
  parent?: string | null;
  [field: string]: unknown;
}

export interface ConversationListItem {
  create_time?: number | string | null;
  current_node?: string | null;
  gizmo_id?: string | null;
  id: string;
  is_archived?: boolean | null;
  is_starred?: boolean | null;
  title?: string | null;
  update_time?: number | string | null;
  workspace_id?: string | null;
  [field: string]: unknown;
}

// Synthetic tool-call shape emitted when ChatGPT routes a message to a tool
// via `recipient` instead of the OpenAI-API-style `tool_calls` array.
export interface ToolCallSynthetic {
  content_type?: string;
  invoked_plugin?: unknown;
  language?: string;
  recipient?: string;
  text?: string;
}

// ─── Auth / API client plumbing ─────────────────────────────────────────

export interface ChatGptAuth {
  accessToken: string | null;
  deviceId: string | null;
}

export interface ChatGptFetchResult {
  deferredDueToPressure?: true;
  headers?: Record<string, string | undefined>;
  json: ChatGptJson | null;
  status: number;
}

export interface ChatGptApi {
  auth: () => Promise<ChatGptAuth>;
  fetch: (path: string, opts?: { method?: string; body?: unknown }) => Promise<ChatGptFetchResult>;
  fetchStatus?: (
    path: string,
    opts?: { method?: string; body?: unknown }
  ) => Promise<Pick<ChatGptFetchResult, "headers" | "status">>;
}

// ─── Raw list-endpoint shapes (for memories / gizmos / shares) ──────────
// These describe the `items` entries returned by their respective endpoints
// before normalization into emitted records. Kept here so collect()'s
// per-stream helpers stay typed without inline type assertions.

export interface RawMemoryEntry {
  content?: string;
  created_at?: string | null;
  id?: string;
  name?: string;
  updated_at?: string | null;
}

export interface RawGizmoDisplay {
  category?: string;
  description?: string;
  name?: string;
  tags?: unknown[];
  welcome_message?: string;
}

export interface RawGizmoConfig {
  instructions?: string;
  tools?: unknown[];
}

export interface RawGizmoAuthor {
  display_name?: string;
  id?: string;
  name?: string;
  user_id?: string;
}

export interface RawGizmo {
  author?: RawGizmoAuthor;
  category?: string;
  config?: RawGizmoConfig;
  create_time?: number | string | null;
  created_at?: number | string | null;
  display?: RawGizmoDisplay;
  id?: string;
  instructions?: string;
  is_public?: boolean;
  name?: string;
  owner?: RawGizmoAuthor;
  sharing?: string;
  short_url?: string;
  shortcode?: string;
  tags?: unknown[];
  update_time?: number | string | null;
  updated_at?: number | string | null;
}

export interface RawGizmoWrapper {
  gizmo?: unknown;
  resource?: { gizmo?: unknown } | unknown;
}

// Raw body of GET /backend-api/user_system_messages.
export interface RawCustomInstructionsBody {
  about_model_message?: string | null;
  about_user?: string | null;
  about_user_message?: string | null;
  enabled?: boolean | null;
  response_style?: string | null;
  update_time_detail?: number | string | null;
  updated_at?: number | string | null;
}

export interface RawSharedConversation {
  anonymous?: boolean;
  conversation_id?: string;
  create_time?: number | string | null;
  created_at?: number | string | null;
  highlighted_text?: string;
  id?: string;
  is_anonymous?: boolean;
  is_public?: boolean;
  share_id?: string;
  share_url?: string;
  title?: string;
}
