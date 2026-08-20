#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Signal Desktop Connector (v0.1.0)
 *
 * Reads Signal Desktop's local encrypted `db.sqlite` through the `sigtop`
 * sidecar CLI (github.com/tbvdm/sigtop, ISC license) rather than a native
 * SQLCipher binding: Signal's DB key is protected by Electron's
 * `safeStorage` (OS-keychain-backed AES/PBKDF2 unwrap — KWallet/libsecret
 * on Linux, Keychain on macOS, DPAPI on Windows), and sigtop already
 * implements that unwrap correctly across all three platforms. This is the
 * same "arms-length subprocess" pattern the `slack` connector uses for its
 * own Go sidecar tool — a Go binary kept at a distance rather than
 * reimplemented or natively bound.
 *
 * `sigtop` binary resolution: `SIGTOP_BIN` env var, default `"sigtop"` on
 * PATH — mirrors the analogous `*_BIN`/`resolve*Bin` pattern the `slack`
 * connector uses for its own sidecar. Install:
 * `go install github.com/tbvdm/sigtop@latest` (Linux additionally needs
 * `libsecret-1-dev` + `pkg-config` at build time; see sigtop's README).
 *
 * ## sigtop CLI mechanics (verified directly against sigtop's Go source,
 * github.com/tbvdm/sigtop — a prior design pass assumed `query-database`
 * writes a SQLite file; it does not, and that assumption is corrected
 * here):
 *
 *   - `sigtop check-database` — fast-fail health check (SQLCipher
 *     cipher_integrity_check / integrity_check / foreign_key_check
 *     pragmas). Non-zero exit + failure lines on stdout when the DB fails
 *     a check.
 *   - `sigtop query-database [-o outfile] sql` — writes each result row as
 *     UNESCAPED pipe-delimited text (`strings.Join(columns, "|")`, one
 *     line per row) to `outfile` or stdout. There is no quoting: a column
 *     value containing a literal `|` (e.g. a message body) makes the row
 *     ambiguous to re-split. This connector therefore does NOT use
 *     query-database for anything containing free text.
 *   - `sigtop export-database [-B] [-d dir] file` — decrypts the FULL
 *     database to `file` as a real, regular plaintext SQLite database.
 *     `file` is a positional argument, not `-o`, and sigtop opens it with
 *     `O_EXCL` (fails if it already exists) — this connector always
 *     targets a freshly `mkdtemp`'d path it never pre-creates. This is
 *     the connector's PRIMARY data-access mechanism for `messages`,
 *     `conversations`, and `reactions`: opened read-only with
 *     `node:sqlite`'s `DatabaseSync`, queried with real bound `?`
 *     parameters (no manual SQL-string interpolation of the cursor value
 *     — `node:sqlite` supports positional bound parameters the same way
 *     `imessage`/`slack` already use them). One export, shared across all
 *     three streams, deleted at the end of the run.
 *   - `sigtop export-attachments -i <dir>` — real incremental support
 *     native to the tool: a `.incremental` marker file in `<dir>` skips
 *     attachments already exported by a prior run. Attachment BYTES are
 *     encrypted at rest by Signal Desktop itself (a per-attachment
 *     `localKey`); only sigtop knows how to decrypt them, so this
 *     connector never reads Signal's raw `attachments.noindex/` tree
 *     directly — it always goes through this export step first, then
 *     hydrates from sigtop's own (connector-controlled) decrypted output
 *     directory using the exact same TOCTOU-safe O_NOFOLLOW read
 *     primitive (`readAttachmentFileSync`, `resolveSafeAttachmentPath`)
 *     `imessage/index.ts` uses against its own Attachments tree — same
 *     threat model (untrusted path from a local tool's output, trusted
 *     root directory, check-then-read race), so it is imported rather
 *     than re-derived.
 *
 * Signal Desktop's own schema exposes `hasAttachments`/edit-history/
 * reactions only inside each message row's `json` TEXT column, not as
 * flat SQL columns (verified against sigtop's own
 * signal/{message,reaction,attachment}.go, which parses that same JSON
 * envelope for its own text/JSON export formats). `parsers.ts`'s
 * `parseMessageJson`/`extractReactionsFromMessageJson` decode exactly that
 * shape; this connector has no CLI subcommand that emits per-message
 * reaction or attachment-presence data as a flat row, so both are derived
 * here rather than queried directly.
 *
 * Per-attachment metadata (content_type, size, owning message id) comes
 * from Signal Desktop's `message_attachments` table (schema version >=
 * 1360 only — see sigtop's signal/attachment.go), read from the same
 * export-database SQLite file already opened for messages/conversations/
 * reactions. On an older schema lacking that table, attachments still
 * hydrate (bytes + hash) but message_id/content_type degrade to
 * best-effort/null rather than the run failing — the same
 * `tableExists`-gated schema-drift tolerance imessage applies to its own
 * optional tables.
 *
 * Complexity budget: this connector deliberately does NOT copy slack's
 * stall-vs-runtime-timeout budgets, sqlite-lock-race retry counts, scoped-
 * archive reconciliation, or 3-way resumed/failed/throttled outcome
 * machinery — all of that was earned by specific production incidents
 * that have no analog here yet (see slack/index.ts's own module doc for
 * that history). This connector starts at imessage's complexity budget:
 * one subprocess call per concern, a plain incremental cursor,
 * schema-drift tolerance via `tableExists`. Additional complexity is
 * warranted only by a real observed failure, not preemptively.
 *
 * Reachability probe and mock-mutation check are permanently and
 * correctly UNKNOWN for this connector: it has no network surface at all
 * (a local subprocess reading a local file), the same shape as
 * imessage/claude_code/whatsapp. That is not a gap the checklist expects
 * closed — see CONNECTOR-CHECKLIST.md's exemption rule and this repo's
 * docs/inbox/report-connector-coverage.md classification table.
 *
 * Target evidence level: Development — real collector, unverified against
 * a live account (CONNECTOR-CHECKLIST.md). No cross-platform testing claim
 * is made anywhere in this connector or its tests: sigtop's own docs and
 * source state the same subcommands/flags behave identically across
 * Linux/macOS/Windows, but only a Linux run (unit tests + a mocked
 * subprocess integration test) has actually been exercised while building
 * this — no real sigtop binary, no real Signal account, no macOS/Windows
 * run.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildDetailCoverageMessage,
  type CollectContext,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import {
  makeReferenceBlobUploader,
  type ReferenceBlobRef,
  runtimeBlobUploadAvailable,
} from "../../src/reference-blob-uploader.ts";
import {
  buildConversationRecord,
  buildMessageRecord,
  buildReactionRecord,
  extractReactionsFromMessageJson,
  parseMessageJson,
  type SignalConversationRow,
  type SignalMessageRow,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const PROGRESS_INTERVAL_ROWS = 10_000;
const ATTACHMENT_PROGRESS_INTERVAL = 25;
/**
 * Cap on ids listed in the unreachable-backfill diagnostic. The full count
 * is always reported; only the id sample is bounded, so a large hole stays
 * legible without unbounded diagnostic growth. Mirrors slack's
 * `MAX_MISSING_CHANNEL_IDS_IN_DIAGNOSTIC`.
 */
const MAX_UNREACHABLE_IDS_IN_DIAGNOSTIC = 50;
/**
 * Cap on the durable emitted-id cursor. A Signal Desktop replica is a
 * bounded local store (this owner's is ~4.7k messages), so this holds the
 * whole history for realistic accounts while still refusing to grow without
 * limit. When it binds, the backfill check reports "cannot prove" rather
 * than a clean bill — see `mergeEmittedIds`.
 */
const MAX_EMITTED_ID_CURSOR = 200_000;

// Conservative default cap for local attachment reads, matching imessage's
// / Gmail's documented-default pattern (25 MiB). Operators can raise/lower
// with PDPP_SIGNAL_MAX_ATTACHMENT_BYTES; non-positive/non-numeric overrides
// are ignored so a misconfigured env var can never silently disable the cap.
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES_ENV = "PDPP_SIGNAL_MAX_ATTACHMENT_BYTES";
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

export function resolveSigtopBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.SIGTOP_BIN || "sigtop";
}

