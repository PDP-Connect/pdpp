#!/usr/bin/env node
/**
 * PDPP Gmail Connector (v0.1.0)
 *
 * Uses IMAP + Google app-specific password. Iterates [Gmail]/All Mail so
 * messages with multiple labels aren't multi-counted. Derives label
 * membership from X-GM-LABELS per message.
 *
 * Auth:
 *   GOOGLE_APP_PASSWORD_PDPP or GMAIL_APP_PASSWORD — app password
 *   GMAIL_ADDRESS or GMAIL_USER                    — the account's email;
 *                                                    if missing, emits
 *                                                    INTERACTION kind=credentials.
 *
 * Streams: messages, threads, labels, attachments.
 *
 * State shape:
 *   {
 *     all_mail: { uidvalidity: N, uidnext: N, highest_modseq: N }
 *   }
 *
 * Rate budget: keep to one concurrent connection; fetch in windows of 200.
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import {
  type FetchMessageObject,
  type FetchQueryObject,
  ImapFlow,
  type ListResponse,
  type MailboxObject,
} from "imapflow";
import { flushAndExitAfterRuntimeAck } from "../../src/connector-exit.ts";
import {
  buildDetailCoverageMessage,
  buildDetailGap,
  type DetailCoverageMessage,
  type DetailGapMessage,
  type DetailGapStartEntry,
} from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import {
  makeReferenceBlobUploader as makeSharedReferenceBlobUploader,
  runtimeBlobUploadAvailable as sharedRuntimeBlobUploadAvailable,
} from "../../src/reference-blob-uploader.ts";
import { stringifyForJsonl } from "../../src/safe-emit.ts";
import { requireCredentialsOrAsk, resourceSet } from "../../src/scope-filters.ts";
import {
  type BodyPartSelection,
  bigintToCursor,
  bigintToNumber,
  buildDeltaMessageRecord,
  buildMessageBodyRecord,
  buildMessageRecord,
  buildThreadRecord,
  canonicalLabelName,
  decodeBodyPart,
  decodeBodystructureForAttachments,
  envelopeParticipants,
  isGmailSystemLabel,
  isInTimeRange,
  labelParentName,
  makeSnippet,
  SNIPPET_MAX_CHARS,
  sanitizeForJsonl,
  selectBodyParts,
  toFlagsArray,
  toLabelsArray,
  updateThreadAggregate,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
  AllMailCursor,
  AttachmentAllMailCursor,
  AttachmentHydrationStatus,
  AttachmentRecord,
  BlobRef,
  EmittedMessage,
  InteractionMessage,
  InteractionResponse,
  PriorAttachmentsState,
  PriorMessagesState,
  PriorThreadsState,
  ProgressMessage,
  StartMessage,
  StreamRequest,
  ThreadAggregate,
} from "./types.ts";

// ─── Module-scoped regexes (Biome useTopLevelRegex) ─────────────────────

const EMAIL_AT_RE = /@/;
const RETRYABLE_ERROR_RE = /ECONN|ETIMEDOUT|fetch failed|EPIPE|timeout/i;
// Splits an address into [local-part, domain] for progress redaction. Only the
// last `@` is treated as the domain delimiter so quoted local-parts that embed
// an `@` still redact (the domain is whatever follows the final `@`).
const EMAIL_SPLIT_RE = /^(.*)@([^@]+)$/;

// ─── Constants ──────────────────────────────────────────────────────────

const FETCH_HEADER_BATCH_PROGRESS = 1000;
const SNIPPET_FETCH_MAX_BYTES = 4096;
const ERROR_MSG_TAIL = 400;
const DEFAULT_CRED_TIMEOUT_S = 1800;
const DEFAULT_GMAIL_CONNECTOR_ID = "https://registry.pdpp.org/connectors/gmail";
const HYDRATION_ERROR_MAX_CHARS = 240;
const DEFAULT_ATTACHMENT_MIME_TYPE = "application/octet-stream";
const BLOB_UPLOAD_ENV_ERROR =
  "blob upload unavailable: PDPP_RS_URL and PDPP_OWNER_TOKEN must be provided by the runtime";
// Conservative default chosen to align with Gmail's per-message attachment
// cap (25 MiB). Operators can raise/lower with PDPP_GMAIL_MAX_ATTACHMENT_BYTES;
// the value is enforced both before download (when source size is known) and
// while streaming bytes (defense against under-reported sizes).
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES_ENV = "PDPP_GMAIL_MAX_ATTACHMENT_BYTES";
const POSITIVE_INTEGER_PATTERN = /^\d+$/;
export const DEFAULT_ATTACHMENT_BACKFILL_WINDOW_UIDS = 500;
const ATTACHMENT_BACKFILL_WINDOW_UIDS_ENV = "PDPP_GMAIL_ATTACHMENT_BACKFILL_WINDOW_UIDS";

// ─── imapflow interface augmentation ────────────────────────────────────

/**
 * imapflow's published FetchQueryObject omits Gmail's X-GM-MSGID selector
 * (`emailId`) even though the implementation supports it. Extending here
 * rather than casting preserves type-checking on every other field.
 */
interface ExtendedFetchQuery extends FetchQueryObject {
  emailId?: boolean;
}

// ─── Stdin / stdout plumbing ────────────────────────────────────────────

// Readline interface for stdin. Initialized inside the isMainModule guard
// at the bottom of the file so importing index.ts from tests doesn't
// open stdin and keep the Node event loop alive.
let rl: ReadlineInterface | null = null;

function getReadline(): ReadlineInterface {
  if (!rl) {
    rl = createInterface({ input: process.stdin, terminal: false });
  }
  return rl;
}

// Track in-flight writes so back-pressured, partial stdout writes can't
// produce interleaved or truncated JSONL lines on the runtime side. Bodies
// on the `message_bodies` stream can exceed 200 KB each, which is well
// above the default pipe buffer (~64 KB on Linux). A blocking write alone
// isn't enough: Node returns `false` from write() without sending any
// bytes on a full pipe, and the caller must wait for 'drain' before the
// next write.
//
// Gmail uses `sanitizeForJsonl` (parsers.ts) to scrub lone surrogates and
// control chars out of body text before encoding. The JSONL encoding
// itself — BigInt coercion + U+2028/U+2029 escaping — lives in
// `stringifyForJsonl`.
function emit(msg: EmittedMessage): Promise<void> {
  const line = stringifyForJsonl(sanitizeForJsonl(msg));
  const ok = process.stdout.write(line);
  if (ok) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    process.stdout.once("drain", () => {
      resolve();
    });
  });
}

function flushAndExit(code: number): void {
  flushAndExitAfterRuntimeAck(code);
}

function fail(m: string, retryable = false): void {
  emit({
    type: "DONE",
    status: "failed",
    records_emitted: 0,
    error: { message: m, retryable },
  }).catch((): undefined => undefined);
  flushAndExit(1);
}

const nowIso = (): string => new Date().toISOString();

let interactionCounter = 0;
function nextInteractionId(): string {
  interactionCounter += 1;
  return `int_${Date.now()}_${interactionCounter}`;
}

