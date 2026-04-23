// Shapes for the Slack connector. Extracted from index.ts so parsers.ts
// and tests can import them without pulling in the slackdump subprocess
// runtime entry.

// ─── SQLite row shapes (from slackdump's sqlite archive) ────────────────

export interface WorkspaceRow {
  DATA: Uint8Array | string | null;
  ENTERPRISE_ID: string | null;
  ID: number;
  TEAM: string | null;
  TEAM_ID: string | null;
  URL: string | null;
  USER_ID: string | null;
  USERNAME: string | null;
}

export interface ChannelRow {
  data: Uint8Array | string | null;
  id: string;
  name: string | null;
}

export interface ChannelUserRow {
  CHANNEL_ID: string;
  USER_ID: string;
}

export interface UserRow {
  data: Uint8Array | string | null;
  id: string;
  username: string | null;
}

export interface MessageRow {
  CHANNEL_ID: string;
  DATA: Uint8Array | string | null;
  IS_PARENT: number | null;
  NUM_FILES: number | null;
  THREAD_TS: string | null;
  TS: string;
  TXT: string | null;
}

export interface FileRow {
  data: Uint8Array | string | null;
  filename: string | null;
  id: string;
  mode: string | null;
  url: string | null;
}

export interface CanvasRow extends FileRow {
  channel_id: string | null;
  message_id: number | null;
}

// ─── Parsed Slack JSON shapes ───────────────────────────────────────────

export interface SlackDataBlob {
  attachments?: Record<string, unknown>[];
  blocks?: unknown[];
  bot_id?: string;
  client_msg_id?: string;
  color?: string;
  context_team_id?: string;
  created?: number;
  creator?: string;
  deleted?: boolean;
  domain?: string;
  edited?: { ts?: string; user?: string };
  email_domain?: string;
  enterprise_name?: string;
  enterprise_user?: { enterprise_id?: string };
  external_type?: string;
  files?: unknown[];
  filetype?: string;
  has_2fa?: boolean;
  icon?: { image_230?: string; image_102?: string };
  is_admin?: boolean;
  is_app_user?: boolean;
  is_archived?: boolean;
  is_bot?: boolean;
  is_channel?: boolean;
  is_ext_shared?: boolean;
  is_external?: boolean;
  is_general?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_invited_user?: boolean;
  is_member?: boolean;
  is_mpim?: boolean;
  is_org_shared?: boolean;
  is_owner?: boolean;
  is_primary_owner?: boolean;
  is_private?: boolean;
  is_public?: boolean;
  is_read_only?: boolean;
  is_restricted?: boolean;
  is_shared?: boolean;
  is_starred?: boolean;
  is_stranger?: boolean;
  is_ultra_restricted?: boolean;
  latest_reply?: string;
  metadata?: { event_type?: string };
  mimetype?: string;
  mode?: string;
  name?: string;
  name_normalized?: string;
  num_members?: number;
  original_h?: number;
  original_w?: number;
  parent_user_id?: string;
  permalink?: string;
  pinned_to?: string[];
  pretty_type?: string;
  previous_names?: string[];
  profile?: {
    real_name_normalized?: string;
    display_name?: string;
    display_name_normalized?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    title?: string;
    status_text?: string;
    status_emoji?: string;
    status_expiration?: number;
    image_192?: string;
  };
  properties?: {
    canvas?: {
      file_id?: string;
      is_empty?: boolean;
      quip_thread_id?: string;
    };
    posting_restricted_to?: { type?: string };
    threads_restricted_to?: { type?: string };
  };
  purpose?: { value?: string; creator?: string; last_set?: number };
  reactions?: { name?: string; count?: number; users?: string[] }[];
  real_name?: string;
  reply_count?: number;
  reply_users?: string[];
  shared_team_ids?: string[];
  size?: number;
  subtype?: string;
  team?: string;
  team_id?: string;
  text?: string;
  timestamp?: number;
  title?: string;
  topic?: { value?: string; creator?: string; last_set?: number };
  two_factor_type?: string;
  tz?: string;
  tz_label?: string;
  tz_offset?: number;
  updated?: number;
  url_private?: string;
  user?: string;
  user_id?: string;
  [field: string]: unknown;
}

export interface SlackdumpRunResult {
  stderr: string;
  stdout: string;
}

export interface MessagesState {
  archive_dir?: string;
  last_ts?: string | null;
}

export interface ChannelCanvasMeta {
  channel_id: string;
  is_empty: boolean | null;
  quip_thread_id: string | null;
}

/** Stream-scope time_range slice we consume. Kept local so parsers.ts
 * doesn't depend on the connector runtime. */
export interface TimeRangeLike {
  from?: string | null;
  to?: string | null;
}
