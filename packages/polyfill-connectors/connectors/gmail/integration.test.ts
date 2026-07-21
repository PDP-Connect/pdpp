/**
 * Integration tests for the Gmail connector's `collect()` emit path —
 * specifically the per-message orchestration in `processMessage` and the
 * loop driver `emitMessagesPass`.
 *
 * These tests DON'T talk to IMAP. They build a fake `PerMessageDeps`
 * that:
 *   - records every (stream, data) pair pushed through emitRecord,
 *   - injects a pure fetchBodies() that returns canned bodies (or
 *     rejects to simulate a real-world fetch failure),
 *   - freezes nowIso() so timestamp fallbacks are deterministic,
 *   - captures PROGRESS emits (none expected at N<FETCH_MSG_PROGRESS).
 *
 * Imports directly from ./index.ts — `main().catch(...)` is guarded by
 * `isMainModule(import.meta.url)` so it only fires when index.ts is the
 * process entry point, not when a test imports it.
 *
 * Why bother: parsers.test.ts proves record *shapes*. Integration tests
 * on the emit path prove the invariants downstream consumers observe:
 *   - stream-scope filters (wantMessages / wantBodies / attachments)
 *     suppress only their own stream and don't break siblings,
 *   - body-fetch failure still emits the envelope record (with null
 *     snippet, body_source="empty"), never silently drops the message,
 *   - emit order within a message is body → envelope → attachments,
 *   - missing X-GM-MSGID is skipped silently without emitting anything,
 *   - per-message errors inside emitMessagesPass don't halt the loop.
 * Regressing any of these is a real data-loss bug.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mock, test } from "node:test";
import type {
  FetchMessageObject,
  ImapFlow,
  ListResponse,
  MessageEnvelopeObject,
  MessageStructureObject,
} from "imapflow";
import type { DetailGapStartEntry } from "../../src/connector-runtime.ts";
import { buildDetailCoverageMessage } from "../../src/connector-runtime.ts";
import { runtimeBlobUploadAvailable } from "../../src/reference-blob-uploader.ts";
import { type EmittedRecord, makeRecordingEmit, type RecordedEvent } from "../../src/test-harness.ts";
import {
  ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES,
  ATTACHMENT_BACKFILL_PAGE_MAX_BYTES,
  ATTACHMENT_BACKFILL_PAGE_MIN_BYTES,
  ATTACHMENT_BACKFILL_UNKNOWN_SIZE_FALLBACK_BYTES,
  type AttachmentDetailCoverage,
  addAttachmentBackfillRecordToSummary,
  attachmentBackfillPageByteBudget,
  buildAttachmentDetailCoverageMessage,
  buildAttachmentDetailGap,
  createAttachmentBackfillSummary,
  DEFAULT_ATTACHMENT_BACKFILL_WINDOW_UIDS,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  emitMessagesPass,
  type FetchBodiesFn,
  type FetchedBodies,
  formatAttachmentBackfillSummary,
  type HydrateAttachmentFn,
  makeAttachmentDetailCoverage,
  makeAttachmentHydrator,
  type PerMessageDeps,
  processMessage,
  recordAttachmentCoverage,
  recoverServedAttachmentGaps,
  redactEmailForProgress,
  resolveAttachmentBackfillPageByteBudget,
  resolveAttachmentBackfillWindowUids,
  resolveGmailAddressFromEnv,
  resolveGmailPasswordFromEnv,
  resolveMaxAttachmentBytes,
  runAttachmentBackfillAndRecoveryPass,
  selectAllMailFetchRange,
  selectAttachmentBackfillFetchRange,
  shouldBackfillAttachments,
  trimAttachmentBackfillPageToByteBudget,
  validateAttachmentHydrationPreflight,
} from "./index.ts";
import type { AttachmentRecord, ProgressMessage, StreamRequest } from "./types.ts";

interface RecordingHarness {
  deps: PerMessageDeps;
  emit: ReturnType<typeof makeRecordingEmit>["emit"];
  emitted: EmittedRecord[];
  events: RecordedEvent[];
  progress: ProgressMessage[];
  protocolMessages: ReturnType<typeof makeRecordingEmit>["protocolMessages"];
}

const FROZEN_NOW = "2026-04-22T12:00:00.000Z";

function makeRequested(streams: readonly string[]): Map<string, StreamRequest> {
  return new Map(streams.map((name) => [name, { name }]));
}

/** Default fake body fetch: returns plausible non-null bodies so records
 *  with wantBodies/wantMessages show real content. Override per-test via
 *  the `fetchBodies` option. */
const defaultFetchBodies: FetchBodiesFn = (): Promise<FetchedBodies> =>
  Promise.resolve({
    bodyHtmlFull: "<p>hi</p>",
    bodyTextFull: "hi",
    snippet: "hi",
  });

interface HarnessOverrides {
  attachmentCoverage?: AttachmentDetailCoverage;
  detailGaps?: readonly DetailGapStartEntry[];
  fetchBodies?: FetchBodiesFn;
  hydrateAttachment?: HydrateAttachmentFn;
  nowIso?: () => string;
  requested?: Map<string, StreamRequest>;
  timeRange?: { since?: string; until?: string };
  wantBodies?: boolean;
  wantMessages?: boolean;
}

function makeHarness(overrides: HarnessOverrides = {}): RecordingHarness {
  // gmail has no validateRecord (no schemas.ts). pass-through mirrors
  // runtime behaviour for this connector; shape-checking kicks in the
  // moment a schema is threaded into runConnector.
  const harness = makeRecordingEmit();
  const progress: ProgressMessage[] = [];
  const requested = overrides.requested ?? makeRequested(["messages", "attachments"]);
  const deps: PerMessageDeps = {
    ...(overrides.attachmentCoverage ? { attachmentCoverage: overrides.attachmentCoverage } : {}),
    ...(overrides.detailGaps ? { detailGaps: overrides.detailGaps } : {}),
    emitProgress: (m: ProgressMessage): Promise<void> => {
      progress.push(m);
      return Promise.resolve();
    },
    emitProtocol: harness.emit,
    emitRecord: async (stream, data, _keyField) => {
      await harness.emitRecord(stream, data);
      return true;
    },
    fetchBodies: overrides.fetchBodies ?? defaultFetchBodies,
    hydrateAttachment: overrides.hydrateAttachment ?? ((_, attachment) => Promise.resolve(attachment)),
    recoveredAttachmentGapIds: new Set<string>(),
    nowIso: overrides.nowIso ?? ((): string => FROZEN_NOW),
    requested,
    timeRange: overrides.timeRange,
    wantBodies: overrides.wantBodies ?? false,
    wantMessages: overrides.wantMessages ?? true,
  };
  return {
    emit: harness.emit,
    deps,
    emitted: harness.emitted,
    events: harness.events,
    progress,
    protocolMessages: harness.protocolMessages,
  };
}

function makeAttachmentMsg(): FetchMessageObject {
  const bodyStructure: MessageStructureObject = {
    childNodes: [
      {
        type: "text/plain",
        encoding: "7bit",
        parameters: { charset: "utf-8" },
      },
      {
        type: "application/pdf",
        disposition: "attachment",
        dispositionParameters: { filename: "invoice.pdf" },
        encoding: "base64",
        size: 21,
      },
    ],
    type: "multipart/mixed",
  };
  return makeMsg({
    bodyStructure,
  });
}

function makeServedRecoveryMsg(
  overrides: { attachments?: readonly number[]; emailId?: string; threadId?: string; uid?: number } = {}
): FetchMessageObject {
  const attachmentSizes = overrides.attachments ?? [2 * 1024 * 1024, 16];
  const bodyStructure: MessageStructureObject = {
    childNodes: attachmentSizes.map((size, index) => ({
      type: "application/pdf",
      disposition: "attachment",
      dispositionParameters: { filename: `attachment-${index + 1}.pdf` },
      encoding: "base64",
      size,
    })),
    type: "multipart/mixed",
  };
  return makeMsg({
    bodyStructure,
    emailId: overrides.emailId ?? "gmmsgid-recovery",
    threadId: overrides.threadId ?? "gmthrid-recovery",
    uid: overrides.uid ?? 321,
  });
}

