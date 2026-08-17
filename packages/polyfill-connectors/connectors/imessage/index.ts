#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP iMessage Connector (v0.1.0)
 *
 * Reads ~/Library/Messages/chat.db (macOS only by default). SQLite is
 * read-only opened via `node:sqlite`'s `DatabaseSync` (unflagged since
 * Node 22.13, and this repo's minimum supported engine) — deliberately not
 * `better-sqlite3`, a native compiled dependency: this connector must ship in
 * the published `@pdpp/local-collector` npx bundle (see
 * `packages/local-collector/scripts/validate-package.ts`'s forbidden-pattern
 * list), and a native module can't. User may override with IMESSAGE_DB_PATH
 * env var (useful for copying chat.db off a machine and running the
 * connector on Linux).
 *
 * Incremental via message.date (Apple epoch: seconds/nanos since 2001-01-01)
 * for `messages`. `participants` and `attachments` are full resnapshots each
 * run (mutable_state) — every run re-emits the full current set, with no
 * incremental cursor gating either query. Whether that resnapshot is
 * actually cheap depends on the size of the local chat.db; this connector
 * makes no performance claim about it, only a correctness one (see
 * manifests/imessage.json's incremental:false on both streams).
 *
 * Attachment bytes are only ever read from inside a trusted root directory
 * (default ~/Library/Messages/Attachments, override via
 * IMESSAGE_ATTACHMENTS_ROOT — same override pattern as IMESSAGE_DB_PATH).
 * Every candidate path is canonicalized and verified to resolve inside that
 * root before any read; `../` traversal, an absolute path outside the root,
 * and a symlink that escapes the root are all rejected the same way a
 * missing file is: hydration_status="missing", no local path in the
 * diagnostic. This connector never reads attachment bytes from outside that
 * root, no matter what chat.db's attachment.filename column claims.
 *
 * That canonicalize-then-verify check and the eventual read are two
 * separate syscalls with a window between them (check-then-use / TOCTOU):
 * something with local write access to the Attachments tree could in
 * principle swap the final path component for an escaping symlink after
 * the check passes but before the read happens. readAttachmentFileSync()
 * closes that window by opening the already-canonical path with
 * O_NOFOLLOW and doing every subsequent operation (fstat, byte-cap check,
 * read) through that single fd — the kernel resolves the name to an inode
 * exactly once, and a symlink swapped in after the check causes the open
 * itself to fail rather than being silently followed. macOS (this
 * connector's only supported platform) provides O_NOFOLLOW unconditionally.
 * readAttachmentFileSync is exported (alongside resolveMaxAttachmentBytes
 * and resolveAttachmentsRoot, the existing pattern for this module's
 * independently-testable internals) specifically so a test can call this
 * exact primitive directly against a final-component symlink and assert
 * O_NOFOLLOW is what rejects it — no env-var backdoor that mutates a real
 * user's filesystem, no timing race, no source-text inspection.
 *
 * `chat.db`'s schema (message/handle/chat/chat_message_join/
 * chat_handle_join/attachment/message_attachment_join tables) is entirely
 * reverse-engineered by the open-source forensics/backup community — Apple
 * publishes no documentation of it anywhere. This connector must never claim
 * Apple-official support for that schema, and never infer deletion support:
 * chat.db exposes no reliable tombstone/deletion signal.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, constants as fsConstants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type EmittedMessage, type RecordData, runConnector } from "../../src/connector-runtime.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import {
  makeReferenceBlobUploader,
  type ReferenceBlobRef,
  runtimeBlobUploadAvailable,
} from "../../src/reference-blob-uploader.ts";
import { validateRecord } from "./schemas.ts";

interface MessageRow {
  cache_has_attachments: number | null;
  chat_id: number | null;
  date: number | null;
  date_read: number | null;
  guid: string | null;
  handle: string | null;
  id: number;
  is_from_me: number;
  service: string | null;
  text: string | null;
}

interface ParticipantRow {
  chat_id: number;
  handle: string | null;
  is_from_me: number;
}