export function formatSigtopMissingError(bin: string): string {
  return [
    `sigtop binary not found: ${bin}`,
    "Install sigtop (github.com/tbvdm/sigtop) and either put it on PATH or set SIGTOP_BIN to its absolute path.",
    "Linux builds additionally require libsecret-1-dev and pkg-config at build time (apt install libsecret-1-dev pkg-config) — see sigtop's README.",
  ].join(" ");
}

interface SigtopRunResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

const DEFAULT_SIGTOP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Spawn `sigtop <args>` and collect its output. Deliberately simple: a
 * single total-runtime timeout, no stall-detection budget, no retry
 * machinery — see this file's module doc for why slack's heavier
 * subprocess runtime is not copied here. `check-database`/
 * `export-database`/`export-attachments` are all bounded, single-shot
 * operations against a local file, not a multi-hour network archive dump.
 */
export function runSigtop(
  args: string[],
  { timeoutMs = DEFAULT_SIGTOP_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<SigtopRunResult> {
  const bin = resolveSigtopBin();
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`sigtop_timeout: '${args[0] ?? ""}' did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error(`sigtop_not_found: ${formatSigtopMissingError(bin)}`, { cause: err }));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
}

/**
 * Validate + coerce a STATE-supplied cursor value to a non-negative
 * integer. Even though this connector now queries via bound `?`
 * parameters (no manual SQL-string interpolation — see
 * `openExportedDatabase`'s callers), an untrusted STATE cursor is still
 * coerced defensively before use: anything that is not a finite
 * non-negative integer (NaN, Infinity, negative, non-numeric) coerces to
 * 0, matching imessage's since-defaults-to-0 behavior on first run or a
 * malformed cursor.
 */
export function parseCursorMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.floor(n);
}

// Returns true when `table` exists in the opened database. Signal
// Desktop's schema has changed columns/tables across app versions (e.g.
// `message_attachments` only exists from schema version 1360 onward — see
// sigtop's signal/attachment.go). A stream built on an absent table
// degrades to a best-effort/SKIP_RESULT outcome rather than crashing the
// whole run, mirroring imessage's identical `tableExists` gate.
function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row !== undefined;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).iterate() as IterableIterator<{ name: string }>;
  for (const r of rows) {
    if (r.name === column) {
      return true;
    }
  }
  return false;
}

/**
 * Decrypts Signal's full database to a fresh temp file via
 * `sigtop export-database` and opens it read-only with `node:sqlite`.
 * Caller owns closing the DB and removing the temp directory (see
 * `withExportedDatabase`) — kept separate so tests can drive the open step
 * without spawning a real sigtop process.
 */
async function exportAndOpenDatabase(): Promise<{ db: DatabaseSync; tmpDir: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-signal-"));
  // sigtop's export-database opens its target with O_EXCL and fails if it
  // already exists — this path must be reserved (a fresh dir) but never
  // pre-created as a file.
  const dbFile = join(tmpDir, "export.sqlite");
  const result = await runSigtop(["export-database", dbFile]);
  if (result.code !== 0) {
    rmSync(tmpDir, { force: true, recursive: true });
    throw new Error(`sigtop_export_database_failed: exit code ${String(result.code)}: ${result.stderr.trim()}`);
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  return { db, tmpDir };
}

/** Runs `fn` against a freshly exported+opened database, always cleaning up. */
async function withExportedDatabase<T>(fn: (db: DatabaseSync) => Promise<T>): Promise<T> {
  const { db, tmpDir } = await exportAndOpenDatabase();
  try {
    return await fn(db);
  } finally {
    db.close();
    rmSync(tmpDir, { force: true, recursive: true });
  }
}

/**
 * `sourceServiceId` is not a flat column on `messages` in any schema
 * version sigtop supports (verified against signal/message.go) — it is
 * obtained by joining the message's own sender identifier against
 * `conversations.serviceId`. Older schema versions use `source`/
 * `sourceUuid` instead of `sourceServiceId` on the message row itself;
 * this connector targets current (schema >= 88) Signal Desktop databases,
 * consistent with sigtop's own newest-first column preference, and
 * degrades `sender` to null on a database old enough to lack the
 * `sourceServiceId` column rather than failing the whole stream.
 *
 * `sender` resolves through `LEFT JOIN conversations AS c ON
 * m.sourceServiceId = c.serviceId`, selecting `c.id` rather than the raw
 * `sourceServiceId` — matching sigtop's own sender resolution (verified
 * against signal/message.go's schema>=88 query, which performs the
 * identical join and returns the same `conversations.id`). This is a
 * deliberate identity choice, not an incidental copy of sigtop's shape:
 * Signal Desktop's schema gives every contact exactly one 1:1
 * `conversations` row (a "recipient" and its "conversation" are the same
 * row), so `c.id` is that contact's own canonical identity row — the same
 * id this connector's own `conversations` stream emits as `id`. Joining
 * lets `messages.sender` actually foreign-key against `conversations.id`
 * (what a consumer joining sender -> conversations would need); the raw
 * `sourceServiceId` ACI/PNI UUID is a different identifier space that
 * matches nothing else this connector emits. On a database old enough to
 * lack `conversations.serviceId`, the join degrades to `NULL` the same way
 * a missing `messages.sourceServiceId` already does.
 */
function messagesSelect(db: DatabaseSync): string {
  const hasSourceServiceId = columnExists(db, "messages", "sourceServiceId");
  const hasReceivedAtMs = columnExists(db, "messages", "received_at_ms");
  const hasConversationServiceId = columnExists(db, "conversations", "serviceId");
  const senderExpr =
    hasSourceServiceId && hasConversationServiceId ? "c.id" : hasSourceServiceId ? "m.sourceServiceId" : "NULL";
  const receivedExpr = hasReceivedAtMs ? "m.received_at_ms" : "NULL";
  const joinClause =
    hasSourceServiceId && hasConversationServiceId
      ? "LEFT JOIN conversations AS c ON m.sourceServiceId = c.serviceId"
      : "";
  return `
    SELECT m.id AS id, m.conversationId AS conversationId, ${senderExpr} AS sourceServiceId,
           m.sent_at AS sentAt, ${receivedExpr} AS receivedAtMs, m.body AS body, m.type AS type,
           m.json AS json
    FROM messages AS m
    ${joinClause}
    WHERE (m.sent_at > ? OR m.sent_at IS NULL)
    ORDER BY m.sent_at ASC
  `;
}

function conversationsSelect(): string {
  return `
    SELECT id, type, name, e164, serviceId, groupId
    FROM conversations
    ORDER BY id ASC
  `;
}

/**
 * Validate a source-measured row total: must be a finite, non-negative
 * integer. Fail closed — a missing or malformed count is NOT zero and NOT
 * "complete". Mirrors jellyfin's `validateTotalRecordCount` discipline
 * (connectors/jellyfin/index.ts), minus the monotonicity rule: Signal
 * Desktop legitimately DELETES rows (disappearing messages expire, the
 * owner deletes a thread), so a decreasing total here is ordinary source
 * behavior rather than the provider-side anomaly it is for Jellyfin.
 */
export function validateSourceTotal(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new Error(`signal_source_total_not_number: ${label}`);
  }
  if (!Number.isFinite(value)) {
    throw new Error(`signal_source_total_not_finite: ${label}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`signal_source_total_not_integer: ${label}`);
  }
  if (value < 0) {
    throw new Error(`signal_source_total_negative: ${label}`);
  }
  return value;
}