// Block on stdin until we receive INTERACTION_RESPONSE matching request_id.
async function sendInteractionAndWait(msg: InteractionMessage): Promise<InteractionResponse> {
  await emit(msg);
  const reqId = msg.request_id;
  const reader = getReadline();
  return new Promise<InteractionResponse>((resolve, reject) => {
    const onLine = (line: string): void => {
      try {
        const parsed = JSON.parse(line) as InteractionResponse;
        if (parsed.type === "INTERACTION_RESPONSE" && parsed.request_id === reqId) {
          reader.off("line", onLine);
          resolve(parsed);
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    reader.on("line", onLine);
  });
}

// Clock-dependent ISO conversion — lives here because the fallback reaches
// for wall-clock time. Pure-date conversion is inlined in parsers.ts tests.
function internalDateToIso(date: Date | string | undefined): string {
  if (!date) {
    return nowIso();
  }
  return new Date(date).toISOString();
}

// ─── Startup: credentials + scope ───────────────────────────────────────

/** Progress cadence for the body pass — emit a PROGRESS message every N
 *  processed rows. Exported so the extraction preserves observable
 *  behavior; tests rely on the boundary. */
export const FETCH_MSG_PROGRESS = 500;

export type EmitRecordFn = (
  stream: string,
  data: Record<string, unknown>,
  keyField?: "id" | "name"
) => Promise<boolean> | Promise<void>;

export type ProgressEmitter = (msg: ProgressMessage) => Promise<void>;

/** Bodies resolved for one message. All fields may be null if the fetch
 *  failed, the message has no matching parts, or scope didn't ask. */
export interface FetchedBodies {
  bodyHtmlFull: string | null;
  bodyTextFull: string | null;
  snippet: string | null;
}

/**
 * Injected body fetcher. Production wires this to an IMAP round-trip;
 * tests wire it to a pure function that returns canned bodies (or a
 * rejected promise to simulate fetch failure — the helper turns that
 * into all-nulls internally).
 */
export type FetchBodiesFn = (
  msg: FetchMessageObject,
  selection: BodyPartSelection,
  wantBodies: boolean,
  wantMessages: boolean
) => Promise<FetchedBodies>;

export interface AttachmentDownload {
  content: AsyncIterable<Buffer | Uint8Array | string>;
  expectedSize: number | null;
  mimeType: string;
}

export type FetchAttachmentFn = (msg: FetchMessageObject, attachment: AttachmentRecord) => Promise<AttachmentDownload>;

export type UploadAttachmentBlobFn = (args: {
  content: AsyncIterable<Buffer | Uint8Array | string>;
  connectorId: string;
  mimeType: string;
  recordKey: string;
  stream: "attachments";
}) => Promise<BlobRef>;

export type HydrateAttachmentFn = (msg: FetchMessageObject, attachment: AttachmentRecord) => Promise<AttachmentRecord>;

export interface AttachmentBackfillSummary {
  failed: number;
  hydrated: number;
  remaining_historical_gaps: number;
  too_large: number;
  unavailable_skipped: number;
}

export function createAttachmentBackfillSummary(): AttachmentBackfillSummary {
  return {
    failed: 0,
    hydrated: 0,
    remaining_historical_gaps: 0,
    too_large: 0,
    unavailable_skipped: 0,
  };
}

export function addAttachmentBackfillRecordToSummary(
  summary: AttachmentBackfillSummary,
  data: Record<string, unknown>
): void {
  switch (data.hydration_status) {
    case "hydrated":
      summary.hydrated += 1;
      break;
    case "too_large":
      summary.too_large += 1;
      summary.remaining_historical_gaps += 1;
      break;
    case "failed":
      summary.failed += 1;
      summary.remaining_historical_gaps += 1;
      break;
    case "deferred":
      summary.unavailable_skipped += 1;
      summary.remaining_historical_gaps += 1;
      break;
    default:
      summary.unavailable_skipped += 1;
      summary.remaining_historical_gaps += 1;
      break;
  }
}

export function formatAttachmentBackfillSummary(summary: AttachmentBackfillSummary): string {
  return [
    `hydrated=${summary.hydrated}`,
    `too_large=${summary.too_large}`,
    `failed=${summary.failed}`,
    `unavailable_skipped=${summary.unavailable_skipped}`,
    `remaining_historical_gaps=${summary.remaining_historical_gaps}`,
  ].join(" ");
}

/**
 * Per-run honest coverage accounting for the `attachments` detail stream.
 *
 * Every attachment decoded from a message's BODYSTRUCTURE during the run is
 * a key we attempted to hydrate, so it lands in `requiredKeys` (the
 * denominator). Each attempted hydration then lands in exactly one outcome
 * bucket by its `hydration_status`:
 *   - `hydrated`  → `hydratedKeys` (the numerator: blob bytes committed).
 *   - `failed`    → `gapKeys` (a retryable detail gap to re-attempt next run).
 *   - `too_large` → `optionalSkipKeys` (a permanent, by-policy skip — NOT a
 *                   gap, because the next run will skip it again on the same
 *                   size cap; counting it as a gap would falsely report the
 *                   stream as never-complete).
 *
 * This is the real `considered` axis the progress-evidence contract asks for:
 * the count is observed from the run, never inferred. Streams without an
 * attempt-per-key denominator (threads, labels, message_bodies) emit no
 * coverage rather than a fabricated one.
 */
export interface AttachmentDetailCoverage {
  /**
   * Failed attachment records, retained so the run can emit one matching
   * DETAIL_GAP per `gapKeys` entry. The host commit-gate credits a missing
   * required key only when it is hydrated, optional-skipped, or backed by a
   * durable pending DETAIL_GAP — `gap_keys` alone do not satisfy it. Each
   * record's `id` is exactly the value that landed in `gapKeys`, keeping the
   * gap's `record_key` and the coverage key a single source of truth.
   */
  failedRecords: AttachmentRecord[];
  gapKeys: string[];
  hydratedKeys: string[];
  optionalSkipKeys: string[];
  requiredKeys: string[];
}

/** Fresh, empty accumulator for one attachments detail pass. */
export function makeAttachmentDetailCoverage(): AttachmentDetailCoverage {
  return { failedRecords: [], gapKeys: [], hydratedKeys: [], optionalSkipKeys: [], requiredKeys: [] };
}

/**
 * Record one attempted attachment hydration into the coverage accumulator by
 * its terminal `hydration_status`. A `deferred` status (never hydrated this
 * run) is still a considered key but has no terminal outcome bucket, so it
 * counts only toward the denominator. Pure: mutates the passed accumulator.
 */
export function recordAttachmentCoverage(coverage: AttachmentDetailCoverage, record: AttachmentRecord): void {
  coverage.requiredKeys.push(record.id);
  switch (record.hydration_status) {
    case "hydrated":
      coverage.hydratedKeys.push(record.id);
      return;
    case "failed":
      coverage.gapKeys.push(record.id);
      // Retain the record so a matching DETAIL_GAP is emitted for this key.
      // `gap_keys` on DETAIL_COVERAGE are not enough on their own: the host
      // commit-gate requires a durable pending DETAIL_GAP to credit the key.
      coverage.failedRecords.push(record);
      return;
    case "too_large":
      coverage.optionalSkipKeys.push(record.id);
      return;
    default:
      // `deferred`: considered but not hydrated this run; denominator only.
      return;
  }
}

/**
 * Build the per-run attachments DETAIL_COVERAGE after the detail lane settles.
 * A requested attachments pass that scans the parent `messages` boundary and
 * finds zero attachment parts has a real empty denominator: `required_keys: []`
 * means "nothing owed", not "unknown". The list cursor that anchors this
 * detail pass lives on `messages`, so that is the `state_stream`.
 * Reference-only: this reuses DETAIL_COVERAGE without promoting it to portable
 * protocol.
 *
 * Extracted from `emitAttachmentDetailCoverage` so the zero-attachment case is
 * testable without capturing process stdout.
 */
export function buildAttachmentDetailCoverageMessage(coverage: AttachmentDetailCoverage): DetailCoverageMessage {
  return buildDetailCoverageMessage({
    stream: "attachments",
    stateStream: "messages",
    requiredKeys: coverage.requiredKeys,
    hydratedKeys: coverage.hydratedKeys,
    gapKeys: coverage.gapKeys,
    optionalSkipKeys: coverage.optionalSkipKeys,
    considered: coverage.requiredKeys.length,
    covered: coverage.hydratedKeys.length + coverage.optionalSkipKeys.length,
  });
}

/**
 * Emit the per-run attachments DETAIL_COVERAGE after the detail lane settles.
 *
 * Extracted from `runAllMailPasses` to keep that orchestrator under the
 * cognitive-complexity ceiling (authoring guide §"Rules the tooling enforces").
 */
async function emitAttachmentDetailCoverage(coverage: AttachmentDetailCoverage | undefined): Promise<void> {
  if (!coverage) {
    return;
  }
  await emit(buildAttachmentDetailCoverageMessage(coverage));
}

/**
 * Build the recoverable DETAIL_GAP for one failed attachment hydration.
 *
 * Every attachment that lands in `DETAIL_COVERAGE.gap_keys` (hydration_status
 * `failed`) needs a matching durable DETAIL_GAP: the host commit-gate credits a
 * missing required key only when it is hydrated, optional-skipped, or backed by
 * a pending DETAIL_GAP — `gap_keys` on their own are not enough, so without this
 * a successful run that failed even one attachment aborts at commit and the
 * messages cursor never advances, re-fetching the same window every run.
 *
 * `record_key` is the attachment `id` (`<X-GM-MSGID>:<part_index>`), the exact
 * value already in `gap_keys`, so the gate matches one-to-one. `reason` is
 * `temporary_unavailable` (retryable): the `failed` bucket mixes transient
 * download/network/parse errors with no exhaustion signal, mirroring Amazon's
 * order-detail gap; retrying next run is the honest, non-destructive default.
 *
 * Reference-only and bounded: only opaque message and part identifiers cross
 * (X-GM-MSGID, the BODYSTRUCTURE part index, and the attachment id). No
 * filename, content, blob bytes, raw error text, tokens, cookies, URLs, request
 * bodies, or payload snippets are carried.
 */
export function buildAttachmentDetailGap(attachment: AttachmentRecord): DetailGapMessage {
  return buildDetailGap({
    stream: "attachments",
    parentStream: "messages",
    recordKey: attachment.id,
    reason: "temporary_unavailable",
    locator: {
      kind: "gmail.attachment_detail",
      message_id: attachment.message_id,
      part_index: attachment.part_index,
      attachment_id: attachment.id,
    },
  });
}

function normalizeAttachmentRecoveryKey(recordKey: string | number | null | undefined): string | null {
  if (recordKey == null) {
    return null;
  }
  const key = String(recordKey).trim();
  return key.length > 0 ? key : null;
}

function attachmentDetailGapMatches(
  gap: DetailGapStartEntry,
  attachment: AttachmentRecord,
  normalizedAttachmentKey: string
): boolean {
  if (gap.stream !== "attachments" || gap.status !== "pending") {
    return false;
  }
  if (normalizeAttachmentRecoveryKey(gap.record_key) !== normalizedAttachmentKey) {
    return false;
  }
  const locator = gap.detail_locator;
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
    return true;
  }
  const typedLocator = locator as Record<string, unknown>;
  if (typedLocator.kind !== "gmail.attachment_detail") {
    return false;
  }
  if (typedLocator.attachment_id != null && typedLocator.attachment_id !== attachment.id) {
    return false;
  }
  if (typedLocator.message_id != null && typedLocator.message_id !== attachment.message_id) {
    return false;
  }
  if (typedLocator.part_index != null && typedLocator.part_index !== attachment.part_index) {
    return false;
  }
  return true;
}

function findRecoveredAttachmentDetailGaps(
  detailGaps: readonly DetailGapStartEntry[] | undefined,
  attachment: AttachmentRecord,
  recoveredGapIds: ReadonlySet<string>
): DetailGapStartEntry[] {
  const normalizedAttachmentKey = normalizeAttachmentRecoveryKey(attachment.id);
  if (!(normalizedAttachmentKey && Array.isArray(detailGaps)) || detailGaps.length === 0) {
    return [];
  }
  const matches: DetailGapStartEntry[] = [];
  for (const gap of detailGaps) {
    if (!gap || recoveredGapIds.has(gap.gap_id)) {
      continue;
    }
    if (attachmentDetailGapMatches(gap, attachment, normalizedAttachmentKey)) {
      matches.push(gap);
    }
  }
  return matches;
}

async function emitAttachmentRecords(
  deps: PerMessageDeps,
  msg: FetchMessageObject,
  attachments: readonly AttachmentRecord[]
): Promise<void> {
  if (!deps.requested.has("attachments") || attachments.length === 0) {
    return;
  }
  const recoveredAttachmentGapIds = deps.recoveredAttachmentGapIds ?? new Set<string>();
  for (const a of attachments) {
    const hydrated = await deps.hydrateAttachment(msg, a);
    // Record the outcome BEFORE emitting so the coverage denominator counts
    // every attempt even if the emit is scope-filtered downstream.
    if (deps.attachmentCoverage) {
      recordAttachmentCoverage(deps.attachmentCoverage, hydrated);
    }
    const emitted = await deps.emitRecord("attachments", { ...hydrated });
    // `emitted` only proves the record landed, not that hydration succeeded —
    // a `failed` (and `deferred`) attachment still emits a record so the
    // coverage denominator is honest. Only `hydrated` (a real blob fill) may
    // acknowledge a served gap as recovered. `too_large` is deliberately
    // excluded even though the commit-gate already treats it as covered via
    // `optionalSkipKeys`: it is a permanent by-policy skip, never the subject
    // of a durable DETAIL_GAP in the first place (gaps are only ever created
    // for `failed`, see `emitAttachmentDetailGaps`), so there is nothing to
    // recover — the pre-existing pending row (from an earlier `failed`
    // attempt, before a size cap started applying) is already harmless and
    // left to age/terminalize on its own.
    if (!emitted || hydrated.hydration_status !== "hydrated") {
      continue;
    }
    const recoveredGaps = findRecoveredAttachmentDetailGaps(deps.detailGaps, hydrated, recoveredAttachmentGapIds);
    for (const gap of recoveredGaps) {
      recoveredAttachmentGapIds.add(gap.gap_id);
      await deps.emitProtocol({
        type: "DETAIL_GAP_RECOVERED",
        reference_only: true,
        gap_id: gap.gap_id,
        record_key: hydrated.id,
        stream: "attachments",
      });
    }
  }
}

/**
 * Emit one DETAIL_GAP per failed attachment retained during the run, mirroring
 * `emitAttachmentDetailCoverage`. Emitted right after the coverage report and
 * before the messages STATE commits, so the gate sees every gap as durable when
 * it credits required keys. No-ops when nothing failed.
 */
async function emitAttachmentDetailGaps(coverage: AttachmentDetailCoverage | undefined): Promise<void> {
  if (!coverage) {
    return;
  }
  for (const attachment of coverage.failedRecords) {
    await emit(buildAttachmentDetailGap(attachment));
  }
}

export interface PerMessageDeps {
  /**
   * Optional accumulator for the `attachments` detail-coverage report. When
   * present, `processMessage` records every attachment it attempts to hydrate
   * so the pass driver can emit one honest DETAIL_COVERAGE after the lane
   * settles. Absent for passes that have no attachments denominator.
   */
  attachmentCoverage?: AttachmentDetailCoverage;
  detailGaps?: readonly DetailGapStartEntry[] | undefined;
  emitProgress: ProgressEmitter;
  emitProtocol: (msg: EmittedMessage) => Promise<void>;
  emitRecord: EmitRecordFn;
  fetchBodies: FetchBodiesFn;
  hydrateAttachment: HydrateAttachmentFn;
  nowIso: () => string;
  recoveredAttachmentGapIds?: Set<string>;
  requested: Map<string, StreamRequest>;
  timeRange: { since?: string; until?: string } | undefined;
  wantBodies: boolean;
  wantMessages: boolean;
}

function perMessageInternalDateToIso(date: Date | string | undefined, nowIsoFn: () => string): string {
  if (!date) {
    return nowIsoFn();
  }
  return new Date(date).toISOString();
}

/**
 * Emit the per-stream records for one Gmail message.
 *
 * Invariants (tested in integration.test.ts):
 *   1. No X-GM-MSGID → skip silently (return false).
 *   2. time_range filter skips out-of-range messages.
 *   3. Emit order within a single message: message_bodies → messages →
 *      attachments. The per-message order matters because downstream
 *      consumers rely on bodies being present before the messages row
 *      that references them.
 *   4. wantBodies / wantMessages / requested.has("attachments") each
 *      gate their own stream; disabling one doesn't suppress siblings.
 *   5. Body-fetch failure (returned all-nulls) still emits the messages
 *      record with a null snippet — never silently drops the envelope.
 *
 * Returns true if the message produced any emits (or would have, modulo
 * scope). Returns false when skipped by an early filter so the caller
 * can skip progress accounting.
 */
export async function processMessage(deps: PerMessageDeps, msg: FetchMessageObject): Promise<boolean> {
  // Gmail-specific IDs via imapflow: msg.emailId = X-GM-MSGID; msg.threadId = X-GM-THRID.
  const gmMsgid = String(msg.emailId ?? "");
  const gmThrid = String(msg.threadId ?? "");
  if (!gmMsgid) {
    return false;
  }

  const env = msg.envelope ?? {};
  const receivedAt = perMessageInternalDateToIso(msg.internalDate, deps.nowIso);
  if (!isInTimeRange(receivedAt, deps.timeRange)) {
    return false;
  }
  const dateHeader = env.date ? new Date(env.date).toISOString() : null;
  const flagsArr = toFlagsArray(msg.flags);
  const labels = toLabelsArray(msg.labels);
  const attachments = decodeBodystructureForAttachments(msg.bodyStructure, gmMsgid, receivedAt);

  const selection = selectBodyParts(msg.bodyStructure, deps.wantBodies);
  const { bodyHtmlFull, bodyTextFull, snippet } = await deps.fetchBodies(
    msg,
    selection,
    deps.wantBodies,
    deps.wantMessages
  );

  if (deps.wantBodies) {
    await deps.emitRecord(
      "message_bodies",
      buildMessageBodyRecord({
        bodyHtmlFull,
        bodyTextFull,
        gmMsgid,
        htmlCharset: selection.htmlCharset,
        textCharset: selection.plainCharset,
      })
    );
  }

  if (deps.wantMessages) {
    await deps.emitRecord(
      "messages",
      buildMessageRecord({
        attachmentsCount: attachments.length,
        dateHeader,
        envelope: env,
        flagsArr,
        gmMsgid,
        gmThrid,
        labels,
        rawHeaders: msg.headers,
        receivedAt,
        sizeBytes: typeof msg.size === "number" ? msg.size : null,
        snippet,
      })
    );
  }

  await emitAttachmentRecords(deps, msg, attachments);
  return true;
}

/**
 * Phase B driver: iterate metas, emit records, report progress every
 * FETCH_MSG_PROGRESS rows. Per-message errors are logged to stderr and
 * swallowed so a single bad message doesn't halt the whole pass.
 */
export async function emitMessagesPass(deps: PerMessageDeps, metas: readonly FetchMessageObject[]): Promise<void> {
  let count = 0;
  for (const msg of metas) {
    try {
      const processed = await processMessage(deps, msg);
      if (!processed) {
        continue;
      }
      count += 1;
      if (count % FETCH_MSG_PROGRESS === 0) {
        await deps.emitProgress({
          type: "PROGRESS",
          stream: "messages",
          message: `Fetched ${count} messages`,
          count,
          total: metas.length,
        });
      }
    } catch (perMsgErr) {
      const emsg = perMsgErr instanceof Error ? (perMsgErr.stack ?? perMsgErr.message) : String(perMsgErr);
      process.stderr.write(`[gmail] per-message error at UID ${String(msg.uid)}: ${emsg}\n`);
      // Continue with next message; don't let one bad record halt the whole run.
    }
  }
}

/** Read one START line from stdin, or reject if malformed. */
function readStartMessage(reader: ReadlineInterface): Promise<StartMessage> {
  return new Promise<StartMessage>((resolve, reject) => {
    reader.once("line", (line: string) => {
      try {
        resolve(JSON.parse(line) as StartMessage);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

/** Resolve the Gmail app password from env or via INTERACTION kind=credentials. */
export function resolveGmailPasswordFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GOOGLE_APP_PASSWORD_PDPP || env.GMAIL_APP_PASSWORD || null;
}

async function resolvePassword(): Promise<string | null> {
  const envPassword = resolveGmailPasswordFromEnv();
  if (envPassword) {
    return envPassword;
  }
  try {
    const creds = await requireCredentialsOrAsk({
      required: [["GOOGLE_APP_PASSWORD_PDPP", "GMAIL_APP_PASSWORD"]],
      connectorName: "Gmail",
      sendInteraction: (req) => {
        const wrapped: InteractionMessage = {
          type: "INTERACTION",
          request_id: req.request_id ?? nextInteractionId(),
          kind: req.kind,
          message: req.message,
          ...(req.schema === undefined ? {} : { schema: req.schema }),
          ...(req.timeout_seconds === undefined ? {} : { timeout_seconds: req.timeout_seconds }),
        };
        return sendInteractionAndWait(wrapped).then((resp) => ({
          type: "INTERACTION_RESPONSE" as const,
          request_id: resp.request_id,
          status: resp.status,
          ...(resp.data === undefined ? {} : { data: resp.data as Record<string, string> }),
        }));
      },
    });
    return creds.GOOGLE_APP_PASSWORD_PDPP ?? null;
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), false);
    return null;
  }
}

/**
 * Resolve the Gmail address from env (GMAIL_ADDRESS, GMAIL_USER, or
 * AMAZON_USERNAME if it looks like an email) or by asking the user via
 * INTERACTION.
 */
export function resolveGmailAddressFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.GMAIL_ADDRESS) {
    return env.GMAIL_ADDRESS;
  }
  if (env.GMAIL_USER) {
    return env.GMAIL_USER;
  }
  if (env.AMAZON_USERNAME && EMAIL_AT_RE.test(env.AMAZON_USERNAME)) {
    return env.AMAZON_USERNAME;
  }
  return null;
}

/**
 * Mask an email address for an operator/model-visible PROGRESS message.
 *
 * The owner's full Gmail address is a raw PII identifier; emitting it verbatim
 * in a PROGRESS line leaks it to every consumer of the run stream (dashboard,
 * timeline, logs, model). We still want the progress line to confirm *which
 * account/domain* connected, so we keep the domain and the first character of
 * the local-part and mask the rest:
 *
 *   "taylor.rivera@example.com"  ->  "t***@example.com"
 *   "x@example.com"            ->  "***@example.com"
 *
 * If the value does not look like an `local@domain` address (no `@`, or an
 * empty domain), we return a constant placeholder rather than risk echoing an
 * unexpected raw value. The output never contains the full local-part.
 */
export function redactEmailForProgress(address: string): string {
  const match = EMAIL_SPLIT_RE.exec(address);
  const local = match?.[1];
  const domain = match?.[2];
  if (!(local && domain)) {
    return "[redacted-account]";
  }
  const head = local.length > 1 ? local[0] : "";
  return `${head}***@${domain}`;
}

async function resolveAddress(): Promise<string | null> {
  const fromEnv = resolveGmailAddressFromEnv();
  if (fromEnv) {
    return fromEnv;
  }
  const resp = await sendInteractionAndWait({
    type: "INTERACTION",
    request_id: nextInteractionId(),
    kind: "credentials",
    message: "Gmail address to sync (the account the app password was generated for)",
    schema: {
      type: "object",
      properties: { email: { type: "string", format: "email" } },
      required: ["email"],
    },
    timeout_seconds: DEFAULT_CRED_TIMEOUT_S,
  });
  if (resp.status === "success" && resp.data && typeof resp.data.email === "string") {
    return resp.data.email;
  }
  return null;
}

// ─── Labels stream ──────────────────────────────────────────────────────

/**
 * Parse the prior `labels` STATE cursor's `fingerprints` map. The cursor
 * shape is `state.labels.fingerprints` keyed by label `name`. Legacy
 * cursors (pre-fingerprint: only `{ fetched_at }`) decode to an empty
 * map, so the first post-deploy run rebuilds the map and re-emits every
 * label exactly once.
 */
export function readPriorLabelFingerprints(state: Record<string, unknown>): Map<string, string> {
  const streamState = (state.labels ?? {}) as Record<string, unknown>;
  const raw = streamState.fingerprints;
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out.set(id, value);
    }
  }
  return out;
}

/**
 * Emit the IMAP mailbox list as `labels` records, gated through a
 * per-label fingerprint cursor so an unchanged mailbox set does not
 * append a new version of every label on every run.
 *
 * The labels record body is `{ name, canonical_name, is_system,
 * parent_name, message_count }`. `message_count` is hardcoded `null`,
 * and there is no run-clock field in the record (the `fetched_at`
 * lives only in the STATE cursor). So the record's stable-JSON IS the
 * change signal: a label only re-emits when its name/derived flags
 * actually change. No fields are excluded from the fingerprint.
 *
 * Before this gate, `labels` re-emitted every mailbox unconditionally
 * each run, accumulating ~269 versions per label of byte-identical
 * history.
 */
async function emitLabelsStream(
  client: ImapFlow,
  emitRecord: EmitRecordFn,
  state: Record<string, unknown>
): Promise<void> {
  // `labels` is keyed by `name`, not `id`, and the stored record body has
  // no `id` field. The fingerprint cursor keys on `data.id`, so we pass a
  // keying `id` (the label name) but EXCLUDE it from the fingerprint —
  // leaving the hash computed over exactly the stored record body
  // (`{name, canonical_name, is_system, parent_name, message_count}`).
  // This keeps byte-parity with the compaction script, which fingerprints
  // the stored `record_json` (no `id`) with an empty exclude set.
  const cursor = openFingerprintCursor(state, {
    excludeFromFingerprint: ["id"],
    priorFingerprints: readPriorLabelFingerprints(state),
  });
  const mailboxes: ListResponse[] = await client.list();
  for (const mb of mailboxes) {
    const name = mb.path;
    const record = {
      name,
      canonical_name: canonicalLabelName(name),
      is_system: isGmailSystemLabel(name),
      parent_name: labelParentName(name),
      message_count: null, // we could SELECT each to get EXISTS but not worth it
    };
    // Fingerprint by the label `name` (the record key for this stream).
    if (cursor.shouldEmit({ id: name, ...record })) {
      await emitRecord("labels", record, "name");
    }
  }
  // Drop fingerprints for mailboxes that disappeared so a future
  // re-creation re-emits. `labels` is always a full scan.
  cursor.pruneStale();
  const labelsCursor: Record<string, unknown> = { fetched_at: nowIso() };
  if (cursor.size() > 0) {
    labelsCursor.fingerprints = cursor.toState();
  }
  await emit({
    type: "STATE",
    stream: "labels",
    cursor: labelsCursor,
  });
}

// ─── All Mail resolution + cursor ───────────────────────────────────────

/** Locate the [Gmail]/All Mail mailbox via \All special-use or fallback path. */
async function findAllMailbox(client: ImapFlow): Promise<ListResponse | null> {
  const mailboxes: ListResponse[] = await client.list();
  return mailboxes.find((m) => m.specialUse === "\\All" || m.path === "[Gmail]/All Mail") ?? null;
}

interface AllMailSession {
  attachmentBackfill: AttachmentAllMailCursor;
  fullResync: boolean;
  highestModseqCursor: number | string | null;
  priorModseq: number | string | null | undefined;
  priorUidnext: number;
  uidnext: number | undefined;
  uidvalidityNum: number;
}

/**
 * Narrow the MailboxObject + prior state into the (UIDVALIDITY, cursor,
 * resync-flag) triple the fetch loop needs. Returns null when UIDVALIDITY
 * is missing (caller should fail).
 */
function deriveAllMailSession(mailbox: MailboxObject, state: Record<string, unknown>): AllMailSession | null {
  const uidvalidityNum = bigintToNumber(mailbox.uidValidity);
  if (uidvalidityNum === null) {
    return null;
  }
  // The RS returns state as { <stream>: <cursor>, ... } where each <cursor>
  // is the object the connector put in the STATE message's .cursor field.
  // This connector emits STATE with stream='messages' and
  // cursor={all_mail:{uidvalidity,uidnext,highest_modseq}}, so the correct
  // read path is state.messages.all_mail — NOT state.all_mail. Prior code
  // read the top level, resolving to undefined on every run and silently
  // forcing full-refresh. Observed 2026-04-21: state persisted correctly
  // but every run did a full 1:* fetch. Also accept the legacy top-level
  // shape in case any historical state was written before this fix.
  const messagesState = (state.messages ?? {}) as PriorMessagesState;
  const attachmentsState = (state.attachments ?? {}) as PriorAttachmentsState;
  const legacyState = state as { all_mail?: AllMailCursor };
  const priorAllMail: AllMailCursor = messagesState.all_mail ?? legacyState.all_mail ?? {};
  const priorAttachmentAllMail: AttachmentAllMailCursor = attachmentsState.all_mail ?? {};
  const priorUidvalidity = priorAllMail.uidvalidity;
  const attachmentBackfill =
    priorAttachmentAllMail.uidvalidity === uidvalidityNum
      ? priorAttachmentAllMail
      : {
          completed_at: null,
          uidvalidity: uidvalidityNum,
        };
  return {
    attachmentBackfill,
    fullResync: !priorUidvalidity || priorUidvalidity !== uidvalidityNum,
    highestModseqCursor: bigintToCursor(mailbox.highestModseq),
    priorModseq: priorAllMail.highest_modseq,
    priorUidnext: priorAllMail.uidnext ?? 1,
    uidnext: mailbox.uidNext,
    uidvalidityNum,
  };
}

// ─── Phase A: metadata collection ───────────────────────────────────────

async function collectMetadata(client: Pick<ImapFlow, "fetch">, fetchRange: string): Promise<FetchMessageObject[]> {
  const metas: FetchMessageObject[] = [];
  for await (const m of client.fetch(fetchRange, GMAIL_METADATA_FETCH_QUERY, { uid: true })) {
    metas.push(m);
    if (metas.length % FETCH_HEADER_BATCH_PROGRESS === 0) {
      await emit({
        type: "PROGRESS",
        stream: "messages",
        message: `Collected ${metas.length} message headers`,
        count: metas.length,
      });
    }
  }
  await emit({
    type: "PROGRESS",
    stream: "messages",
    message: `Collected ${metas.length} message headers`,
    count: metas.length,
    total: metas.length,
  });
  return metas;
}

// ─── Phase B: per-message body fetch + emit ────────────────────────────

type BodyPartRequest =
  | string
  | {
      key: string;
      start?: number;
      maxLength?: number;
    };

/** Build the bodyParts request list given the selection + scope. */
function buildBodyPartsRequest(selection: ReturnType<typeof selectBodyParts>, wantBodies: boolean): BodyPartRequest[] {
  const parts: BodyPartRequest[] = [];
  if (selection.plainPart) {
    // Full body if we need message_bodies; otherwise bounded for snippet.
    parts.push(
      wantBodies
        ? { key: selection.plainPart }
        : {
            key: selection.plainPart,
            start: 0,
            maxLength: SNIPPET_FETCH_MAX_BYTES,
          }
    );
  }
  if (wantBodies && selection.htmlPart) {
    parts.push({ key: selection.htmlPart });
  }
  return parts;
}

/**
 * Decode fetched body buffers into strings + optional snippet per the
 * caller's scope. Never throws; missing buffers resolve to nulls.
 */
function decodeFetchedBodies(
  plainBuf: Buffer | null,
  htmlBuf: Buffer | null,
  selection: ReturnType<typeof selectBodyParts>,
  wantBodies: boolean,
  wantMessages: boolean
): FetchedBodies {
  let bodyTextFull: string | null = null;
  let bodyHtmlFull: string | null = null;
  let snippet: string | null = null;
  if (plainBuf) {
    if (wantBodies) {
      bodyTextFull = decodeBodyPart(plainBuf, selection.plainEncoding, selection.plainCharset);
    }
    if (wantMessages) {
      snippet = makeSnippet(plainBuf, selection.plainEncoding, selection.plainCharset, SNIPPET_MAX_CHARS);
    }
  }
  if (htmlBuf && wantBodies) {
    bodyHtmlFull = decodeBodyPart(htmlBuf, selection.htmlEncoding, selection.htmlCharset);
  }
  return { bodyHtmlFull, bodyTextFull, snippet };
}

/**
 * Fetch (and decode) the parts we need for one message in a single IMAP
 * round-trip. Best-effort: body fetch failures return all-nulls so the
 * caller can still emit the envelope record.
 */
async function fetchBodies(
  client: ImapFlow,
  msg: FetchMessageObject,
  selection: ReturnType<typeof selectBodyParts>,
  wantBodies: boolean,
  wantMessages: boolean
): Promise<FetchedBodies> {
  const empty: FetchedBodies = { bodyHtmlFull: null, bodyTextFull: null, snippet: null };
  if (!(msg.uid && (wantBodies || (wantMessages && selection.plainPart)))) {
    return empty;
  }
  const parts = buildBodyPartsRequest(selection, wantBodies);
  if (parts.length === 0) {
    return empty;
  }
  try {
    const bodyResp = await client.fetchOne(String(msg.uid), { bodyParts: parts }, { uid: true });
    const plainBuf = selection.plainPart && bodyResp ? (bodyResp.bodyParts?.get(selection.plainPart) ?? null) : null;
    const htmlBuf = selection.htmlPart && bodyResp ? (bodyResp.bodyParts?.get(selection.htmlPart) ?? null) : null;
    return decodeFetchedBodies(plainBuf, htmlBuf, selection, wantBodies, wantMessages);
  } catch {
    // Best-effort: body fetch failures shouldn't block message emit.
    return empty;
  }
}

export function selectAllMailFetchRange(
  session: { fullResync: boolean; priorUidnext: number },
  _requested: Map<string, StreamRequest>
): string {
  // Range is determined purely by the persisted cursor:
  //   - Full resync (no prior uidvalidity, or it changed): 1:*.
  //   - Incremental: priorUidnext:* — only UIDs we haven't seen yet.
  //
  // The earlier behavior forced 1:* whenever the run scope included
  // `attachments`. Rationale at the time was: enable attachment
  // backfill when a user first turns the stream on. The cost was real:
  // every Gmail sync re-scanned the entire mailbox forever, not just
  // the once-after-enabling pass.
  //
  // The correct shape is to treat backfill as an explicit, per-stream
  // operation rather than an implicit side effect of stream selection.
  // For new attachments on new messages — the common case — the
  // incremental range already covers them: new UIDs land in `metas`
  // and `processMessage` emits attachment records for them
  // (lines 357-361).
  //
  // Historical attachment recovery is still bounded by the dedicated
  // attachment backfill cursor, but a pending attachment detail backlog also
  // activates that path so a healthy-looking messages cursor does not hide
  // durable attachment work.
  if (session.fullResync) {
    return "1:*";
  }
  return `${session.priorUidnext}:*`;
}

export function isAttachmentBackfillRequested(streamsToBackfill: readonly string[] | undefined): boolean {
  return Array.isArray(streamsToBackfill) && streamsToBackfill.includes("attachments");
}

function hasPendingAttachmentBacklog(detailGaps: readonly DetailGapStartEntry[] | undefined): boolean {
  return (
    Array.isArray(detailGaps) && detailGaps.some((gap) => gap.stream === "attachments" && gap.status === "pending")
  );
}

/**
 * Historical attachment backfill should run when the operator asked for it or
 * when the runtime hands the connector pending attachment detail gaps. The
 * latter is the recovery-first seam: durable attachment backlog should not
 * look healthy just because the ordinary messages cursor is current.
 */
export function shouldBackfillAttachments(args: {
  detailGaps?: readonly DetailGapStartEntry[] | undefined;
  streamsToBackfill?: readonly string[] | undefined;
}): boolean {
  return isAttachmentBackfillRequested(args.streamsToBackfill) || hasPendingAttachmentBacklog(args.detailGaps);
}

export function selectAttachmentBackfillFetchRange(session: {
  attachmentBackfill: AttachmentAllMailCursor;
  maxWindowUids?: number;
  priorUidnext: number;
}): string | null {
  const backfilledThrough = session.attachmentBackfill.backfilled_through_uid ?? 0;
  const startUid = Math.max(1, backfilledThrough + 1);
  const endUid = Math.max(0, session.priorUidnext - 1);
  if (startUid > endUid) {
    return null;
  }
  const maxWindowUids = normalizeAttachmentBackfillWindowUids(session.maxWindowUids);
  const windowEndUid = Math.min(endUid, startUid + maxWindowUids - 1);
  return `${startUid}:${windowEndUid}`;
}

export function resolveAttachmentBackfillWindowUids(env: NodeJS.ProcessEnv = process.env): number {
  const value = env[ATTACHMENT_BACKFILL_WINDOW_UIDS_ENV];
  if (!(value && POSITIVE_INTEGER_PATTERN.test(value))) {
    return DEFAULT_ATTACHMENT_BACKFILL_WINDOW_UIDS;
  }
  return normalizeAttachmentBackfillWindowUids(Number(value));
}

function normalizeAttachmentBackfillWindowUids(value: number | undefined): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  return DEFAULT_ATTACHMENT_BACKFILL_WINDOW_UIDS;
}

