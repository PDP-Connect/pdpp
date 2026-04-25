#!/usr/bin/env node
/**
 * PDPP Gmail Connector (v0.1.0)
 *
 * Uses IMAP + Google app-specific password. Iterates [Gmail]/All Mail so
 * messages with multiple labels aren't multi-counted. Derives label
 * membership from X-GM-LABELS per message.
 *
 * Auth:
 *   GOOGLE_APP_PASSWORD_PDPP — app password
 *   GMAIL_ADDRESS            — the account's email; if missing, emits
 *                              INTERACTION kind=credentials on first run.
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

import { createHash } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import {
  type FetchMessageObject,
  type FetchQueryObject,
  ImapFlow,
  type ListResponse,
  type MailboxObject,
  // biome-ignore lint/correctness/noUnresolvedImports: imapflow is declared in package.json; Biome's resolver doesn't see it here
} from "imapflow";
import { isMainModule } from "../../src/is-main-module.ts";
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
  AttachmentHydrationStatus,
  AttachmentRecord,
  BlobRef,
  EmittedMessage,
  InteractionMessage,
  InteractionResponse,
  PriorMessagesState,
  ProgressMessage,
  StartMessage,
  StreamRequest,
  ThreadAggregate,
} from "./types.ts";

// ─── Module-scoped regexes (Biome useTopLevelRegex) ─────────────────────

const EMAIL_AT_RE = /@/;
const RETRYABLE_ERROR_RE = /ECONN|ETIMEDOUT|fetch failed|EPIPE|timeout/i;

// ─── Constants ──────────────────────────────────────────────────────────

const FETCH_HEADER_BATCH_PROGRESS = 1000;
const SNIPPET_FETCH_MAX_BYTES = 4096;
const ERROR_MSG_TAIL = 400;
const FLUSH_HARD_TIMEOUT_MS = 3000;
const DEFAULT_CRED_TIMEOUT_S = 1800;
const DEFAULT_GMAIL_CONNECTOR_ID = "https://registry.pdpp.org/connectors/gmail";
const HYDRATION_ERROR_MAX_CHARS = 240;
const DEFAULT_ATTACHMENT_MIME_TYPE = "application/octet-stream";
const BLOB_UPLOAD_ENV_ERROR =
  "blob upload unavailable: PDPP_RS_URL and PDPP_OWNER_TOKEN must be provided by the runtime";

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

// Drain stdout before exit — otherwise Node may exit with buffered bytes
// still unwritten on a pipe, truncating the final line.
function flushAndExit(code: number): void {
  if (process.stdout.writableLength > 0) {
    process.stdout.once("drain", () => process.exit(code));
    // Hard timeout so we don't hang on a pipe that's gone away
    setTimeout(() => process.exit(code), FLUSH_HARD_TIMEOUT_MS).unref();
  } else {
    process.exit(code);
  }
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

export type EmitRecordFn = (stream: string, data: Record<string, unknown>, keyField?: "id" | "name") => Promise<void>;

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

export interface PerMessageDeps {
  emitProgress: ProgressEmitter;
  emitRecord: EmitRecordFn;
  fetchBodies: FetchBodiesFn;
  hydrateAttachment: HydrateAttachmentFn;
  nowIso: () => string;
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

  if (deps.requested.has("attachments") && attachments.length) {
    for (const a of attachments) {
      await deps.emitRecord("attachments", { ...(await deps.hydrateAttachment(msg, a)) });
    }
  }
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
async function resolvePassword(): Promise<string | null> {
  const envPassword = process.env.GOOGLE_APP_PASSWORD_PDPP;
  if (envPassword) {
    return envPassword;
  }
  try {
    const creds = await requireCredentialsOrAsk({
      required: ["GOOGLE_APP_PASSWORD_PDPP"],
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
 * Resolve the Gmail address from env (GMAIL_ADDRESS, or AMAZON_USERNAME if
 * it looks like an email) or by asking the user via INTERACTION.
 */