/**
 * The `messages` completeness anchor: `SELECT COUNT(*)` over Signal
 * Desktop's own `messages` table, measured at the SOURCE boundary (the
 * decrypted database) and independent of what this run enumerated or
 * emitted.
 *
 * This is a genuine external anchor — it is the source's own count, not a
 * number this connector derived from its own output. It is what makes the
 * `messages` stream's `considered` an objectively-measured denominator
 * rather than a tautology.
 *
 * CEILING, stated honestly: Signal Desktop is a linked-device REPLICA, not
 * the account of record. Messages that Signal Desktop never received (sent
 * before this device was linked, or expired before it synced) are absent
 * from this table and therefore absent from this denominator too. This
 * anchor proves "we hold everything the local replica holds"; it cannot
 * prove "we hold everything the Signal account ever had." No local anchor
 * can, and this connector does not claim otherwise.
 *
 * Fails closed: a query error or a malformed count throws rather than
 * defaulting to zero, because an unmeasurable boundary is not an empty one.
 */
function countSourceMessages(db: DatabaseSync): number {
  let row: unknown;
  try {
    row = db.prepare("SELECT COUNT(*) AS total FROM messages").get();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`signal_source_total_query_failed: messages: ${msg}`, { cause: err });
  }
  const total = (row as { total?: unknown } | undefined)?.total;
  return validateSourceTotal(typeof total === "bigint" ? Number(total) : total, "messages");
}