function makeServedRecoveryGap(args: {
  gapId: string;
  messageId: string;
  partIndex: number;
  attachmentId?: string;
}): DetailGapStartEntry {
  const attachmentId = args.attachmentId ?? `${args.messageId}:${args.partIndex}`;
  return {
    gap_id: args.gapId,
    reference_only: true,
    status: "pending",
    stream: "attachments",
    record_key: attachmentId,
    detail_locator: {
      kind: "gmail.attachment_detail",
      attachment_id: attachmentId,
      message_id: args.messageId,
      part_index: String(args.partIndex),
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeAllMailMailbox(): ListResponse {
  return {
    delimiter: "/",
    flags: new Set(["\\All"]),
    listed: true,
    name: "All Mail",
    path: "[Gmail]/All Mail",
    pathAsListed: "[Gmail]/All Mail",
    parent: ["[Gmail]"],
    parentPath: "[Gmail]",
    specialUse: "\\All",
    subscribed: true,
  };
}

function blobRefBlobId(record: EmittedRecord | undefined): string | null {
  const blobRef = record?.data.blob_ref;
  if (blobRef && typeof blobRef === "object" && !Array.isArray(blobRef)) {
    const blobId = (blobRef as Record<string, unknown>).blob_id;
    return typeof blobId === "string" ? blobId : null;
  }
  return null;
}

/** Minimal-but-complete FetchMessageObject. imapflow only requires seq+uid;
 *  everything else is optional but we populate realistic defaults so the
 *  record builders have something to work with. */
function makeMsg(overrides: Partial<FetchMessageObject> = {}): FetchMessageObject {
  const envelope: MessageEnvelopeObject = {
    date: new Date("2026-04-20T10:00:00.000Z"),
    subject: "Test subject",
    from: [{ name: "Alice", address: "alice@example.com" }],
    to: [{ name: "Bob", address: "bob@example.com" }],
    cc: [],
    bcc: [],
    messageId: "<msg-abc@example.com>",
  };
  return {
    seq: 1,
    uid: 100,
    emailId: "gmmsgid-1111",
    threadId: "gmthrid-2222",
    flags: new Set<string>(["\\Seen"]),
    labels: new Set<string>(["\\Inbox"]),
    envelope,
    internalDate: new Date("2026-04-20T10:00:05.000Z"),
    size: 1024,
    ...overrides,
  };
}

// ─── Invariant: parent-before-child (body → envelope → attachments) ──────

test("processMessage: emits message_bodies BEFORE messages record for the same message", async () => {
  const { deps, emitted } = makeHarness({
    requested: makeRequested(["messages", "message_bodies"]),
    wantBodies: true,
    wantMessages: true,
  });
  await processMessage(deps, makeMsg());

  const bodyIdx = emitted.findIndex((r) => r.stream === "message_bodies");
  const messageIdx = emitted.findIndex((r) => r.stream === "messages");
  assert.notEqual(bodyIdx, -1, "expected a message_bodies record");
  assert.notEqual(messageIdx, -1, "expected a messages record");
  assert.ok(bodyIdx < messageIdx, "message_bodies must precede messages in emit order");
});

// ─── Invariant: stream-scope filters cleanly ─────────────────────────────

test("processMessage: wantMessages=false suppresses messages but still emits message_bodies + attachments", async () => {
  const { deps, emitted } = makeHarness({
    requested: makeRequested(["message_bodies", "attachments"]),
    wantBodies: true,
    wantMessages: false,
  });
  // msg with no attachments → only message_bodies should emit. Skip attachments.
  await processMessage(deps, makeMsg());
  assert.equal(emitted.filter((r) => r.stream === "messages").length, 0, "no messages record when wantMessages=false");
  assert.ok(
    emitted.some((r) => r.stream === "message_bodies"),
    "message_bodies still flows"
  );
});

test("processMessage: hydrates requested attachments with blob_ref, hash, MIME type, and stable id", async () => {
  const bytes = Buffer.from("pdf attachment bytes");
  const expectedSha = createHash("sha256").update(bytes).digest("hex");
  const uploadCalls: Array<{ recordKey: string; sha256: string }> = [];
  const hydrateAttachment = makeAttachmentHydrator({
    connectorId: "https://registry.pdpp.org/connectors/gmail",
    fetchAttachment: () =>
      Promise.resolve({
        content: Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
        expectedSize: bytes.length,
        mimeType: "application/pdf",
      }),
    uploadBlob: async ({ content, recordKey, mimeType }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const uploaded = Buffer.concat(chunks);
      const sha256 = createHash("sha256").update(uploaded).digest("hex");
      uploadCalls.push({ recordKey, sha256 });
      return {
        blob_id: `blob_sha256_${sha256}`,
        mime_type: mimeType,
        sha256,
        size_bytes: uploaded.byteLength,
      };
    },
  });
  const { deps, emitted } = makeHarness({
    hydrateAttachment,
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });

  await processMessage(deps, makeAttachmentMsg());

  const attachment = emitted.find((record) => record.stream === "attachments");
  assert.ok(attachment, "expected hydrated attachment record");
  assert.equal(attachment.data.id, "gmmsgid-1111:2");
  assert.equal(attachment.data.content_sha256, expectedSha);
  assert.equal(attachment.data.content_type, "application/pdf");
  assert.equal(attachment.data.size_bytes, bytes.length);
  assert.equal(attachment.data.hydration_status, "hydrated");
  assert.equal(attachment.data.hydration_error, null);
  assert.deepEqual(attachment.data.blob_ref, {
    blob_id: `blob_sha256_${expectedSha}`,
    mime_type: "application/pdf",
    sha256: expectedSha,
    size_bytes: bytes.length,
  });
  assert.deepEqual(uploadCalls, [{ recordKey: "gmmsgid-1111:2", sha256: expectedSha }]);
});

test("processMessage: emits DETAIL_GAP_RECOVERED only after the matching attachment record lands", async () => {
  const bytes = Buffer.from("recoverable attachment");
  const hydrateAttachment = makeAttachmentHydrator({
    connectorId: "https://registry.pdpp.org/connectors/gmail",
    fetchAttachment: () =>
      Promise.resolve({
        content: Readable.from([bytes]),
        expectedSize: bytes.length,
        mimeType: "application/pdf",
      }),
    uploadBlob: async ({ content, mimeType }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const uploaded = Buffer.concat(chunks);
      const sha256 = createHash("sha256").update(uploaded).digest("hex");
      return {
        blob_id: `blob_sha256_${sha256}`,
        mime_type: mimeType,
        sha256,
        size_bytes: uploaded.byteLength,
      };
    },
  });
  const matchingGap: DetailGapStartEntry = {
    gap_id: "gap-match",
    reference_only: true,
    status: "pending",
    stream: "attachments",
    record_key: "gmmsgid-1111:2",
    detail_locator: {
      kind: "gmail.attachment_detail",
      attachment_id: "gmmsgid-1111:2",
      message_id: "gmmsgid-1111",
      part_index: "2",
    },
  };
  const nearMissGap: DetailGapStartEntry = {
    gap_id: "gap-near-miss",
    reference_only: true,
    status: "pending",
    stream: "attachments",
    record_key: "gmmsgid-1111:2",
    detail_locator: {
      kind: "gmail.attachment_detail",
      attachment_id: "gmmsgid-1111:2",
      message_id: "gmmsgid-1111",
      part_index: "9",
    },
  };
  const harness = makeHarness({
    detailGaps: [matchingGap, nearMissGap],
    hydrateAttachment,
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });

  await processMessage(harness.deps, makeAttachmentMsg());

  const attachmentIdx = harness.events.findIndex((event) => event.kind === "record" && event.stream === "attachments");
  const recoveryIdx = harness.events.findIndex(
    (event) => event.kind === "message" && event.message.type === "DETAIL_GAP_RECOVERED"
  );
  assert.ok(attachmentIdx !== -1, "expected attachment record to emit");
  assert.ok(recoveryIdx !== -1, "expected DETAIL_GAP_RECOVERED protocol emit");
  assert.ok(attachmentIdx < recoveryIdx, "recovery ack must land after the attachment record");
  const emittedRecovery = harness.protocolMessages.filter((msg) => msg.type === "DETAIL_GAP_RECOVERED");
  assert.deepEqual(
    emittedRecovery.map((msg) => (msg as { gap_id?: string }).gap_id),
    ["gap-match"],
    "only the exact matching gap should recover"
  );
  assert.equal(emittedRecovery.length, 1);
});

test("processMessage: a served gap whose attachment fails hydration AGAIN is never acknowledged as recovered", async () => {
  // The commit-gate credits a required key against a durable gap whose status
  // is `pending` OR `recovered` (reference-implementation/runtime/index.js
  // assertDetailCoverageSatisfiedBeforeCommit), and the store's same-run
  // stickiness rule keeps a `recovered` row recovered when the re-upserted
  // DETAIL_GAP shares the same run id. So if a re-failed attachment were
  // wrongly acknowledged as recovered, the run would still commit and the
  // durable gap would never surface as retryable again — a silent,
  // undetectable data loss on exactly the population this fix targets (a
  // served gap that fails again). This pins the guard against that.
  const hydrateAttachment = makeAttachmentHydrator({
    connectorId: "https://registry.pdpp.org/connectors/gmail",
    fetchAttachment: () => Promise.reject(new Error("download failed again")),
    uploadBlob: () => Promise.reject(new Error("should not upload when download fails")),
  });
  const servedGap: DetailGapStartEntry = {
    gap_id: "gap-refail",
    reference_only: true,
    status: "pending",
    stream: "attachments",
    record_key: "gmmsgid-1111:2",
    detail_locator: {
      kind: "gmail.attachment_detail",
      attachment_id: "gmmsgid-1111:2",
      message_id: "gmmsgid-1111",
      part_index: "2",
    },
  };
  const attachmentCoverage = makeAttachmentDetailCoverage();
  const harness = makeHarness({
    attachmentCoverage,
    detailGaps: [servedGap],
    hydrateAttachment,
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });

  await processMessage(harness.deps, makeAttachmentMsg());

  const attachment = harness.emitted.find((record) => record.stream === "attachments");
  assert.ok(attachment, "expected the failed attachment metadata to still emit");
  assert.equal(
    attachment.data.hydration_status,
    "failed",
    "hydration must have actually failed for this probe to be valid"
  );

  const emittedRecovery = harness.protocolMessages.filter((msg) => msg.type === "DETAIL_GAP_RECOVERED");
  assert.deepEqual(emittedRecovery, [], "a re-failed served gap must NOT emit DETAIL_GAP_RECOVERED");

  // A `failed` hydration lands in `gapKeys`/`failedRecords`, which is exactly
  // what `emitAttachmentDetailGaps` (the end-of-pass emitter) turns into one
  // DETAIL_GAP per failed record — the ordinary requeue path that keeps the
  // durable gap pending and retryable next run, instead of it being silently
  // abandoned as `recovered`.
  assert.deepEqual(
    attachmentCoverage.gapKeys,
    ["gmmsgid-1111:2"],
    "the re-failed attachment must be a retryable gap key"
  );
  assert.deepEqual(
    attachmentCoverage.failedRecords.map((r) => r.id),
    ["gmmsgid-1111:2"],
    "the re-failed attachment must be retained so a fresh DETAIL_GAP is emitted for it"
  );
});

test("processMessage: emits bounded failed attachment metadata without fake blob ids", async () => {
  const hydrateAttachment = makeAttachmentHydrator({
    connectorId: "https://registry.pdpp.org/connectors/gmail",
    fetchAttachment: () => Promise.reject(new Error(`download failed ${"x".repeat(400)}`)),
    uploadBlob: () => Promise.reject(new Error("should not upload when download fails")),
  });
  const { deps, emitted } = makeHarness({
    hydrateAttachment,
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });

  await processMessage(deps, makeAttachmentMsg());

  const attachment = emitted.find((record) => record.stream === "attachments");
  assert.ok(attachment, "expected failed attachment metadata");
  assert.equal(attachment.data.id, "gmmsgid-1111:2");
  assert.equal(attachment.data.blob_ref, null);
  assert.equal(attachment.data.content_sha256, null);
  assert.equal(attachment.data.hydration_status, "failed");
  assert.equal(typeof attachment.data.hydration_error, "string");
  assert.ok(String(attachment.data.hydration_error).length <= 240);
});

test("processMessage: rerun hydration preserves attachment identity and idempotent blob identity", async () => {
  const bytes = Buffer.from("same bytes");
  const expectedSha = createHash("sha256").update(bytes).digest("hex");
  let uploadCount = 0;
  const hydrateAttachment = makeAttachmentHydrator({
    connectorId: "https://registry.pdpp.org/connectors/gmail",
    fetchAttachment: () =>
      Promise.resolve({
        content: Readable.from([bytes]),
        expectedSize: bytes.length,
        mimeType: "application/pdf",
      }),
    uploadBlob: async ({ content, mimeType }) => {
      for await (const _chunk of content) {
        // Drain the stream; the fake upload service dedupes by hash.
      }
      uploadCount += 1;
      return {
        blob_id: `blob_sha256_${expectedSha}`,
        mime_type: mimeType,
        sha256: expectedSha,
        size_bytes: bytes.length,
      };
    },
  });
  const first = makeHarness({
    hydrateAttachment,
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });
  const second = makeHarness({
    hydrateAttachment,
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });

  await processMessage(first.deps, makeAttachmentMsg());
  await processMessage(second.deps, makeAttachmentMsg());

  const firstAttachment = first.emitted.find((record) => record.stream === "attachments");
  const secondAttachment = second.emitted.find((record) => record.stream === "attachments");
  assert.ok(firstAttachment);
  assert.ok(secondAttachment);
  assert.equal(firstAttachment.data.id, secondAttachment.data.id);
  assert.equal(blobRefBlobId(firstAttachment), blobRefBlobId(secondAttachment));
  assert.equal(uploadCount, 2, "reruns may re-upload, but blob identity remains content-addressed and stable");
});

test("processMessage: repeated backfill preserves record id, content hash, blob id, and binding tuple", async () => {
  const bytes = Buffer.from("historical invoice bytes");
  const expectedSha = createHash("sha256").update(bytes).digest("hex");
  const bindings = new Set<string>();
  const storedPayloads = new Map<string, Buffer>();
  const hydrateAttachment = makeAttachmentHydrator({
    connectorId: "https://registry.pdpp.org/connectors/gmail",
    fetchAttachment: () =>
      Promise.resolve({
        content: Readable.from([bytes]),
        expectedSize: bytes.length,
        mimeType: "application/pdf",
      }),
    uploadBlob: async ({ connectorId, content, mimeType, recordKey, stream }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const uploaded = Buffer.concat(chunks);
      const sha256 = createHash("sha256").update(uploaded).digest("hex");
      const blobId = `blob_sha256_${sha256}`;
      if (!storedPayloads.has(blobId)) {
        storedPayloads.set(blobId, uploaded);
      }
      bindings.add(`${blobId}|${connectorId}|${stream}|${recordKey}`);
      return {
        blob_id: blobId,
        mime_type: mimeType,
        sha256,
        size_bytes: uploaded.byteLength,
      };
    },
  });
  const first = makeHarness({
    hydrateAttachment,
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });
  const second = makeHarness({
    hydrateAttachment,
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });

  await processMessage(first.deps, makeAttachmentMsg());
  await processMessage(second.deps, makeAttachmentMsg());

  const firstAttachment = first.emitted.find((record) => record.stream === "attachments");
  const secondAttachment = second.emitted.find((record) => record.stream === "attachments");
  assert.ok(firstAttachment);
  assert.ok(secondAttachment);
  assert.equal(firstAttachment.data.id, "gmmsgid-1111:2");
  assert.equal(secondAttachment.data.id, firstAttachment.data.id);
  assert.equal(firstAttachment.data.content_sha256, expectedSha);
  assert.equal(secondAttachment.data.content_sha256, expectedSha);
  assert.equal(blobRefBlobId(firstAttachment), `blob_sha256_${expectedSha}`);
  assert.equal(blobRefBlobId(secondAttachment), blobRefBlobId(firstAttachment));
  assert.equal(storedPayloads.size, 1, "content-addressed store keeps one payload for repeated bytes");
  assert.deepEqual(
    bindings,
    new Set([`blob_sha256_${expectedSha}|https://registry.pdpp.org/connectors/gmail|attachments|gmmsgid-1111:2`])
  );
});

test("attachment backfill summary counts non-secret hydration outcomes", () => {
  const summary = createAttachmentBackfillSummary();
  addAttachmentBackfillRecordToSummary(summary, { hydration_status: "hydrated" });
  addAttachmentBackfillRecordToSummary(summary, { hydration_status: "too_large", hydration_error: "size only" });
  addAttachmentBackfillRecordToSummary(summary, { hydration_status: "failed", hydration_error: "download failed" });
  addAttachmentBackfillRecordToSummary(summary, { hydration_status: "deferred" });

  assert.deepEqual(summary, {
    failed: 1,
    hydrated: 1,
    remaining_historical_gaps: 3,
    too_large: 1,
    unavailable_skipped: 1,
  });
  assert.equal(
    formatAttachmentBackfillSummary(summary),
    "hydrated=1 too_large=1 failed=1 unavailable_skipped=1 remaining_historical_gaps=3"
  );
});

test("processMessage: refuses hydration when source-reported size exceeds the bounded cap (declared size)", async () => {
  const fetchAttachment = mock.fn(() =>
    Promise.reject(new Error("fetch should be skipped when size_bytes > maxBytes"))
  );
  const uploadBlob = mock.fn(() => Promise.reject(new Error("upload should be skipped when size_bytes > maxBytes")));
  const hydrateAttachment = makeAttachmentHydrator({
    connectorId: "https://registry.pdpp.org/connectors/gmail",
    fetchAttachment,
    maxBytes: 1024,
    uploadBlob,
  });
  const oversize: MessageStructureObject = {
    childNodes: [
      {
        type: "application/pdf",
        disposition: "attachment",
        dispositionParameters: { filename: "huge.pdf" },
        encoding: "base64",
        size: 5000,
      },
    ],
    type: "multipart/mixed",
  };
  const { deps, emitted } = makeHarness({
    hydrateAttachment,
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });
  await processMessage(deps, makeMsg({ bodyStructure: oversize }));

  const attachment = emitted.find((record) => record.stream === "attachments");
  assert.ok(attachment, "expected too_large attachment metadata");
  assert.equal(attachment.data.hydration_status, "too_large");
  assert.equal(attachment.data.blob_ref, null);
  assert.equal(attachment.data.content_sha256, null);
  assert.equal(typeof attachment.data.hydration_error, "string");
  assert.equal(fetchAttachment.mock.callCount(), 0, "must not download when declared size exceeds cap");
  assert.equal(uploadBlob.mock.callCount(), 0, "must not upload when declared size exceeds cap");
});

test("processMessage: refuses hydration when streamed bytes overshoot the cap (under-reported size)", async () => {
  const oversizedBytes = Buffer.alloc(2048, 0x41);
  const uploadBlob = mock.fn(({ content }: { content: AsyncIterable<Buffer | Uint8Array | string> }) => {
    return (async () => {
      let bytes = 0;
      // Drain the upstream stream — guard should error before we collect everything.
      for await (const chunk of content) {
        bytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.from(chunk).byteLength;
      }
      return {
        blob_id: "blob_unused",
        mime_type: "application/octet-stream",
        sha256: "0".repeat(64),
        size_bytes: bytes,
      };
    })();
  });
  const hydrateAttachment = makeAttachmentHydrator({
    connectorId: "https://registry.pdpp.org/connectors/gmail",
    fetchAttachment: () =>
      Promise.resolve({
        // Source under-reports the size: declared 100 bytes but actually 2048.
        content: Readable.from([oversizedBytes.subarray(0, 700), oversizedBytes.subarray(700)]),
        expectedSize: 100,
        mimeType: "application/octet-stream",
      }),
    maxBytes: 1024,
    uploadBlob,
  });

  const { deps, emitted } = makeHarness({
    hydrateAttachment,
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });
  await processMessage(deps, makeAttachmentMsg());

  const attachment = emitted.find((record) => record.stream === "attachments");
  assert.ok(attachment, "expected too_large attachment metadata");
  assert.equal(attachment.data.hydration_status, "too_large");
  assert.equal(attachment.data.blob_ref, null);
  assert.equal(uploadBlob.mock.callCount(), 1, "upload was attempted but the streaming cap fired mid-flight");
});

test("resolveMaxAttachmentBytes: env override is honored only when positive integer; otherwise falls back to default", () => {
  assert.equal(resolveMaxAttachmentBytes({}), DEFAULT_MAX_ATTACHMENT_BYTES);
  assert.equal(resolveMaxAttachmentBytes({ PDPP_GMAIL_MAX_ATTACHMENT_BYTES: "1048576" }), 1_048_576);
  assert.equal(
    resolveMaxAttachmentBytes({ PDPP_GMAIL_MAX_ATTACHMENT_BYTES: "0" }),
    DEFAULT_MAX_ATTACHMENT_BYTES,
    "non-positive override is ignored"
  );
  assert.equal(
    resolveMaxAttachmentBytes({ PDPP_GMAIL_MAX_ATTACHMENT_BYTES: "abc" }),
    DEFAULT_MAX_ATTACHMENT_BYTES,
    "unparseable override is ignored"
  );
  assert.equal(
    resolveMaxAttachmentBytes({ PDPP_GMAIL_MAX_ATTACHMENT_BYTES: "123abc" }),
    DEFAULT_MAX_ATTACHMENT_BYTES,
    "partially numeric override is ignored"
  );
});

test("runtimeBlobUploadAvailable: requires an RS URL alias and owner token", () => {
  assert.equal(runtimeBlobUploadAvailable({}), false);
  assert.equal(runtimeBlobUploadAvailable({ PDPP_RS_URL: "http://rs.local" }), false);
  assert.equal(runtimeBlobUploadAvailable({ PDPP_OWNER_TOKEN: "token" }), false);
  assert.equal(runtimeBlobUploadAvailable({ PDPP_RS_URL: "http://rs.local", PDPP_OWNER_TOKEN: "token" }), true);
  assert.equal(runtimeBlobUploadAvailable({ RS_URL: "http://rs.local", PDPP_OWNER_TOKEN: "token" }), true);
});

test("validateAttachmentHydrationPreflight: fails attachment hydration before mailbox work when prerequisites are missing", () => {
  assert.equal(
    validateAttachmentHydrationPreflight({
      env: {},
      requested: makeRequested(["attachments"]),
    }),
    "Gmail attachment hydration requires GMAIL_ADDRESS or GMAIL_USER"
  );
  assert.equal(
    validateAttachmentHydrationPreflight({
      env: { GMAIL_ADDRESS: "me@example.com" },
      requested: makeRequested(["attachments"]),
    }),
    "Gmail attachment hydration requires GOOGLE_APP_PASSWORD_PDPP or GMAIL_APP_PASSWORD"
  );
  assert.equal(
    validateAttachmentHydrationPreflight({
      env: {
        GMAIL_ADDRESS: "me@example.com",
        GOOGLE_APP_PASSWORD_PDPP: "app-password",
      },
      requested: makeRequested(["attachments"]),
    }),
    "blob upload unavailable: PDPP_RS_URL and PDPP_OWNER_TOKEN must be provided by the runtime"
  );
  assert.equal(
    validateAttachmentHydrationPreflight({
      env: {
        GMAIL_ADDRESS: "me@example.com",
        GOOGLE_APP_PASSWORD_PDPP: "app-password",
        PDPP_OWNER_TOKEN: "owner-token",
        PDPP_RS_URL: "http://127.0.0.1:4000",
      },
      requested: makeRequested(["attachments"]),
    }),
    null
  );
});

test("validateAttachmentHydrationPreflight: explicit backfill requires upload config even when attachments stream is not requested", () => {
  assert.equal(
    validateAttachmentHydrationPreflight({
      env: {
        GMAIL_ADDRESS: "me@example.com",
        GOOGLE_APP_PASSWORD_PDPP: "app-password",
      },
      requested: makeRequested(["messages"]),
      streamsToBackfill: ["attachments"],
    }),
    "blob upload unavailable: PDPP_RS_URL and PDPP_OWNER_TOKEN must be provided by the runtime"
  );
});

test("shouldBackfillAttachments: pending attachment detail gaps trigger historical backfill without the CLI flag", () => {
  const attachmentGap: DetailGapStartEntry = {
    gap_id: "gap-attachment-1",
    reference_only: true,
    status: "pending",
    stream: "attachments",
  };
  const messageGap: DetailGapStartEntry = {
    gap_id: "gap-message-1",
    reference_only: true,
    status: "pending",
    stream: "messages",
  };

  assert.equal(shouldBackfillAttachments({ detailGaps: [attachmentGap] }), true);
  assert.equal(shouldBackfillAttachments({ detailGaps: [messageGap] }), false);
  assert.equal(shouldBackfillAttachments({ streamsToBackfill: ["attachments"] }), true);
});

test("validateAttachmentHydrationPreflight: pending attachment detail gaps require blob upload config even without explicit backfill", () => {
  assert.equal(
    validateAttachmentHydrationPreflight({
      detailGaps: [
        {
          gap_id: "gap-attachment-1",
          reference_only: true,
          status: "pending",
          stream: "attachments",
        },
      ],
      env: {
        GMAIL_ADDRESS: "me@example.com",
        GOOGLE_APP_PASSWORD_PDPP: "app-password",
      },
      requested: makeRequested(["messages"]),
    }),
    "blob upload unavailable: PDPP_RS_URL and PDPP_OWNER_TOKEN must be provided by the runtime"
  );
});

test("Gmail env aliases prefer Docker names while accepting documented names", () => {
  assert.equal(
    resolveGmailPasswordFromEnv({
      GOOGLE_APP_PASSWORD_PDPP: "docker-password",
      GMAIL_APP_PASSWORD: "docs-password",
    }),
    "docker-password"
  );
  assert.equal(resolveGmailPasswordFromEnv({ GMAIL_APP_PASSWORD: "docs-password" }), "docs-password");
  assert.equal(resolveGmailPasswordFromEnv({}), null);

  assert.equal(
    resolveGmailAddressFromEnv({
      GMAIL_ADDRESS: "docker@example.com",
      GMAIL_USER: "docs@example.com",
    }),
    "docker@example.com"
  );
  assert.equal(resolveGmailAddressFromEnv({ GMAIL_USER: "docs@example.com" }), "docs@example.com");
  assert.equal(resolveGmailAddressFromEnv({ AMAZON_USERNAME: "amazon@example.com" }), "amazon@example.com");
  assert.equal(resolveGmailAddressFromEnv({ AMAZON_USERNAME: "not-an-email" }), null);
});

test("selectAllMailFetchRange: incremental runs use priorUidnext:* regardless of requested streams", () => {
  // Incremental sync: fetch range covers only new UIDs we haven't seen yet,
  // independent of whether the run scope includes attachments. New
  // messages still hit `processMessage`, which emits attachment records
  // for any new message that carries them (per-message gate at lines
  // 357-361 of connectors/gmail/index.ts).
  assert.equal(selectAllMailFetchRange({ fullResync: false, priorUidnext: 500 }, makeRequested(["messages"])), "500:*");
  assert.equal(
    selectAllMailFetchRange({ fullResync: false, priorUidnext: 500 }, makeRequested(["attachments"])),
    "500:*"
  );
  assert.equal(
    selectAllMailFetchRange(
      { fullResync: false, priorUidnext: 500 },
      makeRequested(["messages", "attachments", "message_bodies", "threads", "labels"])
    ),
    "500:*"
  );
  // Full resync (no prior uidvalidity or uidvalidity changed): still 1:*.
  assert.equal(selectAllMailFetchRange({ fullResync: true, priorUidnext: 500 }, makeRequested(["attachments"])), "1:*");
  assert.equal(selectAllMailFetchRange({ fullResync: true, priorUidnext: 500 }, makeRequested(["messages"])), "1:*");
});

test("selectAttachmentBackfillFetchRange: historical range is bounded and independent of messages uidnext cursor", () => {
  assert.equal(
    selectAttachmentBackfillFetchRange({
      attachmentBackfill: { uidvalidity: 123 },
      priorUidnext: 500,
    }),
    "1:499"
  );
  assert.equal(
    selectAttachmentBackfillFetchRange({
      attachmentBackfill: { backfilled_through_uid: 250, uidvalidity: 123 },
      maxWindowUids: 100,
      priorUidnext: 500,
    }),
    "251:350"
  );
  assert.equal(
    selectAttachmentBackfillFetchRange({
      attachmentBackfill: { backfilled_through_uid: 499, uidvalidity: 123 },
      priorUidnext: 500,
    }),
    null
  );
});

test("selectAttachmentBackfillFetchRange: interrupted windows replay until the durable cursor advances", () => {
  const session = {
    attachmentBackfill: { backfilled_through_uid: 100, uidvalidity: 123 },
    maxWindowUids: 50,
    priorUidnext: 251,
  };
  assert.equal(selectAttachmentBackfillFetchRange(session), "101:150");

  // If a run crashes before its STATE is persisted, the durable cursor is
  // unchanged and the same bounded window is retried. Attachment records are
  // idempotent/content-addressed, so replay is safer than skipping ahead.
  assert.equal(selectAttachmentBackfillFetchRange(session), "101:150");

  assert.equal(
    selectAttachmentBackfillFetchRange({
      ...session,
      attachmentBackfill: { backfilled_through_uid: 150, uidvalidity: 123 },
    }),
    "151:200"
  );
});

test("recoverServedAttachmentGaps: a completed historical cursor still drains a served-gap prefix without scanning the mailbox", async () => {
  assert.equal(
    selectAttachmentBackfillFetchRange({
      attachmentBackfill: { backfilled_through_uid: 499, uidvalidity: 123 },
      priorUidnext: 500,
    }),
    null,
    "the historical attachment cursor is already complete"
  );

  const oversizedGap: DetailGapStartEntry = {
    gap_id: "gap-served-oversized",
    reference_only: true,
    status: "pending",
    stream: "attachments",
    record_key: "gmmsgid-recovery:1",
    detail_locator: {
      kind: "gmail.attachment_detail",
      attachment_id: "gmmsgid-recovery:1",
      message_id: "gmmsgid-recovery",
      part_index: "1",
    },
  };
  const admittedGap: DetailGapStartEntry = {
    gap_id: "gap-served-admitted",
    reference_only: true,
    status: "pending",
    stream: "attachments",
    record_key: "gmmsgid-recovery:2",
    detail_locator: {
      kind: "gmail.attachment_detail",
      attachment_id: "gmmsgid-recovery:2",
      message_id: "gmmsgid-recovery",
      part_index: "2",
    },
  };
  const attachmentCoverage = makeAttachmentDetailCoverage();
  const recoveryMessage = makeServedRecoveryMsg();
  const search = mock.fn((query: { emailId?: string }) => {
    assert.equal(query.emailId, "gmmsgid-recovery");
    return Promise.resolve([recoveryMessage.uid ?? 321]);
  });
  const fetchOne = mock.fn((range: string) => {
    assert.equal(range, "321");
    return Promise.resolve(recoveryMessage);
  });
  const client: Pick<ImapFlow, "search" | "fetchOne"> = { search, fetchOne };
  const hydrateAttachmentMock = mock.fn((_msg: FetchMessageObject, attachment: AttachmentRecord) =>
    Promise.resolve({
      ...attachment,
      blob_ref: {
        blob_id: `blob-${attachment.id}`,
        mime_type: attachment.content_type ?? "application/octet-stream",
        sha256: `sha-${attachment.id}`,
        size_bytes: attachment.size_bytes ?? 0,
      },
      content_sha256: `sha-${attachment.id}`,
      content_type: attachment.content_type,
      hydration_error: null,
      hydration_status: "hydrated" as const,
      size_bytes: attachment.size_bytes,
    })
  );
  const harness = makeHarness({
    attachmentCoverage,
    detailGaps: [oversizedGap, admittedGap],
    hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });
  const recoveredAttachmentGapIds = harness.deps.recoveredAttachmentGapIds ?? new Set<string>();

  const summary = await recoverServedAttachmentGaps(client, {
    attachmentCoverage,
    detailGaps: [oversizedGap, admittedGap],
    emitProtocol: harness.deps.emitProtocol,
    emitRecord: harness.deps.emitRecord,
    hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
    recoveredAttachmentGapIds,
  });

  assert.equal(search.mock.callCount(), 1, "the recovery pass should search the message only once");
  assert.equal(fetchOne.mock.callCount(), 1, "the recovery pass should fetch the message only once");
  assert.equal(summary.admitted, 1, "the positional prefix should admit only the oversized first gap");
  assert.equal(summary.recovered, 1, "the admitted gap should recover");
  assert.equal(hydrateAttachmentMock.mock.callCount(), 1, "the unadmitted gap must remain untouched");

  const recovered = harness.protocolMessages.filter((msg) => msg.type === "DETAIL_GAP_RECOVERED");
  assert.deepEqual(
    recovered.map((msg) => (msg as { gap_id?: string }).gap_id),
    ["gap-served-oversized"],
    "only the admitted served gap should be acknowledged as recovered"
  );

  const coverage = buildAttachmentDetailCoverageMessage(attachmentCoverage);
  assert.equal(coverage.considered, 1, "only the admitted gap should count toward considered");
  assert.equal(coverage.covered, 1, "the admitted gap hydrated successfully");
  assert.deepEqual(coverage.required_keys, ["gmmsgid-recovery:1"]);
  assert.equal(coverage.gap_keys, undefined, "no retryable gap should be recorded for the recovered attachment");

  const attachments = harness.emitted.filter((record) => record.stream === "attachments");
  assert.equal(attachments.length, 1, "the unadmitted gap must not emit an attachment record");
  assert.equal(attachments[0]?.data.id, "gmmsgid-recovery:1");
});

test("runAttachmentBackfillAndRecoveryPass: served gaps preempt historical attachment backfill and keep the cursor unchanged", async () => {
  const allMail = makeAllMailMailbox();
  const recoveryMessage = makeServedRecoveryMsg();
  const runHarness = makeRecordingEmit();
  const search = mock.fn((query: { emailId?: string }) => {
    assert.equal(query.emailId, "gmmsgid-recovery");
    return Promise.resolve([recoveryMessage.uid ?? 321]);
  });
  const fetchOne = mock.fn((range: string) => {
    assert.equal(range, "321");
    return Promise.resolve(recoveryMessage);
  });
  const fetch = mock.fn(
    () =>
      ({
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          return Promise.reject(new Error("historical backfill must not run when served gaps exist"));
        },
        return() {
          return Promise.resolve({ done: true, value: undefined }) as Promise<IteratorResult<FetchMessageObject>>;
        },
        throw(error: unknown) {
          return Promise.reject(error) as Promise<IteratorResult<FetchMessageObject>>;
        },
      }) as AsyncIterableIterator<FetchMessageObject>
  );
  const client: Pick<ImapFlow, "fetch" | "fetchOne" | "search"> = { fetch, fetchOne, search };
  const attachmentCoverage = makeAttachmentDetailCoverage();
  const hydrateAttachmentMock = mock.fn((_msg: FetchMessageObject, attachment: AttachmentRecord) =>
    Promise.resolve({
      ...attachment,
      blob_ref: {
        blob_id: `blob-${attachment.id}`,
        mime_type: attachment.content_type ?? "application/octet-stream",
        sha256: `sha-${attachment.id}`,
        size_bytes: attachment.size_bytes ?? 0,
      },
      content_sha256: `sha-${attachment.id}`,
      content_type: attachment.content_type,
      hydration_error: null,
      hydration_status: "hydrated" as const,
      size_bytes: attachment.size_bytes,
    })
  );
  const servedGap: DetailGapStartEntry = {
    gap_id: "gap-served-old",
    reference_only: true,
    status: "pending",
    stream: "attachments",
    record_key: "gmmsgid-recovery:1",
    detail_locator: {
      kind: "gmail.attachment_detail",
      attachment_id: "gmmsgid-recovery:1",
      message_id: "gmmsgid-recovery",
      part_index: "1",
    },
  };

  await runAttachmentBackfillAndRecoveryPass({
    allMail,
    attachmentBackfillRequested: true,
    attachmentCoverage,
    client,
    deps: {
      detailGaps: [servedGap],
      emitRecord: mock.fn(() => Promise.resolve(true)),
      emittedAt: FROZEN_NOW,
      requested: makeRequested(["attachments"]),
      streamsToBackfill: [],
    },
    emit: runHarness.emit,
    fetchBodiesBound: mock.fn(() => Promise.reject(new Error("historical body fetch must not run"))),
    hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
    recoveredAttachmentGapIds: new Set<string>(),
    session: {
      attachmentBackfill: { backfilled_through_uid: 250, uidvalidity: 123 },
      fullResync: false,
      highestModseqCursor: null,
      priorModseq: null,
      priorUidnext: 500,
      uidnext: 600,
      uidvalidityNum: 123,
    },
  });

  assert.equal(search.mock.callCount(), 1, "served-gap recovery should use X-GM-MSGID lookup");
  assert.equal(fetchOne.mock.callCount(), 1, "served-gap recovery should fetch exactly one message");
  assert.equal(fetch.mock.callCount(), 0, "historical attachment backfill must not run in the served-gap branch");
  assert.equal(hydrateAttachmentMock.mock.callCount(), 1, "the served attachment should be attempted now");

  const attachmentCoverageMessage = buildAttachmentDetailCoverageMessage(attachmentCoverage);
  assert.equal(attachmentCoverageMessage.considered, 1);
  assert.equal(attachmentCoverageMessage.covered, 1);
  const recovered = runHarness.protocolMessages.filter((msg) => msg.type === "DETAIL_GAP_RECOVERED");
  assert.deepEqual(
    recovered.map((msg) => (msg as { gap_id?: string }).gap_id),
    ["gap-served-old"],
    "the served gap should recover now"
  );
  assert.ok(
    runHarness.protocolMessages.some((msg) => msg.type === "PROGRESS" && msg.stream === "attachments"),
    "the served-gap branch should emit its own recovery progress"
  );
  assert.equal(
    runHarness.protocolMessages.some((msg) => msg.type === "STATE" && msg.stream === "attachments"),
    false,
    "the served-gap branch must not advance the historical attachment cursor"
  );
  assert.equal(
    runHarness.protocolMessages.some(
      (msg) =>
        msg.type === "PROGRESS" &&
        msg.stream === "attachments" &&
        msg.message.includes("Backfilling historical attachment UIDs")
    ),
    false,
    "the historical byte-budget page must not run in the served-gap branch"
  );
});

test("runAttachmentBackfillAndRecoveryPass: recoveryOnly=true recovers served gaps and suppresses the forward walk", async () => {
  const allMail = makeAllMailMailbox();
  const recoveryMessage = makeServedRecoveryMsg();
  const runHarness = makeRecordingEmit();
  const search = mock.fn((query: { emailId?: string }) => {
    assert.equal(query.emailId, "gmmsgid-recovery");
    return Promise.resolve([recoveryMessage.uid ?? 321]);
  });
  const fetchOne = mock.fn((range: string) => {
    assert.equal(range, "321");
    return Promise.resolve(recoveryMessage);
  });
  const fetch = mock.fn(
    () =>
      ({
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          return Promise.reject(new Error("historical backfill must not run in recoveryOnly mode"));
        },
        return() {
          return Promise.resolve({ done: true, value: undefined }) as Promise<IteratorResult<FetchMessageObject>>;
        },
        throw(error: unknown) {
          return Promise.reject(error) as Promise<IteratorResult<FetchMessageObject>>;
        },
      }) as AsyncIterableIterator<FetchMessageObject>
  );
  const client: Pick<ImapFlow, "fetch" | "fetchOne" | "search"> = { fetch, fetchOne, search };
  const attachmentCoverage = makeAttachmentDetailCoverage();
  const hydrateAttachmentMock = mock.fn((_msg: FetchMessageObject, attachment: AttachmentRecord) =>
    Promise.resolve({
      ...attachment,
      blob_ref: {
        blob_id: `blob-${attachment.id}`,
        mime_type: attachment.content_type ?? "application/octet-stream",
        sha256: `sha-${attachment.id}`,
        size_bytes: attachment.size_bytes ?? 0,
      },
      content_sha256: `sha-${attachment.id}`,
      content_type: attachment.content_type,
      hydration_error: null,
      hydration_status: "hydrated" as const,
      size_bytes: attachment.size_bytes,
    })
  );
  const servedGap: DetailGapStartEntry = {
    gap_id: "gap-served-only",
    reference_only: true,
    status: "pending",
    stream: "attachments",
    record_key: "gmmsgid-recovery:1",
    detail_locator: {
      kind: "gmail.attachment_detail",
      attachment_id: "gmmsgid-recovery:1",
      message_id: "gmmsgid-recovery",
      part_index: "1",
    },
  };

  await runAttachmentBackfillAndRecoveryPass({
    allMail,
    attachmentBackfillRequested: true,
    attachmentCoverage,
    client,
    deps: {
      detailGaps: [servedGap],
      emitRecord: mock.fn(() => Promise.resolve(true)),
      emittedAt: FROZEN_NOW,
      recoveryOnly: true,
      requested: makeRequested(["attachments"]),
      streamsToBackfill: [],
    },
    emit: runHarness.emit,
    fetchBodiesBound: mock.fn(() => Promise.reject(new Error("historical body fetch must not run"))),
    hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
    recoveredAttachmentGapIds: new Set<string>(),
    recoveryOnly: true,
    session: {
      attachmentBackfill: { backfilled_through_uid: 250, uidvalidity: 123 },
      fullResync: false,
      highestModseqCursor: null,
      priorModseq: null,
      priorUidnext: 500,
      uidnext: 600,
      uidvalidityNum: 123,
    },
  });

  assert.equal(search.mock.callCount(), 1, "served-gap recovery should still look up the message by X-GM-MSGID");
  assert.equal(fetchOne.mock.callCount(), 1, "served-gap recovery should still fetch exactly one message");
  assert.equal(fetch.mock.callCount(), 0, "recoveryOnly mode must not enter the historical attachment backfill");
  assert.equal(hydrateAttachmentMock.mock.callCount(), 1, "the served attachment should still be attempted now");
  assert.equal(
    runHarness.protocolMessages.some((msg) => msg.type === "PROGRESS" && msg.stream === "attachments"),
    true,
    "recoveryOnly mode should still emit the recovery progress"
  );
  assert.equal(
    runHarness.protocolMessages.some((msg) => msg.type === "STATE" && msg.stream === "attachments"),
    false,
    "recoveryOnly mode must not advance the historical attachment cursor"
  );
});

test("recoverServedAttachmentGaps: an oversized first candidate admits exactly one lookup, fetch, and hydration", async () => {
  const originalBudget = process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES;
  process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES = String(ATTACHMENT_BACKFILL_PAGE_MIN_BYTES);
  try {
    const messagesById = new Map<string, FetchMessageObject>();
    const servedGaps = Array.from({ length: 256 }, (_unused, index) => {
      const messageId = `gmmsgid-${String(index).padStart(3, "0")}`;
      const message = makeServedRecoveryMsg({
        attachments: [index === 0 ? 2 * 1024 * 1024 : 16],
        emailId: messageId,
        threadId: `gmthrid-${index}`,
        uid: 1000 + index,
      });
      messagesById.set(messageId, message);
      return makeServedRecoveryGap({
        gapId: `gap-${index}`,
        messageId,
        partIndex: 1,
      });
    });
    const search = mock.fn((query: { emailId?: string }) => {
      const message = query.emailId ? messagesById.get(query.emailId) : undefined;
      return Promise.resolve(message ? [message.uid ?? 0] : []);
    });
    const fetchOne = mock.fn((range: string) => {
      const uid = Number(range);
      const message = [...messagesById.values()].find((candidate) => candidate.uid === uid);
      assert.ok(message, `unexpected uid lookup: ${range}`);
      return Promise.resolve(message);
    });
    const hydrateAttachmentMock = mock.fn((_msg: FetchMessageObject, attachment: AttachmentRecord) =>
      Promise.resolve({
        ...attachment,
        blob_ref: {
          blob_id: `blob-${attachment.id}`,
          mime_type: attachment.content_type ?? "application/octet-stream",
          sha256: `sha-${attachment.id}`,
          size_bytes: attachment.size_bytes ?? 0,
        },
        content_sha256: `sha-${attachment.id}`,
        content_type: attachment.content_type,
        hydration_error: null,
        hydration_status: "hydrated" as const,
        size_bytes: attachment.size_bytes,
      })
    );
    const emitHarness = makeRecordingEmit();
    const emitRecord = async (stream: string, data: Record<string, unknown>): Promise<boolean> => {
      await emitHarness.emitRecord(stream, data);
      return true;
    };

    const summary = await recoverServedAttachmentGaps(
      { search, fetchOne },
      {
        detailGaps: servedGaps,
        emitProtocol: emitHarness.emit,
        emitRecord,
        hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
      }
    );

    assert.equal(search.mock.callCount(), 1, "the oversized first admitted candidate should stop the probe lane");
    assert.equal(fetchOne.mock.callCount(), 1, "the oversized first admitted candidate should fetch once");
    assert.equal(
      hydrateAttachmentMock.mock.callCount(),
      1,
      "the oversized first admitted candidate should hydrate once"
    );
    assert.equal(summary.admitted, 1);
    assert.equal(summary.recovered, 1);
    const progressMessages = emitHarness.protocolMessages.filter((msg) => msg.type === "PROGRESS");
    assert.equal(
      progressMessages.length,
      2,
      "the run should emit hydrating and settled progress for the admitted attempt"
    );
    assert.match(progressMessages[0]?.message ?? "", /phase=hydrating/u);
    assert.match(progressMessages[1]?.message ?? "", /phase=settled/u);
    assert.match(
      progressMessages[1]?.message ?? "",
      /admitted=1 recovered=1 metadata_lookups=1/u,
      "the progress message should stay bounded and non-secret"
    );
  } finally {
    if (originalBudget === undefined) {
      delete process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES;
    } else {
      process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES = originalBudget;
    }
  }
});

test("recoverServedAttachmentGaps: small candidates stop at budget after one rejected probe", async () => {
  const originalBudget = process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES;
  process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES = String(ATTACHMENT_BACKFILL_PAGE_MIN_BYTES);
  try {
    const messagesById = new Map<string, FetchMessageObject>();
    const servedGaps = Array.from({ length: 5 }, (_unused, index) => {
      const messageId = `gmmsgid-small-${index}`;
      const message = makeServedRecoveryMsg({
        attachments: [100_000],
        emailId: messageId,
        threadId: `gmthrid-small-${index}`,
        uid: 2000 + index,
      });
      messagesById.set(messageId, message);
      return makeServedRecoveryGap({
        gapId: `gap-small-${index}`,
        messageId,
        partIndex: 1,
      });
    });
    const search = mock.fn((query: { emailId?: string }) => {
      const message = query.emailId ? messagesById.get(query.emailId) : undefined;
      return Promise.resolve(message ? [message.uid ?? 0] : []);
    });
    const fetchOne = mock.fn((range: string) => {
      const uid = Number(range);
      const message = [...messagesById.values()].find((candidate) => candidate.uid === uid);
      assert.ok(message, `unexpected uid lookup: ${range}`);
      return Promise.resolve(message);
    });
    const hydrateAttachmentMock = mock.fn((_msg: FetchMessageObject, attachment: AttachmentRecord) =>
      Promise.resolve({
        ...attachment,
        blob_ref: {
          blob_id: `blob-${attachment.id}`,
          mime_type: attachment.content_type ?? "application/octet-stream",
          sha256: `sha-${attachment.id}`,
          size_bytes: attachment.size_bytes ?? 0,
        },
        content_sha256: `sha-${attachment.id}`,
        content_type: attachment.content_type,
        hydration_error: null,
        hydration_status: "hydrated" as const,
        size_bytes: attachment.size_bytes,
      })
    );
    const emitHarness = makeRecordingEmit();
    const emitRecord = async (stream: string, data: Record<string, unknown>): Promise<boolean> => {
      await emitHarness.emitRecord(stream, data);
      return true;
    };

    const summary = await recoverServedAttachmentGaps(
      { search, fetchOne },
      {
        detailGaps: servedGaps,
        emitProtocol: emitHarness.emit,
        emitRecord,
        hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
      }
    );

    assert.equal(search.mock.callCount(), 3, "the first rejected overflow probe is the only extra lookup");
    assert.equal(fetchOne.mock.callCount(), 3, "the overflow candidate should still require one fetch before stopping");
    assert.equal(hydrateAttachmentMock.mock.callCount(), 2, "only the budgeted prefix should hydrate");
    assert.equal(summary.admitted, 2);
    assert.equal(summary.recovered, 2);
    const progressMessages = emitHarness.protocolMessages.filter((msg) => msg.type === "PROGRESS");
    assert.equal(progressMessages.length, 4, "each admitted attempt should emit hydrating and settled progress");
    assert.deepEqual(
      progressMessages.map((msg) => msg.message.match(/phase=([a-z]+)/u)?.[1]),
      ["hydrating", "settled", "hydrating", "settled"]
    );
  } finally {
    if (originalBudget === undefined) {
      delete process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES;
    } else {
      process.env.PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES = originalBudget;
    }
  }
});

test("recoverServedAttachmentGaps: emits hydrating progress before a slow hydration resolves, then emits recovery and settled progress after record emission", async () => {
  const message = makeServedRecoveryMsg({
    attachments: [16],
    emailId: "gmmsgid-slow",
    threadId: "gmthrid-slow",
    uid: 5000,
  });
  const search = mock.fn((query: { emailId?: string }) => {
    assert.equal(query.emailId, "gmmsgid-slow");
    return Promise.resolve([message.uid ?? 5000]);
  });
  const fetchOne = mock.fn((range: string) => {
    assert.equal(range, "5000");
    return Promise.resolve(message);
  });
  const hydration = createDeferred<AttachmentRecord>();
  const hydrateAttachmentMock = mock.fn(() => hydration.promise);
  const emitHarness = makeRecordingEmit();
  const emitRecord = async (stream: string, data: Record<string, unknown>): Promise<boolean> => {
    await emitHarness.emitRecord(stream, data);
    return true;
  };

  const runPromise = recoverServedAttachmentGaps(
    { search, fetchOne },
    {
      detailGaps: [
        makeServedRecoveryGap({
          gapId: "gap-slow",
          messageId: "gmmsgid-slow",
          partIndex: 1,
        }),
      ],
      emitProtocol: emitHarness.emit,
      emitRecord,
      hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
    }
  );

  await new Promise<void>((resolve) => setImmediate(resolve));

  const preResolveProgress = emitHarness.protocolMessages.filter(
    (msg): msg is ProgressMessage => msg.type === "PROGRESS"
  );
  assert.equal(preResolveProgress.length, 1, "only the hydrating progress should exist before hydration resolves");
  assert.match(preResolveProgress[0]?.message ?? "", /phase=hydrating/u);
  assert.equal(
    emitHarness.protocolMessages.some((msg) => msg.type === "DETAIL_GAP_RECOVERED"),
    false,
    "no recovery claim should emit before hydration and record emission complete"
  );
  assert.equal(
    emitHarness.protocolMessages.some((msg) => msg.type === "PROGRESS" && msg.message.includes("phase=settled")),
    false,
    "no settled progress should emit before hydration and record emission complete"
  );
  assert.equal(
    emitHarness.events.some((event) => event.kind === "record" && event.stream === "attachments"),
    false,
    "the attachment record must not emit before the hydration promise resolves"
  );

  hydration.resolve({
    blob_ref: {
      blob_id: "blob-gmmsgid-slow:1",
      mime_type: "application/pdf",
      sha256: "sha-gmmsgid-slow:1",
      size_bytes: 16,
    },
    content_id: null,
    content_sha256: "sha-gmmsgid-slow:1",
    content_type: "application/pdf",
    encoding: "base64",
    filename: "attachment-1.pdf",
    hydration_error: null,
    hydration_status: "hydrated",
    id: "gmmsgid-slow:1",
    is_inline: false,
    message_id: "gmmsgid-slow",
    message_received_at: FROZEN_NOW,
    part_index: "1",
    size_bytes: 16,
  });

  const summary = await runPromise;

  assert.equal(search.mock.callCount(), 1);
  assert.equal(fetchOne.mock.callCount(), 1);
  assert.equal(summary.admitted, 1);
  assert.equal(summary.recovered, 1);

  const progressMessages = emitHarness.protocolMessages.filter((msg) => msg.type === "PROGRESS");
  assert.equal(progressMessages.length, 2, "hydrating and settled progress should both emit once the run completes");
  assert.match(progressMessages[0]?.message ?? "", /phase=hydrating/u);
  assert.match(progressMessages[1]?.message ?? "", /phase=settled/u);
  const eventLabel = (event: RecordedEvent): string => {
    if (event.kind === "message") {
      if (event.message.type === "PROGRESS") {
        return `progress:${event.message.message.match(/phase=([a-z]+)/u)?.[1]}`;
      }
      if (event.message.type === "DETAIL_GAP_RECOVERED") {
        return "recovered";
      }
      return "other";
    }
    if (event.kind === "record") {
      return `record:${event.stream}`;
    }
    return "other";
  };
  assert.deepEqual(emitHarness.events.map(eventLabel), [
    "progress:hydrating",
    "record:attachments",
    "recovered",
    "progress:settled",
  ]);
});

test("recoverServedAttachmentGaps: 33 distinct lookup misses cap out at 32 unique metadata calls", async () => {
  const servedGaps = Array.from({ length: 33 }, (_unused, index) =>
    makeServedRecoveryGap({
      gapId: `gap-miss-${index}`,
      messageId: `gmmsgid-miss-${index}`,
      partIndex: 1,
    })
  );
  const search = mock.fn(() => Promise.resolve([] as number[]));
  const fetchOne = mock.fn(() => Promise.reject(new Error("fetchOne should not run for a miss")));
  const emitHarness = makeRecordingEmit();
  const emitRecord = async (stream: string, data: Record<string, unknown>): Promise<boolean> => {
    await emitHarness.emitRecord(stream, data);
    return true;
  };

  const summary = await recoverServedAttachmentGaps(
    { search, fetchOne },
    {
      detailGaps: servedGaps,
      emitProtocol: emitHarness.emit,
      emitRecord,
      hydrateAttachment: mock.fn((_msg: FetchMessageObject, attachment: AttachmentRecord) =>
        Promise.resolve({
          ...attachment,
          blob_ref: null,
          content_sha256: null,
          content_type: attachment.content_type,
          hydration_error: "unexpected",
          hydration_status: "failed" as const,
          size_bytes: attachment.size_bytes,
        })
      ) as HydrateAttachmentFn,
    }
  );

  assert.equal(search.mock.callCount(), 32, "the lookup cap should stop the 33rd unique Gmail metadata lookup");
  assert.equal(fetchOne.mock.callCount(), 0, "misses never fetch a message body");
  assert.equal(summary.admitted, 0);
  assert.equal(summary.recovered, 0);
  assert.equal(
    emitHarness.protocolMessages.some((msg) => msg.type === "PROGRESS"),
    false
  );
});

test("recoverServedAttachmentGaps: same-message served gaps reuse one lookup", async () => {
  const message = makeServedRecoveryMsg({
    attachments: [16, 24],
    emailId: "gmmsgid-cache",
    threadId: "gmthrid-cache",
    uid: 4000,
  });
  const search = mock.fn((query: { emailId?: string }) => {
    if (query.emailId !== "gmmsgid-cache") {
      return Promise.resolve([]);
    }
    return Promise.resolve([message.uid ?? 4000]);
  });
  const fetchOne = mock.fn((range: string) => {
    assert.equal(range, "4000");
    return Promise.resolve(message);
  });
  const hydrateAttachmentMock = mock.fn((_msg: FetchMessageObject, attachment: AttachmentRecord) =>
    Promise.resolve({
      ...attachment,
      blob_ref: {
        blob_id: `blob-${attachment.id}`,
        mime_type: attachment.content_type ?? "application/octet-stream",
        sha256: `sha-${attachment.id}`,
        size_bytes: attachment.size_bytes ?? 0,
      },
      content_sha256: `sha-${attachment.id}`,
      content_type: attachment.content_type,
      hydration_error: null,
      hydration_status: "hydrated" as const,
      size_bytes: attachment.size_bytes,
    })
  );
  const emitHarness = makeRecordingEmit();
  const emitRecord = async (stream: string, data: Record<string, unknown>): Promise<boolean> => {
    await emitHarness.emitRecord(stream, data);
    return true;
  };

  const summary = await recoverServedAttachmentGaps(
    { search, fetchOne },
    {
      detailGaps: [
        makeServedRecoveryGap({
          gapId: "gap-cache-1",
          messageId: "gmmsgid-cache",
          partIndex: 1,
        }),
        makeServedRecoveryGap({
          gapId: "gap-cache-2",
          messageId: "gmmsgid-cache",
          partIndex: 2,
        }),
      ],
      emitProtocol: emitHarness.emit,
      emitRecord,
      hydrateAttachment: hydrateAttachmentMock as HydrateAttachmentFn,
    }
  );

  assert.equal(search.mock.callCount(), 1, "same-message gaps should reuse the cached Gmail metadata lookup");
  assert.equal(fetchOne.mock.callCount(), 1, "same-message gaps should fetch the message only once");
  assert.equal(hydrateAttachmentMock.mock.callCount(), 2, "both same-message gaps should be attempted");
  assert.equal(summary.admitted, 2);
  assert.equal(summary.recovered, 2);
  assert.equal(emitHarness.protocolMessages.filter((msg) => msg.type === "PROGRESS").length, 4);
  assert.deepEqual(
    emitHarness.protocolMessages
      .filter((msg): msg is ProgressMessage => msg.type === "PROGRESS")
      .map((msg) => msg.message.match(/phase=([a-z]+)/u)?.[1]),
    ["hydrating", "settled", "hydrating", "settled"]
  );
});

test("resolveAttachmentBackfillWindowUids: env override must be a positive integer", () => {
  assert.equal(resolveAttachmentBackfillWindowUids({}), DEFAULT_ATTACHMENT_BACKFILL_WINDOW_UIDS);
  assert.equal(resolveAttachmentBackfillWindowUids({ PDPP_GMAIL_ATTACHMENT_BACKFILL_WINDOW_UIDS: "1" }), 1);
  assert.equal(resolveAttachmentBackfillWindowUids({ PDPP_GMAIL_ATTACHMENT_BACKFILL_WINDOW_UIDS: "2000" }), 2000);
  assert.equal(
    resolveAttachmentBackfillWindowUids({ PDPP_GMAIL_ATTACHMENT_BACKFILL_WINDOW_UIDS: "0" }),
    DEFAULT_ATTACHMENT_BACKFILL_WINDOW_UIDS
  );
  assert.equal(
    resolveAttachmentBackfillWindowUids({ PDPP_GMAIL_ATTACHMENT_BACKFILL_WINDOW_UIDS: "12x" }),
    DEFAULT_ATTACHMENT_BACKFILL_WINDOW_UIDS
  );
});

// openspec/changes/fix-recovery-run-lifecycle: the historical attachment
// backfill's actual unit of completed work is a byte-cost-bounded page, not
// the coarse selectAttachmentBackfillFetchRange UID ceiling above. Mirrors
// reference-implementation/runtime/detail-gap-paging.js's
// byte-budget/EWMA/trim-to-budget pattern as Gmail-local policy.

test("attachmentBackfillPageByteBudget: clamps to the configured min/max range", () => {
  assert.equal(attachmentBackfillPageByteBudget(), ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES);
  // Below the minimum falls back to the default, mirroring
  // detail-gap-paging.js's boundedPositiveInteger (below-min is treated as
  // an invalid override, not clamped up).
  assert.equal(attachmentBackfillPageByteBudget(1), ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES);
  assert.equal(
    attachmentBackfillPageByteBudget(ATTACHMENT_BACKFILL_PAGE_MIN_BYTES),
    ATTACHMENT_BACKFILL_PAGE_MIN_BYTES
  );
  assert.equal(attachmentBackfillPageByteBudget(1024 * 1024 * 1024), ATTACHMENT_BACKFILL_PAGE_MAX_BYTES);
  assert.equal(attachmentBackfillPageByteBudget(2 * 1024 * 1024), 2 * 1024 * 1024);
});

test("resolveAttachmentBackfillPageByteBudget: env override must be a positive integer", () => {
  assert.equal(resolveAttachmentBackfillPageByteBudget({}), ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES);
  assert.equal(
    resolveAttachmentBackfillPageByteBudget({ PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES: String(4 * 1024 * 1024) }),
    4 * 1024 * 1024
  );
  assert.equal(
    resolveAttachmentBackfillPageByteBudget({ PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES: "0" }),
    ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES
  );
  assert.equal(
    resolveAttachmentBackfillPageByteBudget({ PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES: "not-a-number" }),
    ATTACHMENT_BACKFILL_PAGE_DEFAULT_BYTES
  );
});

test("trimAttachmentBackfillPageToByteBudget: a page is sized by cumulative byte cost, not a fixed UID count", () => {
  const budget = 1_000_000;
  const candidates = [
    { uid: 1, attachmentBytes: 400_000 },
    { uid: 2, attachmentBytes: 400_000 },
    { uid: 3, attachmentBytes: 400_000 }, // would push cumulative to 1.2M, over budget
    { uid: 4, attachmentBytes: 100 },
  ];
  const { admittedCount, estimatedBytesTotal } = trimAttachmentBackfillPageToByteBudget(candidates, budget);
  assert.equal(admittedCount, 2, "the page stops once the next entry would exceed budget");
  assert.equal(estimatedBytesTotal, 800_000);
});

test("trimAttachmentBackfillPageToByteBudget: a single oversized attachment still forms a complete page", () => {
  const budget = 100_000;
  const candidates = [
    { uid: 1, attachmentBytes: 5_000_000 }, // alone exceeds budget
    { uid: 2, attachmentBytes: 100 },
  ];
  const { admittedCount } = trimAttachmentBackfillPageToByteBudget(candidates, budget);
  assert.equal(admittedCount, 1, "at-least-one-entry admission: an oversized attachment doesn't block all progress");
});

test("trimAttachmentBackfillPageToByteBudget: a zero-attachment UID costs nothing and does not consume budget", () => {
  // The live bug this guards: mapping "no attachments" to the unknown-size
  // fallback would starve an ordinary no-attachment window down to ~4
  // admitted messages per 1 MiB page. A zero-attachment UID must cost 0.
  const budget = 300_000;
  const candidates = [
    { uid: 1, attachmentBytes: 0 },
    { uid: 2, attachmentBytes: 0 },
    { uid: 3, attachmentBytes: 0 },
    { uid: 4, attachmentBytes: 0 },
    { uid: 5, attachmentBytes: 0 },
  ];
  const { admittedCount, estimatedBytesTotal } = trimAttachmentBackfillPageToByteBudget(candidates, budget);
  assert.equal(admittedCount, 5, "every zero-cost UID is admitted regardless of the budget");
  assert.equal(estimatedBytesTotal, 0);
});

test("trimAttachmentBackfillPageToByteBudget: mixed known/unknown attachment sizes charge the fallback per unknown attachment, not per UID", () => {
  // Mirrors how the call site computes attachmentBytes: sum each
  // attachment's known size_bytes, substituting the fixed fallback for
  // each attachment whose size is unavailable — never dropping the
  // unknown ones (which would underestimate the UID's true cost).
  const known = 500_000;
  const mixedUidCost = known + ATTACHMENT_BACKFILL_UNKNOWN_SIZE_FALLBACK_BYTES * 2; // 2 attachments unknown
  const budget = mixedUidCost + 10; // just enough for the one mixed UID
  const candidates = [
    { uid: 1, attachmentBytes: mixedUidCost },
    { uid: 2, attachmentBytes: 100 },
  ];
  const { admittedCount, estimatedBytesTotal } = trimAttachmentBackfillPageToByteBudget(candidates, budget);
  assert.equal(admittedCount, 1);
  assert.equal(estimatedBytesTotal, mixedUidCost);
});

test("trimAttachmentBackfillPageToByteBudget: an empty candidate list admits nothing", () => {
  const { admittedCount, estimatedBytesTotal } = trimAttachmentBackfillPageToByteBudget([], 1_000_000);
  assert.equal(admittedCount, 0);
  assert.equal(estimatedBytesTotal, 0);
});

test("trimAttachmentBackfillPageToByteBudget: caller must sort ascending by UID — an out-of-order high-cost candidate first still trims by position, proving the caller-side sort is load-bearing", () => {
  // This function trusts array order; it does not re-sort. Feeding it an
  // out-of-order list here (as if the caller forgot to sort) demonstrates
  // why the call site sorts probeMetas ascending by UID before trimming:
  // trimming an unsorted list still only returns a POSITIONAL prefix count,
  // so a caller that derives the admitted page via `uid <= someMax` on
  // unsorted input — rather than `slice(0, admittedCount)` on sorted
  // input — could wrongly include a high UID admitted early by an
  // unsorted trim. The fix is call-site sorting, not a trim-level UID
  // filter; this test pins the trim's positional-only contract so a
  // future edit can't silently reintroduce a UID-comparison shortcut.
  const budget = 100;
  const outOfOrderCandidates = [
    { uid: 500, attachmentBytes: 40 }, // a high UID first
    { uid: 1, attachmentBytes: 40 },
    { uid: 2, attachmentBytes: 40 }, // pushes cumulative to 120, over budget
  ];
  const { admittedCount } = trimAttachmentBackfillPageToByteBudget(outOfOrderCandidates, budget);
  assert.equal(admittedCount, 2, "trims by array position, not by UID value — sorting is the caller's responsibility");
});

test("processMessage: attachment bytes are not inlined into message_bodies", async () => {
  const attachmentBytes = Buffer.from("secret attachment payload");
  const hydrateAttachment = makeAttachmentHydrator({
    connectorId: "https://registry.pdpp.org/connectors/gmail",
    fetchAttachment: () =>
      Promise.resolve({
        content: Readable.from([attachmentBytes]),
        expectedSize: attachmentBytes.length,
        mimeType: "application/octet-stream",
      }),
    uploadBlob: async ({ content, mimeType }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const sha256 = createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
      return {
        blob_id: `blob_sha256_${sha256}`,
        mime_type: mimeType,
        sha256,
        size_bytes: attachmentBytes.length,
      };
    },
  });
  const { deps, emitted } = makeHarness({
    hydrateAttachment,
    requested: makeRequested(["message_bodies", "attachments"]),
    wantBodies: true,
    wantMessages: false,
  });

  await processMessage(deps, makeAttachmentMsg());

  const body = emitted.find((record) => record.stream === "message_bodies");
  const attachment = emitted.find((record) => record.stream === "attachments");
  assert.ok(body);
  assert.ok(attachment);
  assert.equal(JSON.stringify(body.data).includes("secret attachment payload"), false);
  assert.equal(JSON.stringify(attachment.data).includes("secret attachment payload"), false);
});

test("processMessage: wantBodies=false suppresses message_bodies but still emits the messages record", async () => {
  const { deps, emitted } = makeHarness({
    wantBodies: false,
    wantMessages: true,
  });
  await processMessage(deps, makeMsg());
  assert.equal(
    emitted.filter((r) => r.stream === "message_bodies").length,
    0,
    "no message_bodies record when wantBodies=false"
  );
  assert.equal(emitted.filter((r) => r.stream === "messages").length, 1, "messages record still emits");
});

// ─── Invariant: all-streams-disabled emits nothing ───────────────────────

test("processMessage: all streams disabled → nothing emitted, but returns true (message was processed)", async () => {
  const { deps, emitted } = makeHarness({
    requested: makeRequested([]), // no 'attachments' requested
    wantBodies: false,
    wantMessages: false,
  });
  const processed = await processMessage(deps, makeMsg());
  assert.equal(emitted.length, 0, "no records emitted when all streams off");
  assert.equal(processed, true, "processed flag still true (message wasn't skipped by early filter)");
});

// ─── Invariant: early-filter skip (missing X-GM-MSGID) ───────────────────

test("processMessage: missing X-GM-MSGID returns false and emits nothing", async () => {
  const { deps, emitted } = makeHarness({ wantMessages: true });
  // Build a message without emailId (we omit rather than set undefined to
  // satisfy exactOptionalPropertyTypes).
  const { emailId: _emailId, ...rest } = makeMsg();
  const processed = await processMessage(deps, rest);
  assert.equal(processed, false);
  assert.equal(emitted.length, 0);
});

// ─── Invariant: time_range filter skips out-of-window messages ───────────

test("processMessage: receivedAt outside time_range → false, emits nothing", async () => {
  const { deps, emitted } = makeHarness({
    timeRange: { since: "2030-01-01T00:00:00.000Z" }, // in the future
    wantMessages: true,
  });
  const processed = await processMessage(deps, makeMsg());
  assert.equal(processed, false);
  assert.equal(emitted.length, 0);
});

// ─── Invariant: body-fetch failure → still emit envelope record ──────────

test("processMessage: fetchBodies that resolves all-nulls still emits messages with snippet=null", async () => {
  const nullFetcher: FetchBodiesFn = (): Promise<FetchedBodies> =>
    Promise.resolve({ bodyHtmlFull: null, bodyTextFull: null, snippet: null });
  const { deps, emitted } = makeHarness({
    fetchBodies: nullFetcher,
    wantMessages: true,
  });
  await processMessage(deps, makeMsg());
  const msgRecord = emitted.find((r) => r.stream === "messages");
  assert.ok(msgRecord, "envelope record must emit even when body fetch returned nothing");
  assert.equal(msgRecord.data.snippet, null, "snippet falls back to null, not undefined");
});

test("processMessage: body-fetch failure + wantBodies=true emits message_bodies with body_source='empty'", async () => {
  const nullFetcher: FetchBodiesFn = (): Promise<FetchedBodies> =>
    Promise.resolve({ bodyHtmlFull: null, bodyTextFull: null, snippet: null });
  const { deps, emitted } = makeHarness({
    fetchBodies: nullFetcher,
    requested: makeRequested(["messages", "message_bodies"]),
    wantBodies: true,
    wantMessages: true,
  });
  await processMessage(deps, makeMsg());
  const bodyRecord = emitted.find((r) => r.stream === "message_bodies");
  assert.ok(bodyRecord);
  assert.equal(bodyRecord.data.body_source, "empty", "body_source marks the fallback");
  assert.equal(bodyRecord.data.body_text, null);
  assert.equal(bodyRecord.data.body_html, null);
});

// ─── Invariant: timestamp propagation (internalDate → received_at) ───────

test("processMessage: message.internalDate propagates into messages.received_at", async () => {
  const { deps, emitted } = makeHarness({ wantMessages: true });
  const fixed = new Date("2026-04-20T10:00:05.000Z");
  await processMessage(deps, makeMsg({ internalDate: fixed }));
  const msgRecord = emitted.find((r) => r.stream === "messages");
  assert.ok(msgRecord);
  assert.equal(msgRecord.data.received_at, fixed.toISOString());
});

test("processMessage: missing internalDate falls back to injected nowIso()", async () => {
  const { deps, emitted } = makeHarness({
    nowIso: (): string => "2026-04-22T12:00:00.000Z",
    wantMessages: true,
  });
  const { internalDate: _internalDate, ...rest } = makeMsg();
  await processMessage(deps, rest);
  const msgRecord = emitted.find((r) => r.stream === "messages");
  assert.ok(msgRecord);
  assert.equal(
    msgRecord.data.received_at,
    "2026-04-22T12:00:00.000Z",
    "nowIso dep is the clock seam for missing internalDate"
  );
});

// ─── Invariant: emitMessagesPass isolates per-message errors ─────────────

test("emitMessagesPass: one message throwing doesn't halt the rest of the batch", async () => {
  let calls = 0;
  const throwingFetcher: FetchBodiesFn = (): Promise<FetchedBodies> => {
    calls += 1;
    if (calls === 1) {
      return Promise.reject(new Error("synthetic fetch failure"));
    }
    return Promise.resolve({ bodyHtmlFull: null, bodyTextFull: "second msg", snippet: "second msg" });
  };
  const { deps, emitted } = makeHarness({
    fetchBodies: throwingFetcher,
    wantMessages: true,
  });
  const metas: FetchMessageObject[] = [
    makeMsg({ emailId: "bad-msg", uid: 1 }),
    makeMsg({ emailId: "good-msg", uid: 2 }),
  ];
  await emitMessagesPass(deps, metas);

  const msgRecords = emitted.filter((r) => r.stream === "messages");
  assert.equal(msgRecords.length, 1, "the second message emits even though the first errored");
  assert.equal(msgRecords[0]?.data.id, "good-msg");
});

test("emitMessagesPass: progress includes count and total when metadata count is known", async () => {
  const { deps, progress } = makeHarness({ wantMessages: true });
  const metas = Array.from({ length: 500 }, (_, i) =>
    makeMsg({
      emailId: `gmmsgid-${i}`,
      threadId: `gmthrid-${i}`,
      uid: i + 1,
    })
  );

  await emitMessagesPass(deps, metas);

  assert.equal(progress.length, 1);
  assert.equal(progress[0]?.stream, "messages");
  assert.equal(progress[0]?.count, 500);
  assert.equal(progress[0]?.total, 500);
});

// ─── Historical attachment backfill: pin the per-UID hydration shape ────
//
// The connector's runAllMailPasses, when START.streamsToBackfill includes
// "attachments", drives emitMessagesPass over the bounded historical UID
// window in attachment-only mode (no messages, no bodies), wrapping
// emitRecord to update the AttachmentBackfillSummary on each
// `attachments` record. These tests pin that mode without IMAP: a
// "historical" UID below priorUidnext is fed through the same code path
// and we verify hydration, idempotency, and summary accounting.
// Scope note: this asserts per-UID behavior and summary shape. Window
// selection is pinned above; cross-invocation replay of the Gmail-shaped
// cursor is pinned in src/collector-runner.test.ts.

test("backfill mode: historical UID below priorUidnext hydrates attachment bytes in attachment-only mode", async () => {
  const historicalPayload = Buffer.from("ancient invoice bytes");
  const expectedSha = createHash("sha256").update(historicalPayload).digest("hex");
  const hydrateAttachment = makeAttachmentHydrator({
    connectorId: "https://registry.pdpp.org/connectors/gmail",
    fetchAttachment: () =>
      Promise.resolve({
        content: Readable.from([historicalPayload]),
        expectedSize: historicalPayload.length,
        mimeType: "application/pdf",
      }),
    uploadBlob: async ({ content, mimeType }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return {
        blob_id: `blob_sha256_${expectedSha}`,
        mime_type: mimeType,
        sha256: expectedSha,
        size_bytes: historicalPayload.length,
      };
    },
  });
  const { deps, emitted } = makeHarness({
    hydrateAttachment,
    // Attachment-only backfill mode: matches runAllMailPasses' inner
    // emitMessagesPass call for the historical window.
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });

  // Wrap emitRecord with summary accounting, like runAllMailPasses does
  // for the historical window. This is what gives the operator-facing
  // PROGRESS payload its hydrated / failed / too_large / unavailable
  // counts.
  const summary = createAttachmentBackfillSummary();
  const originalEmitRecord = deps.emitRecord;
  deps.emitRecord = async (stream, data, _keyField) => {
    await originalEmitRecord(stream, data);
    if (stream === "attachments") {
      addAttachmentBackfillRecordToSummary(summary, data);
    }
  };

  // UID 42 is well below an imagined priorUidnext of 500 — i.e. it is
  // historical and would NOT be revisited by an incremental
  // `priorUidnext:*` pass.
  await emitMessagesPass(deps, [makeAttachmentMsg()]);

  const attachmentRecord = emitted.find((r) => r.stream === "attachments");
  assert.ok(attachmentRecord, "historical attachment must emit a record under streamsToBackfill");
  assert.equal(attachmentRecord.data.hydration_status, "hydrated");
  assert.equal(attachmentRecord.data.content_sha256, expectedSha);
  assert.equal(blobRefBlobId(attachmentRecord), `blob_sha256_${expectedSha}`);

  // No messages / bodies emitted — backfill is attachment-only.
  assert.equal(
    emitted.filter((r) => r.stream === "messages").length,
    0,
    "backfill mode must not re-emit historical messages records"
  );
  assert.equal(
    emitted.filter((r) => r.stream === "message_bodies").length,
    0,
    "backfill mode must not re-emit historical bodies"
  );

  assert.deepEqual(summary, {
    failed: 0,
    hydrated: 1,
    remaining_historical_gaps: 0,
    too_large: 0,
    unavailable_skipped: 0,
  });
});

test("backfill mode: rerunning the same historical UID is idempotent and the summary stays honest", async () => {
  const payload = Buffer.from("ancient invoice bytes");
  const expectedSha = createHash("sha256").update(payload).digest("hex");
  const hydrateAttachment = makeAttachmentHydrator({
    connectorId: "https://registry.pdpp.org/connectors/gmail",
    fetchAttachment: () =>
      Promise.resolve({
        content: Readable.from([payload]),
        expectedSize: payload.length,
        mimeType: "application/pdf",
      }),
    uploadBlob: async ({ content, mimeType }) => {
      // Drain to surface upload semantics; content-addressed blob_id
      // is identical across reruns.
      for await (const _ of content) {
        // intentional: only drain
      }
      return {
        blob_id: `blob_sha256_${expectedSha}`,
        mime_type: mimeType,
        sha256: expectedSha,
        size_bytes: payload.length,
      };
    },
  });
  const { deps, emitted } = makeHarness({
    hydrateAttachment,
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });

  await emitMessagesPass(deps, [makeAttachmentMsg()]);
  await emitMessagesPass(deps, [makeAttachmentMsg()]);

  const attachments = emitted.filter((r) => r.stream === "attachments");
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0]?.data.id, attachments[1]?.data.id);
  assert.equal(attachments[0]?.data.content_sha256, attachments[1]?.data.content_sha256);
  assert.equal(blobRefBlobId(attachments[0]), blobRefBlobId(attachments[1]));
});

