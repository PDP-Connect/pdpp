// Pure parsers for the Slack connector. Kept free of slackdump / sqlite /
// Node I/O so they can be unit-tested in isolation (see parsers.test.ts).
// The subprocess runtime, sqlite reads, and clock-dependent helpers live
// in index.ts.

import { createHash } from "node:crypto";
import type { RecordData } from "../../src/connector-runtime.ts";
import type {
  CanvasRow,
  ChannelCanvasMeta,
  ChannelRow,
  ChannelUserRow,
  FileRow,
  MessageRow,
  SlackDataBlob,
  TimeRangeLike,
  UserRow,
  WorkspaceRow,
} from "./types.ts";

// ─── Module-scoped regexes (Biome useTopLevelRegex) ─────────────────────

export const WORKSPACE_LIST_ARROW = /=>/;
const SLACK_TIME_FRAC = /\..+$/;
const SLACK_TIME_Z = /Z$/;

// ─── Per-record fingerprint helper ──────────────────────────────────────

/**
 * Stable per-record fingerprint used by the connector's STATE cursor to
 * skip re-emitting records whose semantic shape hasn't moved. The
 * `excludeKeys` parameter lists fields that are part of the emitted
 * record but should NOT participate in change detection — namely
 * run-clock metadata like `fetched_at` whose value is "when the run
 * happened", not "when the source row changed". Without the exclusion,
 * every run would look like a change.
 *
 * Implementation note: SHA-1 is fine here. Collisions over a per-key
 * change-detection check on ~300 keys would not produce a correctness
 * bug — at worst, a colliding pair of distinct shapes would silently
 * skip one emit. The risk is dominated by the run-clock fields the
 * caller already excludes.
 */
export function recordFingerprint(record: Record<string, unknown>, excludeKeys: readonly string[] = []): string {
  const exclude = new Set(excludeKeys);
  const canonical = stableStringify(record, exclude);
  return createHash("sha1").update(canonical).digest("hex");
}

function compareKeys(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function stableStringify(value: unknown, exclude: ReadonlySet<string>): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v, exclude)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([k]) => !exclude.has(k))
    .sort(([a], [b]) => compareKeys(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v, exclude)}`).join(",")}}`;
}

// ─── Blob / time helpers ────────────────────────────────────────────────

const TEXT_DECODER = new TextDecoder("utf-8");

/**
 * Slackdump stores most of the richness inside a DATA BLOB (full Slack
 * API JSON). node:sqlite returns BLOB as Uint8Array, not Buffer — use
 * TextDecoder. Malformed / missing blobs return an empty object.
 */
export function parseBlob(blob: Uint8Array | string | null | undefined): SlackDataBlob {
  if (!blob) {
    return {};
  }
  try {
    let s: string;
    if (typeof blob === "string") {
      s = blob;
    } else if (blob instanceof Uint8Array) {
      s = TEXT_DECODER.decode(blob);
    } else {
      s = String(blob);
    }
    return JSON.parse(s) as SlackDataBlob;
  } catch {
    return {};
  }
}

/** Slack "seconds.micros" string → ISO-8601 string (or null). */
export function tsToIso(ts: string | null | undefined): string | null {
  return ts ? new Date(Number.parseFloat(ts) * 1000).toISOString() : null;
}

/** Epoch seconds → ISO-8601 string (or null). */
export function epochToIso(sec: number | null | undefined): string | null {
  return Number.isFinite(sec) ? new Date((sec as number) * 1000).toISOString() : null;
}

/**
 * slackdump time format is 'YYYY-MM-DDTHH:MM:SS' (no Z, UTC implied).
 * Strip trailing fractional seconds and the trailing Z if present.
 */
export function toSlackTime(iso: string | null): string | null {
  return iso ? iso.replace(SLACK_TIME_FRAC, "").replace(SLACK_TIME_Z, "") : null;
}

// ─── Record builders ────────────────────────────────────────────────────

export function buildWorkspaceRecord(r: WorkspaceRow, emittedAt: string): RecordData {
  const d = parseBlob(r.DATA);
  return {
    id: r.TEAM_ID ?? d.team_id ?? String(r.ID),
    name: r.TEAM ?? d.team ?? null,
    domain: d.domain ?? null,
    email_domain: d.email_domain ?? null,
    enterprise_id: r.ENTERPRISE_ID || null,
    enterprise_name: d.enterprise_name ?? null,
    url: r.URL ?? null,
    icon_url: d.icon?.image_230 ?? d.icon?.image_102 ?? null,
    authenticated_user_id: r.USER_ID ?? d.user_id ?? null,
    authenticated_username: r.USERNAME ?? d.user ?? null,
    authenticated_bot_id: d.bot_id || null,
    fetched_at: emittedAt,
  };
}