// ─── Historical attachment backfill: byte-cost-bounded page sizing ────────
//
// A fixed UID count is a poor unit of completed work for historical
// attachment backfill: two UIDs can differ by orders of magnitude in
// attachment bytes to transfer (see gmail-blob-throughput-rootcause-0715.md
// — a single 4.77 MB attachment observed at ~5.7 KB/s). Mirrors
// reference-implementation/runtime/detail-gap-paging.js's byte-budget-clamp
// and trim-to-budget-with-at-least-one-entry pattern as Gmail-local policy:
// the generic detail-gap-paging module is not modified and gains no Gmail
// knowledge.
//
// Unlike the generic detail-gap page (which has no per-row size hint and so
// needs a learned observed-average), Gmail already knows each UID's
// attachment byte cost up front from BODYSTRUCTURE (fetched pre-download by
// collectMetadata). There is no cross-page learning here: the historical
// backfill emits exactly one page per run (see runAllMailPasses), so an
// EWMA "observed average that adapts across pages" would have nothing to
// adapt across and was removed as dead complexity. A UID whose attachment
// size is unavailable (BODYSTRUCTURE parse gap) falls back to a single
// fixed conservative estimate, not a learned one.
//
// Default sizing: at the live-incident worst-case observed throughput of
// ~5.7 KB/s (gmail-blob-throughput-rootcause-0715.md), a 1 MiB page is
// ~3 minutes of transfer time in the worst case, leaving headroom inside
// the connector's ~15-minute run cadence for the rest of the run's work
// (normal message walk, other streams). The max (4 MiB, ~12 min worst-case)
// stays under one cadence window; the min (256 KiB, <1 min worst-case) is a
// usable floor for an operator who wants faster, smaller pages. No
// wall-clock timer is introduced — the budget bounds completed work, not
// elapsed time.