/**
 * Read the durable emitted-id cursor tolerantly. A missing, malformed, or
 * legacy (pre-cursor) value yields an EMPTY set, which is safe: an empty
 * prior set combined with a `since` of 0 (the only state a cold start can
 * be in) puts nothing below the watermark, so no false gap can be reported.
 * A legacy cursor that DOES carry `last_sent_at_ms` but no `emitted_ids`
 * would report every below-watermark id as unreachable on its first
 * post-deploy run — see `readPriorEmittedIds`'s caller, which suppresses
 * the finding in exactly that case.
 */
export function parseEmittedIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }
  const out = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && entry !== "") {
      out.add(entry);
    }
  }
  return out;
}

/**
 * Merge the prior emitted-id set with this run's, newest-last, bounded.
 *
 * The bound matters: this set is a durable cursor, and an unbounded one
 * grows without limit on a large account. Keeping the NEWEST ids is the
 * right truncation because the check only ever asks about ids at or below
 * the watermark — and the watermark advances, so the oldest ids are the
 * ones least likely to be re-offered by a backfill. When truncation is in
 * force the check degrades to "cannot prove", never to a false clean bill:
 * `reconcileMessageAnchor`'s caller reports the truncation explicitly.
 */
export function mergeEmittedIds(prior: ReadonlySet<string>, current: readonly string[]): string[] {
  const merged = [...prior, ...current];
  return merged.length > MAX_EMITTED_ID_CURSOR ? merged.slice(merged.length - MAX_EMITTED_ID_CURSOR) : merged;
}

interface QueriedMessageRows {
  /** Ids this run actually emitted, for the durable emitted-id cursor. */
  emittedIds: string[];
  latestMs: number;
  reactionSourceRows: Array<{ id: string; json: string | null }>;
  skippedNullDate: number;
  /** Rows this run's cursor window enumerated (the in-window denominator). */
  windowConsidered: number;
  /** Rows this run's cursor window accounted for (emitted or deliberately skipped). */
  windowCovered: number;
}

/**
 * How this run's cursor window relates to the source's own holdings.
 *
 * `sourceTotal` is the objective anchor (every row Signal Desktop holds),
 * reported as a stream-level fact and NOT substituted for the per-window
 * `considered`: `isHealthyBoundedContinuation`
 * (reference-implementation/server/continuation-proof.ts) admits a bounded
 * window only when `considered === covered`, so folding a stream-level
 * total into the window denominator would pin every incremental run to a
 * permanent false `partial`.
 *
 * `unreachableIds` is the load-bearing part: source ids sitting at-or-below
 * the cursor watermark that this connector has NOT previously emitted. A
 * forward-only `sent_at > ?` filter can never revisit them.
 *
 * WHY A SET, NOT A COUNT. A scalar comparison cannot work here, in both
 * directions:
 *
 *   - `sourceTotal - belowWatermark` is identically the in-window row count
 *     when both are measured from the same database in the same instant.
 *     It is a tautology: it cannot fire, not even on the backfill hole it
 *     would be written to catch. (Verified numerically against the live
 *     4,739-row database before this design was chosen.)
 *   - Counts also conflate "missing upstream", "surplus", and "duplicated".
 *     PDPP is a preservation product: it deliberately RETAINS records the
 *     source later deletes, so held-but-absent-upstream is expected correct
 *     behavior, never a defect. A two-way count check flags successful
 *     preservation as loss — backwards.
 *
 * A set difference distinguishes the three cases. Only `upstream-present
 * AND never-emitted` is a real gap; `held-but-gone-upstream` is preservation
 * working and is deliberately not reported here.
 */
interface MessageAnchorReconciliation {
  belowWatermark: number;
  sourceTotal: number;
  unreachableIds: string[];
}

/**
 * Reconcile the source's own rows against the cursor watermark and the set
 * of ids prior runs already emitted.
 *
 * Every input is measured at the SOURCE boundary (the decrypted database)
 * except `priorEmittedIds`, which is this connector's own durable cursor.
 * Fails closed: a malformed count or an unreadable query throws rather than
 * defaulting to "complete".
 *
 * Deletion-safe by construction: it only ever asks "which source ids have
 * we never emitted", never "do our holdings match the source count". A row
 * deleted from Signal Desktop simply stops appearing in the source set; it
 * produces no finding.
 */