interface AttachmentRow {
  chat_id: number | null;
  filename: string | null;
  message_guid: string | null;
  message_id: number;
  message_rowid: number;
  mime_type: string | null;
  rowid: number;
  total_bytes: number | null;
}

// Apple cocoa epoch offset: seconds from 1970 to 2001-01-01 UTC.
const APPLE_EPOCH_SEC = 978_307_200;
const APPLE_NANOS_THRESHOLD = 1e10;
const APPLE_NANOS_DIVISOR = 1e9;
const MS_PER_SEC = 1000;
// Messages are a lightweight row scan (no I/O beyond the SQLite read), so a
// wide interval keeps PROGRESS noise low on large histories. Attachments
// each do a stat + read + network blob upload — much more expensive per
// item — so a narrower interval keeps progress visible during a slow batch.
const PROGRESS_INTERVAL_ROWS = 10_000;
const ATTACHMENT_PROGRESS_INTERVAL = 25;

// Conservative default cap for local attachment reads, matching Gmail's
// documented-default pattern (25 MiB). Operators can raise/lower with
// PDPP_IMESSAGE_MAX_ATTACHMENT_BYTES; non-positive/non-numeric overrides are
// ignored so a misconfigured env var can never silently disable the cap.
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES_ENV = "PDPP_IMESSAGE_MAX_ATTACHMENT_BYTES";
const POSITIVE_INTEGER_PATTERN = /^\d+$/;

export function resolveMaxAttachmentBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_ATTACHMENT_BYTES_ENV];
  if (!(raw && POSITIVE_INTEGER_PATTERN.test(raw))) {
    return DEFAULT_MAX_ATTACHMENT_BYTES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_ATTACHMENT_BYTES;
  }
  return parsed;
}

// Attachment bytes are only ever read from inside this root. Default matches
// the well-known macOS Messages Attachments directory; operators can
// override with IMESSAGE_ATTACHMENTS_ROOT for the same reason
// IMESSAGE_DB_PATH is overridable — copying chat.db (and its Attachments
// tree) off the originating machine, or pointing the connector at a fixture
// root in tests. This is deliberately an env var, matching the existing
// IMESSAGE_DB_PATH/WHATSAPP_EXPORT_DIR pattern, not a new configuration
// mechanism.
const ATTACHMENTS_ROOT_ENV = "IMESSAGE_ATTACHMENTS_ROOT";

export function resolveAttachmentsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env[ATTACHMENTS_ROOT_ENV] || join(homedir(), "Library/Messages/Attachments");
}

interface SafeAttachmentPathResult {
  ok: boolean;
  path: string | null;
}

// Resolves `rawPath` (chat.db's raw attachment.filename column, `~`-prefixed
// or absolute) against `root` and verifies the result is genuinely inside
// `root` before returning it — the one and only gate attachment bytes pass
// through before being read.
//
// realpathSync() is the load-bearing call: it fully resolves `..` segments
// AND symlinks (both the path's own components and the root's), so a
// candidate that traverses out via `../../etc/passwd`, an absolute path
// recorded outside the root, or a symlink placed inside the root that
// points outside it, all collapse to the same real filesystem location —
// and that location is then string-prefix-checked against the root's own
// real location. A path that doesn't exist (ENOENT) or can't be resolved
// (permissions, a symlink cycle) fails closed with ok:false, same as a
// path that resolves outside the root; no exception ever propagates past
// this function, and the raw/resolved path is never included in the
// result — callers must not log `rawPath` on an ok:false result.
function resolveSafeAttachmentPath(rawPath: string, root: string): SafeAttachmentPathResult {
  const expanded = rawPath.startsWith("~") ? join(homedir(), rawPath.slice(1)) : rawPath;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    // The trusted root itself doesn't exist or isn't reachable — every
    // attachment fails closed, since there is nothing safe to compare
    // against.
    return { ok: false, path: null };
  }
  let realCandidate: string;
  try {
    realCandidate = realpathSync(expanded);
  } catch {
    return { ok: false, path: null };
  }
  const withinRoot = realCandidate === realRoot || realCandidate.startsWith(realRoot + sep);
  if (!withinRoot) {
    return { ok: false, path: null };
  }
  return { ok: true, path: realCandidate };
}