test("backfill mode: a failed historical attachment fetch is counted as a remaining historical gap, not silently dropped", async () => {
  const hydrateAttachment = makeAttachmentHydrator({
    connectorId: "https://registry.pdpp.org/connectors/gmail",
    fetchAttachment: () => Promise.reject(new Error("imap fetch transient failure")),
    uploadBlob: () => Promise.reject(new Error("should not be called when fetch fails")),
  });
  const { deps, emitted } = makeHarness({
    hydrateAttachment,
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });

  const summary = createAttachmentBackfillSummary();
  const originalEmitRecord = deps.emitRecord;
  deps.emitRecord = async (stream, data, _keyField) => {
    await originalEmitRecord(stream, data);
    if (stream === "attachments") {
      addAttachmentBackfillRecordToSummary(summary, data);
    }
  };

  await emitMessagesPass(deps, [makeAttachmentMsg()]);

  const attachmentRecord = emitted.find((r) => r.stream === "attachments");
  assert.ok(attachmentRecord, "failed historical attachment must still emit a record so the gap is visible");
  assert.equal(attachmentRecord.data.hydration_status, "failed");
  // The summary counts this as a remaining gap so the operator must
  // re-run before claiming completeness.
  assert.equal(summary.failed, 1);
  assert.equal(summary.hydrated, 0);
  assert.equal(summary.remaining_historical_gaps, 1);
});