function reconcileMessageAnchor(
  db: DatabaseSync,
  since: number,
  priorEmittedIds: ReadonlySet<string>
): MessageAnchorReconciliation {
  const sourceTotal = countSourceMessages(db);
  let rows: unknown[];
  try {
    rows = db
      .prepare("SELECT id AS id FROM messages WHERE sent_at IS NOT NULL AND sent_at <= ?")
      .all(since) as unknown[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`signal_source_total_query_failed: messages_below_watermark: ${msg}`, { cause: err });
  }
  const belowWatermark = validateSourceTotal(rows.length, "messages_below_watermark");
  if (belowWatermark > sourceTotal) {
    throw new Error(
      `signal_source_total_inconsistent: below-watermark ${String(belowWatermark)} exceeds source total ${String(sourceTotal)}`
    );
  }
  // A cold start (no prior cursor) has emitted nothing yet, so every
  // below-watermark id would look "unreachable". But a cold start has
  // `since === 0`, which puts nothing below the watermark — the set is
  // empty and no false finding is possible.
  const unreachableIds: string[] = [];
  for (const row of rows) {
    const { id } = row as { id?: unknown };
    if (typeof id === "string" && !priorEmittedIds.has(id)) {
      unreachableIds.push(id);
    }
  }
  return { belowWatermark, sourceTotal, unreachableIds };
}

/**
 * Runs the messages query and builds every row's record + cursor
 * contribution, WITHOUT emitting anything — pure row-shaping over an
 * already-open database. Kept separate from `emitMessageRowsAndReactions`
 * so a `reactions`-only request (no `messages` in scope) can walk the same
 * rows to derive reactions without also emitting `messages` RECORD/
 * SKIP_RESULT traffic for a stream nobody asked for.
 */
function queryMessageRows(
  db: DatabaseSync,
  since: number
): { latestMs: number; rows: Array<{ built: ReturnType<typeof buildMessageRecord>; raw: SignalMessageRow }> } {
  const iter = db.prepare(messagesSelect(db)).iterate(since) as IterableIterator<SignalMessageRow>;
  let latestMs = since;
  const rows: Array<{ built: ReturnType<typeof buildMessageRecord>; raw: SignalMessageRow }> = [];
  for (const r of iter) {
    const built = buildMessageRecord(r);
    if (built.sentAtMs !== null && built.sentAtMs > latestMs) {
      latestMs = built.sentAtMs;
    }
    rows.push({ built, raw: r });
  }
  return { latestMs, rows };
}

async function emitMessageRowsAndReactions({
  db,
  emitRecord,
  emitReactions,
  progress,
  since,
}: {
  db: DatabaseSync;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  emitReactions: boolean;
  progress: (message: string, extra?: Record<string, unknown>) => Promise<void>;
  since: number;
}): Promise<QueriedMessageRows> {
  const { latestMs, rows } = queryMessageRows(db, since);
  let itemOrdinal = 0;
  let skippedNullDate = 0;
  // Measured at the enumeration site from the rows the source handed back —
  // never aliased to the emitted count. A row skipped for an unusable date
  // raises `windowConsidered` without raising `windowCovered`, so it reads
  // `partial` exactly as it should.
  const windowConsidered = rows.length;
  let windowCovered = 0;
  const emittedIds: string[] = [];
  const reactionSourceRows: Array<{ id: string; json: string | null }> = [];
  for (const { built, raw } of rows) {
    itemOrdinal += 1;
    if (built.sentAtMs === null) {
      // No usable timestamp on this row (neither sent_at nor
      // received_at_ms) — no honest cursor position. Skip with a
      // diagnostic rather than fabricating the run's wall clock (see
      // imessage's identical null-date-skip-not-fabricate rule).
      skippedNullDate += 1;
      continue;
    }
    await emitRecord("messages", built.record);
    windowCovered += 1;
    emittedIds.push(raw.id);
    if (emitReactions) {
      reactionSourceRows.push({ id: raw.id, json: raw.json });
    }
    if (itemOrdinal % PROGRESS_INTERVAL_ROWS === 0) {
      await progress(`Signal phase=emit pass=emit stream=messages item=${itemOrdinal}`, { stream: "messages" });
    }
  }
  return { emittedIds, latestMs, reactionSourceRows, skippedNullDate, windowConsidered, windowCovered };
}

async function emitReactionRowsFromMessages(
  reactionSourceRows: ReadonlyArray<{ id: string; json: string | null }>,
  emitRecord: (stream: string, data: RecordData) => Promise<void>
): Promise<number> {
  let emitted = 0;
  for (const row of reactionSourceRows) {
    const json = parseMessageJson(row.json);
    for (const reaction of extractReactionsFromMessageJson(row.id, json)) {
      await emitRecord("reactions", buildReactionRecord(reaction));
      emitted += 1;
    }
  }
  return emitted;
}

async function emitConversationRows(
  db: DatabaseSync,
  emitRecord: (stream: string, data: RecordData) => Promise<void>
): Promise<number> {
  const rows = db.prepare(conversationsSelect()).iterate() as IterableIterator<SignalConversationRow>;
  let emitted = 0;
  for (const r of rows) {
    await emitRecord("conversations", buildConversationRecord(r));
    emitted += 1;
  }
  return emitted;
}

// ─── Attachment hydration (reused pattern from imessage/index.ts) ───────

interface SafeAttachmentPathResult {
  ok: boolean;
  path: string | null;
}

/**
 * Resolves `rawPath` (sigtop's own exported-attachment path) against
 * `root` (sigtop's export directory) and verifies the result genuinely
 * resolves inside `root` before returning it. Identical logic to
 * imessage's `resolveSafeAttachmentPath` — the threat model is the same
 * (untrusted path from a local tool's output, trusted root directory,
 * TOCTOU race between check and read) even though sigtop's export
 * directory is connector-controlled and arguably a stronger boundary than
 * imessage's user-owned Attachments tree.
 */