export const ATTACHMENT_BACKFILL_PAGE_MIN_BYTES = 256 * 1024;
export const ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES = 1024 * 1024;
export const ATTACHMENT_BACKFILL_PAGE_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Fixed conservative per-UID cost used only when BODYSTRUCTURE reported no
 * usable attachment size. Not learned or updated — a single documented
 * fallback, chosen above the ordinary attachment-metadata overhead so a run
 * of unknown-size UIDs still forms a small, bounded page rather than an
 * unbounded one.
 */
export const ATTACHMENT_BACKFILL_UNKNOWN_SIZE_FALLBACK_BYTES = 256 * 1024;
const ATTACHMENT_BACKFILL_PAGE_BYTES_ENV = "PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES";

function boundedPositiveInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function attachmentBackfillPageByteBudget(configuredTargetBytes?: number): number {
  return boundedPositiveInteger(
    configuredTargetBytes,
    ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES,
    ATTACHMENT_BACKFILL_PAGE_MIN_BYTES,
    ATTACHMENT_BACKFILL_PAGE_MAX_BYTES
  );
}

export function resolveAttachmentBackfillPageByteBudget(env: NodeJS.ProcessEnv = process.env): number {
  const value = env[ATTACHMENT_BACKFILL_PAGE_BYTES_ENV];
  if (!(value && POSITIVE_INTEGER_PATTERN.test(value))) {
    return attachmentBackfillPageByteBudget();
  }
  return attachmentBackfillPageByteBudget(Number(value));
}

