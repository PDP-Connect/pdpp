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
 * - Direct messages: GET /chats (list conversations), GET /direct_messages
 * - Rate limits: Undocumented; conservative pacing (10s+ between requests).
 * - Response wrappers: messages use { count, messages/direct_messages };
 *   groups/chats use direct array.
 * - Attachments: URLs hydrated to blob storage if runtime available (origin-validated,
 *   redirect-safe). Undeliverable attachments logged but don't fail record emit.
 *
 * Fingerprint-cursor dedup ensures no duplicate record emission across runs.
 * Absence of a message on subsequent runs does not indicate deletion (API
 * provides no deletion signal); messages not re-fetched are retained in
 * state.
 *
 * group_messages persists a per-group durable CURSOR
 * (`state.group_messages.cursors`, keyed by group id → the id of the newest
 * message seen last run) and resumes with GroupMe's documented FORWARD
 * continuation primitive, `after_id`: "ascending order... easy to pick off
 * the last result for continued pagination" (dev.groupme.com/docs/v3) — the
 * API's own intended mechanism for exactly this "give me what's new since
 * X" case. The walk pages strictly forward, advancing the cursor to each
 * page's last message id, until a page shorter than the page size proves
 * the natural end. There is NO page-count ceiling anywhere in this walk (an
 * arbitrary cap would itself be a correctness bug — see `NonProgressError`'s
 * doc comment); the only non-natural exit is a typed failure when a page's
 * own cursor fails to advance, repeats one already used this walk, or
 * violates the endpoint's documented ordering, which correctly withholds
 * STATE for the boundary that walk never proved. A cold start (no persisted
 * cursor for a group) or an explicit `START.collection_mode ===
 * "full_refresh"` (surfaced as `CollectContext.collectionMode`) walks
 * BACKWARD via `before_id` to the natural end instead — same no-ceiling,
 * same typed-failure-on-non-progress discipline — and rebuilds the forward
 * cursor from what that full walk observed, so the next ordinary run
 * resumes forward-incrementally again. See `GroupMessageCursors`'s doc
 * comment for why this replaced two earlier, rejected designs (a
 * timestamp-plus-overlap window, then a backward-anchor-search). Old-message
 * mutable-field repair (e.g. a like added to a message from months ago) is
 * NOT automatic under ordinary incremental resume — see the design note at
 * the bottom of this file for the honest accounting of that gap and what a
 * generic fix would require. direct_chat_messages has NO documented
 * ordering guarantee (the current GroupMe docs omit the direct-message index
 * contract), so it deliberately walks every chat to its natural
 * end every run — an honest full scan, not a pretend incremental walk — but
 * like every other pagination walk in this connector (group messages,
 * direct chats list, groups list) it has NO page-count ceiling either; its
 * only non-natural exit is the same typed `NonProgressError` on a
 * non-advancing/repeated cursor. See collectDirectChatMessagesForChat's doc
 * comment.
 */

import { createHash } from "node:crypto";
import { isMainModule } from "@pdpp/connector-protocol";
import { SaxesParser } from "saxes";
import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import {
  buildDetailCoverageMessage,
  buildFullScanCoverageMessage,
  type CollectContext,
  type DetailCoverageMessage,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { groupmePacingProfile } from "../../src/provider-profile.ts";
import {
  makeReferenceBlobUploader,
  type ReferenceBlobRef,
  runtimeBlobUploadAvailable,
} from "../../src/reference-blob-uploader.ts";
import { validateRecord } from "./schemas.ts";

let httpGovernor = createConnectorHttpGovernor({
  name: "groupme",
  // Retry transient 5xx/transport failures at the request boundary. This is
  // deliberately bounded and shared: a failed page is retried in place, so
  // successful chats are never replayed and the run is never replayed here.
  maxAttempts: 3,
  profile: groupmePacingProfile(),
});

/**
 * Test-only escape hatch: swap the module-level governor for one with pacing
 * disabled (`pacingInitialIntervalMs: 0`, zero-delay `sleep`), so unit tests
 * that exercise real multi-page/multi-group walks (the incremental-anchor
 * tests walk many pages by construction) don't pay GroupMe's production
 * pacing interval per request. Production `collect()` never calls
 * this — only test files import it. Restores the real, paced governor via
 * `resetHttpGovernorForTests()` so tests remain isolated from each other.
 */
export function __setZeroDelayHttpGovernorForTests(): void {
  httpGovernor = createConnectorHttpGovernor({
    name: "groupme",
    maxAttempts: 3,
    profile: groupmePacingProfile(),
    pacingInitialIntervalMs: 0,
  });
}

/** Restore the real, production-paced governor after a test that called
 *  `__setZeroDelayHttpGovernorForTests()`. */
export function __resetHttpGovernorForTests(): void {
  httpGovernor = createConnectorHttpGovernor({
    name: "groupme",
    maxAttempts: 3,
    profile: groupmePacingProfile(),
  });
}

interface GroupMeGroup {
  archived?: boolean | null;
  avatar_url?: string | null;
  created_at?: number | null;
  description?: string | null;
  id: string;
  image_url?: string | null;
  members_count?: number | null;
  /**
   * GroupMe's own documented per-group message envelope on `GET /groups`:
   * `{ count, last_message_id, last_message_created_at, preview }`.
   *
   * The connector previously read only a FLAT `messages_count`, which is
   * absent from that documented shape — and live evidence agrees: all 156
   * of this owner's groups carry `messages_count: null` across every
   * version ever collected, while the sibling `members_count` populates
   * normally. So the flat field was never the real one.
   */
  messages?: { count?: number | null } | null;
  messages_count?: number | null;
  muted?: boolean | null;
  name?: string | null;
  office_mode?: boolean | null;
  phone_number?: string | null;
  share_url?: string | null;
  show_full_last_message?: boolean | null;
  updated_at?: number | null;
}

/**
 * The provider-reported message count for one group, read from whichever
 * shape the API actually returned: the documented nested
 * `messages.count`, or the flat `messages_count` this connector has always
 * modelled.
 *
 * Returns `null` when NEITHER is present or usable. That distinction is
 * load-bearing: `null` means "the provider did not tell us", which is
 * different from `0` ("the provider says this group is empty"). A missing
 * count must never collapse into a zero denominator — that would assert an
 * empty group that was simply never reported on.
 *
 * Rejects non-integer, negative, and non-finite values rather than
 * coercing them, so a malformed provider value degrades to "unknown"
 * instead of silently becoming a fabricated anchor.
 */
export function providerMessageCount(group: GroupMeGroup): number | null {
  const candidate = group.messages?.count ?? group.messages_count;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return null;
  }
  if (!Number.isInteger(candidate) || candidate < 0) {
    return null;
  }
  return candidate;
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
  id?: string | null;
  last_message?:
    | string
    | {
        created_at?: number | null;
        text?: string | null;
      }
    | null;
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
  after_id?: string;
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

async function readAttachmentBody(
  res: Response,
  recordKey: string,
  maxBytes = BLOB_MAX_BYTES
): Promise<{ buffer: Buffer; size: number } | null> {
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
    if (totalBytes > maxBytes) {
      reader.cancel();
      // eslint-disable-next-line no-console
      console.warn(`groupme: attachment streaming exceeded limit (${recordKey}): ${totalBytes} > ${maxBytes}`);
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
  const outcome = await fetchAttachmentBlobOutcome(urlString, recordKey);
  return outcome.kind === "available" ? outcome.blob : null;
}

export type AttachmentFetchOutcome =
  | { kind: "available"; blob: { buffer: Buffer; contentType: string | null; size: number } }
  | { kind: "failed"; reason: string }
  | { kind: "unavailable"; reason: "provider_object_unavailable" };

const GROUPME_PROVIDER_ERROR_MAX_BYTES = 16 * 1024;
const DECIMAL_HEADER_RE = /^\d+$/;
const GROUPME_PROVIDER_ERROR_FIELDS = new Set(["Code", "HostId", "Key", "Message", "RequestId", "Resource"]);

function parseTerminalProviderErrorCode(xml: string): "AccessDenied" | "NoSuchKey" | null {
  let code = "";
  let codeCount = 0;
  let depth = 0;
  let invalid = false;
  let insideCode = false;
  let rootCount = 0;
  const seenFields = new Set<string>();
  const parser = new SaxesParser({ xmlns: false });

  parser.on("opentag", (tag) => {
    depth += 1;
    if (depth === 1) {
      rootCount += 1;
      invalid ||= tag.name !== "Error" || Object.keys(tag.attributes).length !== 0;
      return;
    }
    if (depth === 2) {
      if (
        !GROUPME_PROVIDER_ERROR_FIELDS.has(tag.name) ||
        seenFields.has(tag.name) ||
        Object.keys(tag.attributes).length !== 0
      ) {
        invalid = true;
      }
      seenFields.add(tag.name);
      if (tag.name === "Code") {
        codeCount += 1;
        insideCode = true;
      }
      return;
    }
    invalid = true;
  });
  parser.on("text", (text) => {
    if (insideCode) {
      code += text;
    } else if (depth < 2 && text.trim()) {
      invalid = true;
    }
  });
  parser.on("closetag", (tag) => {
    if (depth === 2 && tag.name === "Code") {
      insideCode = false;
    }
    depth -= 1;
  });
  parser.on("cdata", () => {
    invalid = true;
  });
  parser.on("comment", () => {
    invalid = true;
  });
  parser.on("doctype", () => {
    invalid = true;
  });
  parser.on("processinginstruction", () => {
    invalid = true;
  });
  parser.on("error", () => {
    invalid = true;
  });

  try {
    parser.write(xml).close();
  } catch {
    return null;
  }
  const normalizedCode = code.trim();
  if (invalid || rootCount !== 1 || depth !== 0 || insideCode || codeCount !== 1) {
    return null;
  }
  return normalizedCode === "AccessDenied" || normalizedCode === "NoSuchKey" ? normalizedCode : null;
}

async function readTerminalProviderErrorCode(response: Response): Promise<"AccessDenied" | "NoSuchKey" | null> {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/xml" && contentType !== "text/xml") {
    return null;
  }
  const declaredLengthHeader = response.headers.get("content-length");
  let declaredLength: number | null = null;
  if (declaredLengthHeader !== null) {
    if (!DECIMAL_HEADER_RE.test(declaredLengthHeader)) {
      return null;
    }
    declaredLength = Number(declaredLengthHeader);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 1 ||
      declaredLength > GROUPME_PROVIDER_ERROR_MAX_BYTES
    ) {
      return null;
    }
  }
  const body = await readAttachmentBody(response, "provider-error", GROUPME_PROVIDER_ERROR_MAX_BYTES);
  if (!body || (declaredLength !== null && body.size !== declaredLength)) {
    return null;
  }
  return parseTerminalProviderErrorCode(body.buffer.toString("utf8").trim());
}