function resolveSafeAttachmentPath(rawPath: string, root: string): SafeAttachmentPathResult {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, path: null };
  }
  let realCandidate: string;
  try {
    realCandidate = realpathSync(rawPath);
  } catch {
    return { ok: false, path: null };
  }
  const withinRoot = realCandidate === realRoot || realCandidate.startsWith(realRoot + sep);
  if (!withinRoot) {
    return { ok: false, path: null };
  }
  return { ok: true, path: realCandidate };
}

export interface AttachmentHydrationResult {
  blobRef: ReferenceBlobRef | null;
  bytes: Buffer | null;
  contentSha256: string | null;
  hydrationError: string | null;
  hydrationStatus: "deferred" | "hydrated" | "failed" | "too_large" | "missing";
  sizeBytes: number | null;
}

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

/**
 * Bounded local read with the check-then-read (TOCTOU) window closed —
 * verbatim port of imessage/index.ts's `readAttachmentFileSync`. See that
 * file's doc comment for the full O_NOFOLLOW rationale; it applies
 * unchanged here since the threat model (canonicalize-then-verify
 * followed by a separate read syscall) is identical. Linux (this
 * connector's development/test platform) supports O_NOFOLLOW
 * unconditionally, and so do macOS/Windows (sigtop's other supported
 * platforms per Node's fs module) — untested here, see module doc.
 */
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
    try {
      closeSync(fd);
    } catch {
      // Nothing actionable: the read outcome above is already decided.
    }
  }
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
    connectorId: "https://registry.pdpp.org/connectors/signal",
    content: [args.bytes],
    mimeType: args.mimeType,
    recordKey: args.recordKey,
    stream: "attachments",
  });
}

function attachmentRecordId(localPath: string): string {
  return createHash("sha256").update(localPath).digest("hex");
}

interface AttachmentMetadata {
  contentType: string | null;
  messageId: string | null;
  size: number | null;
}

/**
 * Best-effort metadata join: keyed by the exported file's basename against
 * `message_attachments.fileName` (schema >= 1360 only — see this file's
 * module doc). sigtop does not preserve a stable per-attachment id across
 * its export step and Signal's own DB row, so a filename collision (two
 * different attachments across different messages sharing an identical
 * original filename, e.g. two photos both literally named "IMG_0001.jpg")
 * can join to the wrong metadata row. This degrades gracefully: a wrong or
 * missing join leaves message_id/content_type null/best-effort rather than
 * corrupting the attachment's actual bytes/hash, which are read directly
 * from the exported file regardless of whether the join succeeded.
 */
function buildAttachmentMetadataIndex(db: DatabaseSync): Map<string, AttachmentMetadata> {
  const index = new Map<string, AttachmentMetadata>();
  if (!tableExists(db, "message_attachments")) {
    return index;
  }
  const rows = db
    .prepare("SELECT messageId, contentType, fileName, size FROM message_attachments")
    .iterate() as IterableIterator<{
    contentType: string | null;
    fileName: string | null;
    messageId: string | null;
    size: number | null;
  }>;
  for (const r of rows) {
    if (r.fileName) {
      index.set(r.fileName, { contentType: r.contentType, messageId: r.messageId, size: r.size });
    }
  }
  return index;
}

/**
 * Recursively lists every regular file under `dir`. sigtop's
 * `export-attachments` lays files out in a nested directory structure (one
 * subdirectory per conversation), so a flat `readdirSync` is not enough.
 * Symlinks encountered during the walk are not traversed (Node's
 * `withFileTypes` reports them as `isSymbolicLink()`, which this function
 * skips) — the eventual read still goes through
 * `resolveSafeAttachmentPath` + `readAttachmentFileSync`'s O_NOFOLLOW gate
 * regardless, but skipping them here avoids walking into an
 * attacker-controlled subtree during enumeration itself.
 */
async function listExportedAttachmentFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