function appleDateToIso(raw: number | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  // Newer macOS: nanoseconds; older: seconds. Heuristic: > 1e10 → nanos.
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return null;
  }
  const sec = n > APPLE_NANOS_THRESHOLD ? n / APPLE_NANOS_DIVISOR : n;
  return new Date((APPLE_EPOCH_SEC + sec) * MS_PER_SEC).toISOString();
}

// Returns true when `table` exists in the opened database. chat.db's schema
// has drifted across macOS releases (e.g. chat_handle_join predates some
// early schema versions; attachment column names have shifted). Streams
// built on an absent table degrade to SKIP_RESULT rather than crashing the
// whole run — the `messages` stream must keep working even if group-chat or
// attachment tables are missing/renamed on a given macOS version.
function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row !== undefined;
}

// Returns a lazy row iterator instead of materializing the whole result set.
// `.iterate(since)` streams one row at a time so process memory is bounded by a
// single row plus emitted-record bounds, never by the size of `chat.db`. The
// SQL/query error surfaces on the first `.next()` (statement preparation is
// eager but row stepping is lazy); the caller wraps stepping to preserve the
// `imessage_db_query_failed` failure contract.
//
// `OR m.date IS NULL` is deliberate: SQLite's `NULL > ?` is NULL (falsy), so
// a plain `WHERE m.date > ?` silently excludes null-date rows from every
// run — the caller would never even see them to report a diagnostic. Making
// them visible here lets emitMessageRows() surface a SKIP_RESULT instead of
// the row vanishing from the connector's output with no trace. The
// tradeoff: a null-date row is re-selected (and re-skipped) on every run,
// since there's no date value to gate it out of a future `since` window —
// that's still strictly better than never surfacing it at all.
function queryMessageRows(db: DatabaseSync, since: number): IterableIterator<MessageRow> {
  return db
    .prepare(
      `
        SELECT m.ROWID as id, m.guid, m.handle_id, m.service, m.is_from_me,
               m.text, m.date, m.date_read, m.cache_has_attachments,
               h.id as handle,
               cmj.chat_id as chat_id
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        WHERE m.date > ? OR m.date IS NULL
        ORDER BY m.date ASC
      `
    )
    .iterate(since) as IterableIterator<MessageRow>;
}

// One row per (chat, handle) membership pair — NOT one row per message, so
// group-chat participants don't duplicate the messages stream. `is_from_me`
// reflects whether the joined handle is ever the message sender in that chat
// (best-effort local-account marker; the owner's own handle is often absent
// from chat_handle_join entirely, which callers must treat as "the owner is
// an implicit participant", not as "this chat has one fewer member").
function queryParticipantRows(db: DatabaseSync): IterableIterator<ParticipantRow> {
  return db
    .prepare(
      `
        SELECT chj.chat_id as chat_id, h.id as handle,
               EXISTS(
                 SELECT 1 FROM message m
                 JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                 WHERE cmj.chat_id = chj.chat_id AND m.handle_id = chj.handle_id AND m.is_from_me = 1
               ) as is_from_me
        FROM chat_handle_join chj
        JOIN handle h ON h.ROWID = chj.handle_id
        ORDER BY chj.chat_id ASC, h.id ASC
      `
    )
    .iterate() as IterableIterator<ParticipantRow>;
}

// One row per attachment, joined to its owning message + chat via
// message_attachment_join and chat_message_join. `filename` is chat.db's
// raw local filesystem path (e.g. `~/Library/Messages/Attachments/.../IMG.jpg`)
// — never exposed to emitted records or diagnostics; only its basename and a
// hash of the full path travel downstream.
function queryAttachmentRows(db: DatabaseSync, hasChatJoin: boolean): IterableIterator<AttachmentRow> {
  const chatIdSelect = hasChatJoin ? "cmj.chat_id as chat_id" : "NULL as chat_id";
  const chatJoin = hasChatJoin ? "LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID" : "";
  return db
    .prepare(
      `
        SELECT a.ROWID as rowid, a.filename, a.mime_type, a.total_bytes,
               maj.message_id as message_rowid, m.ROWID as message_id, m.guid as message_guid,
               ${chatIdSelect}
        FROM attachment a
        JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
        JOIN message m ON m.ROWID = maj.message_id
        ${chatJoin}
        ORDER BY a.ROWID ASC
      `
    )
    .iterate() as IterableIterator<AttachmentRow>;
}