// ─── redactEmailForProgress ─────────────────────────────────────────────
//
// The "Connected to <address>" PROGRESS message is operator/model-visible.
// Emitting the owner's full Gmail address leaks a raw PII identifier into
// every consumer of the run stream. These tests prove the redaction keeps
// the domain (so the progress line still confirms which account connected)
// while never echoing the full local-part.

test("redactEmailForProgress: masks the local-part but keeps the domain", () => {
  assert.equal(redactEmailForProgress("taylor.rivera@example.com"), "t***@example.com");
  assert.equal(redactEmailForProgress("alice@example.org"), "a***@example.org");
});

test("redactEmailForProgress: single-character local-part is fully masked", () => {
  // A 1-char local-part would otherwise be wholly revealed by a "keep first
  // char" rule, so it is masked entirely.
  assert.equal(redactEmailForProgress("x@example.com"), "***@example.com");
});

test("redactEmailForProgress: output never contains the full address or local-part", () => {
  for (const address of [
    "the owner.nunamaker@gmail.com",
    "first.last+tag@corp.example.co.uk",
    'weird"@"local@host.example', // quoted local-part embedding an @
  ]) {
    const redacted = redactEmailForProgress(address);
    assert.ok(!redacted.includes(address), `redacted output must not contain the full address: ${redacted}`);
    // Multi-char local-parts (the only ones that carry meaningful identity)
    // must never appear verbatim in the redacted output. A 1-char local-part
    // is masked entirely and is excluded here because it can collide with an
    // unrelated character in the kept domain.
    const localPart = address.slice(0, address.lastIndexOf("@"));
    assert.ok(!redacted.includes(localPart), `redacted output must not contain the full local-part: ${redacted}`);
  }
});