async function classifyAttachmentHttpFailure(response: Response, recordKey: string): Promise<AttachmentFetchOutcome> {
  const terminalCode = await readTerminalProviderErrorCode(response);
  const providerObjectUnavailable =
    (response.status === 403 && terminalCode === "AccessDenied") ||
    (response.status === 404 && terminalCode === "NoSuchKey");
  if (providerObjectUnavailable) {
    // eslint-disable-next-line no-console
    console.warn(`groupme: attachment is unavailable from the provider (${recordKey}): HTTP ${response.status}`);
    return { kind: "unavailable", reason: "provider_object_unavailable" };
  }
  // eslint-disable-next-line no-console
  console.warn(`groupme: attachment fetch failed (${recordKey}): HTTP ${response.status}`);
  return { kind: "failed", reason: `attachment_http_${response.status}` };
}

function canonicalAttachmentFetchUrl(urlString: string): string {
  try {
    const url = new URL(urlString);
    if (
      url.protocol === "http:" &&
      url.hostname === "i.groupme.com" &&
      url.port === "" &&
      !url.username &&
      !url.password
    ) {
      url.protocol = "https:";
      return url.toString();
    }
  } catch {
    // The validator below owns the typed invalid-URL outcome.
  }
  return urlString;
}

/**
 * Preserve the distinction between a provider object that no longer exists
 * and a fetch that may succeed later. GroupMe's public CDN returns 403/404 for
 * unavailable objects; every other failure remains retryable/unproven.
 */
export async function fetchAttachmentBlobOutcome(
  urlString: string,
  recordKey: string
): Promise<AttachmentFetchOutcome> {
  const fetchUrl = canonicalAttachmentFetchUrl(urlString);
  const validation = validateAttachmentUrl(fetchUrl);
  if (!validation.valid) {
    // eslint-disable-next-line no-console
    console.warn(`groupme: attachment validation failed (${recordKey}): ${validation.reason}`);
    return { kind: "failed", reason: "attachment_url_invalid" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BLOB_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(fetchUrl, {
      signal: controller.signal,
      redirect: "error", // Fail closed on any redirect
    });

    if (!res.ok) {
      return classifyAttachmentHttpFailure(res, recordKey);
    }

    // Validate Content-Length header exists and is within bounds
    const contentLengthHeader = res.headers.get("content-length");
    if (!contentLengthHeader) {
      // eslint-disable-next-line no-console
      console.warn(`groupme: attachment missing content-length (${recordKey})`);
      return { kind: "failed", reason: "attachment_content_length_missing" };
    }

    if (!DECIMAL_HEADER_RE.test(contentLengthHeader)) {
      // eslint-disable-next-line no-console
      console.warn(`groupme: attachment invalid content-length (${recordKey}): ${contentLengthHeader}`);
      return { kind: "failed", reason: "attachment_content_length_invalid" };
    }
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength)) {
      // eslint-disable-next-line no-console
      console.warn(`groupme: attachment invalid content-length (${recordKey}): ${contentLengthHeader}`);
      return { kind: "failed", reason: "attachment_content_length_invalid" };
    }

    if (contentLength > BLOB_MAX_BYTES) {
      // eslint-disable-next-line no-console
      console.warn(`groupme: attachment exceeds size limit (${recordKey}): ${contentLength} > ${BLOB_MAX_BYTES}`);
      return { kind: "failed", reason: "attachment_too_large" };
    }

    const body = await readAttachmentBody(res, recordKey);
    if (!body) {
      return { kind: "failed", reason: "attachment_body_unreadable" };
    }
    if (body.size !== contentLength) {
      // eslint-disable-next-line no-console
      console.warn(`groupme: attachment content-length mismatch (${recordKey}): ${body.size} != ${contentLength}`);
      return { kind: "failed", reason: "attachment_content_length_mismatch" };
    }
    return {
      kind: "available",
      blob: { ...body, contentType: normalizeAttachmentContentType(res.headers.get("content-type")) },
    };
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
    return { kind: "failed", reason: "attachment_fetch_failed" };
  } finally {
    clearTimeout(timeoutId);
  }
}

function convertTimestamp(unixSeconds: number | undefined | null, context = "unknown"): string {
  if (!(unixSeconds && Number.isFinite(unixSeconds) && unixSeconds > 0)) {
    throw new Error(`groupme_missing_timestamp: ${context}`);
  }
  return new Date(unixSeconds * 1000).toISOString();
}

function convertOptionalTimestamp(unixSeconds: number | undefined | null): string | null {
  return unixSeconds && Number.isFinite(unixSeconds) && unixSeconds > 0
    ? new Date(unixSeconds * 1000).toISOString()
    : null;
}

interface NormalizedAttachment {
  blob_id?: string | null;
  lat?: number | null;
  lng?: number | null;
  name: string | null;
  type: "image" | "file" | "location" | "emoji";
  url: string | null;
}

type AttachmentRecordEmitter = (data: RecordData) => Promise<void>;

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
  emitAttachmentRecord: AttachmentRecordEmitter | undefined
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
  let hydrationStatus: HydrationStatus = "deferred";
  let hydrationError: string | null = null;

  if (uploader) {
    try {
      const uploadResult = await uploader(url, contentType, recordId);
      // Keep the exported normalization seam compatible with callers that
      // provide a direct blob uploader; the production uploader returns the
      // richer tagged outcome needed for unavailable-vs-failed accounting.
      const applied = applyBlobUploadResult(uploadResult);
      ({ blobRef, hydrationError, hydrationStatus } = applied);
      if (blobRef) {
        normalized.blob_id = blobRef.blob_id;
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
  emitAttachmentRecord: AttachmentRecordEmitter | undefined
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

/**
 * Thrown for HTTP 304 — documented explicitly for `GET /groups/:id/messages`
 * with `before_id`: "If no messages are found (e.g. when filtering with
 * `before_id`) we return code 304" (dev.groupme.com/docs/v3). GroupMe's docs
 * are SILENT on what `after_id`/`since_id` do when they reference a
 * deleted/invalid/nonexistent message id — no documented distinct error
 * code, status, or body shape exists for that case. Treating 304 as "empty
 * page" is the conservative reading: it's the one case the docs actually
 * describe, and applying the same interpretation to `after_id` costs
 * nothing if that endpoint never actually returns 304 (the branch simply
 * never fires). This is caught only at message-pagination call sites (see
 * `fetchMessagesPage`), never treated as a generic success by `makeRequest`
 * itself — a 304 on any other endpoint (e.g. `/groups`) still throws as an
 * ordinary unexpected-status error.
 */
class EmptyPageResponse extends Error {
  constructor() {
    super("groupme_messages_empty_page_304");
  }
}

/**
 * Thrown for any non-2xx, non-304, non-401/403 HTTP response from GroupMe.
 * Carries `status` as a STRUCTURED field — never parsed back out of the
 * message string — specifically so callers that need to distinguish status
 * classes (e.g. the invalid-resume-cursor fallback in
 * `collectGroupMessagesForwardFromCursor`, which must NOT trigger on a
 * transient 429/5xx) can do so reliably instead of pattern-matching
 * `error.message`, which is fragile and was the root cause of a P1: a prior
 * revision matched on `error.message.startsWith("groupme_http_")`, which is
 * true for EVERY status alike (400, 404, 429, 500, 502, 503), silently
 * misclassifying a transient server error as an invalid cursor and
 * triggering an expensive, unsignaled full backward rescan.
 */
class GroupMeHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`groupme_http_${status}: ${body.slice(0, 200)}`);
    this.name = "GroupMeHttpError";
    this.status = status;
  }
}

async function makeRequest<T>(token: string, path: string, queryParams?: Record<string, string | number>): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, String(value));
    }
  }

  const r = await httpGovernor.request<
    { body: string; status: number; headers: Record<string, string | undefined> },
    { body: string; status: number; headers: Record<string, string | undefined> }
  >(
    async () => {
      const res = await fetch(url.toString(), {
        headers: {
          "X-Access-Token": token,
        },
      });
      return {
        body: await res.text().catch((): string => ""),
        headers: { "retry-after": res.headers.get("retry-after") ?? undefined },
        status: res.status,
      };
    },
    (resp) => ({ headers: resp.headers, status: resp.status, value: resp })
  );
  const raw = r.value;

  if (raw.status === 401 || raw.status === 403) {
    throw new Error("groupme_auth_failed");
  }
  if (raw.status === 304) {
    throw new EmptyPageResponse();
  }
  if (raw.status < 200 || raw.status >= 300) {
    throw new GroupMeHttpError(raw.status, raw.body);
  }

  const json = JSON.parse(raw.body) as { response: T };
  return json.response;
}

/**
 * Fetch one page of `GET /groups/:id/messages`, normalizing GroupMe's
 * documented 304-on-empty response (see `EmptyPageResponse`) into an
 * ordinary empty-messages shape so every walk's natural-end check
 * (`messages.length === 0`) handles it uniformly regardless of which
 * pagination parameter produced the empty result.
 */