async function emitMessageRows({
  emit,
  emitRecord,
  progress,
  rows,
  since,
}: {
  emit: (msg: EmittedMessage) => Promise<void>;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  progress: (message: string, extra?: Record<string, unknown>) => Promise<void>;
  rows: Iterable<MessageRow>;
  since: number;
}): Promise<number> {
  let latestApple = since;
  let itemOrdinal = 0;
  let skippedNullDate = 0;
  for (const r of rows) {
    itemOrdinal += 1;
    const isoDate = appleDateToIso(r.date);
    if (isoDate === null) {
      // A message row with an unusable date (NULL, zero, or a non-finite
      // value) has no honest cursor position. Substituting the run's wall
      // clock (new Date()) would be non-deterministic: the same row would
      // get a different `date` on every run, and since the cursor only
      // advances from `r.date` (never from the fallback), the row would
      // also never age out of future `since` windows. Skip it with a
      // diagnostic instead of fabricating a timestamp.
      skippedNullDate += 1;
      continue;
    }
    await emitRecord("messages", {
      id: r.guid || String(r.id),
      chat_id: r.chat_id ? String(r.chat_id) : null,
      handle: r.handle ?? null,
      service: r.service ?? null,
      is_from_me: Boolean(r.is_from_me),
      text: r.text ?? null,
      date: isoDate,
      date_read: appleDateToIso(r.date_read),
      has_attachments: Boolean(r.cache_has_attachments),
    });
    if (r.date && Number(r.date) > latestApple) {
      latestApple = Number(r.date);
    }
    if (itemOrdinal % PROGRESS_INTERVAL_ROWS === 0) {
      await progress(`iMessage phase=emit pass=emit stream=messages item=${itemOrdinal}`, {
        stream: "messages",
      });
    }
  }
  if (skippedNullDate > 0) {
    await emit({
      type: "SKIP_RESULT",
      stream: "messages",
      reason: "message_date_unusable",
      message: `Skipped ${skippedNullDate} message(s) with a missing or unusable date; they cannot be placed on the date cursor without fabricating a timestamp.`,
    });
  }
  return latestApple;
}

async function emitParticipantRows({
  db,
  emitRecord,
}: {
  db: DatabaseSync;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
}): Promise<number> {
  if (!tableExists(db, "chat_handle_join")) {
    return 0;
  }
  const rows = queryParticipantRows(db);
  let emitted = 0;
  for (const r of rows) {
    await emitRecord("participants", {
      id: `${r.chat_id}:${r.handle ?? "unknown"}`,
      chat_id: String(r.chat_id),
      handle: r.handle ?? null,
      is_from_me: Boolean(r.is_from_me),
    });
    emitted += 1;
  }
  return emitted;
}

// Keyed by `attachment.ROWID` alone (not message/chat context): the `id`
// intentionally identifies the underlying attachment row, which is the
// unit chat.db actually deduplicates on disk. If the same attachment row is
// joined to more than one message (e.g. a forwarded image), every join
// re-emits the same `id` — by design, since primary_key: ["id"] makes that
// an idempotent re-assertion of the same attachment, not a duplicate.
function attachmentRecordId(filename: string, rowid: number): string {
  return createHash("sha256").update(`${filename}:${rowid}`).digest("hex");
}

function uploadAttachmentBlob(args: {
  bytes: Buffer;
  mimeType: string;
  recordKey: string;
}): Promise<ReferenceBlobRef | null> {
  const rsUrl = process.env.PDPP_RS_URL || process.env.RS_URL;
  const ownerToken = process.env.PDPP_OWNER_TOKEN;
  if (!(runtimeBlobUploadAvailable(process.env) && rsUrl && ownerToken)) {
    return Promise.resolve(null);
  }
  const uploader = makeReferenceBlobUploader({
    connectorInstanceId: process.env.PDPP_CONNECTOR_INSTANCE_ID || null,
    ownerToken,
    rsUrl,
  });
  return uploader({
    connectorId: "https://registry.pdpp.dev/connectors/imessage",
    content: [args.bytes],
    mimeType: args.mimeType,
    recordKey: args.recordKey,
    stream: "attachments",
  });
}