async function resolveAttachmentHydration(
  localPath: string,
  contentType: string,
  id: string,
  maxBytes: number,
  exportRoot: string
): Promise<AttachmentHydrationResult> {
  const safe = resolveSafeAttachmentPath(localPath, exportRoot);
  if (!(safe.ok && safe.path)) {
    return {
      blobRef: null,
      bytes: null,
      contentSha256: null,
      hydrationError: "attachment file is missing, unreadable, or outside the trusted export root.",
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
  emitRecord,
  exportRoot,
  files,
  maxBytes,
  metadataIndex,
  progress,
}: {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  exportRoot: string;
  files: readonly string[];
  maxBytes: number;
  metadataIndex: Map<string, AttachmentMetadata>;
  progress: (message: string, extra?: Record<string, unknown>) => Promise<void>;
}): Promise<number> {
  let emitted = 0;
  for (const localPath of files) {
    const filename = localPath.split(sep).at(-1) || `attachment-${emitted}`;
    const meta = metadataIndex.get(filename) ?? null;
    const contentType = meta?.contentType || "application/octet-stream";
    const id = attachmentRecordId(localPath);
    const result = await resolveAttachmentHydration(localPath, contentType, id, maxBytes, exportRoot);

    await emitRecord("attachments", {
      id,
      message_id: meta?.messageId ?? null,
      conversation_id: null,
      filename,
      content_type: contentType,
      size_bytes: result.sizeBytes ?? meta?.size ?? null,
      content_sha256: result.contentSha256,
      hydration_status: result.hydrationStatus,
      hydration_error: result.hydrationError,
      blob_ref: result.blobRef,
    });
    emitted += 1;

    if (emitted % ATTACHMENT_PROGRESS_INTERVAL === 0) {
      await progress(`Signal phase=emit pass=emit stream=attachments item=${emitted}`, { stream: "attachments" });
    }
  }
  return emitted;
}

async function collectAttachments(ctx: CollectContext): Promise<void> {
  const { emit, emitRecord, progress } = ctx;
  const maxBytes = resolveMaxAttachmentBytes(process.env);
  const exportRoot =
    process.env.SIGNAL_ATTACHMENTS_EXPORT_DIR || join(tmpdir(), `pdpp-signal-attachments-${randomUUID()}`);
  await mkdir(exportRoot, { recursive: true });

  await progress("Signal phase=index pass=index stream=attachments exporting via sigtop", { stream: "attachments" });
  const result = await runSigtop(["export-attachments", "-i", exportRoot]);
  if (result.code !== 0) {
    throw new Error(`sigtop_export_attachments_failed: exit code ${String(result.code)}: ${result.stderr.trim()}`);
  }

  const files = await listExportedAttachmentFiles(exportRoot);
  const metadataIndex = await withExportedDatabase((db) => Promise.resolve(buildAttachmentMetadataIndex(db)));

  await progress("Signal phase=emit pass=emit stream=attachments hydrating rows", { stream: "attachments" });
  const emitted = await emitAttachmentRows({ emitRecord, exportRoot, files, maxBytes, metadataIndex, progress });
  if (emitted === 0) {
    await emit({
      type: "SKIP_RESULT",
      stream: "attachments",
      reason: "no_attachments_exported",
      message:
        "sigtop export-attachments produced no files for this account (or all attachments were already exported by a prior incremental run).",
    });
  }
  await emit({ type: "STATE", stream: "attachments", cursor: { synced_at: new Date().toISOString() } });
}

/**
 * Emit the `messages` completeness evidence for one run: the in-window
 * coverage declaration plus, when the source holds rows the forward-only
 * cursor will never revisit, an explicit gap.
 *
 * Two facts, deliberately kept separate:
 *
 *  1. DETAIL_COVERAGE carries the WINDOW's own `considered`/`covered` —
 *     rows this run enumerated vs rows it accounted for. It must NOT carry
 *     the stream-level source total: `isHealthyBoundedContinuation`
 *     (reference-implementation/server/continuation-proof.ts) admits a
 *     bounded window only when `considered === covered`, so substituting a
 *     stream-level total would pin every incremental run to a permanent
 *     false `partial`.
 *
 *  2. The backfill hole is reported as a SET difference: source ids at or
 *     below the watermark that no prior run ever emitted. A forward-only
 *     `sent_at > ?` filter can never revisit those rows, so without this
 *     evidence a re-link backfill carrying older `sent_at` values would be
 *     permanently invisible.
 *
 *     Deliberately one-directional. Ids this connector holds that are GONE
 *     from Signal Desktop are NOT reported: PDPP retains records the source
 *     deletes, so held-but-absent-upstream is preservation working as
 *     intended, not a gap. Only upstream-present-and-never-emitted counts.
 */
async function emitMessageAnchorEvidence(
  emit: CollectContext["emit"],
  anchor: MessageAnchorReconciliation,
  result: QueriedMessageRows,
  since: number,
  proveBackfill: boolean
): Promise<void> {
  if (!proveBackfill) {
    // A legacy cursor (watermark, no emitted-id set) cannot distinguish
    // "already emitted" from "newly backfilled". Say so plainly rather than
    // reporting either a false gap or an unearned clean bill.
    await emit({
      type: "SKIP_RESULT",
      stream: "messages",
      reason: "backfill_check_unproven_legacy_cursor",
      message:
        "Below-watermark backfill could not be checked this run: the messages cursor predates the emitted-id set. " +
        "This run seeds that set; the next run checks properly.",
      diagnostics: { source_total: anchor.sourceTotal, below_watermark: anchor.belowWatermark },
      recovery_hint: { action: "retry_by_runtime", retryable: true },
    });
  } else if (anchor.unreachableIds.length > 0) {
    const sample = anchor.unreachableIds.slice(0, MAX_UNREACHABLE_IDS_IN_DIAGNOSTIC);
    await emit({
      type: "SKIP_RESULT",
      stream: "messages",
      reason: "source_rows_below_watermark_unreachable",
      message:
        `Signal Desktop holds ${String(anchor.unreachableIds.length)} message(s) at or below the cursor watermark that this ` +
        "connector has never emitted — a backfill carrying older sent_at values. The forward-only sent_at cursor cannot " +
        "revisit them; re-run with collection_mode=full_refresh to recover them.",
      diagnostics: {
        source_total: anchor.sourceTotal,
        below_watermark: anchor.belowWatermark,
        unreachable_count: anchor.unreachableIds.length,
        unreachable_ids: sample,
        truncated: sample.length < anchor.unreachableIds.length,
        watermark_sent_at_ms: since,
      },
      recovery_hint: { action: "retry_by_runtime", retryable: true },
    });
  }
  await emit(
    buildDetailCoverageMessage({
      stream: "messages",
      stateStream: "messages",
      requiredKeys: [],
      hydratedKeys: [],
      considered: result.windowConsidered,
      covered: result.windowCovered,
    })
  );
}

/**
 * Runs the messages/reactions pass against an already-open exported
 * database: derives both streams from the same row scan (reactions live
 * inside each message's own json blob, not a standalone table — see
 * parsers.ts), emitting only the streams actually requested. Extracted
 * from `collect()` to keep that function's cognitive complexity bounded —
 * this is one cohesive concern (one query, two derived streams), not
 * incidental nesting.
 */
async function collectMessagesAndReactions({
  db,
  ctx,
  emitMessages,
  emitReactions,
  priorEmittedIds,
  proveBackfill,
  since,
}: {
  ctx: CollectContext;
  db: DatabaseSync;
  emitMessages: boolean;
  emitReactions: boolean;
  priorEmittedIds: ReadonlySet<string>;
  /** False on a legacy cursor with no emitted-id set — see the caller. */
  proveBackfill: boolean;
  since: number;
}): Promise<void> {
  const { emit, emitRecord, progress } = ctx;
  await progress("Signal phase=index pass=index stream=messages querying rows", { stream: "messages" });

  // Measured BEFORE the emit pass, at the source boundary, so the anchor
  // cannot be contaminated by anything this run emitted. Throws on a
  // malformed or unreadable count — an unmeasurable boundary is not an
  // empty one.
  const anchor = reconcileMessageAnchor(db, since, priorEmittedIds);

  let result: QueriedMessageRows;
  try {
    result = await emitMessageRowsAndReactions({
      db,
      // A reactions-only request (messages not in scope) must not emit
      // `messages` RECORD/SKIP_RESULT traffic for a stream nobody asked
      // for — route through a no-op in that case.
      emitRecord: emitMessages ? emitRecord : () => Promise.resolve(),
      emitReactions,
      progress,
      since,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`signal_db_query_failed: ${msg}`, { cause: err });
  }

  if (emitMessages) {
    if (result.skippedNullDate > 0) {
      await emit({
        type: "SKIP_RESULT",
        stream: "messages",
        reason: "message_date_unusable",
        message: `Skipped ${result.skippedNullDate} message(s) with a missing or unusable sent_at/received_at_ms; they cannot be placed on the sent_at cursor without fabricating a timestamp.`,
      });
    }
    await emitMessageAnchorEvidence(emit, anchor, result, since, proveBackfill);
    await emit({
      type: "STATE",
      stream: "messages",
      cursor: {
        last_sent_at_ms: result.latestMs,
        // Union of what prior runs emitted and what this run emitted. This
        // is what makes the backfill check a SET comparison rather than a
        // count: without it there is no way to tell a below-watermark row
        // we already have from one a re-link just introduced.
        emitted_ids: mergeEmittedIds(priorEmittedIds, result.emittedIds),
      },
    });
  }

  if (emitReactions) {
    await progress("Signal phase=emit pass=emit stream=reactions deriving from message json", { stream: "reactions" });
    await emitReactionRowsFromMessages(result.reactionSourceRows, emitRecord);
    await emit({ type: "STATE", stream: "reactions", cursor: { synced_at: new Date().toISOString() } });
  }
}

async function collectConversations(db: DatabaseSync, ctx: CollectContext): Promise<void> {
  const { emit, emitRecord, progress } = ctx;
  await progress("Signal phase=index pass=index stream=conversations querying rows", { stream: "conversations" });
  try {
    await emitConversationRows(db, emitRecord);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`signal_db_query_failed: ${msg}`, { cause: err });
  }
  await emit({ type: "STATE", stream: "conversations", cursor: { synced_at: new Date().toISOString() } });
}

async function collectMessagesConversationsReactions(ctx: CollectContext): Promise<void> {
  const { state, requested } = ctx;
  const emitMessages = requested.has("messages");
  const emitReactions = requested.has("reactions");
  const emitConversationsStream = requested.has("conversations");
  if (!(emitMessages || emitReactions || emitConversationsStream)) {
    return;
  }
  await withExportedDatabase(async (db) => {
    if (emitMessages || emitReactions) {
      const messagesState = (state.messages ?? {}) as { emitted_ids?: unknown; last_sent_at_ms?: number };
      const since = parseCursorMs(messagesState.last_sent_at_ms ?? 0);
      const priorEmittedIds = parseEmittedIds(messagesState.emitted_ids);
      // A legacy cursor carries a watermark but no emitted-id set. Every
      // below-watermark id would then look "never emitted" — a false gap
      // for rows prior runs genuinely did emit. Treat that first
      // post-deploy run as unproven (skip the check, seed the set) rather
      // than alarming. The run after it has a real set and checks properly.
      const hasEmittedIdCursor = Array.isArray(messagesState.emitted_ids);
      await collectMessagesAndReactions({
        ctx,
        db,
        emitMessages,
        emitReactions,
        priorEmittedIds,
        proveBackfill: since === 0 || hasEmittedIdCursor,
        since,
      });
    }
    if (emitConversationsStream) {
      await collectConversations(db, ctx);
    }
  });
}

async function runHealthCheck(ctx: CollectContext): Promise<void> {
  await ctx.progress("Signal phase=index pass=index sigtop check-database", {});
  const health = await runSigtop(["check-database"]);
  if (health.code !== 0) {
    throw new Error(
      `signal_db_check_failed: sigtop check-database reported a problem: ${health.stderr.trim() || health.stdout.trim()}`
    );
  }
}

// Guarded so importing this module (e.g. from a unit test) never starts the
// stdin-driven Collection Profile protocol loop — that only happens when
// this file is the actual process entry point. See is-main-module.ts.
if (isMainModule(import.meta.url)) {
  runConnector({
    name: "signal",
    validateRecord,
    async collect(ctx) {
      await runHealthCheck(ctx);
      await collectMessagesConversationsReactions(ctx);
      if (ctx.requested.has("attachments")) {
        await collectAttachments(ctx);
      }
    },
  });
}