test("redactEmailForProgress: non-address input falls back to a constant placeholder", () => {
  // Defensive: if an unexpected non-email value reaches the progress line we
  // emit a constant rather than risk echoing a raw value.
  assert.equal(redactEmailForProgress("not-an-email"), "[redacted-account]");
  assert.equal(redactEmailForProgress("@no-local.example"), "[redacted-account]");
  assert.equal(redactEmailForProgress("no-domain@"), "[redacted-account]");
  assert.equal(redactEmailForProgress(""), "[redacted-account]");
});

// ─── Attachments detail-coverage evidence (progress-evidence contract) ───
//
// These pin the honest `considered`/hydrated/gap/skip accounting the Gmail
// connector emits for the `attachments` detail stream. They are the
// regression guard for the progress-evidence wiring: if the connector stops
// recording attempted attachments into the coverage accumulator, or
// misclassifies a hydration outcome, these fail.

/** A single-attachment message keyed `gmmsgid-<n>:1`, for coverage tests. */
function makeSingleAttachmentMsg(emailId: string): FetchMessageObject {
  const bodyStructure: MessageStructureObject = {
    childNodes: [
      {
        type: "application/pdf",
        disposition: "attachment",
        dispositionParameters: { filename: "doc.pdf" },
        encoding: "base64",
        size: 21,
      },
    ],
    type: "multipart/mixed",
  };
  return makeMsg({ bodyStructure, emailId });
}