async function fetchMessagesPage(
  token: string,
  groupId: string,
  params: Record<string, string | number>
): Promise<GroupMessagesResponse> {
  try {
    return await makeRequest<GroupMessagesResponse>(token, `/groups/${groupId}/messages`, params);
  } catch (error) {
    if (error instanceof EmptyPageResponse) {
      return { count: 0, messages: [] };
    }
    throw error;
  }
}

interface PaginatedListResult<T> {
  items: T[];
}

/**
 * Fully paginate a GroupMe list endpoint (`/groups`, `/chats`) using its
 * documented `page`/`per_page` query params, to the natural end: a page
 * shorter than `PAGE_SIZE` (including empty). No page-count ceiling — an
 * arbitrary cap silently prevents an owner with more groups/chats than the
 * cap from ever completing, which is itself a correctness bug, not a safe
 * truncation. The only non-natural exit is `NonProgressError`, thrown when
 * a full-size page contributes ZERO ids this walk hasn't already seen (a
 * provider bug re-serving the same content for a different `page` number,
 * or a list that has stopped growing while still returning full pages) —
 * caught by `runCollectionPass`'s existing catch, converted to an ordinary
 * `failed: true`.
 */
async function fetchPaginatedList<T extends { id?: string | null }>(
  token: string,
  path: string,
  stream: string,
  progressWithSignals: ProgressFn,
  identityOf: (item: T) => string = (item) => (item.id === null || item.id === undefined ? "" : String(item.id).trim())
): Promise<PaginatedListResult<T>> {
  const items: T[] = [];
  const seenIds = new Set<string>();
  let page = 1;

  for (;;) {
    await progressWithSignals(`Fetching ${path}`, { stream, phase: "fetch", page, total_seen: items.length });
    const pageItems = await makeRequest<T[]>(token, path, { page, per_page: PAGE_SIZE });
    const newItems = pageItems.filter((item) => !seenIds.has(identityOf(item)));
    if (pageItems.length >= PAGE_SIZE && newItems.length === 0) {
      throw new NonProgressError(path, "forward", String(page));
    }
    for (const item of newItems) {
      const itemId = identityOf(item);
      if (!itemId) {
        throw new NonProgressError(path, "forward", String(page));
      }
      seenIds.add(itemId);
      items.push(item);
    }
    await progressWithSignals(`Fetched ${path} page`, {
      stream,
      phase: "page",
      page,
      item_count: pageItems.length,
      total_seen: items.length,
    });

    if (pageItems.length < PAGE_SIZE) {
      return { items };
    }
    page += 1;
  }
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
    // Reads whichever shape the API returned. The prior flat-only read is
    // why all 156 of this owner's groups persisted `messages_count: null`.
    messages_count: providerMessageCount(g),
  };
}

async function toGroupMessageRecord(
  msg: GroupMeMessage,
  groupId: string,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: AttachmentRecordEmitter | undefined
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

function directChatIdentity(chat: GroupMeDirectChat): string {
  const chatId = chat.id?.trim() || chat.other_user?.id?.trim();
  if (!chatId) {
    throw new Error("groupme_direct_chat_missing_identity");
  }
  return chatId;
}

function toDirectChatRecord(chat: GroupMeDirectChat): RecordData {
  const chatId = directChatIdentity(chat);
  const lastMessage = chat.last_message;
  const lastMessageText = typeof lastMessage === "string" ? lastMessage : (lastMessage?.text ?? null);
  const lastMessageAt = chat.last_message_at ?? (typeof lastMessage === "object" ? lastMessage?.created_at : null);
  return {
    id: chatId,
    other_user_id: chat.other_user?.id ?? null,
    other_user_name: chat.other_user?.name ?? null,
    avatar_url: chat.avatar_url ?? chat.other_user?.avatar_url ?? null,
    last_message: lastMessageText,
    last_message_at: convertOptionalTimestamp(lastMessageAt),
  };
}

async function toDirectChatMessageRecord(
  msg: GroupMeMessage,
  chatId: string,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: AttachmentRecordEmitter | undefined
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

type BlobHydrationOutcome =
  | { kind: "failed"; reason: string }
  | { kind: "hydrated"; blobRef: ReferenceBlobRef }
  | { kind: "unavailable"; reason: "provider_object_unavailable" };
type BlobUploader = (
  url: string,
  mimeType: string,
  recordKey: string
) => Promise<BlobHydrationOutcome | ReferenceBlobRef | null>;

function applyBlobUploadResult(uploadResult: BlobHydrationOutcome | ReferenceBlobRef | null): {
  blobRef: ReferenceBlobRef | null;
  hydrationError: string | null;
  hydrationStatus: HydrationStatus;
} {
  if (uploadResult === null) {
    return { blobRef: null, hydrationError: null, hydrationStatus: "deferred" };
  }
  const outcome: BlobHydrationOutcome =
    "kind" in uploadResult ? uploadResult : { kind: "hydrated", blobRef: uploadResult };
  if (outcome.kind === "hydrated") {
    return { blobRef: outcome.blobRef, hydrationError: null, hydrationStatus: "hydrated" };
  }
  return { blobRef: null, hydrationError: outcome.reason, hydrationStatus: outcome.kind };
}

type HydrationStatus = "deferred" | "failed" | "hydrated" | "unavailable";
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
  return async (url: string, mimeType: string, recordKey: string): Promise<BlobHydrationOutcome> => {
    const fetched = await fetchAttachmentBlobOutcome(url, recordKey);
    if (fetched.kind !== "available") {
      return fetched;
    }
    const { blob } = fetched;
    const resolvedMimeType = resolveUploadMimeType(blob.contentType, mimeType);

    try {
      const blobRef = await blobUploader({
        connectorId: "groupme",
        connectorInstanceId: process.env.PDPP_CONNECTOR_INSTANCE_ID || null,
        content: [blob.buffer],
        mimeType: resolvedMimeType,
        recordKey,
        stream: "attachments",
      });
      return blobRef ? { kind: "hydrated", blobRef } : { kind: "failed", reason: "attachment_blob_upload_failed" };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `groupme: blob upload failed (${recordKey}): ${error instanceof Error ? error.message : String(error)}`
      );
      return { kind: "failed", reason: "attachment_blob_upload_failed" };
    }
  };
}

interface GroupMessagesResponse {
  count: number;
  messages: GroupMeMessage[];
}

/**
 * Whether a message page is SELF-INCONSISTENT: the very same response body
 * states the conversation holds `count > 0` messages and simultaneously
 * serves `messages: []`.
 *
 * WHY THIS EXISTS — throttle-blindness. GroupMe signals at least two
 * materially different situations with a byte-identical HTTP 200 + empty
 * `messages` array:
 *
 *   1. A genuine natural end (nothing more to serve).
 *   2. A refusal to serve content it still counts.
 *
 * Neither carries a distinguishing status code, `Retry-After`, or rate-limit
 * header — measured live, an empty page and a full page differ in NO header
 * except `content-length`. So a status-based retry governor (which is what
 * `httpGovernor` is) cannot see the difference, and a walk that terminates
 * on `messages.length === 0` alone will silently declare a proven-complete
 * walk of a conversation it never actually read.
 *
 * The response's OWN `count` field is the only in-band signal that
 * contradicts the empty array, so it is the one thing a walk can check
 * without inventing a heuristic. `count === 0` with an empty array is
 * coherent and stays an ordinary natural end; `count > 0` with an empty
 * array is the provider contradicting itself, and this connector refuses to
 * call that a proven walk.
 *
 * Deliberately NOT a claim about the cause. This predicate says only "the
 * provider's own two fields disagree, so an empty page here proves nothing"
 * — never "this is throttling" or "this is retention". Distinguishing those
 * needs evidence the response does not carry.
 */
export function pageContradictsItsOwnCount(resp: GroupMessagesResponse): boolean {
  const served = (resp.messages || []).length;
  return served === 0 && typeof resp.count === "number" && resp.count > 0;
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
  /** The `id` of the newest message this walk fetched (page 1's first
   *  message for a backward walk, or the last id reached for a forward
   *  walk), or `undefined` if the group/chat returned no messages at all.
   *  This becomes next run's cursor — an opaque, provider-issued boundary
   *  marker, never a locally-computed time window. Undefined for walks that
   *  don't track a cursor (direct chat messages, which have no documented
   *  ordering to license one). */
  newestMessageId: string | undefined;
  totalSeen: number;
  /**
   * True when this walk stopped on a page that CONTRADICTED ITS OWN COUNT
   * (see `pageContradictsItsOwnCount`) — the provider served an empty array
   * while stating a non-zero `count`. The walk's boundary is then UNPROVEN:
   * it may have reached a genuine end, or it may have been refused content
   * that exists, and the response carries nothing that tells them apart.
   *
   * Callers must not treat such a walk as proof of completeness. It is
   * deliberately separate from `failed`: nothing errored, the request
   * succeeded, and partial results already emitted stay valid — only the
   * COMPLETENESS claim is withheld.
   */
  unprovenBoundary: boolean;
}

/**
 * Thrown when ANY GroupMe pagination walk in this connector — group
 * messages (forward `after_id` or backward `before_id`), direct chat
 * messages (backward `before_id`), or the `/groups`/`/chats` list endpoints
 * (`page`/`per_page`) — cannot prove it made progress: a page's own
 * trailing cursor repeats one already used this walk, or a full-size list
 * page contributed zero ids not already seen. This is the ONLY page-loop
 * exit besides the natural short-page/empty-page boundary — there is
 * deliberately NO page-count ceiling anywhere in GroupMe's pagination (an
 * arbitrary cap is itself a correctness bug: it silently prevents an owner
 * with more history/groups/chats than the cap from ever completing, and —
 * the defect this design replaces — a truncated walk with no persisted
 * progress would replay the same window forever). A real non-progress
 * condition (a provider bug, a cursor that echoes back unchanged, a page
 * whose cursor repeats one already seen) is a genuine anomaly that must
 * fail the pass loudly rather than loop forever or silently under-report —
 * caught by `runCollectionPass`'s existing catch, converted to `failed:
 * true` exactly like any other fetch error, so STATE and the coverage claim
 * are withheld for the boundary this walk never proved.
 */