/** Channel "is_*" kind/visibility flags. Ten of them so pulling into its
 * own helper drops the parent's complexity score without losing legibility. */
function channelKindFlags(d: SlackDataBlob): Record<string, boolean | null> {
  return {
    is_channel: d.is_channel ?? null,
    is_group: d.is_group ?? null,
    is_im: d.is_im ?? null,
    is_mpim: d.is_mpim ?? null,
    is_private: d.is_private ?? null,
    is_shared: d.is_shared ?? null,
    is_ext_shared: d.is_ext_shared ?? null,
    is_org_shared: d.is_org_shared ?? null,
    is_archived: d.is_archived ?? null,
    is_general: d.is_general ?? null,
    is_member: d.is_member ?? null,
    is_read_only: d.is_read_only ?? null,
  };
}

/** Channel topic/purpose subfields flattened into snake_case columns. */
function channelTopicPurpose(d: SlackDataBlob): Record<string, unknown> {
  return {
    topic: d.topic?.value ?? null,
    topic_creator: d.topic?.creator || null,
    topic_last_set: d.topic?.last_set ?? null,
    purpose: d.purpose?.value ?? null,
    purpose_creator: d.purpose?.creator || null,
    purpose_last_set: d.purpose?.last_set ?? null,
  };
}

/** Channel `properties` subfields (canvas, posting/threads restrictions). */
function channelPropertiesFlags(d: SlackDataBlob): Record<string, unknown> {
  const canvas = d.properties?.canvas;
  return {
    has_canvas: canvas ? !canvas.is_empty : null,
    canvas_file_id: canvas?.file_id || null,
    posting_restricted: d.properties?.posting_restricted_to?.type != null,
    threads_restricted: d.properties?.threads_restricted_to?.type != null,
  };
}

export function buildChannelRecord(r: ChannelRow): RecordData {
  const d = parseBlob(r.data);
  return {
    id: r.id,
    name: r.name ?? d.name ?? null,
    name_normalized: d.name_normalized ?? null,
    ...channelKindFlags(d),
    creator: d.creator || null,
    created: d.created ?? null,
    created_at: epochToIso(d.created),
    ...channelTopicPurpose(d),
    num_members: d.num_members ?? null,
    user: d.user || null,
    shared_team_ids: Array.isArray(d.shared_team_ids) ? d.shared_team_ids : null,
    context_team_id: d.context_team_id ?? null,
    previous_names: Array.isArray(d.previous_names) ? d.previous_names : null,
    ...channelPropertiesFlags(d),
  };
}

export function buildChannelMembershipRecord(r: ChannelUserRow, emittedAt: string): RecordData {
  return {
    id: `${r.CHANNEL_ID}:${r.USER_ID}`,
    channel_id: r.CHANNEL_ID,
    user_id: r.USER_ID,
    fetched_at: emittedAt,
  };
}

/** Flatten the `profile` subobject into snake_case columns. */
function userProfileFields(profile: NonNullable<SlackDataBlob["profile"]>): Record<string, unknown> {
  return {
    real_name_normalized: profile.real_name_normalized ?? null,
    display_name: profile.display_name ?? null,
    display_name_normalized: profile.display_name_normalized ?? null,
    first_name: profile.first_name ?? null,
    last_name: profile.last_name ?? null,
    email: profile.email ?? null,
    phone: profile.phone ?? null,
    title: profile.title ?? null,
    status_text: profile.status_text || null,
    status_emoji: profile.status_emoji || null,
    status_expiration: profile.status_expiration ?? null,
    image_192_url: profile.image_192 ?? null,
  };
}

/** User role / membership flags — all boolean-ish nullable fields. */
function userRoleFlags(d: SlackDataBlob): Record<string, boolean | null> {
  return {
    is_bot: d.is_bot ?? null,
    is_admin: d.is_admin ?? null,
    is_owner: d.is_owner ?? null,
    is_primary_owner: d.is_primary_owner ?? null,
    is_restricted: d.is_restricted ?? null,
    is_ultra_restricted: d.is_ultra_restricted ?? null,
    is_stranger: d.is_stranger ?? null,
    is_invited_user: d.is_invited_user ?? null,
    is_app_user: d.is_app_user ?? null,
    deleted: d.deleted ?? null,
  };
}

export function buildUserRecord(r: UserRow): RecordData {
  const d = parseBlob(r.data);
  const profile = d.profile || {};
  return {
    id: r.id,
    team_id: d.team_id ?? null,
    name: r.username ?? d.name ?? null,
    real_name: d.real_name ?? null,
    ...userProfileFields(profile),
    tz: d.tz ?? null,
    tz_label: d.tz_label ?? null,
    tz_offset: d.tz_offset ?? null,
    color: d.color || null,
    ...userRoleFlags(d),
    has_2fa: d.has_2fa ?? null,
    two_factor_type: d.two_factor_type || null,
    enterprise_id: d.enterprise_user?.enterprise_id || null,
    updated: d.updated ?? null,
  };
}