/**
 * A fake hydrator that stamps a chosen terminal `hydration_status` onto every
 * attachment, keyed by the attachment id, so a test can drive each coverage
 * bucket deterministically without exercising the real download/upload path.
 */
function statusStampingHydrator(statusById: Record<string, AttachmentRecord["hydration_status"]>): HydrateAttachmentFn {
  return (_msg, attachment) =>
    Promise.resolve({ ...attachment, hydration_status: statusById[attachment.id] ?? attachment.hydration_status });
}

test("recordAttachmentCoverage: routes each hydration status into the honest bucket", () => {
  const coverage = makeAttachmentDetailCoverage();
  const base: Omit<AttachmentRecord, "id" | "hydration_status"> = {
    blob_ref: null,
    content_id: null,
    content_sha256: null,
    content_type: "application/pdf",
    encoding: "base64",
    filename: "doc.pdf",
    hydration_error: null,
    is_inline: false,
    message_id: "m",
    message_received_at: FROZEN_NOW,
    part_index: "1",
    size_bytes: 10,
  };
  recordAttachmentCoverage(coverage, { ...base, id: "a:1", hydration_status: "hydrated" });
  recordAttachmentCoverage(coverage, { ...base, id: "b:1", hydration_status: "failed" });
  recordAttachmentCoverage(coverage, { ...base, id: "c:1", hydration_status: "too_large" });
  recordAttachmentCoverage(coverage, { ...base, id: "d:1", hydration_status: "deferred" });

  // Every attempt counts toward the denominator.
  assert.deepEqual(coverage.requiredKeys, ["a:1", "b:1", "c:1", "d:1"]);
  // hydrated → numerator; failed → retryable gap; too_large → permanent skip.
  assert.deepEqual(coverage.hydratedKeys, ["a:1"]);
  assert.deepEqual(coverage.gapKeys, ["b:1"]);
  assert.deepEqual(coverage.optionalSkipKeys, ["c:1"]);
  // `deferred` is considered-but-not-attempted: denominator only, no outcome.
  assert.ok(!coverage.hydratedKeys.includes("d:1"));
  assert.ok(!coverage.gapKeys.includes("d:1"));
  assert.ok(!coverage.optionalSkipKeys.includes("d:1"));
  // The failed record is retained so a matching DETAIL_GAP can be emitted; its
  // id is exactly the gap_keys entry, keeping the gap's record_key and the
  // coverage key a single source of truth. Only `failed` is retained.
  assert.deepEqual(
    coverage.failedRecords.map((r) => r.id),
    ["b:1"]
  );
});