async function resolveAddress(): Promise<string | null> {
  const fromEnv = process.env.GMAIL_ADDRESS;
  if (fromEnv) {
    return fromEnv;
  }
  if (process.env.AMAZON_USERNAME && EMAIL_AT_RE.test(process.env.AMAZON_USERNAME)) {
    return process.env.AMAZON_USERNAME;
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

async function emitLabelsStream(client: ImapFlow, emitRecord: EmitRecordFn): Promise<void> {
  const mailboxes: ListResponse[] = await client.list();
  for (const mb of mailboxes) {
    const name = mb.path;
    await emitRecord(
      "labels",
      {
        name,
        canonical_name: canonicalLabelName(name),
        is_system: isGmailSystemLabel(name),
        parent_name: labelParentName(name),
        message_count: null, // we could SELECT each to get EXISTS but not worth it
      },
      "name"
    );
  }
  await emit({
    type: "STATE",
    stream: "labels",
    cursor: { fetched_at: nowIso() },
  });
}

// ─── All Mail resolution + cursor ───────────────────────────────────────

/** Locate the [Gmail]/All Mail mailbox via \All special-use or fallback path. */
async function findAllMailbox(client: ImapFlow): Promise<ListResponse | null> {
  const mailboxes: ListResponse[] = await client.list();
  return mailboxes.find((m) => m.specialUse === "\\All" || m.path === "[Gmail]/All Mail") ?? null;
}

interface AllMailSession {
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
  const legacyState = state as { all_mail?: AllMailCursor };
  const priorAllMail: AllMailCursor = messagesState.all_mail ?? legacyState.all_mail ?? {};
  const priorUidvalidity = priorAllMail.uidvalidity;
  return {
    fullResync: !priorUidvalidity || priorUidvalidity !== uidvalidityNum,
    highestModseqCursor: bigintToCursor(mailbox.highestModseq),
    priorModseq: priorAllMail.highest_modseq,
    priorUidnext: priorAllMail.uidnext ?? 1,
    uidnext: mailbox.uidNext,
    uidvalidityNum,
  };
}

// ─── Phase A: metadata collection ───────────────────────────────────────

async function collectMetadata(client: ImapFlow, fetchRange: string): Promise<FetchMessageObject[]> {
  const metaQuery: ExtendedFetchQuery = {
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
  const metas: FetchMessageObject[] = [];
  for await (const m of client.fetch(fetchRange, metaQuery, { uid: true })) {
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
  requested: Map<string, StreamRequest>
): string {
  if (session.fullResync || requested.has("attachments")) {
    return "1:*";
  }
  return `${session.priorUidnext}:*`;
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

export function makeAttachmentHydrator(args: {
  connectorId: string;
  fetchAttachment: FetchAttachmentFn;
  uploadBlob: UploadAttachmentBlobFn;
}): HydrateAttachmentFn {
  return async (msg, attachment) => {
    try {
      const downloaded = await args.fetchAttachment(msg, attachment);
      const blobRef = await args.uploadBlob({
        content: downloaded.content,
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
      return attachmentWithHydrationFailure(attachment, "failed", err);
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

interface BlobUploadResponse {
  blob_id: string;
  mime_type: string;
  object: "blob";
  sha256: string;
  size_bytes: number;
}

function isBlobUploadResponse(value: unknown): value is BlobUploadResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.object === "blob" &&
    typeof record.blob_id === "string" &&
    typeof record.mime_type === "string" &&
    typeof record.sha256 === "string" &&
    typeof record.size_bytes === "number"
  );
}

function makeBlobUploadUrl(args: {
  connectorId: string;
  recordKey: string;
  rsUrl: string;
  stream: "attachments";
}): URL {
  const url = new URL("/v1/blobs", args.rsUrl);
  url.searchParams.set("connector_id", args.connectorId);
  url.searchParams.set("stream", args.stream);
  url.searchParams.set("record_key", args.recordKey);
  return url;
}

interface HashingUploadBody {
  body: ReadableStream<Uint8Array>;
  digest: Promise<{ sha256: string; sizeBytes: number }>;
}

function toUploadChunk(chunk: Buffer | Uint8Array | string): Uint8Array {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function createHashingUploadBody(content: AsyncIterable<Buffer | Uint8Array | string>): HashingUploadBody {
  const hash = createHash("sha256");
  const iterator = content[Symbol.asyncIterator]();
  let sizeBytes = 0;
  let settled = false;
  let resolveDigest: (value: { sha256: string; sizeBytes: number }) => void = () => undefined;
  let rejectDigest: (reason?: unknown) => void = () => undefined;
  const digest = new Promise<{ sha256: string; sizeBytes: number }>((resolve, reject) => {
    resolveDigest = resolve;
    rejectDigest = reject;
  });
  const settleDigest = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    resolveDigest({ sha256: hash.digest("hex"), sizeBytes });
  };
  const failDigest = (reason: unknown): void => {
    if (settled) {
      return;
    }
    settled = true;
    rejectDigest(reason);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          settleDigest();
          controller.close();
          return;
        }
        const chunk = toUploadChunk(next.value);
        hash.update(chunk);
        sizeBytes += chunk.byteLength;
        controller.enqueue(chunk);
      } catch (err) {
        failDigest(err);
        controller.error(err);
      }
    },
    async cancel(reason) {
      failDigest(reason);
      if (typeof iterator.return === "function") {
        await iterator.return();
      }
    },
  });
  return { body, digest };
}

interface StreamingRequestInit extends Omit<RequestInit, "body"> {
  body: ReadableStream<Uint8Array>;
  duplex: "half";
}

export function makeReferenceBlobUploader(args: { ownerToken: string; rsUrl: string }): UploadAttachmentBlobFn {
  return async ({ connectorId, content, mimeType, recordKey, stream }) => {
    const upload = createHashingUploadBody(content);
    const requestInit: StreamingRequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.ownerToken}`,
        "Content-Type": mimeType,
      },
      body: upload.body,
      duplex: "half",
    };
    const response = await fetch(makeBlobUploadUrl({ connectorId, recordKey, rsUrl: args.rsUrl, stream }), requestInit);
    const body = (await response.json().catch((): unknown => null)) as unknown;
    if (!response.ok) {
      const message =
        body && typeof body === "object" && !Array.isArray(body)
          ? String((body as Record<string, unknown>).error ?? response.statusText)
          : response.statusText;
      throw new Error(`blob upload failed (${response.status}): ${message}`);
    }
    if (!isBlobUploadResponse(body)) {
      throw new Error("blob upload returned an invalid response");
    }
    const localHash = await upload.digest;
    if (body.sha256 !== localHash.sha256 || body.size_bytes !== localHash.sizeBytes) {
      throw new Error("blob upload hash/size mismatch");
    }
    return {
      blob_id: body.blob_id,
      mime_type: body.mime_type,
      sha256: body.sha256,
      size_bytes: body.size_bytes,
    };
  };
}

function buildRuntimeBlobUploader(): UploadAttachmentBlobFn {
  const rsUrl = process.env.PDPP_RS_URL || process.env.RS_URL;
  const ownerToken = process.env.PDPP_OWNER_TOKEN;
  if (!(rsUrl && ownerToken)) {
    return () => Promise.reject(new Error(BLOB_UPLOAD_ENV_ERROR));
  }
  return makeReferenceBlobUploader({ ownerToken, rsUrl });
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

async function runThreadsPass(client: ImapFlow, emitRecord: EmitRecordFn): Promise<void> {
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
  for (const agg of threadAgg.values()) {
    await emitRecord("threads", buildThreadRecord(agg));
  }
}

// ─── All Mail orchestration (inside the mailbox lock) ───────────────────

interface AllMailDeps {
  emitRecord: EmitRecordFn;
  emittedAt: string;
  requested: Map<string, StreamRequest>;
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
    await runThreadsPass(client, deps.emitRecord);
  }

  const metas = await collectMetadata(client, fetchRange);
  await emit({
    type: "PROGRESS",
    stream: "messages",
    message: `Collected ${metas.length} headers; beginning body pass`,
  });

  const fetchBodiesBound: FetchBodiesFn = (msg, selection, wantBodies, wantMessages) =>
    fetchBodies(client, msg, selection, wantBodies, wantMessages);
  const hydrateAttachment = makeAttachmentHydrator({
    connectorId: process.env.PDPP_CONNECTOR_ID || DEFAULT_GMAIL_CONNECTOR_ID,
    fetchAttachment: (msg, attachment) => fetchAttachmentPart(client, msg, attachment),
    uploadBlob: buildRuntimeBlobUploader(),
  });
  const perMessageDeps: PerMessageDeps = {
    emitProgress: (m) => emit(m),
    emitRecord: deps.emitRecord,
    fetchBodies: fetchBodiesBound,
    hydrateAttachment,
    nowIso,
    requested: deps.requested,
    timeRange,
    wantBodies: deps.requested.has("message_bodies"),
    wantMessages: deps.requested.has("messages"),
  };
  await emitMessagesPass(perMessageDeps, metas);

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
  return async (stream: string, data: Record<string, unknown>, keyField: "id" | "name" = "id"): Promise<void> => {
    const keyCandidate = data[keyField] ?? data.name;
    if (keyCandidate == null) {
      return;
    }
    const canonical = String(keyCandidate);
    const resSet = resFilters.get(stream);
    if (resSet && !resSet.has(canonical)) {
      return;
    }

    // Validate record against schema.
    const validation = validateRecord(stream, data);
    if (!validation.ok) {
      process.stderr.write(
        `[gmail] SKIP_RESULT ${stream} ${canonical}: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}\n`
      );
      return;
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
    await emit({ type: "PROGRESS", message: `Connected to ${address}` });

    if (requested.has("labels")) {
      await emitLabelsStream(client, emitRecord);
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
        requested,
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