const GMAIL_METADATA_FETCH_QUERY: ExtendedFetchQuery = {
  uid: true,
  envelope: true,
  internalDate: true,
  flags: true,
  size: true,
  bodyStructure: true,
  headers: ["list-unsubscribe", "auto-submitted", "references"],
  source: false,
  labels: true,
  threadId: true,
  emailId: true,
};

/**
 * One UID's attachment byte cost, for page-size planning. `attachmentBytes`
 * is precomputed by the caller as: 0 for a UID with no attachments (a
 * no-attachment message must not consume the unknown-size fallback, or an
 * ordinary window of plain messages would starve to a handful admitted per
 * page); otherwise the sum of each attachment's known `size_bytes`, with
 * `ATTACHMENT_BACKFILL_UNKNOWN_SIZE_FALLBACK_BYTES` substituted per
 * attachment whose size is unavailable (never dropped, so a mix of known
 * and unknown attachment sizes is not underestimated).
 */
export interface AttachmentBackfillCandidate {
  readonly attachmentBytes: number;
  readonly uid: number;
}
export interface ServedAttachmentRecoverySummary {
  admitted: number;
  recovered: number;
}

type GmailMessageLookupClient = Pick<ImapFlow, "search" | "fetchOne">;
type GmailAttachmentBackfillClient = GmailMessageLookupClient & Pick<ImapFlow, "fetch">;

// Bound the served-gap probe lane so START.detail_gaps can never fan out into
// unbounded Gmail metadata work before byte admission has a chance to stop the
// prefix. Same-message gaps reuse a single lookup through the cache.
const SERVED_ATTACHMENT_RECOVERY_METADATA_LOOKUP_LIMIT = 32;

/**
 * Trim a candidate list — MUST already be sorted ascending by UID by the
 * caller; this function trusts array order and does not re-sort, so an
 * out-of-order input silently produces a wrong prefix — to a byte-cost
 * page: keep admitting candidates in order while the running total of
 * attachment bytes stays within budget, but always admit at least one
 * candidate (mirrors `trimDetailGapPageToByteBudget`'s at-least-one-entry
 * rule) so a single oversized attachment cannot block all backfill
 * progress. Returns a PREFIX COUNT, not a UID value or set, so the caller
 * derives the admitted page positionally (`candidates.slice(0, admittedCount)`)
 * rather than by comparing UIDs — immune to UID gaps.
 */
export function trimAttachmentBackfillPageToByteBudget(
  candidates: readonly AttachmentBackfillCandidate[],
  byteBudget: number
): { admittedCount: number; estimatedBytesTotal: number } {
  let admittedCount = 0;
  let estimatedBytesTotal = 0;
  for (const candidate of candidates) {
    const cost = candidate.attachmentBytes;
    if (admittedCount > 0 && estimatedBytesTotal + cost > byteBudget) {
      break;
    }
    admittedCount += 1;
    estimatedBytesTotal += cost;
    if (estimatedBytesTotal >= byteBudget) {
      break;
    }
  }
  return { admittedCount, estimatedBytesTotal };
}

function servedAttachmentDetailGaps(
  detailGaps: readonly DetailGapStartEntry[] | undefined
): readonly DetailGapStartEntry[] {
  if (!Array.isArray(detailGaps) || detailGaps.length === 0) {
    return [];
  }
  return detailGaps.filter((gap) => {
    if (gap.stream !== "attachments" || gap.status !== "pending") {
      return false;
    }
    const locator = gap.detail_locator;
    if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
      return false;
    }
    const typedLocator = locator as Record<string, unknown>;
    return (
      typedLocator.kind === "gmail.attachment_detail" &&
      typedLocator.message_id != null &&
      typedLocator.part_index != null
    );
  });
}

function normalizeGmailAttachmentRecoveryLocator(gap: DetailGapStartEntry): {
  attachmentId: string | null;
  messageId: string;
  partIndex: string;
} | null {
  const locator = gap.detail_locator;
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
    return null;
  }
  const typedLocator = locator as Record<string, unknown>;
  if (typedLocator.kind !== "gmail.attachment_detail") {
    return null;
  }
  const messageId = typedLocator.message_id == null ? "" : String(typedLocator.message_id).trim();
  const partIndex = typedLocator.part_index == null ? "" : String(typedLocator.part_index).trim();
  if (!(messageId && partIndex)) {
    return null;
  }
  const attachmentId = typedLocator.attachment_id == null ? null : String(typedLocator.attachment_id).trim() || null;
  return { attachmentId, messageId, partIndex };
}

async function fetchGmailMessageByMessageId(
  client: GmailMessageLookupClient,
  messageId: string
): Promise<FetchMessageObject | null> {
  const uids = await client.search({ emailId: messageId }, { uid: true });
  if (!uids || uids.length === 0) {
    return null;
  }
  const uid = uids[0];
  if (uid == null) {
    return null;
  }
  const message = await client.fetchOne(String(uid), GMAIL_METADATA_FETCH_QUERY, { uid: true });
  return message || null;
}

function buildServedAttachmentRecoveryProgressMessage(args: {
  admitted: number;
  metadataLookups: number;
  phase: "hydrating" | "settled";
  recovered: number;
}): string {
  return `Gmail served attachment-gap recovery phase=${args.phase} admitted=${args.admitted} recovered=${args.recovered} metadata_lookups=${args.metadataLookups}`;
}

async function emitServedAttachmentRecoveryProgress(
  emitProtocol: (msg: EmittedMessage) => Promise<void>,
  progress: {
    admitted: number;
    metadataLookups: number;
    phase: "hydrating" | "settled";
    recovered: number;
  }
): Promise<void> {
  await emitProtocol({
    type: "PROGRESS",
    stream: "attachments",
    message: buildServedAttachmentRecoveryProgressMessage(progress),
    count: progress.phase === "hydrating" ? progress.admitted : progress.recovered,
    total: progress.phase === "hydrating" ? progress.metadataLookups : progress.admitted,
  });
}

interface ServedAttachmentRecoveryState {
  admitted: number;
  admittedBytesTotal: number;
  messageCache: Map<string, FetchMessageObject | null>;
  metadataLookups: number;
  recovered: number;
  recoveredAttachmentGapIds: Set<string>;
}

type ServedAttachmentRecoveryLookupResult = FetchMessageObject | null | "metadata_lookup_limit_reached";

async function loadServedAttachmentRecoveryMessage(
  client: GmailMessageLookupClient,
  messageId: string,
  state: ServedAttachmentRecoveryState
): Promise<ServedAttachmentRecoveryLookupResult> {
  const cachedMessage = state.messageCache.get(messageId);
  if (cachedMessage !== undefined) {
    return cachedMessage;
  }
  if (state.metadataLookups >= SERVED_ATTACHMENT_RECOVERY_METADATA_LOOKUP_LIMIT) {
    return "metadata_lookup_limit_reached";
  }
  state.metadataLookups += 1;
  const message = await fetchGmailMessageByMessageId(client, messageId);
  state.messageCache.set(messageId, message);
  return message;
}

async function settleServedAttachmentRecoveryAttempt(
  deps: {
    attachmentCoverage?: AttachmentDetailCoverage;
    detailGaps?: readonly DetailGapStartEntry[] | undefined;
    emitProtocol: (msg: EmittedMessage) => Promise<void>;
    emitRecord: EmitRecordFn;
  },
  state: ServedAttachmentRecoveryState,
  hydrated: AttachmentRecord
): Promise<void> {
  if (deps.attachmentCoverage) {
    recordAttachmentCoverage(deps.attachmentCoverage, hydrated);
  }
  const emitted = await deps.emitRecord("attachments", { ...hydrated });
  if (emitted && hydrated.hydration_status === "hydrated") {
    const recoveredGaps = findRecoveredAttachmentDetailGaps(deps.detailGaps, hydrated, state.recoveredAttachmentGapIds);
    for (const recoveredGap of recoveredGaps) {
      state.recoveredAttachmentGapIds.add(recoveredGap.gap_id);
      await deps.emitProtocol({
        type: "DETAIL_GAP_RECOVERED",
        reference_only: true,
        gap_id: recoveredGap.gap_id,
        record_key: hydrated.id,
        stream: "attachments",
      });
      state.recovered += 1;
    }
  }
  // Emit bounded, non-secret progress as each admitted attempt settles so a
  // long single hydration is visible before the whole recovery lane ends.
  await emitServedAttachmentRecoveryProgress(deps.emitProtocol, {
    admitted: state.admitted,
    metadataLookups: state.metadataLookups,
    phase: "settled",
    recovered: state.recovered,
  });
}

async function processServedAttachmentRecoveryGap(
  client: GmailMessageLookupClient,
  gap: DetailGapStartEntry,
  deps: {
    attachmentCoverage?: AttachmentDetailCoverage;
    detailGaps?: readonly DetailGapStartEntry[] | undefined;
    emitProtocol: (msg: EmittedMessage) => Promise<void>;
    emitRecord: EmitRecordFn;
    hydrateAttachment: HydrateAttachmentFn;
  },
  state: ServedAttachmentRecoveryState,
  byteBudget: number
): Promise<boolean> {
  if (state.admitted > 0 && state.admittedBytesTotal >= byteBudget) {
    return true;
  }

  const locator = normalizeGmailAttachmentRecoveryLocator(gap);
  if (!locator) {
    return false;
  }

  const loadedMessage = await loadServedAttachmentRecoveryMessage(client, locator.messageId, state);
  if (loadedMessage === "metadata_lookup_limit_reached") {
    return true;
  }
  if (!loadedMessage) {
    return false;
  }

  const normalizedAttachmentKey = normalizeAttachmentRecoveryKey(gap.record_key);
  if (!normalizedAttachmentKey) {
    return false;
  }

  const messageKey = String(loadedMessage.emailId ?? locator.messageId);
  const receivedAt = perMessageInternalDateToIso(loadedMessage.internalDate, nowIso);
  const attachments = decodeBodystructureForAttachments(loadedMessage.bodyStructure, messageKey, receivedAt);
  const attachment = attachments.find((candidate) =>
    attachmentDetailGapMatches(gap, candidate, normalizedAttachmentKey)
  );
  if (!attachment) {
    return false;
  }

  const attachmentBytes =
    typeof attachment.size_bytes === "number" ? attachment.size_bytes : ATTACHMENT_BACKFILL_UNKNOWN_SIZE_FALLBACK_BYTES;
  if (state.admitted > 0 && state.admittedBytesTotal + attachmentBytes > byteBudget) {
    return true;
  }

  state.admitted += 1;
  state.admittedBytesTotal += attachmentBytes;

  await emitServedAttachmentRecoveryProgress(deps.emitProtocol, {
    admitted: state.admitted,
    metadataLookups: state.metadataLookups,
    phase: "hydrating",
    recovered: state.recovered,
  });

  const hydrated = await deps.hydrateAttachment(loadedMessage, attachment);
  await settleServedAttachmentRecoveryAttempt(deps, state, hydrated);
  return false;
}

