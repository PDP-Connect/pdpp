#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP GroupMe Connector (v0.1.0)
 *
 * Auth: OAuth 2.0 implicit grant (callback token) via GROUPME_ACCESS_TOKEN env
 * var, sent via X-Access-Token header (official documented auth).
 *
 * API: GroupMe v3 API at https://api.groupme.com/v3/
 * - Groups: GET /groups (list all), GET /groups/{id}/messages (messages)
 * - Direct messages: GET /chats (list conversations), GET /chats/{id}/messages
 * - Rate limits: Undocumented; conservative pacing (10s+ between requests).
 * - Response wrappers: messages use { count, messages/direct_messages };
 *   groups/chats use direct array.
 * - Attachments: URLs hydrated to blob storage if runtime available (origin-validated,
 *   redirect-safe). Undeliverable attachments logged but don't fail record emit.
 *
 * Message pagination uses before_id (newest-first) without an incremental
 * "since" cursor. Fingerprint-cursor dedup ensures no duplicate record emission
 * across runs. Absence of a message on subsequent runs does not indicate deletion
 * (API provides no deletion signal); messages not re-fetched are retained in state.
 */

import { createHash } from "node:crypto";
import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import {
  buildFullScanCoverageMessage,
  type CollectContext,
  type EmittedMessage,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { groupmePacingProfile } from "../../src/provider-profile.ts";
import {
  makeReferenceBlobUploader,
  type ReferenceBlobRef,
  runtimeBlobUploadAvailable,
} from "../../src/reference-blob-uploader.ts";
import { validateRecord } from "./schemas.ts";

const httpGovernor = createConnectorHttpGovernor({
  name: "groupme",
  maxAttempts: 1,
  profile: groupmePacingProfile(),
});

interface GroupMeGroup {
  archived?: boolean | null;
  avatar_url?: string | null;
  created_at?: number | null;
  description?: string | null;
  id: string;
  image_url?: string | null;
  members_count?: number | null;
  messages_count?: number | null;
  muted?: boolean | null;
  name?: string | null;
  office_mode?: boolean | null;
  phone_number?: string | null;
  share_url?: string | null;
  show_full_last_message?: boolean | null;
  updated_at?: number | null;
}

interface GroupMeAttachment {
  charmap?: [number, number][] | null;
  file_id?: string | null;
  lat?: string | null;
  lng?: string | null;
  name?: string | null;
  picture_url?: string | null;
  type: "image" | "file" | "location" | "emoji";
  url?: string | null;
}

interface GroupMeMessage {
  attachments?: GroupMeAttachment[] | null;
  avatar_url?: string | null;
  created_at: number;
  favorited_by?: string[] | null;
  id: string;
  name?: string | null;
  system?: boolean | null;
  text?: string | null;
  user_id?: string | null;
}

interface GroupMeDirectChat {
  avatar_url?: string | null;
  created_at?: number | null;
  id: string;
  last_message?: string | null;
  last_message_at?: number | null;
  messages_count?: number | null;
  muted?: boolean | null;
  other_user?: {
    avatar_url?: string | null;
    id?: string | null;
    name?: string | null;
  } | null;
  updated_at?: number | null;
}

interface ProgressExtra {
  before_id?: string;
  cursor_present?: boolean;
  item_count?: number;
  page?: number;
  phase?: string;
  rate_limit_pressure?: number;
  stream?: string;
  total_seen?: number;
}

const API_BASE = "https://api.groupme.com/v3";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_STREAM = 200;

// Blob attachment fetch constraints
const APPROVED_BLOB_HOSTS = ["i.groupme.com"];
const BLOB_FETCH_TIMEOUT_MS = 30_000;
const BLOB_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB hard limit

/**
 * Validates attachment URL origin, protocol, port, and auth.
 * Fails closed: only https://i.groupme.com (no port, no userinfo, no redirect).
 */
export function validateAttachmentUrl(urlString: string): { valid: boolean; reason?: string } {
  try {
    const url = new URL(urlString);

    // Require HTTPS (not http://)
    if (url.protocol !== "https:") {
      return { valid: false, reason: `protocol must be https, got ${url.protocol}` };
    }

    // Require exact hostname (no subdomain lookalikes)
    if (!APPROVED_BLOB_HOSTS.includes(url.hostname)) {
      return { valid: false, reason: `hostname not approved: ${url.hostname}` };
    }

    // Require default HTTPS port (no arbitrary ports like :8080, :4443)
    if (url.port !== "") {
      return { valid: false, reason: `port must be default (empty), got ${url.port}` };
    }

    // Reject userinfo (no username:password@)
    if (url.username || url.password) {
      return { valid: false, reason: "userinfo not allowed in attachment URL" };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, reason: `invalid URL: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// Content-Types GroupMe's CDN is known to serve for image/file attachments.
// A header outside this set (or absent/malformed) falls back to the
// type-based guess rather than passing an arbitrary provider-supplied string
// through to blob storage.
const SAFE_ATTACHMENT_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "application/octet-stream",
  "application/pdf",
]);

/**
 * Normalizes a raw Content-Type response header into a safe, known MIME
 * type, or null if the header is missing/malformed/not in the allowed set.
 * Strips parameters (e.g. `; charset=utf-8`) before matching.
 */
export function normalizeAttachmentContentType(rawHeader: string | null | undefined): string | null {
  if (!rawHeader) {
    return null;
  }
  const base = rawHeader.split(";")[0]?.trim().toLowerCase();
  if (!base) {
    return null;
  }
  return SAFE_ATTACHMENT_CONTENT_TYPES.has(base) ? base : null;
}

async function readAttachmentBody(res: Response, recordKey: string): Promise<{ buffer: Buffer; size: number } | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  const reader = res.body?.getReader();
  if (!reader) {
    // eslint-disable-next-line no-console
    console.warn(`groupme: attachment body not readable (${recordKey})`);
    return null;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > BLOB_MAX_BYTES) {
      reader.cancel();
      // eslint-disable-next-line no-console
      console.warn(`groupme: attachment streaming exceeded limit (${recordKey}): ${totalBytes} > ${BLOB_MAX_BYTES}`);
      return null;
    }

    chunks.push(Buffer.from(value));
  }

  const buffer = Buffer.concat(chunks);
  return { buffer, size: buffer.length };
}

/**
 * Fetch and validate blob attachment with streaming byte cap.
 * Returns blob buffer on success, null on any validation/network/size failure.
 * Records the failure (caller must emit record even if blob fetch fails).
 */
export async function fetchAttachmentBlob(
  urlString: string,
  recordKey: string
): Promise<{ buffer: Buffer; contentType: string | null; size: number } | null> {
  const validation = validateAttachmentUrl(urlString);
  if (!validation.valid) {
    // eslint-disable-next-line no-console
    console.warn(`groupme: attachment validation failed (${recordKey}): ${validation.reason}`);
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BLOB_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(urlString, {
      signal: controller.signal,
      redirect: "error", // Fail closed on any redirect
    });

    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`groupme: attachment fetch failed (${recordKey}): HTTP ${res.status}`);
      return null;
    }

    // Validate Content-Length header exists and is within bounds
    const contentLengthHeader = res.headers.get("content-length");
    if (!contentLengthHeader) {
      // eslint-disable-next-line no-console
      console.warn(`groupme: attachment missing content-length (${recordKey})`);
      return null;
    }

    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isNaN(contentLength) || contentLength < 0) {
      // eslint-disable-next-line no-console
      console.warn(`groupme: attachment invalid content-length (${recordKey}): ${contentLengthHeader}`);
      return null;
    }

    if (contentLength > BLOB_MAX_BYTES) {
      // eslint-disable-next-line no-console
      console.warn(`groupme: attachment exceeds size limit (${recordKey}): ${contentLength} > ${BLOB_MAX_BYTES}`);
      return null;
    }

    const body = await readAttachmentBody(res, recordKey);
    if (!body) {
      return null;
    }
    return { ...body, contentType: normalizeAttachmentContentType(res.headers.get("content-type")) };
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("redirect")) {
      // eslint-disable-next-line no-console
      console.warn(`groupme: attachment redirect rejected (${recordKey})`);
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `groupme: attachment fetch error (${recordKey}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function convertTimestamp(unixSeconds: number | undefined | null, context = "unknown"): string {
  if (!unixSeconds) {
    // eslint-disable-next-line no-console
    console.warn(`groupme: missing timestamp in ${context}; using current time (indicates API change)`);
    return new Date().toISOString();
  }
  return new Date(unixSeconds * 1000).toISOString();
}

interface NormalizedAttachment {
  blob_id?: string | null;
  lat?: number | null;
  lng?: number | null;
  name: string | null;
  type: "image" | "file" | "location" | "emoji";
  url: string | null;
}

export function attachmentContentType(att: GroupMeAttachment): string {
  return att.type === "image" ? "image/jpeg" : "application/octet-stream";
}

/**
 * Attachment record ids must be unique per attachment, not per type — the
 * prior `attachment:${type}` record key collapsed every image (or every
 * file) in a run onto one blob-upload record_key, which also meant every
 * hydration after the first for a given type silently overwrote the same
 * upstream record. Keyed on the owning message + the attachment's position
 * within that message's attachment array, which is stable across reruns of
 * the same message.
 */
export function attachmentRecordId(messageId: string, index: number, url: string | null): string {
  const urlHash = url ? createHash("sha256").update(url).digest("hex").slice(0, 16) : "no-url";
  return `${messageId}:attachment:${index}:${urlHash}`;
}

export async function normalizeOneAttachment(
  att: GroupMeAttachment,
  index: number,
  messageId: string,
  messageStream: "group_messages" | "direct_chat_messages",
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: ((data: RecordData) => Promise<void>) | undefined
): Promise<NormalizedAttachment> {
  const url = att.url || att.picture_url || null;
  const normalized: NormalizedAttachment = {
    type: att.type,
    url,
    name: att.name || null,
    ...(att.lat && att.lng ? { lat: Number.parseFloat(att.lat), lng: Number.parseFloat(att.lng) } : {}),
  };

  // Attempt blob hydration for images/files with URLs
  if (!(url && (att.type === "image" || att.type === "file"))) {
    return normalized;
  }

  const contentType = attachmentContentType(att);
  const recordId = attachmentRecordId(messageId, index, url);
  let blobRef: ReferenceBlobRef | null = null;
  let hydrationStatus: "deferred" | "failed" | "hydrated" = "deferred";
  let hydrationError: string | null = null;

  if (uploader) {
    try {
      blobRef = await uploader(url, contentType, recordId);
      if (blobRef) {
        normalized.blob_id = blobRef.blob_id;
        hydrationStatus = "hydrated";
      }
    } catch (error) {
      // Per-item failure: log but continue, don't fail the whole record
      hydrationStatus = "failed";
      hydrationError = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.warn(`groupme: blob upload failed for ${att.type}: ${hydrationError}`);
    }
  }

  if (emitAttachmentRecord) {
    await emitAttachmentRecord({
      id: recordId,
      message_id: messageId,
      message_stream: messageStream,
      type: att.type,
      content_type: blobRef?.mime_type ?? contentType,
      size_bytes: blobRef?.size_bytes ?? null,
      content_sha256: blobRef?.sha256 ?? null,
      hydration_status: hydrationStatus,
      hydration_error: hydrationError,
      blob_ref: blobRef,
    });
  }

  return normalized;
}

export async function normalizeAttachments(
  attachments: GroupMeAttachment[] | undefined | null,
  messageId: string,
  messageStream: "group_messages" | "direct_chat_messages",
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: ((data: RecordData) => Promise<void>) | undefined
): Promise<NormalizedAttachment[]> {
  if (!(attachments && Array.isArray(attachments))) {
    return [];
  }

  const result: NormalizedAttachment[] = [];
  for (const [index, att] of attachments.entries()) {
    result.push(await normalizeOneAttachment(att, index, messageId, messageStream, uploader, emitAttachmentRecord));
  }
  return result;
}

async function makeRequest<T>(token: string, path: string, queryParams?: Record<string, string | number>): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, String(value));
    }
  }

  const r = await httpGovernor.request<{ body: string; status: number }, { body: string; status: number }>(
    async () => {
      const res = await fetch(url.toString(), {
        headers: {
          "X-Access-Token": token,
        },
      });
      return {
        body: await res.text().catch((): string => ""),
        status: res.status,
      };
    },
    (resp) => ({ status: resp.status, value: resp })
  );
  const raw = r.value;

  if (raw.status === 401 || raw.status === 403) {
    throw new Error("groupme_auth_failed");
  }
  if (raw.status < 200 || raw.status >= 300) {
    throw new Error(`groupme_http_${raw.status}: ${raw.body.slice(0, 200)}`);
  }

  const json = JSON.parse(raw.body) as { response: T };
  return json.response;
}

interface PaginatedListResult<T> {
  items: T[];
  /** True when the walk hit `MAX_PAGES_PER_STREAM` before a page came back
   *  shorter than `PAGE_SIZE` — the natural end signal. GroupMe's `/groups`
   *  and `/chats` are genuinely paginated (`page`, `per_page`, empty array
   *  once past the last page); a single unpaged page-1 fetch silently misses
   *  every group/chat beyond it for an account with more than `PAGE_SIZE`. */
  truncated: boolean;
}

/**
 * Fully paginate a GroupMe list endpoint (`/groups`, `/chats`) using its
 * documented `page`/`per_page` query params, stopping at the first page
 * shorter than `PAGE_SIZE` (the natural end) or `maxPages` pages (honest
 * truncation — see `PaginatedListResult.truncated`). `maxPages` defaults to
 * the production `MAX_PAGES_PER_STREAM` cap; tests override it to exercise
 * the truncation branch without paying for hundreds of real paced requests.
 */
async function fetchPaginatedList<T>(
  token: string,
  path: string,
  stream: string,
  progressWithSignals: ProgressFn,
  maxPages: number = MAX_PAGES_PER_STREAM
): Promise<PaginatedListResult<T>> {
  const items: T[] = [];
  let page = 1;

  while (page <= maxPages) {
    await progressWithSignals(`Fetching ${path}`, { stream, phase: "fetch", page, total_seen: items.length });
    const pageItems = await makeRequest<T[]>(token, path, { page, per_page: PAGE_SIZE });
    items.push(...pageItems);
    await progressWithSignals(`Fetched ${path} page`, {
      stream,
      phase: "page",
      page,
      item_count: pageItems.length,
      total_seen: items.length,
    });

    if (pageItems.length < PAGE_SIZE) {
      return { items, truncated: false };
    }
    page += 1;
  }

  return { items, truncated: true };
}

function toGroupRecord(g: GroupMeGroup): RecordData {
  return {
    id: g.id,
    name: g.name ?? null,
    description: g.description ?? null,
    avatar_url: g.avatar_url ?? g.image_url ?? null,
    created_at: convertTimestamp(g.created_at),
    updated_at: convertTimestamp(g.updated_at),
    member_count: g.members_count ?? null,
    messages_count: g.messages_count ?? null,
  };
}

async function toGroupMessageRecord(
  msg: GroupMeMessage,
  groupId: string,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: ((data: RecordData) => Promise<void>) | undefined
): Promise<RecordData> {
  return {
    id: msg.id,
    group_id: groupId,
    user_id: msg.user_id ?? null,
    name: msg.name ?? null,
    text: msg.text ?? null,
    avatar_url: msg.avatar_url ?? null,
    created_at: convertTimestamp(msg.created_at, `group message ${msg.id}`),
    attachments: await normalizeAttachments(msg.attachments, msg.id, "group_messages", uploader, emitAttachmentRecord),
    like_count: msg.favorited_by ? msg.favorited_by.length : null,
    system: msg.system ?? null,
  };
}

function toDirectChatRecord(chat: GroupMeDirectChat): RecordData {
  return {
    id: chat.id,
    other_user_id: chat.other_user?.id ?? null,
    other_user_name: chat.other_user?.name ?? null,
    avatar_url: chat.avatar_url ?? chat.other_user?.avatar_url ?? null,
    last_message: chat.last_message ?? null,
    last_message_at: convertTimestamp(chat.last_message_at, `direct chat ${chat.id}`),
  };
}

async function toDirectChatMessageRecord(
  msg: GroupMeMessage,
  chatId: string,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: ((data: RecordData) => Promise<void>) | undefined
): Promise<RecordData> {
  return {
    id: msg.id,
    chat_id: chatId,
    user_id: msg.user_id ?? null,
    name: msg.name ?? null,
    text: msg.text ?? null,
    avatar_url: msg.avatar_url ?? null,
    created_at: convertTimestamp(msg.created_at, `direct message ${msg.id}`),
    attachments: await normalizeAttachments(
      msg.attachments,
      msg.id,
      "direct_chat_messages",
      uploader,
      emitAttachmentRecord
    ),
  };
}

type BlobUploader = (url: string, mimeType: string, recordKey: string) => Promise<ReferenceBlobRef | null>;
type ProgressFn = (message: string, extra?: ProgressExtra) => Promise<void>;

/**
 * Prefers the Content-Type actually observed on the attachment fetch over
 * the pre-fetch type-based guess. `observedContentType` is already
 * normalized/allowlisted by `normalizeAttachmentContentType` upstream.
 */
export function resolveUploadMimeType(observedContentType: string | null, fallbackGuess: string): string {
  return observedContentType ?? fallbackGuess;
}

function makeUploader(): BlobUploader | undefined {
  if (!runtimeBlobUploadAvailable()) {
    return;
  }
  const rsUrl = process.env.PDPP_RS_URL || process.env.RS_URL;
  const ownerToken = process.env.PDPP_OWNER_TOKEN;
  if (!(rsUrl && ownerToken)) {
    return;
  }
  const blobUploader = makeReferenceBlobUploader({
    connectorInstanceId: process.env.PDPP_CONNECTOR_INSTANCE_ID || null,
    ownerToken,
    rsUrl,
  });
  return async (url: string, mimeType: string, recordKey: string): Promise<ReferenceBlobRef | null> => {
    // Use production fetch seam (validates URL, enforces HTTPS, bounded streaming)
    const blob = await fetchAttachmentBlob(url, recordKey);
    if (!blob) {
      return null; // Failure already logged by fetchAttachmentBlob
    }
    const resolvedMimeType = resolveUploadMimeType(blob.contentType, mimeType);

    try {
      return await blobUploader({
        connectorId: "groupme",
        connectorInstanceId: process.env.PDPP_CONNECTOR_INSTANCE_ID || null,
        content: [blob.buffer],
        mimeType: resolvedMimeType,
        recordKey,
        stream: "attachments",
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `groupme: blob upload failed (${recordKey}): ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  };
}

interface GroupMessagesResponse {
  count: number;
  messages: GroupMeMessage[];
}

/**
 * Walks one group's message pages. Returns the raw item count enumerated
 * across pages (the "considered" contribution for this group) — never
 * aliased to the emitted count, since a page a caller filtered/suppressed
 * was still genuinely observed. Propagates fetch/parse failures to the
 * caller rather than swallowing them, so a mid-group failure cannot be
 * mistaken for "this group has no more messages."
 */
interface PerConversationWalkResult {
  totalSeen: number;
  /** True when the walk hit `MAX_PAGES_PER_STREAM` before reaching a page
   *  shorter than `PAGE_SIZE` — the natural end signal. A capped walk did
   *  not prove it saw every message, so its caller must not report this as
   *  a clean, fully-considered pass. */
  truncated: boolean;
}

/**
 * Applies a declared `since` boundary to one fetched page: counts and emits
 * only messages at-or-after `since`; a message before it is neither counted
 * (does not inflate `considered` with an out-of-scope row) nor emitted.
 *
 * Does NOT assume the page is sorted newest-first — GroupMe's docs describe
 * `before_id` pagination but make no ordering guarantee this connector can
 * verify from the response alone, so every message is checked individually
 * rather than stopping at the first in-page out-of-scope row. Returns
 * whether EVERY message on this page was out of scope (`pageFullyOutOfScope`)
 * — the caller only stops fetching further pages on that signal, which is
 * robust to a single non-monotonic straggler: one out-of-order early/late
 * message on an otherwise in-scope page keeps the walk going, and only a
 * page that is entirely out of scope is treated as having crossed the
 * boundary.
 */
function applySinceBoundToPage(
  messages: GroupMeMessage[],
  sinceEpochSeconds: number | null
): { inScope: GroupMeMessage[]; pageFullyOutOfScope: boolean } {
  if (sinceEpochSeconds === null) {
    return { inScope: messages, pageFullyOutOfScope: false };
  }
  const inScope = messages.filter((msg) => msg.created_at >= sinceEpochSeconds);
  return { inScope, pageFullyOutOfScope: inScope.length === 0 };
}

async function collectGroupMessagesForGroup(
  token: string,
  group: GroupMeGroup,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: ((data: RecordData) => Promise<void>) | undefined,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>,
  maxPages: number = MAX_PAGES_PER_STREAM,
  sinceEpochSeconds: number | null = null
): Promise<PerConversationWalkResult> {
  let beforeId: string | undefined;
  let pageIndex = 0;
  let totalSeen = 0;

  while (pageIndex < maxPages) {
    const pageExtra: ProgressExtra = {
      stream: "group_messages",
      phase: "fetch",
      ...(beforeId ? { before_id: beforeId } : {}),
      total_seen: totalSeen,
    };
    await progressWithSignals("Fetching group messages", pageExtra);

    const resp = await makeRequest<GroupMessagesResponse>(token, `/groups/${group.id}/messages`, {
      limit: PAGE_SIZE,
      ...(beforeId ? { before_id: beforeId } : {}),
    });

    const messages = resp.messages || [];
    if (!messages.length) {
      return { totalSeen, truncated: false };
    }

    // `considered` (totalSeen) counts only messages inside the declared
    // scope — a page spanning the boundary must not credit its out-of-scope
    // tail as part of what was "considered" for this run's coverage claim.
    const { inScope, pageFullyOutOfScope } = applySinceBoundToPage(messages, sinceEpochSeconds);
    totalSeen += inScope.length;
    await progressWithSignals("Fetched group messages page", {
      stream: "group_messages",
      phase: "page",
      item_count: inScope.length,
      total_seen: totalSeen,
    });

    for (const msg of inScope) {
      const record = await toGroupMessageRecord(msg, group.id, uploader, emitAttachmentRecord);
      if (cursor.shouldEmit(record)) {
        await emitRecord("group_messages", record);
      }
    }

    // Every message on this page was before `since`: this page (and every
    // page after it, since before_id only walks further back in time) is
    // entirely outside the declared boundary. This is an honest, fully-
    // considered end of the DECLARED scope, not a truncation — `truncated`
    // stays false so the caller still commits STATE and a coverage claim.
    if (pageFullyOutOfScope) {
      return { totalSeen, truncated: false };
    }

    if (messages.length < PAGE_SIZE) {
      return { totalSeen, truncated: false };
    }

    beforeId = messages.at(-1)?.id;
    pageIndex += 1;
  }

  // Loop exited via the page cap, not the natural `messages.length < PAGE_SIZE`
  // end signal — this group's message history was not fully walked.
  return { totalSeen, truncated: true };
}

/**
 * Whether a stream's collection pass reached its own clean end (`failed:
 * false`) or was cut short by a fetch/parse failure it never recovered from.
 * `considered` is the raw enumerated-boundary count, measured at each
 * fetch's response — independent of how many records `emitRecord` actually
 * received, so a run that filtered/suppressed everything still proves the
 * boundary it walked. The caller (`collect()`) uses `failed` to gate both
 * the STATE checkpoint and the DETAIL_COVERAGE proof: a failed pass must
 * commit neither, since it never fully walked the boundary it would be
 * claiming.
 */
export interface CollectionOutcome {
  considered: number;
  failed: boolean;
}

/**
 * Shared try/catch/outcome wrapper for a stream's top-level collection pass.
 * `body` runs the real fetch-and-emit work and returns the raw enumerated
 * "considered" count on a clean pass. Every GroupMe stream (groups,
 * group_messages, direct_messages, direct_chat_messages) needs the exact
 * same shape here: auth failures propagate untouched (the whole run is
 * dead, not just this stream), any other error is logged via
 * `progressWithSignals` and converted to `{ considered: 0, failed: true }`
 * rather than left to throw — the caller's `collect()` decides what a
 * failed outcome means (skip STATE + coverage), this wrapper only owns
 * catching the error and reporting it the same way every stream already did.
 */
async function runCollectionPass(
  stream: string,
  errorLabel: string,
  progressWithSignals: ProgressFn,
  emit: (msg: EmittedMessage) => Promise<void>,
  body: () => Promise<{ considered: number; truncated: boolean }>,
  maxPages: number = MAX_PAGES_PER_STREAM
): Promise<CollectionOutcome> {
  try {
    const { considered, truncated } = await body();
    if (truncated) {
      // A page-cap-truncated walk did not prove it saw every message in this
      // stream — the enumerated `considered` count is a real but partial
      // lower bound, not the boundary. Emitting it as `considered` would
      // make `buildFullScanCoverageMessage` claim `covered === considered`
      // for a walk that stopped short of the natural end, so this pass
      // reports `failed: true` to withhold both the STATE checkpoint and
      // the coverage claim, same as any other incomplete pass — plus a
      // bounded diagnostic (count only, no message/group/chat identifiers)
      // so the truncation itself is visible instead of silently absorbed.
      await emit({
        type: "SKIP_RESULT",
        stream,
        reason: "page_cap_truncated",
        message: `${errorLabel}: hit the ${String(maxPages)}-page cap before reaching the end of at least one conversation's history`,
        diagnostics: { considered, page_cap: maxPages },
      });
      return { considered: 0, failed: true };
    }
    return { considered, failed: false };
  } catch (error) {
    if (error instanceof Error && error.message === "groupme_auth_failed") {
      throw error;
    }
    await progressWithSignals(
      `Error fetching ${errorLabel}: ${error instanceof Error ? error.message : String(error)}`,
      {
        stream,
        phase: "error",
      }
    );
    return { considered: 0, failed: true };
  }
}

export async function collectGroups(
  token: string,
  cursor: ReturnType<typeof openFingerprintCursor>,
  progressWithSignals: ProgressFn,
  emit: (msg: EmittedMessage) => Promise<void>,
  emitRecord: (stream: string, data: RecordData) => Promise<void>,
  maxPages: number = MAX_PAGES_PER_STREAM
): Promise<CollectionOutcome> {
  await progressWithSignals("Fetching GroupMe groups", { stream: "groups", phase: "start" });
  return await runCollectionPass(
    "groups",
    "groups",
    progressWithSignals,
    emit,
    async () => {
      const { items: groups, truncated } = await fetchPaginatedList<GroupMeGroup>(
        token,
        "/groups",
        "groups",
        progressWithSignals,
        maxPages
      );

      for (const group of groups) {
        const record = toGroupRecord(group);
        if (cursor.shouldEmit(record)) {
          await emitRecord("groups", record);
        }
      }
      return { considered: groups.length, truncated };
    },
    maxPages
  );
}

export async function collectDirectChats(
  token: string,
  cursor: ReturnType<typeof openFingerprintCursor>,
  progressWithSignals: ProgressFn,
  emit: (msg: EmittedMessage) => Promise<void>,
  emitRecord: (stream: string, data: RecordData) => Promise<void>,
  maxPages: number = MAX_PAGES_PER_STREAM
): Promise<CollectionOutcome> {
  await progressWithSignals("Fetching GroupMe direct chats", { stream: "direct_messages", phase: "start" });
  return await runCollectionPass(
    "direct_messages",
    "direct chats",
    progressWithSignals,
    emit,
    async () => {
      const { items: chats, truncated } = await fetchPaginatedList<GroupMeDirectChat>(
        token,
        "/chats",
        "direct_messages",
        progressWithSignals,
        maxPages
      );

      for (const chat of chats) {
        const record = toDirectChatRecord(chat);
        if (cursor.shouldEmit(record)) {
          await emitRecord("direct_messages", record);
        }
      }
      return { considered: chats.length, truncated };
    },
    maxPages
  );
}

interface DirectMessagesResponse {
  count: number;
  direct_messages: GroupMeMessage[];
}

/**
 * Walks one chat's message pages. Returns the raw item count enumerated
 * across pages (the "considered" contribution for this chat) — never
 * aliased to the emitted count, since a page a caller filtered/suppressed
 * was still genuinely observed. Propagates fetch/parse failures to the
 * caller rather than swallowing them, so a mid-chat failure cannot be
 * mistaken for "this chat has no more messages."
 */
async function collectDirectChatMessagesForChat(
  token: string,
  chat: GroupMeDirectChat,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: ((data: RecordData) => Promise<void>) | undefined,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>,
  maxPages: number = MAX_PAGES_PER_STREAM,
  sinceEpochSeconds: number | null = null
): Promise<PerConversationWalkResult> {
  let beforeId: string | undefined;
  let pageIndex = 0;
  let totalSeen = 0;

  while (pageIndex < maxPages) {
    const pageExtra: ProgressExtra = {
      stream: "direct_chat_messages",
      phase: "fetch",
      ...(beforeId ? { before_id: beforeId } : {}),
      total_seen: totalSeen,
    };
    await progressWithSignals("Fetching direct messages", pageExtra);

    const resp = await makeRequest<DirectMessagesResponse>(token, `/chats/${chat.id}/messages`, {
      limit: PAGE_SIZE,
      ...(beforeId ? { before_id: beforeId } : {}),
    });

    const messages = resp.direct_messages || [];
    if (!messages.length) {
      return { totalSeen, truncated: false };
    }

    // Same in-scope-only accounting as collectGroupMessagesForGroup: a page
    // spanning the boundary must not credit its out-of-scope tail as part of
    // what was "considered".
    const { inScope, pageFullyOutOfScope } = applySinceBoundToPage(messages, sinceEpochSeconds);
    totalSeen += inScope.length;
    await progressWithSignals("Fetched direct messages page", {
      stream: "direct_chat_messages",
      phase: "page",
      item_count: inScope.length,
      total_seen: totalSeen,
    });

    for (const msg of inScope) {
      const record = await toDirectChatMessageRecord(msg, chat.id, uploader, emitAttachmentRecord);
      if (cursor.shouldEmit(record)) {
        await emitRecord("direct_chat_messages", record);
      }
    }

    // Same non-monotonic-safe stop condition as collectGroupMessagesForGroup:
    // only a page that is entirely out of scope ends the walk cleanly.
    if (pageFullyOutOfScope) {
      return { totalSeen, truncated: false };
    }

    if (messages.length < PAGE_SIZE) {
      return { totalSeen, truncated: false };
    }

    beforeId = messages.at(-1)?.id;
    pageIndex += 1;
  }

  // Loop exited via the page cap, not the natural `messages.length < PAGE_SIZE`
  // end signal — this chat's message history was not fully walked.
  return { totalSeen, truncated: true };
}

export async function collectDirectChatMessages(
  token: string,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: ((data: RecordData) => Promise<void>) | undefined,
  progressWithSignals: ProgressFn,
  emit: (msg: EmittedMessage) => Promise<void>,
  emitRecord: (stream: string, data: RecordData) => Promise<void>,
  maxPages: number = MAX_PAGES_PER_STREAM,
  sinceEpochSeconds: number | null = null
): Promise<CollectionOutcome> {
  await progressWithSignals("Fetching GroupMe direct messages", {
    stream: "direct_chat_messages",
    phase: "start",
  });
  return await runCollectionPass(
    "direct_chat_messages",
    "direct messages",
    progressWithSignals,
    emit,
    async () => {
      let considered = 0;
      let truncated = false;
      const { items: chats, truncated: chatsListTruncated } = await fetchPaginatedList<GroupMeDirectChat>(
        token,
        "/chats",
        "direct_chat_messages",
        progressWithSignals,
        maxPages
      );
      truncated = truncated || chatsListTruncated;
      for (const chat of chats) {
        const chatResult = await collectDirectChatMessagesForChat(
          token,
          chat,
          cursor,
          uploader,
          emitAttachmentRecord,
          progressWithSignals,
          emitRecord,
          maxPages,
          sinceEpochSeconds
        );
        considered += chatResult.totalSeen;
        truncated = truncated || chatResult.truncated;
      }
      return { considered, truncated };
    },
    maxPages
  );
}

export async function collectGroupMessages(
  token: string,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: ((data: RecordData) => Promise<void>) | undefined,
  progressWithSignals: ProgressFn,
  emit: (msg: EmittedMessage) => Promise<void>,
  emitRecord: (stream: string, data: RecordData) => Promise<void>,
  maxPages: number = MAX_PAGES_PER_STREAM,
  sinceEpochSeconds: number | null = null
): Promise<CollectionOutcome> {
  await progressWithSignals("Fetching GroupMe group messages", { stream: "group_messages", phase: "start" });
  return await runCollectionPass(
    "group_messages",
    "group messages",
    progressWithSignals,
    emit,
    async () => {
      let considered = 0;
      let truncated = false;
      const { items: groups, truncated: groupsListTruncated } = await fetchPaginatedList<GroupMeGroup>(
        token,
        "/groups",
        "group_messages",
        progressWithSignals,
        maxPages
      );
      truncated = truncated || groupsListTruncated;
      for (const group of groups) {
        const groupResult = await collectGroupMessagesForGroup(
          token,
          group,
          cursor,
          uploader,
          emitAttachmentRecord,
          progressWithSignals,
          emitRecord,
          maxPages,
          sinceEpochSeconds
        );
        considered += groupResult.totalSeen;
        truncated = truncated || groupResult.truncated;
      }
      return { considered, truncated };
    },
    maxPages
  );
}

/**
 * `collect()` writes each stream's fingerprint cursor under that stream's OWN
 * top-level `state.<stream>` key — `state.groups`, `state.group_messages`,
 * `state.direct_messages`, `state.direct_chat_messages`, `state.attachments`
 * — mirroring exactly what it reads back on the next run. This is the only
 * shape that survives the runtime's per-stream last-wins STATE projection
 * (`bufferedState[message.stream] = message.cursor` in collector-runner.ts):
 * a single unified emit under `stream: "groups"` would collide with
 * `groups`'s own per-stream STATE emit and get overwritten by it on every
 * run where `groups` succeeds, silently discarding the other four streams'
 * cursors. There is no prior persisted state to migrate — GroupMe has never
 * shipped a build that read these keys.
 */
/**
 * Parse a stream's declared `time_range.since` into epoch seconds for the
 * newest-first `before_id` walk to compare against `created_at` directly
 * (avoids a per-message ISO-string reparse). Returns `null` for an absent,
 * malformed, or unparseable bound — never throws, since a scope-less run
 * (the default) must behave exactly as before this stop condition existed.
 */
function parseSinceEpochSeconds(requested: CollectContext["requested"], stream: string): number | null {
  const since = requested.get(stream)?.time_range?.since;
  if (typeof since !== "string" || !since.trim()) {
    return null;
  }
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

export async function collect({
  state,
  requested,
  credentials,
  emit,
  emitRecord,
  progress,
}: CollectContext): Promise<void> {
  const progressWithSignals = progress as ProgressFn;
  const token = credentials.GROUPME_ACCESS_TOKEN;
  if (!token) {
    throw new Error("groupme_auth_failed");
  }

  const uploader = makeUploader();

  const groupCursor = openFingerprintCursor(state.groups);
  const groupMessageCursor = openFingerprintCursor(state.group_messages);
  const directChatCursor = openFingerprintCursor(state.direct_messages);
  const directChatMessageCursor = openFingerprintCursor(state.direct_chat_messages);
  const attachmentCursor = openFingerprintCursor(state.attachments);

  const attachmentsRequested = requested.has("attachments");
  const emitAttachmentRecord = attachmentsRequested
    ? async (data: RecordData): Promise<void> => {
        if (attachmentCursor.shouldEmit(data)) {
          await emitRecord("attachments", data);
        }
      }
    : undefined;

  let groupsOutcome: CollectionOutcome | undefined;
  if (requested.has("groups")) {
    groupsOutcome = await collectGroups(token, groupCursor, progressWithSignals, emit, emitRecord);
  }
  let groupMessagesOutcome: CollectionOutcome | undefined;
  if (requested.has("group_messages")) {
    groupMessagesOutcome = await collectGroupMessages(
      token,
      groupMessageCursor,
      uploader,
      emitAttachmentRecord,
      progressWithSignals,
      emit,
      emitRecord,
      MAX_PAGES_PER_STREAM,
      parseSinceEpochSeconds(requested, "group_messages")
    );
  }
  let directChatsOutcome: CollectionOutcome | undefined;
  if (requested.has("direct_messages")) {
    directChatsOutcome = await collectDirectChats(token, directChatCursor, progressWithSignals, emit, emitRecord);
  }
  let directChatMessagesOutcome: CollectionOutcome | undefined;
  if (requested.has("direct_chat_messages")) {
    directChatMessagesOutcome = await collectDirectChatMessages(
      token,
      directChatMessageCursor,
      uploader,
      emitAttachmentRecord,
      progressWithSignals,
      emit,
      emitRecord,
      MAX_PAGES_PER_STREAM,
      parseSinceEpochSeconds(requested, "direct_chat_messages")
    );
  }

  // Each stream owns its own top-level STATE key (`state.<stream>`) — the
  // only shape that survives the runtime's per-stream last-wins STATE
  // projection (see the `collect` doc comment above). A stream's own
  // checkpoint and coverage proof are gated on that stream's collection pass
  // having completed cleanly — a fetch/parse failure must commit neither a
  // STATE checkpoint nor a coverage claim for the boundary it never finished
  // walking (see CollectionOutcome). Withholding the emit on failure, rather
  // than emitting a stale/empty replacement, is also what preserves a failed
  // stream's prior cursor: its previously persisted top-level key is simply
  // untouched this run and is still readable next run.
  if (requested.has("groups") && groupsOutcome && !groupsOutcome.failed) {
    await emit({
      type: "STATE",
      stream: "groups",
      cursor: { fingerprints: groupCursor.toState() },
    });
    await emit(buildFullScanCoverageMessage("groups", groupsOutcome.considered));
  }
  if (requested.has("group_messages") && groupMessagesOutcome && !groupMessagesOutcome.failed) {
    await emit({
      type: "STATE",
      stream: "group_messages",
      cursor: { fingerprints: groupMessageCursor.toState() },
    });
    await emit(buildFullScanCoverageMessage("group_messages", groupMessagesOutcome.considered));
  }
  if (requested.has("direct_messages") && directChatsOutcome && !directChatsOutcome.failed) {
    await emit({
      type: "STATE",
      stream: "direct_messages",
      cursor: { fingerprints: directChatCursor.toState() },
    });
    await emit(buildFullScanCoverageMessage("direct_messages", directChatsOutcome.considered));
  }
  if (requested.has("direct_chat_messages") && directChatMessagesOutcome && !directChatMessagesOutcome.failed) {
    await emit({
      type: "STATE",
      stream: "direct_chat_messages",
      cursor: { fingerprints: directChatMessageCursor.toState() },
    });
    await emit(buildFullScanCoverageMessage("direct_chat_messages", directChatMessagesOutcome.considered));
  }
  if (attachmentsRequested) {
    await emit({
      type: "STATE",
      stream: "attachments",
      cursor: { fingerprints: attachmentCursor.toState() },
    });
  }
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "groupme",
    validateRecord,
    retryablePattern: /ECONN|fetch failed|rate_limited/i,
    auth: { kind: "env", required: ["GROUPME_ACCESS_TOKEN"] },
    collect,
  });
}