export interface AttachmentHydrationResult {
  blobRef: ReferenceBlobRef | null;
  bytes: Buffer | null;
  contentSha256: string | null;
  hydrationError: string | null;
  hydrationStatus: "deferred" | "hydrated" | "failed" | "too_large" | "missing";
  sizeBytes: number | null;
}

// O_NOFOLLOW makes `openSync` fail with the same class of error (ENOENT for
// a genuinely missing file, ELOOP if the final component turned out to be
// a symlink) — both map to the same hydration_status="missing" outcome, so
// there is no need or benefit to distinguishing them in the diagnostic; the
// message is deliberately generic in both directions of that ambiguity.
function missingAttachmentResult(): AttachmentHydrationResult {
  return {
    blobRef: null,
    bytes: null,
    contentSha256: null,
    hydrationError: "attachment file is missing, unreadable, or was replaced with a symlink.",
    hydrationStatus: "missing",
    sizeBytes: null,
  };
}

// Bounded local read with the check-then-read (TOCTOU) window closed: the
// caller (resolveAttachmentHydration) has already canonicalized `localPath`
// via realpathSync and verified it resolves inside the trusted root — but
// between that check and any subsequent open, an attacker with local write
// access to the Attachments tree could swap the final path component for a
// symlink pointing outside the root (classic check-then-use race). Opening
// with O_NOFOLLOW closes that window for the final component: if it has
// become a symlink by the time this call runs, the open itself fails
// (ELOOP) instead of silently following it. Every subsequent operation
// (fstat, byte-cap check, read) happens through the SAME fd, so there is no
// second path-based lookup left to race — the kernel resolved the name to
// an inode exactly once. macOS (this connector's only supported platform)
// supports O_NOFOLLOW; this primitive is not conditionally guarded.
export function readAttachmentFileSync(localPath: string, maxBytes: number): AttachmentHydrationResult {
  let fd: number;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: composing POSIX open() flags requires a bitmask OR, not logical OR.
    fd = openSync(localPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return missingAttachmentResult();
  }
  try {
    let size: number;
    try {
      ({ size } = fstatSync(fd));
    } catch (err) {
      return {
        blobRef: null,
        bytes: null,
        contentSha256: null,
        hydrationError: err instanceof Error ? err.message : "Failed to stat attachment file.",
        hydrationStatus: "failed",
        sizeBytes: null,
      };
    }
    if (size > maxBytes) {
      return {
        blobRef: null,
        bytes: null,
        contentSha256: null,
        hydrationError: `attachment exceeds max size: ${size} > ${maxBytes} bytes`,
        hydrationStatus: "too_large",
        sizeBytes: size,
      };
    }
    const buffer = Buffer.alloc(size);
    let offset = 0;
    try {
      while (offset < size) {
        const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
        if (bytesRead === 0) {
          // The file shrank mid-read (concurrent truncation) — stop rather
          // than spin; the truncated buffer below is sliced to what was
          // actually read, never padded with stale zero bytes claimed as
          // real content.
          break;
        }
        offset += bytesRead;
      }
    } catch (err) {
      return {
        blobRef: null,
        bytes: null,
        contentSha256: null,
        hydrationError: err instanceof Error ? err.message : "Failed to read attachment file.",
        hydrationStatus: "failed",
        sizeBytes: size,
      };
    }
    const bytes = offset === size ? buffer : buffer.subarray(0, offset);
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      blobRef: null,
      bytes,
      contentSha256,
      hydrationError: null,
      hydrationStatus: "deferred",
      sizeBytes: bytes.byteLength,
    };
  } finally {
    // Reliable close: runs whether the try block returned normally or an
    // exception propagated past one of the inner try/catch blocks above
    // (none currently do, but this guarantees the fd is never leaked if
    // that changes). A close failure is not itself a hydration failure —
    // the read already succeeded or failed on its own terms — so it's
    // swallowed rather than overwriting a real result.
    try {
      closeSync(fd);
    } catch {
      // Nothing actionable: the read outcome above is already decided.
    }
  }
}