test("buildAttachmentDetailCoverageMessage: emits complete zero-attachment coverage", () => {
  const coverage = makeAttachmentDetailCoverage();

  assert.deepEqual(buildAttachmentDetailCoverageMessage(coverage), {
    type: "DETAIL_COVERAGE",
    reference_only: true,
    stream: "attachments",
    state_stream: "messages",
    required_keys: [],
    hydrated_keys: [],
    considered: 0,
    covered: 0,
  });
});

test("buildAttachmentDetailGap: bounded, non-secret gap whose record_key matches the coverage key", () => {
  // A record shaped like the parser produces: id = `<X-GM-MSGID>:<part_index>`.
  const attachment: AttachmentRecord = {
    blob_ref: null,
    content_id: null,
    content_sha256: null,
    content_type: "application/pdf",
    encoding: "base64",
    filename: "invoice.pdf",
    hydration_error: "Error: connect ETIMEDOUT 10.0.0.1:993 (https://secret/token=abc)",
    hydration_status: "failed",
    id: "gmmsgid-9999:2",
    is_inline: false,
    message_id: "gmmsgid-9999",
    message_received_at: FROZEN_NOW,
    part_index: "2",
    size_bytes: 4096,
  };

  const gap = buildAttachmentDetailGap(attachment);

  // record_key == the attachment id == the DETAIL_COVERAGE.gap_keys entry, so
  // the host commit-gate credits the missing required key one-to-one.
  assert.equal(gap.record_key, "gmmsgid-9999:2");
  assert.equal(gap.stream, "attachments");
  assert.equal(gap.parent_stream, "messages");
  assert.equal(gap.reason, "temporary_unavailable");
  assert.equal(gap.status, "pending");
  assert.equal(gap.retryable, true);
  assert.equal(gap.reference_only, true);
  // Locator carries only bounded identifiers sufficient for a later retry.
  assert.deepEqual(gap.detail_locator, {
    kind: "gmail.attachment_detail",
    message_id: "gmmsgid-9999",
    part_index: "2",
    attachment_id: "gmmsgid-9999:2",
  });
  // No error block — the raw hydration_error (which here contains a secret-ish
  // URL/token) is NOT carried anywhere on the gap. Defense against leaking
  // tokens, cookies, URLs, request bodies, or payload snippets.
  assert.equal(gap.detail, undefined);
  assert.equal(gap.last_error, undefined);
  const serialized = JSON.stringify(gap);
  assert.ok(!serialized.includes("token=abc"), "no raw error text crosses the wire");
  assert.ok(!serialized.includes("invoice.pdf"), "no filename crosses the wire");
  assert.ok(!serialized.includes("ETIMEDOUT"), "no raw error text crosses the wire");
});

