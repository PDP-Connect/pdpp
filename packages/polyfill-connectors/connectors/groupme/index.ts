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
import type { RecordData } from "../../src/connector-runtime.ts";
import { runConnector } from "../../src/connector-runtime.ts";
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

// Runtime merges state per-stream, so all GroupMe state is under a single "groups" stream.
// We emit all cursors under that unified namespace to ensure carry-forward on the next run.
interface GroupMeUnifiedState {
  attachments?: Record<string, string>;
  direct_chat_messages?: Record<string, string>;
  direct_chats?: Record<string, string>;
  group_messages?: Record<string, string>;
  groups?: Record<string, string>;
}

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

async function collectGroups(
  token: string,
  cursor: ReturnType<typeof openFingerprintCursor>,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>
): Promise<void> {
  await progressWithSignals("Fetching GroupMe groups", { stream: "groups", phase: "start" });
  try {
    const groups = await makeRequest<GroupMeGroup[]>(token, "/groups", { per_page: PAGE_SIZE });
    await progressWithSignals("Fetched GroupMe groups", {
      stream: "groups",
      phase: "page",
      item_count: groups.length,
    });

    for (const group of groups) {
      const record = toGroupRecord(group);
      if (cursor.shouldEmit(record)) {
        await emitRecord("groups", record);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "groupme_auth_failed") {
      throw error;
    }
    await progressWithSignals(`Error fetching groups: ${error instanceof Error ? error.message : String(error)}`, {
      stream: "groups",
      phase: "error",
    });
  }
}

interface GroupMessagesResponse {
  count: number;
  messages: GroupMeMessage[];
}

async function collectGroupMessagesForGroup(
  token: string,
  group: GroupMeGroup,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: ((data: RecordData) => Promise<void>) | undefined,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>
): Promise<void> {
  let beforeId: string | undefined;
  let pageIndex = 0;
  let totalSeen = 0;

  while (pageIndex < MAX_PAGES_PER_STREAM) {
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
    totalSeen += messages.length;
    await progressWithSignals("Fetched group messages page", {
      stream: "group_messages",
      phase: "page",
      item_count: messages.length,
      total_seen: totalSeen,
    });

    if (!messages.length) {
      break;
    }

    for (const msg of messages) {
      const record = await toGroupMessageRecord(msg, group.id, uploader, emitAttachmentRecord);
      if (cursor.shouldEmit(record)) {
        await emitRecord("group_messages", record);
      }
    }

    if (messages.length < PAGE_SIZE) {
      break;
    }

    beforeId = messages.at(-1)?.id;
    pageIndex += 1;
  }
}

async function collectGroupMessages(
  token: string,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: ((data: RecordData) => Promise<void>) | undefined,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>
): Promise<void> {
  await progressWithSignals("Fetching GroupMe group messages", { stream: "group_messages", phase: "start" });
  try {
    const groups = await makeRequest<GroupMeGroup[]>(token, "/groups", { per_page: PAGE_SIZE });
    for (const group of groups) {
      await collectGroupMessagesForGroup(
        token,
        group,
        cursor,
        uploader,
        emitAttachmentRecord,
        progressWithSignals,
        emitRecord
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message === "groupme_auth_failed") {
      throw error;
    }
    await progressWithSignals(
      `Error fetching group messages: ${error instanceof Error ? error.message : String(error)}`,
      {
        stream: "group_messages",
        phase: "error",
      }
    );
  }
}

async function collectDirectChats(
  token: string,
  cursor: ReturnType<typeof openFingerprintCursor>,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>
): Promise<void> {
  await progressWithSignals("Fetching GroupMe direct chats", { stream: "direct_messages", phase: "start" });
  try {
    const chats = await makeRequest<GroupMeDirectChat[]>(token, "/chats", { per_page: PAGE_SIZE });
    await progressWithSignals("Fetched GroupMe direct chats", {
      stream: "direct_messages",
      phase: "page",
      item_count: chats.length,
    });

    for (const chat of chats) {
      const record = toDirectChatRecord(chat);
      if (cursor.shouldEmit(record)) {
        await emitRecord("direct_messages", record);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "groupme_auth_failed") {
      throw error;
    }
    await progressWithSignals(
      `Error fetching direct chats: ${error instanceof Error ? error.message : String(error)}`,
      {
        stream: "direct_messages",
        phase: "error",
      }
    );
  }
}

interface DirectMessagesResponse {
  count: number;
  direct_messages: GroupMeMessage[];
}

async function collectDirectChatMessagesForChat(
  token: string,
  chat: GroupMeDirectChat,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: ((data: RecordData) => Promise<void>) | undefined,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>
): Promise<void> {
  let beforeId: string | undefined;
  let pageIndex = 0;
  let totalSeen = 0;

  while (pageIndex < MAX_PAGES_PER_STREAM) {
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
    totalSeen += messages.length;
    await progressWithSignals("Fetched direct messages page", {
      stream: "direct_chat_messages",
      phase: "page",
      item_count: messages.length,
      total_seen: totalSeen,
    });

    if (!messages.length) {
      break;
    }

    for (const msg of messages) {
      const record = await toDirectChatMessageRecord(msg, chat.id, uploader, emitAttachmentRecord);
      if (cursor.shouldEmit(record)) {
        await emitRecord("direct_chat_messages", record);
      }
    }

    if (messages.length < PAGE_SIZE) {
      break;
    }

    beforeId = messages.at(-1)?.id;
    pageIndex += 1;
  }
}

async function collectDirectChatMessages(
  token: string,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: ((data: RecordData) => Promise<void>) | undefined,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>
): Promise<void> {
  await progressWithSignals("Fetching GroupMe direct messages", {
    stream: "direct_chat_messages",
    phase: "start",
  });
  try {
    const chats = await makeRequest<GroupMeDirectChat[]>(token, "/chats", { per_page: PAGE_SIZE });
    for (const chat of chats) {
      await collectDirectChatMessagesForChat(
        token,
        chat,
        cursor,
        uploader,
        emitAttachmentRecord,
        progressWithSignals,
        emitRecord
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message === "groupme_auth_failed") {
      throw error;
    }
    await progressWithSignals(
      `Error fetching direct messages: ${error instanceof Error ? error.message : String(error)}`,
      {
        stream: "direct_chat_messages",
        phase: "error",
      }
    );
  }
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "groupme",
    validateRecord,
    retryablePattern: /ECONN|fetch failed|rate_limited/i,
    auth: { kind: "env", required: ["GROUPME_ACCESS_TOKEN"] },
    async collect({ state, requested, credentials, emit, emitRecord, progress }) {
      const progressWithSignals = progress as ProgressFn;
      const token = credentials.GROUPME_ACCESS_TOKEN;
      if (!token) {
        throw new Error("groupme_auth_failed");
      }

      const uploader = makeUploader();

      const groupmeState = (state.groups as GroupMeUnifiedState) || {};
      const groupCursor = openFingerprintCursor(new Map(Object.entries(groupmeState.groups || {})));
      const groupMessageCursor = openFingerprintCursor(new Map(Object.entries(groupmeState.group_messages || {})));
      const directChatCursor = openFingerprintCursor(new Map(Object.entries(groupmeState.direct_chats || {})));
      const directChatMessageCursor = openFingerprintCursor(
        new Map(Object.entries(groupmeState.direct_chat_messages || {}))
      );
      const attachmentCursor = openFingerprintCursor(new Map(Object.entries(groupmeState.attachments || {})));

      const attachmentsRequested = requested.has("attachments");
      const emitAttachmentRecord = attachmentsRequested
        ? async (data: RecordData): Promise<void> => {
            if (attachmentCursor.shouldEmit(data)) {
              await emitRecord("attachments", data);
            }
          }
        : undefined;

      if (requested.has("groups")) {
        await collectGroups(token, groupCursor, progressWithSignals, emitRecord);
      }
      if (requested.has("group_messages")) {
        await collectGroupMessages(
          token,
          groupMessageCursor,
          uploader,
          emitAttachmentRecord,
          progressWithSignals,
          emitRecord
        );
      }
      if (requested.has("direct_messages")) {
        await collectDirectChats(token, directChatCursor, progressWithSignals, emitRecord);
      }
      if (requested.has("direct_chat_messages")) {
        await collectDirectChatMessages(
          token,
          directChatMessageCursor,
          uploader,
          emitAttachmentRecord,
          progressWithSignals,
          emitRecord
        );
      }

      // Emit all state under a unified namespace. The runtime merges per-stream,
      // so this single emit carries all cursors forward to the next run.
      await emit({
        type: "STATE",
        stream: "groups",
        cursor: {
          groups: groupCursor.toState(),
          group_messages: groupMessageCursor.toState(),
          direct_chats: directChatCursor.toState(),
          direct_chat_messages: directChatMessageCursor.toState(),
          attachments: attachmentCursor.toState(),
        } as GroupMeUnifiedState,
      });
      // The unified emit above only ever proves coverage for the "groups"
      // stream (the runtime keys committed-checkpoint state off the STATE
      // message's own `stream` field, not its cursor payload contents), so
      // group_messages/direct_messages/direct_chat_messages were structurally
      // unable to ever reach `complete` even after collecting real data. Each
      // stream is independently gated above (no manifest `profiles` bundle
      // requires "groups" alongside them), so a state_stream inheritance
      // mapping to "groups" would still leave a groups-less run gapped —
      // emit each stream's own checkpoint directly instead, using the same
      // per-stream cursor state already computed above.
      if (requested.has("group_messages")) {
        await emit({
          type: "STATE",
          stream: "group_messages",
          cursor: { group_messages: groupMessageCursor.toState() },
        });
      }
      if (requested.has("direct_messages")) {
        await emit({
          type: "STATE",
          stream: "direct_messages",
          cursor: { direct_messages: directChatCursor.toState() },
        });
      }
      if (requested.has("direct_chat_messages")) {
        await emit({
          type: "STATE",
          stream: "direct_chat_messages",
          cursor: { direct_chat_messages: directChatMessageCursor.toState() },
        });
      }
      if (attachmentsRequested) {
        await emit({
          type: "STATE",
          stream: "attachments",
          cursor: { attachments: attachmentCursor.toState() },
        });
      }
    },
  });
}