class NonProgressError extends Error {
  constructor(subject: string, direction: "forward" | "backward", cursor: string) {
    super(`groupme: ${subject} ${direction} walk made no progress at cursor ${cursor} — refusing to loop`);
    this.name = "NonProgressError";
  }
}

/**
 * Thrown ONLY when the very FIRST fetch of a resumed forward walk (using a
 * persisted `after_id` cursor) fails with an HTTP error response. GroupMe's
 * docs are silent on what happens when `after_id` references a
 * deleted/invalid/nonexistent message (see `EmptyPageResponse`'s doc
 * comment) — an HTTP error on the resume attempt is the most plausible
 * signal that the persisted cursor itself is no longer valid, since a mid-
 * walk error (any fetch after the first) is treated as an ordinary
 * transient failure instead (see `collectGroupMessagesForwardFromCursor`).
 * Caught by `collectOneGroupMessages`, which falls back to a fresh backward
 * walk to the natural end for JUST this group — bounded (one group, one
 * fallback attempt, no retry loop) and honest (the group's cursor is reset
 * to a real value only once that backward walk itself completes cleanly;
 * the group's own emitted records are unaffected since a genuine resend of
 * unchanged content still no-ops through the fingerprint cursor).
 */
class InvalidResumeCursorError extends Error {
  constructor(groupId: string, cursor: string, cause: unknown) {
    super(
      `groupme: group ${groupId}'s persisted cursor ${cursor} was rejected by the provider — falling back to a full backward walk for this group`,
      { cause }
    );
    this.name = "InvalidResumeCursorError";
  }
}

/**
 * Applies a declared `since` boundary to one fetched page: counts and emits
 * only messages at-or-after `since`; a message before it is neither counted
 * (does not inflate `considered` with an out-of-scope row) nor emitted.
 *
 * `pageFullyOutOfScope` is true when EVERY message on this page is out of
 * scope — the conservative, ordering-agnostic stop signal every caller can
 * use safely: an entirely-out-of-scope page cannot contain a hidden in-scope
 * row regardless of intra-page order.
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

/**
 * Whether a page is genuinely `created_at`-descending (non-increasing,
 * duplicates/ties allowed) — GroupMe's official `GET /groups/:id/messages`
 * documents this ordering and that `before_id` returns the page immediately
 * preceding it, so a page that actually satisfies this check licenses
 * stopping at the first out-of-scope row without walking the rest of the
 * page or the pages after it. Checked per page (not assumed) so a live
 * response that violates the documented contract is caught rather than
 * silently trusted.
 */
function isDescendingByCreatedAt(messages: readonly GroupMeMessage[]): boolean {
  for (let i = 1; i < messages.length; i += 1) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (prev && curr && curr.created_at > prev.created_at) {
      return false;
    }
  }
  return true;
}

/**
 * Per-group durable resumable cursor for `group_messages`' incremental walk.
 * Keyed by GroupMe group id, value is the `id` of the newest message
 * observed in that group's last clean run — an opaque, provider-issued
 * boundary marker, never a locally-computed time window. Lives alongside
 * `fingerprints` in `state.group_messages`, written only when
 * `collectGroupMessages`' overall pass is clean (see `CollectionOutcome`) —
 * the same all-or-nothing gate that already protects the fingerprint map.
 *
 * Resumed with GroupMe's documented FORWARD pagination primitive,
 * `after_id`: "messages that immediately follow a given message... in
 * ascending order (which makes it easy to pick off the last result for
 * continued pagination)" (dev.groupme.com/docs/v3). This is the API's own
 * intended continuation cursor for exactly this use case — advance the
 * cursor to each page's last message id and keep paging forward until a
 * page shorter than the page size proves the natural end. This replaces two
 * earlier, rejected designs: a locally-computed timestamp-plus-overlap
 * window (an ungrounded heuristic — no overlap size is provably sufficient,
 * and a time window cannot force re-observation of a row whose mutable
 * field changed without moving `created_at`), and a backward `before_id`
 * re-scan searching for this same id as an "anchor" (wastes work
 * proportional to everything posted since last run, and — the reason it was
 * rejected outright — a page-count ceiling on that backward search is
 * itself a correctness bug: a sufficiently large, still-growing group could
 * never converge within a fixed page cap).
 *
 * A cursor is a PURE RESUME POINT, not a search target: this walk never
 * re-derives "was this row already covered" by comparing ids against a
 * target — it trusts `after_id` to already start exactly one message past
 * where the prior run stopped, and it just keeps going until the API says
 * there's nothing left.
 */
export interface GroupMessageCursors {
  [groupId: string]: string;
}

/** Decode `state.group_messages.cursors` tolerantly: any missing/malformed
 *  shape yields an empty map (cold start — walk backward to the natural
 *  end instead), matching `decodePriorFingerprints`'s tolerance policy in
 *  fingerprint-cursor.ts. */
export function decodeGroupMessageCursors(priorState: unknown): GroupMessageCursors {
  const out: GroupMessageCursors = {};
  if (!priorState || typeof priorState !== "object" || Array.isArray(priorState)) {
    return out;
  }
  const raw = (priorState as Record<string, unknown>).cursors;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [groupId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out[groupId] = value;
    }
  }
  return out;
}

/** Emit every in-scope group message through the fingerprint cursor. Shared
 *  by both the forward (`after_id`) and backward (`before_id`) walks. */
async function emitInScopeGroupMessages(
  inScope: readonly GroupMeMessage[],
  groupId: string,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: AttachmentRecordEmitter | undefined,
  emitRecord: (stream: string, data: RecordData) => Promise<void>
): Promise<void> {
  for (const msg of inScope) {
    const record = await toGroupMessageRecord(msg, groupId, uploader, emitAttachmentRecord);
    if (cursor.shouldEmit(record)) {
      await emitRecord("group_messages", record);
    }
  }
}

/**
 * Whether a page is genuinely ascending by `created_at` (non-decreasing,
 * ties allowed) — the ordering contract GroupMe's docs state for an
 * `after_id`-paginated response. Checked per page, not assumed, mirroring
 * `isDescendingByCreatedAt`'s existing verify-don't-trust discipline for the
 * backward endpoint's documented order.
 */
function isAscendingByCreatedAt(messages: readonly GroupMeMessage[]): boolean {
  for (let i = 1; i < messages.length; i += 1) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (prev && curr && curr.created_at < prev.created_at) {
      return false;
    }
  }
  return true;
}

/**
 * Forward-resumes one group's message walk from a durable `after_id` cursor
 * using GroupMe's documented forward-continuation pagination — see
 * `GroupMessageCursors`'s doc comment for why this replaces a backward
 * anchor search. Pages strictly forward (oldest-of-the-new-messages first)
 * until a page shorter than `PAGE_SIZE` proves the natural end: no
 * page-count ceiling exists anywhere in this loop — the ONLY other exit is
 * `NonProgressError`, thrown if a page's own trailing cursor fails to
 * strictly advance past every cursor value already used this walk (a
 * provider bug, a stuck `after_id`, or a duplicate/repeated page). That
 * failure propagates to `runCollectionPass`'s existing catch and becomes an
 * ordinary `failed: true` outcome — STATE and the coverage claim are
 * withheld exactly as they are for any other fetch/parse failure.
 */
async function collectGroupMessagesForwardFromCursor(
  token: string,
  group: GroupMeGroup,
  startAfterId: string,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: AttachmentRecordEmitter | undefined,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>
): Promise<PerConversationWalkResult> {
  let afterId = startAfterId;
  let totalSeen = 0;
  let newestMessageId: string | undefined;
  let isFirstFetch = true;
  const usedCursors = new Set<string>([startAfterId]);

  for (;;) {
    await progressWithSignals("Fetching group messages", {
      stream: "group_messages",
      phase: "fetch",
      after_id: afterId,
      total_seen: totalSeen,
    });

    let resp: GroupMessagesResponse;
    try {
      resp = await fetchMessagesPage(token, group.id, {
        limit: PAGE_SIZE,
        after_id: afterId,
      });
    } catch (error) {
      // Only the FIRST fetch of a resumed walk gets the invalid-cursor
      // fallback treatment — see InvalidResumeCursorError's doc comment. A
      // mid-walk failure (any fetch after the first) is an ordinary
      // transient error and propagates normally.
      //
      // The fallback trigger is INTENTIONALLY narrow: only a structured
      // GroupMeHttpError with status 400 or 404 — the closest thing
      // GroupMe's docs gesture at for "this identifier doesn't resolve"
      // (see EmptyPageResponse's doc comment on the docs' silence for
      // after_id specifically). This must NEVER match 401/403 (a separate,
      // unstructured "groupme_auth_failed" Error — auth failures propagate
      // untouched, the whole run is dead, not just this cursor), and must
      // NEVER match 429/5xx (a transient provider condition, not evidence
      // the cursor itself is invalid) — matching those would silently
      // convert a temporary blip into an expensive, unsignaled full
      // backward rescan with no retry and no operator-visible failure. A
      // prior revision matched on `error.message.startsWith("groupme_http_")`,
      // which is true for every status alike; this is the fix for that P1.
      if (isFirstFetch && error instanceof GroupMeHttpError && (error.status === 400 || error.status === 404)) {
        // biome-ignore lint/style/useErrorCause: InvalidResumeCursorError's 3rd constructor arg forwards to super(message, { cause })
        throw new InvalidResumeCursorError(group.id, afterId, error);
      }
      throw error;
    }
    isFirstFetch = false;

    const messages = resp.messages || [];
    if (!messages.length) {
      // NOT checked for a self-contradicting count here, unlike the backward
      // walk. This is a forward resume from a cursor, so `count` describes
      // the group's WHOLE history while this page describes only what is
      // NEW since that cursor. `count > 0` with an empty page is the normal,
      // coherent shape of an up-to-date incremental walk, not a
      // contradiction — applying the backward walk's predicate here would
      // flag every healthy incremental run as unproven.
      return { totalSeen, newestMessageId, unprovenBoundary: false };
    }
    if (!isAscendingByCreatedAt(messages)) {
      // The provider violated its own documented ordering contract for this
      // response — nothing about this page's cursor can be trusted to
      // safely resume from. Fail loudly rather than silently accept a page
      // that might have skipped or reordered messages.
      throw new NonProgressError(group.id, "forward", afterId);
    }

    totalSeen += messages.length;
    await progressWithSignals("Fetched group messages page", {
      stream: "group_messages",
      phase: "page",
      item_count: messages.length,
      total_seen: totalSeen,
    });

    await emitInScopeGroupMessages(messages, group.id, cursor, uploader, emitAttachmentRecord, emitRecord);
    newestMessageId = messages.at(-1)?.id ?? newestMessageId;

    if (messages.length < PAGE_SIZE) {
      return { totalSeen, newestMessageId, unprovenBoundary: false };
    }

    const nextAfterId = messages.at(-1)?.id;
    if (!nextAfterId || usedCursors.has(nextAfterId)) {
      throw new NonProgressError(group.id, "forward", afterId);
    }
    usedCursors.add(nextAfterId);
    afterId = nextAfterId;
  }
}