/** Derived shape for the single-pass MESSAGE co-traversal. Mutated fields
 * (sent_at, id) are captured once, reused for reactions + attachments. */
export interface ParsedMessage {
  attachments: Record<string, unknown>[];
  blob: SlackDataBlob;
  channelId: string;
  messageId: string;
  row: MessageRow;
  sentAt: string;
  ts: string;
}

/**
 * Decode a MessageRow + its DATA blob into the normalized fields the
 * per-stream record builders need. `sentAtFallback` is used when the row's
 * ts is unparseable — callers pass `nowIso()` to preserve prior behavior.
 */
export function parseMessageRow(r: MessageRow, sentAtFallback: string): ParsedMessage {
  const blob = parseBlob(r.DATA);
  const ts = r.TS;
  const sentAt = tsToIso(ts) ?? sentAtFallback;
  const messageId = `${r.CHANNEL_ID}:${ts}`;
  const attachments = Array.isArray(blob.attachments) ? blob.attachments : [];
  return {
    attachments,
    blob,
    channelId: r.CHANNEL_ID,
    messageId,
    row: r,
    sentAt,
    ts,
  };
}

/** Total reaction count across all emoji reactions on a message. Falls back
 * to `users.length` when an individual reaction omits `count`. */
function countReactions(reactions: SlackDataBlob["reactions"]): number {
  if (!Array.isArray(reactions)) {
    return 0;
  }
  let total = 0;
  for (const x of reactions) {
    total += x.count ?? x.users?.length ?? 0;
  }
  return total;
}

/** Thread / reply columns — subtype-derived fields too. */
function messageThreadFields(parsed: ParsedMessage): Record<string, unknown> {
  const { blob: d, row: r } = parsed;
  return {
    thread_ts: r.THREAD_TS || null,
    parent_user_id: d.parent_user_id || null,
    is_thread_parent: r.IS_PARENT === 1 || Boolean(d.reply_count),
    reply_count: d.reply_count ?? null,
    reply_user_ids: Array.isArray(d.reply_users) ? d.reply_users : null,
    latest_reply: d.latest_reply || null,
    subtype: d.subtype || null,
    is_tombstone: d.subtype === "tombstone",
  };
}

/** File/attachment/block counts + reaction count + pinned-to summary. */
function messageContentCounts(parsed: ParsedMessage): Record<string, unknown> {
  const { blob: d, row: r, attachments } = parsed;
  const pinnedTo = Array.isArray(d.pinned_to) ? d.pinned_to : null;
  return {
    has_files: (r.NUM_FILES ?? 0) > 0 || Array.isArray(d.files),
    file_count: r.NUM_FILES ?? (Array.isArray(d.files) ? d.files.length : null),
    has_attachments: attachments.length > 0,
    attachment_count: attachments.length || null,
    has_blocks: Array.isArray(d.blocks) && d.blocks.length > 0,
    reaction_count: countReactions(d.reactions),
    is_pinned: pinnedTo != null && pinnedTo.length > 0,
    pinned_to: pinnedTo,
  };
}

export function buildMessageRecord(parsed: ParsedMessage): RecordData {
  const { blob: d, row: r, channelId, messageId, sentAt, ts } = parsed;
  return {
    id: messageId,
    channel_id: channelId,
    user_id: d.user || null,
    bot_id: d.bot_id || null,
    team_id: d.team || d.team_id || null,
    client_msg_id: d.client_msg_id || null,
    ts,
    sent_at: sentAt,
    ...messageThreadFields(parsed),
    text: r.TXT ?? d.text ?? null,
    edited_ts: d.edited?.ts || null,
    edited_by: d.edited?.user || null,
    ...messageContentCounts(parsed),
    metadata_event_type: d.metadata?.event_type || null,
  };
}

/** Flatten a parsed message's reactions into one record per (emoji, user). */
export function buildReactionRecords(parsed: ParsedMessage): RecordData[] {
  const reactions = parsed.blob.reactions;
  if (!Array.isArray(reactions)) {
    return [];
  }
  const out: RecordData[] = [];
  for (const reaction of reactions) {
    const name = reaction?.name;
    if (!name) {
      continue;
    }
    const users = Array.isArray(reaction.users) ? reaction.users : [];
    for (const u of users) {
      out.push({
        id: `${parsed.messageId}:${name}:${u}`,
        message_id: parsed.messageId,
        channel_id: parsed.channelId,
        user_id: u,
        emoji: name,
      });
    }
  }
  return out;
}