test("processMessage: records an attempted attachment into the coverage accumulator", async () => {
  const coverage = makeAttachmentDetailCoverage();
  const { deps } = makeHarness({
    attachmentCoverage: coverage,
    hydrateAttachment: statusStampingHydrator({ "gmmsgid-1111:2": "hydrated" }),
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });

  await processMessage(deps, makeAttachmentMsg());

  assert.deepEqual(coverage.requiredKeys, ["gmmsgid-1111:2"]);
  assert.deepEqual(coverage.hydratedKeys, ["gmmsgid-1111:2"]);
  assert.deepEqual(coverage.gapKeys, []);
  assert.deepEqual(coverage.optionalSkipKeys, []);
});

test("processMessage: leaves no coverage trace and still emits when no accumulator is wired", async () => {
  // The accumulator is optional: a pass without one (e.g. attachments not in
  // scope) must not throw and must still emit the attachment record.
  const { deps, emitted } = makeHarness({
    hydrateAttachment: statusStampingHydrator({ "gmmsgid-1111:2": "hydrated" }),
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });

  await processMessage(deps, makeAttachmentMsg());

  assert.equal(deps.attachmentCoverage, undefined, "no accumulator wired");
  assert.ok(
    emitted.some((r) => r.stream === "attachments"),
    "attachment record still emits without coverage accounting"
  );
});

test("emitMessagesPass: accumulates honest coverage across hydrated, gap, and skip outcomes", async () => {
  const coverage = makeAttachmentDetailCoverage();
  const { deps, emitted } = makeHarness({
    attachmentCoverage: coverage,
    // ok:1 hydrates, bad:1 fails (retryable gap), big:1 is too_large (policy skip).
    hydrateAttachment: statusStampingHydrator({
      "ok:1": "hydrated",
      "bad:1": "failed",
      "big:1": "too_large",
    }),
    requested: makeRequested(["attachments"]),
    wantBodies: false,
    wantMessages: false,
  });

  await emitMessagesPass(deps, [
    makeSingleAttachmentMsg("ok"),
    makeSingleAttachmentMsg("bad"),
    makeSingleAttachmentMsg("big"),
  ]);

  // Three attachments attempted → three keys in the denominator.
  assert.deepEqual(coverage.requiredKeys, ["ok:1", "bad:1", "big:1"]);
  assert.deepEqual(coverage.hydratedKeys, ["ok:1"]);
  // failed is a retryable gap; too_large is a permanent by-policy skip.
  assert.deepEqual(coverage.gapKeys, ["bad:1"]);
  assert.deepEqual(coverage.optionalSkipKeys, ["big:1"]);

  // Sanity: every attachment record still emitted (coverage is reference-only,
  // it does not gate record emission).
  assert.equal(emitted.filter((r) => r.stream === "attachments").length, 3);

  // The honest DETAIL_COVERAGE wire shape the connector builds from this
  // accumulator: required = denominator, hydrated = numerator, gaps retryable,
  // skips by-policy, anchored to the `messages` list cursor. reference_only.
  assert.deepEqual(
    buildDetailCoverageMessage({
      stream: "attachments",
      stateStream: "messages",
      requiredKeys: coverage.requiredKeys,
      hydratedKeys: coverage.hydratedKeys,
      gapKeys: coverage.gapKeys,
      optionalSkipKeys: coverage.optionalSkipKeys,
      considered: coverage.requiredKeys.length,
      covered: coverage.hydratedKeys.length + coverage.optionalSkipKeys.length,
    }),
    {
      type: "DETAIL_COVERAGE",
      reference_only: true,
      stream: "attachments",
      state_stream: "messages",
      required_keys: ["ok:1", "bad:1", "big:1"],
      hydrated_keys: ["ok:1"],
      gap_keys: ["bad:1"],
      optional_skip_keys: ["big:1"],
      considered: 3,
      covered: 2,
    }
  );

  // P0 invariant: every gap_keys entry MUST be backed by a matching durable
  // DETAIL_GAP. `gap_keys` alone do not satisfy the host commit-gate, which
  // credits a missing required key only when it is hydrated, optional-skipped,
  // or backed by a pending DETAIL_GAP with the same record_key. Without this,
  // an otherwise-successful run aborts at commit and re-fetches the same window
  // forever. The failed record is retained on the accumulator; one gap per key.
  assert.deepEqual(
    coverage.failedRecords.map((r) => r.id),
    coverage.gapKeys,
    "exactly one retained failed record per gap_keys entry"
  );
  const gaps = coverage.failedRecords.map((r) => buildAttachmentDetailGap(r));
  // The gate matches DETAIL_GAP.record_key against the DETAIL_COVERAGE key.
  assert.deepEqual(
    gaps.map((g) => g.record_key),
    coverage.gapKeys
  );
  // Exact wire shape of the gap for `bad:1`: bounded, non-secret locator
  // (message + part identifiers only), temporary_unavailable (retryable),
  // pending, reference_only, and no error block (no raw error text crosses).
  assert.deepEqual(gaps[0], {
    type: "DETAIL_GAP",
    stream: "attachments",
    parent_stream: "messages",
    record_key: "bad:1",
    status: "pending",
    reason: "temporary_unavailable",
    detail_locator: {
      kind: "gmail.attachment_detail",
      message_id: "bad",
      part_index: "1",
      attachment_id: "bad:1",
    },
    retryable: true,
    reference_only: true,
  });
  // Defense-in-depth: the gap carries no error/last_error block, so no raw
  // hydration_error string (which could echo upstream URLs/text) ever crosses.
  assert.equal(gaps[0]?.detail, undefined);
  assert.equal(gaps[0]?.last_error, undefined);
});