/**
 * Whether a backward group-messages page ends the walk at its natural end:
 * every message was out of the declared `since` scope, a `since`-scoped
 * page excluded at least one row, or the page came back shorter than
 * `PAGE_SIZE`. Extracted purely to keep
 * `collectGroupMessagesBackwardToNaturalEnd`'s cognitive complexity within
 * the lint ceiling — no behavior change from inlining it.
 */
function backwardPageReachedNaturalEnd(
  messages: readonly GroupMeMessage[],
  inScope: readonly GroupMeMessage[],
  pageFullyOutOfScope: boolean,
  sinceEpochSeconds: number | null
): boolean {
  if (pageFullyOutOfScope) {
    return true;
  }
  if (sinceEpochSeconds !== null && inScope.length < messages.length) {
    return true;
  }
  return messages.length < PAGE_SIZE;
}

/**
 * Backward-walks one group's ENTIRE message history via `before_id`, to the
 * natural end — used for a cold start (no persisted cursor) or an explicit
 * `full_refresh` run. No page-count ceiling: the only exits are the natural
 * short/empty-page boundary or `NonProgressError` on a page that fails the
 * documented-descending check or whose trailing cursor repeats one already
 * used this walk. `applySinceBoundToPage` still layers an independent,
 * caller-declared `since` bound on top (an owner-narrowed collection
 * window — unrelated to this walk's own cursor bookkeeping); a page that
 * has since-excluded at least one row, verified genuinely descending, ends
 * the walk early since everything after it is out of the declared scope.
 */