/** Flatten a parsed message's attachments into one record per index. */
export function buildMessageAttachmentRecords(parsed: ParsedMessage): RecordData[] {
  const out: RecordData[] = [];
  for (let i = 0; i < parsed.attachments.length; i++) {
    const a = (parsed.attachments[i] || {}) as Record<string, unknown>;
    out.push({
      id: `${parsed.messageId}:att:${i}`,
      message_id: parsed.messageId,
      channel_id: parsed.channelId,
      index: i,
      fallback: a.fallback ?? null,
      service_name: a.service_name ?? null,
      service_icon: a.service_icon ?? null,
      title: a.title ?? null,
      title_link: a.title_link ?? null,
      text: a.text ?? null,
      from_url: a.from_url ?? null,
      image_url: a.image_url ?? null,
      thumb_url: a.thumb_url ?? null,
      author_name: a.author_name ?? null,
      author_link: a.author_link ?? null,
      color: a.color ?? null,
    });
  }
  return out;
}

export function buildFileRecord(r: FileRow): RecordData {
  const d = parseBlob(r.data);
  return {
    id: r.id,
    name: r.filename ?? d.name ?? null,
    title: d.title ?? null,
    mimetype: d.mimetype ?? null,
    filetype: d.filetype ?? null,
    pretty_type: d.pretty_type ?? null,
    size: d.size ?? null,
    created: d.created ?? null,
    created_at: epochToIso(d.created),
    uploader_id: d.user || null,
    is_public: d.is_public ?? null,
    is_external: d.is_external ?? null,
    is_starred: d.is_starred ?? null,
    external_type: d.external_type || null,
    mode: r.mode ?? d.mode ?? null,
    permalink: d.permalink ?? null,
    url_private: d.url_private ?? r.url ?? null,
    original_w: d.original_w ?? null,
    original_h: d.original_h ?? null,
  };
}

/**
 * Build channel_id → canvas-meta map from the latest-chunk CHANNEL rows.
 * Used by the canvases stream to surface is_empty / quip_thread_id that
 * sit on the channel record rather than the file record.
 */
export function buildChannelCanvasIndex(chanRows: readonly ChannelRow[]): Map<string, ChannelCanvasMeta> {
  const idx = new Map<string, ChannelCanvasMeta>();
  for (const r of chanRows) {
    const d = parseBlob(r.data);
    const cv = d.properties?.canvas;
    if (cv?.file_id) {
      idx.set(cv.file_id, {
        channel_id: r.id,
        is_empty: cv.is_empty ?? null,
        quip_thread_id: cv.quip_thread_id || null,
      });
    }
  }
  return idx;
}

export function buildCanvasRecord(
  r: CanvasRow,
  channelCanvasIndex: ReadonlyMap<string, ChannelCanvasMeta>
): RecordData {
  const d = parseBlob(r.data);
  const chanMeta = channelCanvasIndex.get(r.id);
  const createdSec = d.created ?? null;
  const updatedSec = d.updated ?? d.timestamp ?? null;
  return {
    id: r.id,
    file_id: r.id,
    channel_id: r.channel_id || chanMeta?.channel_id || null,
    message_id: r.message_id == null ? null : String(r.message_id),
    title: d.title ?? null,
    name: r.filename ?? d.name ?? null,
    author_id: d.user || null,
    is_empty: chanMeta?.is_empty ?? null,
    quip_thread_id: chanMeta?.quip_thread_id || null,
    content_bytes: d.size ?? null,
    content_markdown: null,
    mimetype: d.mimetype ?? null,
    filetype: d.filetype ?? null,
    pretty_type: d.pretty_type ?? null,
    created: createdSec,
    created_at: epochToIso(createdSec),
    updated: updatedSec,
    updated_at: epochToIso(updatedSec),
    permalink: d.permalink ?? null,
    url_private: d.url_private ?? r.url ?? null,
  };
}

// ─── Cursor selection ──────────────────────────────────────────────────

/**
 * Pick the committed `messages.last_ts` cursor, preserving the prior value
 * if nothing newer was seen this run (otherwise the cursor would go
 * backward on a no-op resume). Slack ts strings compare lexicographically
 * in the same order they compare numerically.
 */
export function selectCommittedMaxTs(priorMaxTs: string | null, runMaxTs: string | null): string | null {
  if (runMaxTs && (priorMaxTs === null || runMaxTs > priorMaxTs)) {
    return runMaxTs;
  }
  return priorMaxTs;
}

// ─── Time range extraction ─────────────────────────────────────────────

export function extractMessageTimeRange(timeRange: TimeRangeLike | undefined): {
  timeFrom: string | null;
  timeTo: string | null;
} {
  if (!timeRange) {
    return { timeFrom: null, timeTo: null };
  }
  return {
    timeFrom: timeRange.from || null,
    timeTo: timeRange.to || null,
  };
}