export async function recoverServedAttachmentGaps(
  client: GmailMessageLookupClient,
  deps: {
    attachmentCoverage?: AttachmentDetailCoverage;
    detailGaps?: readonly DetailGapStartEntry[] | undefined;
    emitProtocol: (msg: EmittedMessage) => Promise<void>;
    emitRecord: EmitRecordFn;
    hydrateAttachment: HydrateAttachmentFn;
    recoveredAttachmentGapIds?: Set<string>;
  }
): Promise<ServedAttachmentRecoverySummary> {
  const servedGaps = servedAttachmentDetailGaps(deps.detailGaps);
  if (servedGaps.length === 0) {
    return { admitted: 0, recovered: 0 };
  }
  const byteBudget = resolveAttachmentBackfillPageByteBudget();
  const recoveryState: ServedAttachmentRecoveryState = {
    admitted: 0,
    admittedBytesTotal: 0,
    metadataLookups: 0,
    messageCache: new Map<string, FetchMessageObject | null>(),
    recovered: 0,
    recoveredAttachmentGapIds: deps.recoveredAttachmentGapIds ?? new Set<string>(),
  };
  const recoveryAttemptDeps = {
    ...(deps.attachmentCoverage ? { attachmentCoverage: deps.attachmentCoverage } : {}),
    detailGaps: deps.detailGaps,
    emitProtocol: deps.emitProtocol,
    emitRecord: deps.emitRecord,
    hydrateAttachment: deps.hydrateAttachment,
  };

  for (const gap of servedGaps) {
    if (await processServedAttachmentRecoveryGap(client, gap, recoveryAttemptDeps, recoveryState, byteBudget)) {
      break;
    }
  }
  return { admitted: recoveryState.admitted, recovered: recoveryState.recovered };
}

async function recoverServedAttachmentGapsIfRequested(
  client: GmailMessageLookupClient,
  deps: {
    attachmentCoverage: AttachmentDetailCoverage | undefined;
    detailGaps: readonly DetailGapStartEntry[] | undefined;
    emitProtocol: (msg: EmittedMessage) => Promise<void>;
    emitRecord: EmitRecordFn;
    hydrateAttachment: HydrateAttachmentFn;
    recoveredAttachmentGapIds: Set<string>;
  }
): Promise<void> {
  if (servedAttachmentDetailGaps(deps.detailGaps).length === 0) {
    return;
  }
  const recoverySummary = await recoverServedAttachmentGaps(client, {
    ...(deps.attachmentCoverage ? { attachmentCoverage: deps.attachmentCoverage } : {}),
    detailGaps: deps.detailGaps,
    emitProtocol: deps.emitProtocol,
    emitRecord: deps.emitRecord,
    hydrateAttachment: deps.hydrateAttachment,
    recoveredAttachmentGapIds: deps.recoveredAttachmentGapIds,
  });
  await deps.emitProtocol({
    type: "PROGRESS",
    stream: "attachments",
    message: `Gmail served attachment-gap recovery summary: admitted=${recoverySummary.admitted} recovered=${recoverySummary.recovered}`,
    count: recoverySummary.recovered,
    total: recoverySummary.admitted,
  });
}

export async function runAttachmentBackfillAndRecoveryPass(args: {
  allMail: ListResponse;
  attachmentBackfillRequested: boolean;
  attachmentCoverage: AttachmentDetailCoverage | undefined;
  client: GmailAttachmentBackfillClient;
  deps: AllMailDeps;
  fetchBodiesBound: FetchBodiesFn;
  hydrateAttachment: HydrateAttachmentFn;
  emit: (msg: EmittedMessage) => Promise<void>;
  recoveredAttachmentGapIds: Set<string>;
  recoveryOnly?: boolean;
  session: AllMailSession;
}): Promise<void> {
  if (args.recoveryOnly === true) {
    await recoverServedAttachmentGapsIfRequested(args.client, {
      attachmentCoverage: args.attachmentCoverage,
      detailGaps: args.deps.detailGaps,
      emitProtocol: args.emit,
      emitRecord: args.deps.emitRecord,
      hydrateAttachment: args.hydrateAttachment,
      recoveredAttachmentGapIds: args.recoveredAttachmentGapIds,
    });
    return;
  }

  if (!args.attachmentBackfillRequested) {
    return;
  }

  const servedAttachmentRecoveryRequested = servedAttachmentDetailGaps(args.deps.detailGaps).length > 0;
  if (servedAttachmentRecoveryRequested) {
    await recoverServedAttachmentGapsIfRequested(args.client, {
      attachmentCoverage: args.attachmentCoverage,
      detailGaps: args.deps.detailGaps,
      emitProtocol: args.emit,
      emitRecord: args.deps.emitRecord,
      hydrateAttachment: args.hydrateAttachment,
      recoveredAttachmentGapIds: args.recoveredAttachmentGapIds,
    });
    return;
  }

  const attachmentBackfillRange = selectAttachmentBackfillFetchRange({
    ...args.session,
    maxWindowUids: resolveAttachmentBackfillWindowUids(),
  });
  if (attachmentBackfillRange) {
    // Probe metadata (cheap: envelope + BODYSTRUCTURE, no body/attachment
    // bytes transferred) across the coarse range to learn each UID's known
    // attachment byte cost, then trim to a byte-cost-bounded page. The
    // durable cursor below only advances to the trimmed page's end UID,
    // not the coarse range's end — so a page that stops well short of the
    // coarse ceiling still commits correctly and the next run picks up
    // where this page left off.
    const probeMetas = await collectMetadata(args.client, attachmentBackfillRange);
    const byteBudget = resolveAttachmentBackfillPageByteBudget();
    const { backfillMetas, backfillWindowEndUid } = planAttachmentBackfillPage(
      probeMetas,
      byteBudget,
      Number(attachmentBackfillRange.split(":")[1])
    );
    await args.emit({
      type: "PROGRESS",
      stream: "attachments",
      message: `Backfilling historical attachment UIDs (${attachmentBackfillRange.split(":")[0]}:${backfillWindowEndUid}) from ${args.allMail.path}, byte budget ${byteBudget}`,
    });
    const backfillSummary = createAttachmentBackfillSummary();
    await emitMessagesPass(
      {
        ...(args.attachmentCoverage ? { attachmentCoverage: args.attachmentCoverage } : {}),
        emitProtocol: emit,
        emitProgress: (m) => emit({ ...m, stream: "attachments" }),
        emitRecord: async (stream, data, keyField): Promise<boolean> => {
          const emitted = await args.deps.emitRecord(stream, data, keyField);
          if (stream === "attachments" && emitted === true) {
            addAttachmentBackfillRecordToSummary(backfillSummary, data);
          }
          return emitted === true;
        },
        fetchBodies: args.fetchBodiesBound,
        hydrateAttachment: args.hydrateAttachment,
        recoveredAttachmentGapIds: args.recoveredAttachmentGapIds,
        nowIso,
        requested: new Map([["attachments", { name: "attachments" }]]),
        timeRange: args.deps.requested.get("attachments")?.time_range,
        wantBodies: false,
        wantMessages: false,
      },
      backfillMetas
    );
    await args.emit({
      type: "PROGRESS",
      stream: "attachments",
      message: `Gmail attachment backfill summary: ${formatAttachmentBackfillSummary(backfillSummary)}`,
      count: backfillSummary.hydrated,
      total:
        backfillSummary.hydrated +
        backfillSummary.too_large +
        backfillSummary.failed +
        backfillSummary.unavailable_skipped,
    });
    await args.emit({
      type: "STATE",
      stream: "attachments",
      cursor: {
        all_mail: {
          uidvalidity: args.session.uidvalidityNum,
          backfilled_through_uid: backfillWindowEndUid,
          completed_at: backfillWindowEndUid >= Math.max(0, args.session.priorUidnext - 1) ? nowIso() : null,
        },
      },
    });
  } else {
    await args.emit({
      type: "PROGRESS",
      stream: "attachments",
      message: `Gmail attachment backfill summary: ${formatAttachmentBackfillSummary(createAttachmentBackfillSummary())}`,
      count: 0,
      total: 0,
    });
    await args.emit({
      type: "STATE",
      stream: "attachments",
      cursor: {
        all_mail: {
          uidvalidity: args.session.uidvalidityNum,
          backfilled_through_uid: Math.max(0, args.session.priorUidnext - 1),
          completed_at: nowIso(),
        },
      },
    });
  }
}

/**
 * Plan one historical attachment backfill page from probe metadata: sort
 * ascending by UID (IMAP fetch responses are not guaranteed to arrive in
 * UID order, and the trim/admission logic is a prefix walk that must
 * operate over a UID-ordered sequence — an out-of-order high UID admitted
 * first would let a `uid <= max` derivation cover the entire coarse window,
 * silently defeating the byte budget), compute each UID's cost, trim to the
 * byte budget, and derive the admitted metas + end UID positionally.
 */
function planAttachmentBackfillPage(
  probeMetas: readonly FetchMessageObject[],
  byteBudget: number,
  fallbackEndUid: number
): { backfillMetas: FetchMessageObject[]; backfillWindowEndUid: number } {
  const sortedMetas = probeMetas.slice().sort((a, b) => a.uid - b.uid);
  const candidates: AttachmentBackfillCandidate[] = sortedMetas.map((meta) => ({
    uid: meta.uid,
    attachmentBytes: attachmentBackfillCandidateCost(meta),
  }));
  const { admittedCount } = trimAttachmentBackfillPageToByteBudget(candidates, byteBudget);
  const backfillMetas = sortedMetas.slice(0, admittedCount);
  const lastAdmittedMeta = backfillMetas.at(-1);
  return {
    backfillMetas,
    backfillWindowEndUid: lastAdmittedMeta ? lastAdmittedMeta.uid : fallbackEndUid,
  };
}

/**
 * A UID with zero attachments costs nothing — it must not consume the
 * unknown-size fallback (that would starve ordinary no-attachment messages
 * down to a handful per page). A UID with one or more attachments sums each
 * attachment's known size, substituting the fixed fallback per attachment
 * whose size is unavailable, so a mix of known and unknown sizes is not
 * underestimated by silently dropping the unknown ones.
 */
function attachmentBackfillCandidateCost(meta: FetchMessageObject): number {
  const attachments = decodeBodystructureForAttachments(
    meta.bodyStructure,
    String(meta.emailId ?? meta.uid),
    perMessageInternalDateToIso(meta.internalDate, nowIso)
  );
  return attachments.reduce(
    (sum, a) =>
      sum + (typeof a.size_bytes === "number" ? a.size_bytes : ATTACHMENT_BACKFILL_UNKNOWN_SIZE_FALLBACK_BYTES),
    0
  );
}

function boundedHydrationError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.slice(0, HYDRATION_ERROR_MAX_CHARS);
}

function attachmentWithHydrationFailure(
  attachment: AttachmentRecord,
  status: Exclude<AttachmentHydrationStatus, "hydrated">,
  err: unknown
): AttachmentRecord {
  return {
    ...attachment,
    blob_ref: null,
    content_sha256: null,
    hydration_status: status,
    hydration_error: boundedHydrationError(err),
  };
}

/**
 * Resolve the per-attachment max byte cap from env, falling back to the
 * conservative default. Non-positive or non-numeric overrides are ignored
 * so a misconfigured env var can never silently disable the cap.
 */
export function resolveMaxAttachmentBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_ATTACHMENT_BYTES_ENV];
  if (!raw) {
    return DEFAULT_MAX_ATTACHMENT_BYTES;
  }
  if (!POSITIVE_INTEGER_PATTERN.test(raw)) {
    return DEFAULT_MAX_ATTACHMENT_BYTES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_ATTACHMENT_BYTES;
  }
  return parsed;
}

class AttachmentTooLargeError extends Error {
  constructor(observedBytes: number, maxBytes: number) {
    super(`attachment exceeds max size: ${observedBytes} > ${maxBytes} bytes`);
    this.name = "AttachmentTooLargeError";
  }
}