async function collectGroupMessagesBackwardToNaturalEnd(
  token: string,
  group: GroupMeGroup,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: AttachmentRecordEmitter | undefined,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>,
  sinceEpochSeconds: number | null
): Promise<PerConversationWalkResult> {
  let beforeId: string | undefined;
  let totalSeen = 0;
  let newestMessageId: string | undefined;
  const usedCursors = new Set<string>();

  for (;;) {
    await progressWithSignals("Fetching group messages", {
      stream: "group_messages",
      phase: "fetch",
      ...(beforeId ? { before_id: beforeId } : {}),
      total_seen: totalSeen,
    });

    const resp = await fetchMessagesPage(token, group.id, {
      limit: PAGE_SIZE,
      ...(beforeId ? { before_id: beforeId } : {}),
    });

    const messages = resp.messages || [];
    if (!messages.length) {
      // An empty page ends the walk either way — there is no cursor to
      // continue from. What differs is whether that ending PROVES the
      // group was fully walked. A page that contradicts its own `count`
      // proves nothing (see `pageContradictsItsOwnCount`), so the boundary
      // is reported as unproven instead of silently passing for complete.
      return { totalSeen, newestMessageId, unprovenBoundary: pageContradictsItsOwnCount(resp) };
    }

    if (newestMessageId === undefined) {
      newestMessageId = messages[0]?.id;
    }

    // GroupMe's docs guarantee GET /groups/:id/messages with `before_id` is
    // created_at-descending. A page that violates this is not safe to
    // continue from: the trailing `before_id` (`messages.at(-1)`) is only
    // guaranteed to be "the oldest on this page" if the page is genuinely
    // ordered — on a non-descending page that id could sit anywhere in
    // time, and paginating from it could silently skip or re-walk
    // messages. Fail loudly (caught by runCollectionPass, becomes an
    // ordinary `failed: true`) rather than trust an unverified cursor.
    // Checked BEFORE emitting so a page this connector cannot trust never
    // contributes to considered/emitted counts under a false "in scope"
    // read of its own now-unreliable ordering.
    if (!isDescendingByCreatedAt(messages)) {
      throw new NonProgressError(group.id, "backward", beforeId ?? "(start)");
    }

    const { inScope, pageFullyOutOfScope } = applySinceBoundToPage(messages, sinceEpochSeconds);
    totalSeen += inScope.length;
    await progressWithSignals("Fetched group messages page", {
      stream: "group_messages",
      phase: "page",
      item_count: inScope.length,
      total_seen: totalSeen,
    });

    await emitInScopeGroupMessages(inScope, group.id, cursor, uploader, emitAttachmentRecord, emitRecord);

    if (backwardPageReachedNaturalEnd(messages, inScope, pageFullyOutOfScope, sinceEpochSeconds)) {
      // A natural end reached on a page that DID serve messages: the
      // provider gave content right up to the boundary, so the boundary is
      // proven in the ordinary way.
      return { totalSeen, newestMessageId, unprovenBoundary: false };
    }

    const nextBeforeId = messages.at(-1)?.id;
    if (!nextBeforeId || usedCursors.has(nextBeforeId)) {
      throw new NonProgressError(group.id, "backward", beforeId ?? "(start)");
    }
    usedCursors.add(nextBeforeId);
    beforeId = nextBeforeId;
  }
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
 * Per-run honest coverage accounting for the `attachments` detail stream
 * (manifest `coverage_strategy: "parent_detail_accounting"` — see
 * evidence/coherence.ts's `strategyBoundsWindowRatherThanCounting`, which
 * deliberately excludes this strategy: it owes a per-item accounting, not a
 * bounded window, so `covered` must actually satisfy `considered`).
 *
 * Every attachment `normalizeOneAttachment` attempts to hydrate (an
 * image/file attachment with a URL) lands in `requiredKeys` — the
 * denominator — the moment its record reaches `emitAttachmentRecord`.
 * `hydrationStatus` then places it in exactly one outcome bucket:
 *   - `hydrated` -> `hydratedKeys` (the numerator: blob bytes actually
 *     committed to storage).
 *   - `unavailable` -> `unavailableKeys`: the public provider CDN returned a
 *     bounded, recognized terminal-object error. Metadata stays retained and
 *     the key is reported as an explicit optional skip.
 *   - `deferred` or `failed` -> neither bucket. Missing runtime support,
 *     validation failures, transient HTTP failures, and upload failures stay
 *     uncovered because another run may still acquire the bytes.
 *
 * A `failed` hydration remains uncovered. Its parent-bound DETAIL_COVERAGE
 * report then withholds that parent's cursor, so the next run re-enumerates the
 * owning message and retries the provider URL without persisting that URL in
 * durable control-plane metadata. A missing uploader is handled the same way.
 */
export interface AttachmentDetailCoverage {
  hydratedKeys: string[];
  requiredKeys: string[];
  unavailableKeys: string[];
}

type AttachmentParentStream = "direct_chat_messages" | "group_messages";

/** Fresh, empty accumulator for one run's attachments detail pass. */
export function makeAttachmentDetailCoverage(): AttachmentDetailCoverage {
  return { hydratedKeys: [], requiredKeys: [], unavailableKeys: [] };
}

interface AttachmentRecordEmitterDeps {
  attachmentCursor: ReturnType<typeof openFingerprintCursor>;
  coverageByParent: Record<AttachmentParentStream, AttachmentDetailCoverage>;
  emitRecord: CollectContext["emitRecord"];
}

function createAttachmentRecordEmitter(deps: AttachmentRecordEmitterDeps): AttachmentRecordEmitter {
  return async (data: RecordData): Promise<void> => {
    const parent = data.message_stream as AttachmentParentStream;
    recordAttachmentCoverage(deps.coverageByParent[parent], data);
    if (deps.attachmentCursor.shouldEmit(data)) {
      await deps.emitRecord("attachments", data);
    }
  };
}

/**
 * Whether one requested attachment parent completed its own enumeration.
 * Coverage is emitted independently per parent, so a failed group-message
 * boundary does not erase a proven direct-message boundary (or vice versa).
 * An unrequested parent contributes no report. Extracted from `collect()` to
 * keep that function's cognitive complexity within the lint ceiling.
 */
function attachmentParentCompleted(
  requested: CollectContext["requested"],
  parent: AttachmentParentStream,
  outcome: CollectionOutcome | undefined
): boolean {
  return requested.has(parent) && outcome?.failed === false;
}

/**
 * Record one attachment record reaching the `attachments` stream into the
 * coverage accumulator, keyed by its own `hydration_status`. Pure: mutates
 * the passed accumulator. `data.id`/`data.hydration_status` are read
 * defensively (RecordData is an index-signature type) since this runs on
 * the same record shape `emitRecord` will independently (re-)validate —
 * this accumulator must never assume the runtime accepted the record.
 */
export function recordAttachmentCoverage(coverage: AttachmentDetailCoverage, data: RecordData): void {
  const key = typeof data.id === "string" ? data.id : String(data.id ?? "");
  coverage.requiredKeys.push(key);
  if (data.hydration_status === "hydrated") {
    coverage.hydratedKeys.push(key);
  } else if (data.hydration_status === "unavailable") {
    coverage.unavailableKeys.push(key);
  }
}

/**
 * Build one parent-bound attachment coverage report. Group and direct-message
 * cursors advance independently, so a shortfall must withhold only the parent
 * whose message walk produced the missing attachment.
 */
export function buildAttachmentDetailCoverageMessage(
  coverage: AttachmentDetailCoverage,
  stateStream: AttachmentParentStream
): DetailCoverageMessage {
  return buildDetailCoverageMessage({
    stream: "attachments",
    stateStream,
    requiredKeys: coverage.requiredKeys,
    hydratedKeys: coverage.hydratedKeys,
    optionalSkipKeys: coverage.unavailableKeys,
    considered: coverage.requiredKeys.length,
    covered: coverage.hydratedKeys.length + coverage.unavailableKeys.length,
  });
}

async function emitAttachmentCoverageByParent(
  requested: CollectContext["requested"],
  coverageByParent: Record<AttachmentParentStream, AttachmentDetailCoverage>,
  outcomes: Record<AttachmentParentStream, CollectionOutcome | undefined>,
  emit: CollectContext["emit"]
): Promise<void> {
  if (attachmentParentCompleted(requested, "group_messages", outcomes.group_messages)) {
    await emit(buildAttachmentDetailCoverageMessage(coverageByParent.group_messages, "group_messages"));
  }
  if (attachmentParentCompleted(requested, "direct_chat_messages", outcomes.direct_chat_messages)) {
    await emit(buildAttachmentDetailCoverageMessage(coverageByParent.direct_chat_messages, "direct_chat_messages"));
  }
}

/**
 * Shared try/catch/outcome wrapper for a stream's top-level collection pass.
 * `body` runs the real fetch-and-emit work and returns the raw enumerated
 * "considered" count on a clean pass. Every GroupMe stream needs the exact
 * same shape here: auth failures propagate untouched (the whole run is dead,
 * not just this stream), any other error — including `NonProgressError` from
 * a walk that couldn't prove it made progress — is logged via
 * `progressWithSignals` and converted to `{ considered: 0, failed: true }`
 * rather than left to throw. There is no page-cap-truncation outcome
 * anymore: every walk in this connector either reaches its provider-defined
 * natural end or throws (see `NonProgressError`'s doc comment for why an
 * arbitrary page ceiling was removed entirely rather than kept as a
 * "truncated but not failed" outcome).
 */
async function runCollectionPass(
  stream: string,
  errorLabel: string,
  progressWithSignals: ProgressFn,
  body: () => Promise<{ considered: number }>,
  reportStreamFailure?: CollectContext["reportStreamFailure"]
): Promise<CollectionOutcome> {
  try {
    const { considered } = await body();
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
    await reportStreamFailure?.(
      stream,
      `Error fetching ${errorLabel}: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true }
    );
    return { considered: 0, failed: true };
  }
}

export async function collectGroups(
  token: string,
  cursor: ReturnType<typeof openFingerprintCursor>,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>,
  reportStreamFailure?: CollectContext["reportStreamFailure"]
): Promise<CollectionOutcome> {
  await progressWithSignals("Fetching GroupMe groups", { stream: "groups", phase: "start" });
  return await runCollectionPass(
    "groups",
    "groups",
    progressWithSignals,
    async () => {
      const { items: groups } = await fetchPaginatedList<GroupMeGroup>(token, "/groups", "groups", progressWithSignals);

      for (const group of groups) {
        const record = toGroupRecord(group);
        if (cursor.shouldEmit(record)) {
          await emitRecord("groups", record);
        }
      }
      return { considered: groups.length };
    },
    reportStreamFailure
  );
}

export async function collectDirectChats(
  token: string,
  cursor: ReturnType<typeof openFingerprintCursor>,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>,
  reportStreamFailure?: CollectContext["reportStreamFailure"]
): Promise<CollectionOutcome> {
  await progressWithSignals("Fetching GroupMe direct chats", { stream: "direct_messages", phase: "start" });
  return await runCollectionPass(
    "direct_messages",
    "direct chats",
    progressWithSignals,
    async () => {
      const { items: chats } = await fetchPaginatedList<GroupMeDirectChat>(
        token,
        "/chats",
        "direct_messages",
        progressWithSignals,
        directChatIdentity
      );

      for (const chat of chats) {
        const record = toDirectChatRecord(chat);
        if (cursor.shouldEmit(record)) {
          await emitRecord("direct_messages", record);
        }
      }
      return { considered: chats.length };
    },
    reportStreamFailure
  );
}

interface DirectMessagesResponse {
  count: number;
  direct_messages: GroupMeMessage[];
}

/**
 * Walks one chat's message pages to the natural end. Returns the raw item
 * count enumerated across pages (the "considered" contribution for this
 * chat) — never aliased to the emitted count, since a page a caller
 * filtered/suppressed was still genuinely observed. Propagates fetch/parse
 * failures to the caller rather than swallowing them, so a mid-chat failure
 * cannot be mistaken for "this chat has no more messages."
 *
 * Deliberately does NOT early-stop on a `since` boundary, and deliberately
 * does NOT attempt an incremental resumed walk, the way `group_messages`
 * now does with `after_id`. GroupMe's official docs make an explicit
 * ordering + pagination-adjacency contract for the GROUP messages endpoint
 * (`GET /groups/:id/messages`), but document no equivalent guarantee for
 * this DIRECT-message endpoint (`GET /direct_messages`) — no
 * `before_id`/`after_id` ordering claim exists to build a resumable cursor
 * on. Absent that authority, out-of-scope rows are filtered from
 * counting/emission (so `considered`/`covered` stay honest for a declared
 * scope) but the walk always continues to the natural end — an empty or
 * short-of-PAGE_SIZE page. This is an honest full-scan-every-run, not a
 * pretend incremental walk: claiming incrementality here would require an
 * ordering guarantee this connector cannot verify.
 *
 * No page-count ceiling: matching `group_messages`' discipline, the only
 * non-natural exit is `NonProgressError`, thrown when a page's own trailing
 * cursor fails to advance or repeats one already used this walk — a real
 * anomaly that must fail the pass loudly (caught by `runCollectionPass`,
 * converted to `failed: true`) rather than loop forever or silently
 * under-report a truncated scan as complete.
 */
async function collectDirectChatMessagesForChat(
  token: string,
  chat: GroupMeDirectChat,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: AttachmentRecordEmitter | undefined,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>,
  sinceEpochSeconds: number | null = null
): Promise<PerConversationWalkResult> {
  let beforeId: string | undefined;
  let totalSeen = 0;
  const usedCursors = new Set<string>();
  const otherUserId = chat.other_user?.id;
  const chatId = directChatIdentity(chat);
  if (!otherUserId) {
    throw new Error(`groupme_direct_chat_missing_other_user: ${chatId}`);
  }

  for (;;) {
    const pageExtra: ProgressExtra = {
      stream: "direct_chat_messages",
      phase: "fetch",
      ...(beforeId ? { before_id: beforeId } : {}),
      total_seen: totalSeen,
    };
    await progressWithSignals("Fetching direct messages", pageExtra);

    const resp = await makeRequest<DirectMessagesResponse>(token, "/direct_messages", {
      other_user_id: otherUserId,
      limit: PAGE_SIZE,
      ...(beforeId ? { before_id: beforeId } : {}),
    });

    const messages = resp.direct_messages || [];
    if (!messages.length) {
      // Same self-contradiction check as the group backward walk. This walk
      // is always backward-to-natural-end (never a forward cursor resume),
      // so the response's `count` and its served page describe the same
      // whole history and a `count > 0` empty page is a real contradiction.
      return {
        totalSeen,
        newestMessageId: undefined,
        unprovenBoundary: pageContradictsItsOwnCount({ count: resp.count, messages }),
      };
    }

    // In-scope-only accounting, same as the group_messages backward walk: a
    // page spanning the boundary must not credit its out-of-scope tail as
    // part of what was "considered". No early-stop on `pageFullyOutOfScope`
    // here — see the function doc comment: this endpoint's ordering is
    // undocumented, so the walk always continues to the natural end.
    const { inScope } = applySinceBoundToPage(messages, sinceEpochSeconds);
    totalSeen += inScope.length;
    await progressWithSignals("Fetched direct messages page", {
      stream: "direct_chat_messages",
      phase: "page",
      item_count: inScope.length,
      total_seen: totalSeen,
    });

    for (const msg of inScope) {
      const record = await toDirectChatMessageRecord(msg, chatId, uploader, emitAttachmentRecord);
      if (cursor.shouldEmit(record)) {
        await emitRecord("direct_chat_messages", record);
      }
    }

    if (messages.length < PAGE_SIZE) {
      return { totalSeen, newestMessageId: undefined, unprovenBoundary: false };
    }

    const nextBeforeId = messages.at(-1)?.id;
    if (!nextBeforeId || usedCursors.has(nextBeforeId)) {
      throw new NonProgressError(chatId, "backward", beforeId ?? "(start)");
    }
    usedCursors.add(nextBeforeId);
    beforeId = nextBeforeId;
  }
}

export async function collectDirectChatMessages(
  token: string,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: AttachmentRecordEmitter | undefined,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>,
  sinceEpochSeconds: number | null = null,
  reportStreamFailure?: CollectContext["reportStreamFailure"]
): Promise<CollectionOutcome> {
  await progressWithSignals("Fetching GroupMe direct messages", {
    stream: "direct_chat_messages",
    phase: "start",
  });
  return await runCollectionPass(
    "direct_chat_messages",
    "direct messages",
    progressWithSignals,
    async () => {
      let considered = 0;
      const { items: chats } = await fetchPaginatedList<GroupMeDirectChat>(
        token,
        "/chats",
        "direct_chat_messages",
        progressWithSignals,
        directChatIdentity
      );
      for (const chat of chats) {
        const chatResult = await collectDirectChatMessagesForChat(
          token,
          chat,
          cursor,
          uploader,
          emitAttachmentRecord,
          progressWithSignals,
          emitRecord,
          sinceEpochSeconds
        );
        considered += chatResult.totalSeen;
      }
      return { considered };
    },
    reportStreamFailure
  );
}

/**
 * Result of `collectGroupMessages`: the ordinary `CollectionOutcome` plus the
 * next-run per-group cursor map. `nextCursors` is only meaningful when
 * `failed` is false — `collect()` must not persist it otherwise, same rule as
 * the fingerprint cursor's STATE emit (see `CollectionOutcome`'s doc comment).
 */
export interface GroupMessagesCollectionOutcome extends CollectionOutcome {
  nextCursors: GroupMessageCursors;
  /** Per-group provider-count reconciliation for this run. */
  shortfalls: GroupMessageShortfall[];
  /** Groups whose walk could not be anchored because the provider reported no count. */
  unanchoredGroupIds: string[];
}

/** One group where the provider reported MORE messages than the walk saw. */
export interface GroupMessageShortfall {
  groupId: string;
  providerCount: number;
  /**
   * True when the walk that produced this shortfall ended on a page that
   * contradicted its own count (see `pageContradictsItsOwnCount`) — so the
   * shortfall is UNEXPLAINED: the connector cannot tell whether the provider
   * has nothing to serve or declined to serve what it counts.
   *
   * Optional so existing constructions (and fixtures) stay valid; absent is
   * read as `false`.
   */
  unprovenBoundary?: boolean;
  walked: number;
}

/**
 * Split a run's shortfalls into the situations they conflate, so each can be
 * reported with its own reason and recovery hint.
 *
 * `unexplained` — the walk ended on a page that CONTRADICTED ITS OWN COUNT:
 * GroupMe served `messages: []` while stating `count > 0` in the same body.
 * That response is ambiguous BY CONSTRUCTION. Measured live, it is
 * byte-identical (headers included, `content-length` aside) whether the
 * provider has nothing to serve or is declining to serve content it still
 * counts, and GroupMe emits no status code, `Retry-After`, or rate-limit
 * header to separate them. The connector therefore does NOT claim to know
 * which it is, and does not claim the group was proven walked.
 *
 * A PRIOR REVISION of this function classified exactly this shape as
 * definitively `not_retriable`, keyed on `walked === 0`. That was
 * unsound: `walked === 0` IS the ambiguous signal, so keying the
 * "unrecoverable" verdict on it means the connector asserts unrecoverability
 * on the strength of a response that cannot support the claim. Being
 * throttled produces the identical shape. Whatever the true cause on any
 * given group, a connector must not convert an ambiguous observation into a
 * certain verdict.
 *
 * `partial` — the walk returned SOME messages but fewer than claimed, and
 * ended on a page the provider actually served. The shortfall is real and the
 * boundary evidence is coherent, so retrying is a meaningful suggestion.
 *
 * This is a classification split ONLY. NEITHER bucket is subtracted from the
 * missing total, and neither is counted as covered: an unserved message is
 * still an absent message, and saying so honestly is the whole point of the
 * anchor.
 */
export function partitionGroupMessageShortfalls(shortfalls: readonly GroupMessageShortfall[]): {
  partial: GroupMessageShortfall[];
  unexplained: GroupMessageShortfall[];
} {
  const partial: GroupMessageShortfall[] = [];
  const unexplained: GroupMessageShortfall[] = [];
  for (const s of shortfalls) {
    if (s.unprovenBoundary === true) {
      unexplained.push(s);
    } else {
      partial.push(s);
    }
  }
  return { partial, unexplained };
}

/**
 * Compare one group's provider-reported message count against what this
 * run's walk actually enumerated.
 *
 * ONE-DIRECTIONAL ON PURPOSE. Only `providerCount > walked` is reported.
 * The reverse — we walked more than the provider now claims — is NOT a
 * defect: PDPP is a preservation product, so messages deleted from GroupMe
 * after we collected them legitimately make our holdings larger than the
 * provider's current count. Reporting that as a gap would flag successful
 * preservation as loss.
 *
 * Returns `null` when the provider reported no usable count: unknown is
 * not zero, and an absent count must never become a denominator.
 *
 * CEILING: this is a scalar, so it cannot distinguish "we are missing N
 * distinct messages" from "we collected N duplicates". GroupMe exposes no
 * cheap per-group message-id listing to make this a set comparison, so the
 * anchor detects magnitude only — see the connector README note.
 */
export function groupMessageShortfall(
  group: GroupMeGroup,
  walked: number,
  unprovenBoundary = false
): { kind: "ok" } | { kind: "short"; shortfall: GroupMessageShortfall } | { kind: "unanchored" } {
  const providerCount = providerMessageCount(group);
  if (providerCount === null) {
    return { kind: "unanchored" };
  }
  if (providerCount > walked) {
    return { kind: "short", shortfall: { groupId: group.id, providerCount, unprovenBoundary, walked } };
  }
  return { kind: "ok" };
}

/**
 * `body`'s per-group loop: choose forward-resume (a prior cursor exists and
 * this isn't a full_refresh run) or backward-to-natural-end (cold start, or
 * an explicit full_refresh bypass), run it, and fold the result into the
 * accumulators. Extracted as its own function purely to keep
 * `collectGroupMessages`'s cognitive complexity within the lint ceiling.
 */
async function collectOneGroupMessages(
  token: string,
  group: GroupMeGroup,
  priorCursor: string | undefined,
  bypassCursor: boolean,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: AttachmentRecordEmitter | undefined,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>,
  sinceEpochSeconds: number | null
): Promise<PerConversationWalkResult> {
  if (priorCursor !== undefined && !bypassCursor) {
    try {
      return await collectGroupMessagesForwardFromCursor(
        token,
        group,
        priorCursor,
        cursor,
        uploader,
        emitAttachmentRecord,
        progressWithSignals,
        emitRecord
      );
    } catch (error) {
      if (!(error instanceof InvalidResumeCursorError)) {
        throw error;
      }
      await progressWithSignals(error.message, { stream: "group_messages", phase: "cursor_reset" });
      // Falls through to the same backward-to-natural-end walk a cold start
      // uses — bounded to exactly one fallback attempt for this group, no
      // retry loop. If this ALSO fails, it propagates normally and the
      // whole pass fails, same as any other walk error.
    }
  }
  return await collectGroupMessagesBackwardToNaturalEnd(
    token,
    group,
    cursor,
    uploader,
    emitAttachmentRecord,
    progressWithSignals,
    emitRecord,
    sinceEpochSeconds
  );
}

/** Cap on ids/entries listed in an anchor diagnostic; counts are always exact. */
const MAX_ANCHOR_IDS_IN_DIAGNOSTIC = 50;

/**
 * Emit the provider-count reconciliation for `group_messages`.
 *
 * Two distinct findings, deliberately not merged:
 *
 *  - `provider_reports_more_messages_than_walked` — a PARTIAL walk. GroupMe
 *    says a group holds more messages than the full walk enumerated, and the
 *    walk did return some. Retrying can plausibly close this.
 *  - `provider_served_empty_page_against_its_own_count` — the provider
 *    served an empty page while the SAME response body still counted
 *    messages. That shape is ambiguous by construction (it is what both
 *    "nothing to serve" and "declining to serve" look like on this API), so
 *    it is reported as an unexplained gap, not as a proven-unrecoverable
 *    one, and stays retryable.
 *  - `group_message_count_unanchored` — the provider reported no usable
 *    count for these groups, so their walk has NO external anchor at all.
 *    Saying so is the honest alternative to silently treating an unanchored
 *    group as proven.
 *
 * The two shortfall buckets are a CLASSIFICATION split, never a subtraction:
 * an unexplained group's messages stay in its own missing total and are
 * never counted as covered. Splitting them tells the owner which part of the
 * gap has coherent evidence behind it, without quietly shrinking the gap.
 *
 * Nothing is emitted for a group where holdings EXCEED the provider count:
 * that is preservation of messages GroupMe has since deleted, not loss.
 */
async function emitGroupMessageAnchorEvidence(
  emit: CollectContext["emit"],
  outcome: GroupMessagesCollectionOutcome
): Promise<void> {
  const { partial, unexplained } = partitionGroupMessageShortfalls(outcome.shortfalls);
  if (partial.length > 0) {
    const missingTotal = partial.reduce((sum, s) => sum + (s.providerCount - s.walked), 0);
    const visible = partial.slice(0, MAX_ANCHOR_IDS_IN_DIAGNOSTIC);
    await emit({
      type: "SKIP_RESULT",
      stream: "group_messages",
      reason: "provider_reports_more_messages_than_walked",
      message:
        `GroupMe reports more messages than this run walked in ${String(partial.length)} group(s): ` +
        `${String(missingTotal)} message(s) unaccounted for. Their history may be incomplete.`,
      diagnostics: {
        short_group_count: partial.length,
        missing_message_total: missingTotal,
        groups: visible.map((s) => ({ group_id: s.groupId, provider_count: s.providerCount, walked: s.walked })),
        truncated: visible.length < partial.length,
      },
      recovery_hint: { action: "retry_by_runtime", retryable: true },
    });
  }
  if (unexplained.length > 0) {
    const unexplainedTotal = unexplained.reduce((sum, s) => sum + (s.providerCount - s.walked), 0);
    const visible = unexplained.slice(0, MAX_ANCHOR_IDS_IN_DIAGNOSTIC);
    await emit({
      type: "SKIP_RESULT",
      stream: "group_messages",
      reason: "provider_served_empty_page_against_its_own_count",
      message:
        "GroupMe served an empty page while its own response still counted messages, in " +
        `${String(unexplained.length)} group(s): ${String(unexplainedTotal)} message(s) are counted by the provider ` +
        "but were not served. GroupMe returns the same empty response whether it has nothing to send or is " +
        "declining to send it, so this run cannot tell those apart and does not claim these group(s) were fully " +
        "read.",
      diagnostics: {
        unexplained_group_count: unexplained.length,
        unexplained_message_total: unexplainedTotal,
        groups: visible.map((s) => ({ group_id: s.groupId, provider_count: s.providerCount, walked: s.walked })),
        truncated: visible.length < unexplained.length,
      },
      // Retryable, and deliberately so. The connector cannot prove these are
      // unrecoverable — an empty page against a non-zero count is exactly what
      // throttling also produces — so the honest hint is the one that leaves
      // the door open. Claiming `not_retriable` here would assert a certainty
      // the evidence does not support.
      recovery_hint: { action: "retry_by_runtime", retryable: true },
    });
  }
  if (outcome.unanchoredGroupIds.length > 0) {
    const visible = outcome.unanchoredGroupIds.slice(0, MAX_ANCHOR_IDS_IN_DIAGNOSTIC);
    await emit({
      type: "SKIP_RESULT",
      stream: "group_messages",
      reason: "group_message_count_unanchored",
      message:
        `GroupMe reported no per-group message count for ${String(outcome.unanchoredGroupIds.length)} group(s), so their ` +
        "walk has no external completeness anchor. Coverage for these groups is unproven, not proven complete.",
      diagnostics: {
        unanchored_group_count: outcome.unanchoredGroupIds.length,
        unanchored_group_ids: visible,
        truncated: visible.length < outcome.unanchoredGroupIds.length,
      },
      recovery_hint: { action: "retry_by_runtime", retryable: true },
    });
  }
}

export async function collectGroupMessages(
  token: string,
  cursor: ReturnType<typeof openFingerprintCursor>,
  uploader: BlobUploader | undefined,
  emitAttachmentRecord: AttachmentRecordEmitter | undefined,
  progressWithSignals: ProgressFn,
  emitRecord: (stream: string, data: RecordData) => Promise<void>,
  sinceEpochSeconds: number | null = null,
  priorCursors: GroupMessageCursors = {},
  collectionMode: "full_refresh" | "incremental" = "incremental",
  reportStreamFailure?: CollectContext["reportStreamFailure"]
): Promise<GroupMessagesCollectionOutcome> {
  await progressWithSignals("Fetching GroupMe group messages", { stream: "group_messages", phase: "start" });
  // Seeded from the prior cursors so a group absent from THIS run's listing
  // (deleted, or the account left it) still carries its last-known cursor
  // forward — mirrors the fingerprint cursor's carry-forward-by-default
  // policy, and is safe because collect() only persists this map when the
  // overall pass is clean (a group truly gone would simply never be walked
  // again; its stale cursor is inert, not harmful).
  const nextCursors: GroupMessageCursors = { ...priorCursors };
  // full_refresh is an explicit owner/operator bypass (START.collection_mode
  // — see CollectContext.collectionMode's doc comment): every group walks
  // BACKWARD to its natural end this run regardless of any persisted
  // cursor. The cursor MAP is still rebuilt from what this full walk
  // observes, so the next ordinary run resumes forward-incrementally again.
  const bypassCursor = collectionMode === "full_refresh";
  const shortfalls: GroupMessageShortfall[] = [];
  const unanchoredGroupIds: string[] = [];
  const outcome = await runCollectionPass(
    "group_messages",
    "group messages",
    progressWithSignals,
    async () => {
      let considered = 0;
      const { items: groups } = await fetchPaginatedList<GroupMeGroup>(
        token,
        "/groups",
        "group_messages",
        progressWithSignals
      );
      for (const group of groups) {
        const priorCursor = priorCursors[group.id];
        const walkedWholeGroup = priorCursor === undefined || bypassCursor;
        const groupResult = await collectOneGroupMessages(
          token,
          group,
          priorCursor,
          bypassCursor,
          cursor,
          uploader,
          emitAttachmentRecord,
          progressWithSignals,
          emitRecord,
          sinceEpochSeconds
        );
        considered += groupResult.totalSeen;
        // The provider count describes the group's WHOLE history, so it can
        // only be compared against a walk that covered the whole history: a
        // cold start or an explicit full_refresh. An incremental forward
        // resume deliberately sees only new messages, and comparing a total
        // against that window would report a false shortfall on every
        // healthy incremental run. A `since`-scoped walk is excluded for the
        // same reason.
        if (walkedWholeGroup && sinceEpochSeconds === null) {
          const verdict = groupMessageShortfall(group, groupResult.totalSeen, groupResult.unprovenBoundary);
          if (verdict.kind === "short") {
            shortfalls.push(verdict.shortfall);
          } else if (verdict.kind === "unanchored") {
            unanchoredGroupIds.push(group.id);
          }
        }
        if (groupResult.newestMessageId !== undefined) {
          nextCursors[group.id] = groupResult.newestMessageId;
        }
      }
      return { considered };
    },
    reportStreamFailure
  );
  return {
    ...outcome,
    nextCursors: outcome.failed ? {} : nextCursors,
    // A failed pass proves nothing about completeness — withhold both
    // findings exactly as the cursor map is withheld.
    shortfalls: outcome.failed ? [] : shortfalls,
    unanchoredGroupIds: outcome.failed ? [] : unanchoredGroupIds,
  };
}

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
export async function collect(
  { state, requested, credentials, emit, emitRecord, progress, reportStreamFailure, collectionMode }: CollectContext,
  testDependencies: { uploader?: BlobUploader } = {}
): Promise<void> {
  const progressWithSignals = progress as ProgressFn;
  const token = credentials.GROUPME_ACCESS_TOKEN;
  if (!token) {
    throw new Error("groupme_auth_failed");
  }
  // Absent collectionMode (a test harness or caller that predates the field)
  // must behave exactly as an ordinary incremental run — see
  // BaseCollectContext.collectionMode's doc comment.
  const effectiveCollectionMode = collectionMode === "full_refresh" ? "full_refresh" : "incremental";

  const uploader = "uploader" in testDependencies ? testDependencies.uploader : makeUploader();

  const groupCursor = openFingerprintCursor(state.groups);
  const groupMessageCursor = openFingerprintCursor(state.group_messages);
  const directChatCursor = openFingerprintCursor(state.direct_messages);
  const directChatMessageCursor = openFingerprintCursor(state.direct_chat_messages);
  const attachmentCursor = openFingerprintCursor(state.attachments);

  const attachmentsRequested = requested.has("attachments");
  const attachmentCoverageByParent: Record<AttachmentParentStream, AttachmentDetailCoverage> = {
    direct_chat_messages: makeAttachmentDetailCoverage(),
    group_messages: makeAttachmentDetailCoverage(),
  };
  const emitAttachmentRecord = attachmentsRequested
    ? createAttachmentRecordEmitter({
        attachmentCursor,
        coverageByParent: attachmentCoverageByParent,
        emitRecord,
      })
    : undefined;

  let groupsOutcome: CollectionOutcome | undefined;
  if (requested.has("groups")) {
    groupsOutcome = await collectGroups(token, groupCursor, progressWithSignals, emitRecord, reportStreamFailure);
  }
  let groupMessagesOutcome: GroupMessagesCollectionOutcome | undefined;
  if (requested.has("group_messages")) {
    groupMessagesOutcome = await collectGroupMessages(
      token,
      groupMessageCursor,
      uploader,
      emitAttachmentRecord,
      progressWithSignals,
      emitRecord,
      parseSinceEpochSeconds(requested, "group_messages"),
      decodeGroupMessageCursors(state.group_messages),
      effectiveCollectionMode,
      reportStreamFailure
    );
    await emitGroupMessageAnchorEvidence(emit, groupMessagesOutcome);
  }
  let directChatsOutcome: CollectionOutcome | undefined;
  if (requested.has("direct_messages")) {
    directChatsOutcome = await collectDirectChats(
      token,
      directChatCursor,
      progressWithSignals,
      emitRecord,
      reportStreamFailure
    );
  }
  let directChatMessagesOutcome: CollectionOutcome | undefined;
  if (requested.has("direct_chat_messages")) {
    directChatMessagesOutcome = await collectDirectChatMessages(
      token,
      directChatMessageCursor,
      uploader,
      emitAttachmentRecord,
      progressWithSignals,
      emitRecord,
      parseSinceEpochSeconds(requested, "direct_chat_messages"),
      reportStreamFailure
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
      cursor: { fingerprints: groupMessageCursor.toState(), cursors: groupMessagesOutcome.nextCursors },
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
    const parentOutcomes = {
      direct_chat_messages: directChatMessagesOutcome,
      group_messages: groupMessagesOutcome,
    };
    const anyParentCompleted = Object.entries(parentOutcomes).some(([parent, outcome]) =>
      attachmentParentCompleted(requested, parent as AttachmentParentStream, outcome)
    );
    if (anyParentCompleted) {
      await emit({
        type: "STATE",
        stream: "attachments",
        cursor: { fingerprints: attachmentCursor.toState() },
      });
      await emitAttachmentCoverageByParent(requested, attachmentCoverageByParent, parentOutcomes, emit);
    }
    // A failed parent already emitted its own stream_collection_failed result
    // in runCollectionPass. Do not also fail the shared attachments stream:
    // that would implicate the successful parent's independently proven cursor.
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

/**
 * DESIGN NOTE (scope closed vs. not): this fix closes exact FORWARD
 * incrementality for group_messages (no more repeated full-history
 * rescans). It does NOT close automatic repair of an old message's mutable
 * field (favorited_by/like_count) once that message has fallen behind the
 * resume cursor — hence `mutable_state` in the manifest, not
 * `immutable_log`. That repair currently requires an explicit
 * `collection_mode: "full_refresh"`; no periodic/automatic trigger for it
 * exists anywhere in this system today (verified against RI's START-build
 * path, not assumed). The generic, connector-agnostic primitive this
 * system would need to close that gap — a manifest-declared per-stream
 * repair cadence the SCHEDULER (not this connector) interprets — is
 * specified in docs/reference/periodic-full-refresh-repair.md, not
 * implemented here.
 */