// Resolves the full hydration outcome for one attachment row: bounded local
// read (gated by resolveSafeAttachmentPath), then blob upload when the
// runtime has blob-upload bindings. Kept separate from the emit loop so
// each concern (per-row hydration vs. stream iteration/progress) stays
// independently readable.
async function resolveAttachmentHydration(
  r: AttachmentRow,
  contentType: string,
  id: string,
  maxBytes: number,
  attachmentsRoot: string
): Promise<AttachmentHydrationResult> {
  if (!r.filename) {
    return {
      blobRef: null,
      bytes: null,
      contentSha256: null,
      hydrationError: "attachment row has no local filename recorded.",
      hydrationStatus: "missing",
      sizeBytes: r.total_bytes,
    };
  }
  // This connector runs against a `local_device`-bound chat.db on the same
  // machine that wrote it (per the manifest binding). chat.db's own
  // attachment.filename column is untrusted input from that connector's
  // point of view: it is never used directly as a filesystem path.
  // resolveSafeAttachmentPath canonicalizes it and verifies the result is
  // genuinely inside attachmentsRoot — rejecting `../` traversal, an
  // absolute path outside the root (including a stale path from a
  // different machine/user), and a symlink that escapes the root, all with
  // the same fail-closed outcome as a missing file. We do not log the raw
  // or resolved path in any diagnostic (standing PDPP no-local-path-leak
  // rule); operators debugging a rejected attachment must consult
  // IMESSAGE_ATTACHMENTS_ROOT and the Attachments directory directly.
  const safe = resolveSafeAttachmentPath(r.filename, attachmentsRoot);
  if (!(safe.ok && safe.path)) {
    return {
      blobRef: null,
      bytes: null,
      contentSha256: null,
      hydrationError: "attachment file is missing, unreadable, or outside the trusted attachments root.",
      hydrationStatus: "missing",
      sizeBytes: null,
    };
  }
  const local = readAttachmentFileSync(safe.path, maxBytes);
  if (!(local.hydrationStatus === "deferred" && local.bytes)) {
    return local;
  }
  try {
    const blobRef = await uploadAttachmentBlob({ bytes: local.bytes, mimeType: contentType, recordKey: id });
    return {
      ...local,
      blobRef,
      contentSha256: blobRef?.sha256 ?? local.contentSha256,
      hydrationStatus: blobRef ? "hydrated" : "deferred",
      sizeBytes: blobRef?.size_bytes ?? local.sizeBytes,
    };
  } catch (err) {
    return {
      ...local,
      blobRef: null,
      hydrationError: err instanceof Error ? err.message : "Attachment blob upload failed.",
      hydrationStatus: "failed",
    };
  }
}

async function emitAttachmentRows({
  attachmentsRoot,
  db,
  emitRecord,
  maxBytes,
  progress,
}: {
  attachmentsRoot: string;
  db: DatabaseSync;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  maxBytes: number;
  progress: (message: string, extra?: Record<string, unknown>) => Promise<void>;
}): Promise<number> {
  if (!(tableExists(db, "attachment") && tableExists(db, "message_attachment_join"))) {
    return 0;
  }
  const hasChatJoin = tableExists(db, "chat_message_join");
  const rows = queryAttachmentRows(db, hasChatJoin);
  let emitted = 0;
  for (const r of rows) {
    const filename = r.filename ? basename(r.filename) : `attachment-${r.rowid}`;
    const contentType = r.mime_type || "application/octet-stream";
    const id = attachmentRecordId(r.filename ?? `rowid:${r.rowid}`, r.rowid);
    const result = await resolveAttachmentHydration(r, contentType, id, maxBytes, attachmentsRoot);

    await emitRecord("attachments", {
      id,
      message_id: r.message_guid || String(r.message_id),
      chat_id: r.chat_id ? String(r.chat_id) : null,
      filename,
      content_type: contentType,
      size_bytes: result.sizeBytes,
      content_sha256: result.contentSha256,
      hydration_status: result.hydrationStatus,
      hydration_error: result.hydrationError,
      blob_ref: result.blobRef,
    });
    emitted += 1;

    if (emitted % ATTACHMENT_PROGRESS_INTERVAL === 0) {
      await progress(`iMessage phase=emit pass=emit stream=attachments item=${emitted}`, {
        stream: "attachments",
      });
    }
  }
  if (emitted > 0 && emitted % ATTACHMENT_PROGRESS_INTERVAL !== 0) {
    await progress(`iMessage phase=emit pass=emit stream=attachments item=${emitted}`, {
      stream: "attachments",
    });
  }
  return emitted;
}