/**
 * Wrap an AsyncIterable so that consumed bytes are tallied and the stream
 * aborts with `AttachmentTooLargeError` the moment it exceeds the cap.
 * Used as a defense-in-depth guard against attachments whose source size
 * is missing or under-reported.
 */
function enforceMaxBytes(
  content: AsyncIterable<Buffer | Uint8Array | string>,
  maxBytes: number
): AsyncIterable<Buffer | Uint8Array | string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Buffer | Uint8Array | string> {
      const inner = content[Symbol.asyncIterator]();
      let observed = 0;
      return {
        async next() {
          const step = await inner.next();
          if (step.done) {
            return step;
          }
          const chunk = step.value;
          const chunkSize =
            typeof chunk === "string" ? Buffer.byteLength(chunk) : (chunk as Buffer | Uint8Array).byteLength;
          observed += chunkSize;
          if (observed > maxBytes) {
            if (typeof inner.return === "function") {
              await inner.return();
            }
            throw new AttachmentTooLargeError(observed, maxBytes);
          }
          return step;
        },
        return(value): Promise<IteratorResult<Buffer | Uint8Array | string>> {
          if (typeof inner.return === "function") {
            return inner.return(value);
          }
          return Promise.resolve({ done: true, value });
        },
      };
    },
  };
}

export function makeAttachmentHydrator(args: {
  connectorId: string;
  fetchAttachment: FetchAttachmentFn;
  maxBytes?: number;
  uploadBlob: UploadAttachmentBlobFn;
}): HydrateAttachmentFn {
  const maxBytes = args.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  return async (msg, attachment) => {
    if (typeof attachment.size_bytes === "number" && attachment.size_bytes > maxBytes) {
      return attachmentWithHydrationFailure(
        attachment,
        "too_large",
        new AttachmentTooLargeError(attachment.size_bytes, maxBytes)
      );
    }
    try {
      const downloaded = await args.fetchAttachment(msg, attachment);
      if (typeof downloaded.expectedSize === "number" && downloaded.expectedSize > maxBytes) {
        return attachmentWithHydrationFailure(
          attachment,
          "too_large",
          new AttachmentTooLargeError(downloaded.expectedSize, maxBytes)
        );
      }
      const guarded = enforceMaxBytes(downloaded.content, maxBytes);
      const blobRef = await args.uploadBlob({
        content: guarded,
        connectorId: args.connectorId,
        mimeType: downloaded.mimeType || attachment.content_type || DEFAULT_ATTACHMENT_MIME_TYPE,
        recordKey: attachment.id,
        stream: "attachments",
      });
      return {
        ...attachment,
        blob_ref: blobRef,
        content_sha256: blobRef.sha256,
        content_type: blobRef.mime_type,
        size_bytes: blobRef.size_bytes,
        hydration_status: "hydrated",
        hydration_error: null,
      };
    } catch (err) {
      const status: Exclude<AttachmentHydrationStatus, "hydrated"> =
        err instanceof AttachmentTooLargeError ? "too_large" : "failed";
      return attachmentWithHydrationFailure(attachment, status, err);
    }
  };
}

interface ImapDownloadMeta {
  contentType?: string;
  expectedSize?: number;
}

interface ImapDownloadResponse {
  content: AsyncIterable<Buffer | Uint8Array | string>;
  meta?: ImapDownloadMeta;
}

export async function fetchAttachmentPart(
  client: ImapFlow,
  msg: FetchMessageObject,
  attachment: AttachmentRecord
): Promise<AttachmentDownload> {
  if (!msg.uid) {
    throw new Error("attachment download requires IMAP UID");
  }
  const response = (await client.download(String(msg.uid), attachment.part_index, {
    uid: true,
  })) as ImapDownloadResponse;
  return {
    content: response.content,
    expectedSize: typeof response.meta?.expectedSize === "number" ? response.meta.expectedSize : attachment.size_bytes,
    mimeType: response.meta?.contentType || attachment.content_type || DEFAULT_ATTACHMENT_MIME_TYPE,
  };
}

function buildRuntimeBlobUploader(): UploadAttachmentBlobFn {
  const rsUrl = process.env.PDPP_RS_URL || process.env.RS_URL;
  const ownerToken = process.env.PDPP_OWNER_TOKEN;
  if (!(rsUrl && ownerToken)) {
    return () => Promise.reject(new Error(BLOB_UPLOAD_ENV_ERROR));
  }
  return makeSharedReferenceBlobUploader({
    connectorInstanceId: process.env.PDPP_CONNECTOR_INSTANCE_ID || null,
    ownerToken,
    rsUrl,
  });
}

export function validateAttachmentHydrationPreflight(args: {
  env?: NodeJS.ProcessEnv;
  detailGaps?: readonly DetailGapStartEntry[] | undefined;
  requested: Map<string, StreamRequest>;
  streamsToBackfill?: readonly string[] | undefined;
}): string | null {
  const env = args.env ?? process.env;
  const hydrationRequested = args.requested.has("attachments") || shouldBackfillAttachments(args);
  if (!hydrationRequested) {
    return null;
  }
  if (!resolveGmailAddressFromEnv(env)) {
    return "Gmail attachment hydration requires GMAIL_ADDRESS or GMAIL_USER";
  }
  if (!resolveGmailPasswordFromEnv(env)) {
    return "Gmail attachment hydration requires GOOGLE_APP_PASSWORD_PDPP or GMAIL_APP_PASSWORD";
  }
  if (!sharedRuntimeBlobUploadAvailable(env)) {
    return BLOB_UPLOAD_ENV_ERROR;
  }
  return null;
}

// ─── Delta pass (flag/label changes since priorModseq) ──────────────────

async function runDeltaPass(
  client: ImapFlow,
  session: AllMailSession,
  requested: Map<string, StreamRequest>,
  emitRecord: EmitRecordFn,
  receivedAtFallback: string
): Promise<void> {
  if (session.fullResync || session.priorModseq === undefined || session.priorModseq === null) {
    return;
  }
  const priorModseq = session.priorModseq;
  const priorModseqBig = typeof priorModseq === "bigint" ? priorModseq : BigInt(priorModseq);
  await emit({
    type: "PROGRESS",
    message: `Fetching flag/label deltas since modseq=${String(priorModseq)}`,
  });
  const deltaQuery: ExtendedFetchQuery = {
    uid: true,
    flags: true,
    labels: true,
    threadId: true,
    emailId: true,
    envelope: false,
  };
  for await (const msg of client.fetch("1:*", deltaQuery, {
    uid: true,
    changedSince: priorModseqBig,
  })) {
    const gmMsgid = String(msg.emailId ?? "");
    if (!gmMsgid) {
      continue;
    }
    // Flag/label delta update: emit a tombstone-free upsert of the message
    // envelope (minimal fields since envelope not re-fetched). For now, we
    // emit a RECORD with the same id so the RS upserts flag/label state.
    // Note: PDPP records are "whole-document" upserts in the current RS,
    // so this delta path is effectively a full re-fetch. Simpler: mark
    // this path as "only flags" by emitting the fields we have plus nulls.
    // For robustness, let's actually re-fetch envelope in v2. For v1, emit
    // flags only.
    if (!requested.has("messages")) {
      continue;
    }
    await emitRecord(
      "messages",
      buildDeltaMessageRecord({
        flagsArr: toFlagsArray(msg.flags),
        gmMsgid,
        gmThrid: String(msg.threadId ?? ""),
        labels: toLabelsArray(msg.labels),
        receivedAtFallback,
      })
    );
  }
}

// ─── Threads pass ───────────────────────────────────────────────────────

async function runThreadsPass(client: ImapFlow, emitRecord: EmitRecordFn, cursor: FingerprintCursor): Promise<void> {
  await emit({
    type: "PROGRESS",
    stream: "threads",
    message: "Deriving threads from All Mail",
  });
  const threadAgg = new Map<string, ThreadAggregate>();
  const threadQuery: ExtendedFetchQuery = {
    uid: true,
    threadId: true,
    emailId: true,
    envelope: true,
    flags: true,
    internalDate: true,
    // Needed for per-thread labels + has_attachments aggregation.
    labels: true,
    bodyStructure: true,
  };
  for await (const msg of client.fetch("1:*", threadQuery, { uid: true })) {
    const tid = String(msg.threadId ?? "");
    if (!tid) {
      continue;
    }
    const env = msg.envelope ?? {};
    const rcv = internalDateToIso(msg.internalDate);
    const msgHasAttachments =
      decodeBodystructureForAttachments(msg.bodyStructure, String(msg.emailId ?? tid), rcv).length > 0;
    const next = updateThreadAggregate(threadAgg.get(tid), {
      flagsArr: toFlagsArray(msg.flags),
      hasAttachments: msgHasAttachments,
      labels: toLabelsArray(msg.labels),
      participants: envelopeParticipants(env),
      receivedAt: rcv,
      subject: env.subject || null,
      threadId: tid,
    });
    threadAgg.set(tid, next);
  }
  await emitChangedThreads(threadAgg.values(), cursor, emitRecord);
}

/**
 * Gate every aggregated thread through the shared fingerprint cursor and
 * emit only the records whose semantic shape moved since the prior run.
 * Pruning stale ids is the caller's responsibility — `runThreadsPass`
 * always drives a full `1:*` scan, so the orchestrator calls
 * `cursor.pruneStale()` after this returns. Threads with empty ids are
 * silently dropped: the upstream IMAP loop already filters them.
 *
 * Exported so the two-pass churn invariant can be exercised without
 * standing up an IMAP fixture.
 */
export async function emitChangedThreads(
  aggregates: Iterable<ThreadAggregate>,
  cursor: FingerprintCursor,
  emitRecord: EmitRecordFn
): Promise<void> {
  for (const agg of aggregates) {
    const record = buildThreadRecord(agg);
    if (!cursor.shouldEmit(record)) {
      continue;
    }
    await emitRecord("threads", record);
  }
}

/**
 * Parse the prior `threads` STATE cursor's `thread_fingerprints` map.
 * Tolerant of:
 *   - missing/legacy cursors (no fingerprints field)
 *   - malformed entries (non-string values silently dropped)
 *   - state from a different schema (best-effort coercion)
 * The returned map is always safe to read; on legacy input it is empty
 * and the next run re-emits every thread once (the normal one-time
 * cost of the cursor's introduction).
 */
export function readPriorThreadFingerprints(state: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const streamState = state.threads;
  if (!streamState || typeof streamState !== "object" || Array.isArray(streamState)) {
    return out;
  }
  const raw = (streamState as PriorThreadsState).thread_fingerprints;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out.set(id, value);
    }
  }
  return out;
}

// ─── All Mail orchestration (inside the mailbox lock) ───────────────────

interface AllMailDeps {
  detailGaps?: readonly DetailGapStartEntry[] | undefined;
  emitRecord: EmitRecordFn;
  emittedAt: string;
  recoveryOnly?: boolean;
  requested: Map<string, StreamRequest>;
  streamsToBackfill?: readonly string[] | undefined;
}

/**
 * Drive Pass 1 (new messages or full resync), Pass 2 (flag/label deltas),
 * threads aggregation, and the final STATE emit — all inside the mailbox
 * lock. The list-mailbox lookup happens in `main()` before entering here.
 */
async function runAllMailPasses(
  client: ImapFlow,
  allMail: ListResponse,
  state: Record<string, unknown>,
  deps: AllMailDeps
): Promise<void> {
  const mailbox = client.mailbox;
  if (!mailbox) {
    fail("mailbox not selected after lock");
    return;
  }
  const session = deriveAllMailSession(mailbox, state);
  if (!session) {
    fail("missing UIDVALIDITY on All Mail mailbox");
    return;
  }

  // Determine fetch range.
  // - Full resync: 1..*
  // - Incremental: new UIDs (priorUidnext..*) + flag/label changes
  //   (CHANGEDSINCE priorModseq).
  const timeRange = deps.requested.get("messages")?.time_range || deps.requested.get("attachments")?.time_range;
  const fetchRange = selectAllMailFetchRange(session, deps.requested);
  const attachmentBackfillRequested = shouldBackfillAttachments({
    detailGaps: deps.detailGaps,
    streamsToBackfill: deps.streamsToBackfill,
  });
  const servedAttachmentRecoveryRequested = servedAttachmentDetailGaps(deps.detailGaps).length > 0;
  const fetchBodiesBound: FetchBodiesFn = (msg, selection, wantBodies, wantMessages) =>
    fetchBodies(client, msg, selection, wantBodies, wantMessages);
  const hydrateAttachment = makeAttachmentHydrator({
    connectorId: process.env.PDPP_CONNECTOR_ID || DEFAULT_GMAIL_CONNECTOR_ID,
    fetchAttachment: (msg, attachment) => fetchAttachmentPart(client, msg, attachment),
    maxBytes: resolveMaxAttachmentBytes(),
    uploadBlob: buildRuntimeBlobUploader(),
  });
  // Accumulate honest attachments detail-coverage across BOTH the primary pass
  // and the historical backfill pass below, so a single DETAIL_COVERAGE can
  // report considered-vs-hydrated for every attachment this run attempted.
  // Only when `attachments` is in scope — otherwise no hydration attempts run
  // and there is no denominator to report.
  const wantsAttachments =
    deps.requested.has("attachments") || attachmentBackfillRequested || servedAttachmentRecoveryRequested;
  const attachmentCoverage = wantsAttachments ? makeAttachmentDetailCoverage() : undefined;
  const recoveredAttachmentGapIds = new Set<string>();

  if (deps.recoveryOnly === true) {
    if (servedAttachmentRecoveryRequested) {
      await runAttachmentBackfillAndRecoveryPass({
        allMail,
        attachmentBackfillRequested,
        attachmentCoverage,
        client,
        deps,
        emit,
        fetchBodiesBound,
        hydrateAttachment,
        recoveredAttachmentGapIds,
        recoveryOnly: true,
        session,
      });
      // Recovery-only mode still reports attachment evidence for the served
      // gaps it actually touched, but it returns before the ordinary Gmail
      // walk and cursor advancement.
      await emitAttachmentDetailCoverage(attachmentCoverage);
      await emitAttachmentDetailGaps(attachmentCoverage);
    }
    return;
  }

  await emit({
    type: "PROGRESS",
    message: `Fetching ${session.fullResync ? "all" : "new"} messages (${fetchRange}) from ${allMail.path}`,
  });

  // Phase A: pull all metadata into an array up-front.
  // Phase B: for each metadata row, do any additional IMAP commands
  // (body fetches) we need — we cannot issue other IMAP commands WHILE the
  // outer fetch iterator is still open, because imapflow multiplexes one
  // command at a time over a single connection and a nested call hangs the
  // outer iterator.
  // THREADS stream first (parent-first convention, Tranche C 2026-04-23).
  // Threads is derived from its own `1:*` IMAP fetch that aggregates by
  // thread_id — it doesn't depend on the per-message body pass below, so
  // emitting it first gives downstream consumers the parent record before
  // any message records arrive. The cost is one extra IMAP round-trip
  // before the message pass can start; that's already how it ran anyway
  // (this fetch happened at the end before the reorder), so no throughput
  // change.
  if (deps.requested.has("threads")) {
    // Per-thread fingerprint cursor via the shared helper. The prior STATE
    // shape (`state.threads.thread_fingerprints`) predates the helper's
    // default `fingerprints` key, so the prior map is decoded by the
    // gmail-local reader and handed in via `priorFingerprints`. The
    // cursor still seeds its next map from the prior so threads we skip
    // emitting carry their fingerprint forward unchanged.
    const threadCursor = openFingerprintCursor(state, {
      priorFingerprints: readPriorThreadFingerprints(state),
    });
    await runThreadsPass(client, deps.emitRecord, threadCursor);
    // Full `1:*` scan: drop ids absent from this run so a future
    // re-creation of the same thread_id triggers a fresh emit instead of
    // matching a stale fingerprint.
    threadCursor.pruneStale();
    // The threads STATE cursor carries the next-run fingerprint map.
    // Emitted here (inside the mailbox lock) so it's persisted right
    // after the threads pass and before the messages pass; if the
    // messages pass crashes, the threads cursor still holds and we
    // don't re-emit every thread on retry.
    await emit({
      type: "STATE",
      stream: "threads",
      cursor: {
        fetched_at: nowIso(),
        thread_fingerprints: threadCursor.toState(),
      },
    });
  }

  const metas = await collectMetadata(client, fetchRange);
  await emit({
    type: "PROGRESS",
    stream: "messages",
    message: `Collected ${metas.length} headers; beginning body pass`,
  });
  const perMessageDeps: PerMessageDeps = {
    ...(attachmentCoverage ? { attachmentCoverage } : {}),
    emitProtocol: emit,
    emitProgress: (m) => emit(m),
    emitRecord: deps.emitRecord,
    fetchBodies: fetchBodiesBound,
    hydrateAttachment,
    recoveredAttachmentGapIds,
    nowIso,
    requested: deps.requested,
    timeRange,
    wantBodies: deps.requested.has("message_bodies"),
    wantMessages: deps.requested.has("messages"),
  };
  await emitMessagesPass(perMessageDeps, metas);

  await runAttachmentBackfillAndRecoveryPass({
    allMail,
    attachmentBackfillRequested,
    attachmentCoverage,
    client,
    deps,
    emit,
    fetchBodiesBound,
    hydrateAttachment,
    recoveredAttachmentGapIds,
    recoveryOnly: false,
    session,
  });

  // Emit the per-run attachments coverage report after every attachments
  // record (primary pass + historical backfill) has settled and before the
  // messages STATE cursor commits — the ordering the progress-evidence
  // contract expects (records, then DETAIL_COVERAGE, then STATE).
  await emitAttachmentDetailCoverage(attachmentCoverage);
  // Then one matching DETAIL_GAP per failed attachment, so the commit-gate can
  // credit each gap_keys entry against a durable pending gap. Without this the
  // gate aborts an otherwise-successful run and the messages cursor never
  // advances, re-fetching the same window every run.
  await emitAttachmentDetailGaps(attachmentCoverage);

  // Pass 2: detect flag/label changes on already-seen messages (incremental only)
  await runDeltaPass(client, session, deps.requested, deps.emitRecord, deps.emittedAt);

  // Keep the cursor value (possibly string if out of safe-integer range) on STATE.
  await emit({
    type: "STATE",
    stream: "messages",
    cursor: {
      all_mail: {
        uidvalidity: session.uidvalidityNum,
        uidnext: session.uidnext,
        highest_modseq: session.highestModseqCursor ?? null,
      },
    },
  });
}

// ─── emitRecord factory ─────────────────────────────────────────────────

function makeEmitRecord(
  resFilters: Map<string, Set<string> | null>,
  emittedAt: string,
  incTotal: () => void
): EmitRecordFn {
  return async (stream: string, data: Record<string, unknown>, keyField: "id" | "name" = "id"): Promise<boolean> => {
    const keyCandidate = data[keyField] ?? data.name;
    if (keyCandidate == null) {
      return false;
    }
    const canonical = String(keyCandidate);
    const resSet = resFilters.get(stream);
    if (resSet && !resSet.has(canonical)) {
      return false;
    }

    // Validate record against schema.
    const validation = validateRecord(stream, data);
    if (!validation.ok) {
      await emit({
        type: "SKIP_RESULT",
        stream,
        reason: "schema_validation_failed",
        message: `${stream} ${canonical}: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        diagnostics: { issues: validation.issues },
      });
      return false;
    }

    const key: string | number = typeof keyCandidate === "number" ? keyCandidate : canonical;
    await emit({
      type: "RECORD",
      stream,
      key,
      data: validation.data,
      emitted_at: emittedAt,
    });
    incTotal();
    return true;
  };
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startMsg = await readStartMessage(getReadline());
  if (startMsg.type !== "START") {
    fail("Expected START");
    return;
  }

  const password = await resolvePassword();
  if (!password) {
    // resolvePassword already calls fail() on error path; the early-fail
    // exits the process, so reaching here means the prompt returned null.
    fail("no Gmail app password provided");
    return;
  }

  const address = await resolveAddress();
  if (!address) {
    fail("no Gmail address provided");
    return;
  }

  const requested = new Map<string, StreamRequest>((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) {
    fail("START.scope.streams is required");
    return;
  }
  const recoveryOnly = startMsg.recovery_only === true;
  const preflightError = validateAttachmentHydrationPreflight({
    detailGaps: startMsg.detail_gaps,
    requested,
    streamsToBackfill: startMsg.streamsToBackfill,
  });
  if (preflightError) {
    fail(preflightError);
    return;
  }

  const resFilters = new Map<string, Set<string> | null>();
  for (const [n, r] of requested) {
    resFilters.set(n, resourceSet(r));
  }

  const state: Record<string, unknown> = startMsg.state ?? {};
  const emittedAt = nowIso();
  let totalEmitted = 0;
  const emitRecord = makeEmitRecord(resFilters, emittedAt, () => {
    totalEmitted += 1;
  });

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: address, pass: password },
    logger: false,
  });

  await client.connect();

  try {
    await emit({ type: "PROGRESS", message: `Connected to ${redactEmailForProgress(address)}` });

    if (requested.has("labels") && !recoveryOnly) {
      await emitLabelsStream(client, emitRecord, state);
    }

    const allMail = await findAllMailbox(client);
    if (!allMail) {
      fail("could not find [Gmail]/All Mail mailbox; is this a Gmail account?");
      return;
    }

    const lock = await client.getMailboxLock(allMail.path);
    try {
      await runAllMailPasses(client, allMail, state, {
        emitRecord,
        emittedAt,
        detailGaps: startMsg.detail_gaps,
        recoveryOnly,
        requested,
        streamsToBackfill: startMsg.streamsToBackfill,
      });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch((): undefined => undefined);
  }

  await emit({
    type: "DONE",
    status: "succeeded",
    records_emitted: totalEmitted,
  });
  flushAndExit(0);
}

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime
// (process-level handlers, stdin reader, IMAP connect) and block the
// Node event loop. Only fires when this module IS the process entry
// point (i.e. `tsx connectors/gmail/index.ts`).
if (isMainModule(import.meta.url)) {
  process.on("unhandledRejection", (reason: unknown) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`[gmail] unhandledRejection: ${msg}\n`);
    const summary = reason instanceof Error ? reason.message : String(reason);
    emit({
      type: "DONE",
      status: "failed",
      records_emitted: 0,
      error: {
        message: `unhandledRejection: ${summary.slice(0, ERROR_MSG_TAIL)}`,
        retryable: false,
      },
    }).catch((): undefined => undefined);
    flushAndExit(1);
  });
  process.on("uncaughtException", (err: Error) => {
    const msg = err.stack ?? err.message;
    process.stderr.write(`[gmail] uncaughtException: ${msg}\n`);
    emit({
      type: "DONE",
      status: "failed",
      records_emitted: 0,
      error: {
        message: `uncaughtException: ${err.message.slice(0, ERROR_MSG_TAIL)}`,
        retryable: false,
      },
    }).catch((): undefined => undefined);
    flushAndExit(1);
  });

  main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    const retryable = RETRYABLE_ERROR_RE.test(msg);
    const trace = e instanceof Error ? (e.stack ?? msg) : msg;
    process.stderr.write(`[gmail] main rejected: ${trace}\n`);
    emit({
      type: "DONE",
      status: "failed",
      records_emitted: 0,
      error: { message: msg, retryable },
    }).catch((): undefined => undefined);
    flushAndExit(1);
  });
}