// Guarded so importing this module (e.g. from a unit test that only wants
// readAttachmentFileSync or the other exported helpers) never starts the
// stdin-driven Collection Profile protocol loop — that only happens when
// this file is the actual process entry point. See is-main-module.ts.
if (isMainModule(import.meta.url)) {
  runConnector({
    name: "imessage",
    validateRecord,
    async collect({ state, requested, emit, emitRecord, progress }) {
      const dbPath = process.env.IMESSAGE_DB_PATH || join(homedir(), "Library/Messages/chat.db");
      if (!existsSync(dbPath)) {
        throw new Error(
          "imessage_db_not_found: configured message database is missing or unreadable. Set IMESSAGE_DB_PATH when running outside the default macOS location."
        );
      }

      const db = new DatabaseSync(dbPath, { readOnly: true });

      if (requested.has("messages")) {
        const messagesState = (state.messages ?? {}) as {
          last_apple_date?: number;
        };
        const since = messagesState.last_apple_date ?? 0;
        await progress("iMessage phase=index pass=index stream=messages querying rows", { stream: "messages" });

        // Row iteration is lazy: query errors surface while stepping the iterator,
        // so the emit loop runs inside the failure boundary that maps any query
        // failure to `imessage_db_query_failed` (and leaves STATE unemitted).
        let latestApple: number;
        try {
          const rows = queryMessageRows(db, since);
          await progress("iMessage phase=emit pass=emit stream=messages streaming rows", { stream: "messages" });
          latestApple = await emitMessageRows({ emit, emitRecord, progress, rows, since });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`imessage_db_query_failed: ${msg}`, { cause: err });
        }

        await emit({
          type: "STATE",
          stream: "messages",
          cursor: { last_apple_date: latestApple },
        });
      }

      if (requested.has("participants")) {
        await progress("iMessage phase=index pass=index stream=participants querying rows", {
          stream: "participants",
        });
        const emitted = await emitParticipantRows({ db, emitRecord });
        if (emitted === 0 && !tableExists(db, "chat_handle_join")) {
          await emit({
            type: "SKIP_RESULT",
            stream: "participants",
            reason: "chat_handle_join_table_missing",
            message:
              "This chat.db does not expose a chat_handle_join table; group-chat participant modeling is unavailable on this schema version.",
          });
        }
        await emit({ type: "STATE", stream: "participants", cursor: { synced_at: new Date().toISOString() } });
      }

      if (requested.has("attachments")) {
        const maxBytes = resolveMaxAttachmentBytes(process.env);
        const attachmentsRoot = resolveAttachmentsRoot(process.env);
        await progress("iMessage phase=index pass=index stream=attachments querying rows", {
          stream: "attachments",
        });
        const hasAttachmentTables = tableExists(db, "attachment") && tableExists(db, "message_attachment_join");
        const emitted = await emitAttachmentRows({ attachmentsRoot, db, emitRecord, maxBytes, progress });
        if (emitted === 0 && !hasAttachmentTables) {
          await emit({
            type: "SKIP_RESULT",
            stream: "attachments",
            reason: "attachment_tables_missing",
            message:
              "This chat.db does not expose attachment/message_attachment_join tables; attachment hydration is unavailable on this schema version.",
          });
        }
        await emit({ type: "STATE", stream: "attachments", cursor: { synced_at: new Date().toISOString() } });
      }
    },
  });
}
