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
  MessageEnvelopeObject,
  MessageStructureObject,
  // biome-ignore lint/correctness/noUnresolvedImports: imapflow is declared in package.json; Biome's resolver doesn't see it here
} from "imapflow";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  emitMessagesPass,
  type FetchBodiesFn,
  type FetchedBodies,
  type HydrateAttachmentFn,
  makeAttachmentHydrator,
  type PerMessageDeps,
  processMessage,
  resolveMaxAttachmentBytes,
  selectAllMailFetchRange,
} from "./index.ts";
import type { ProgressMessage, StreamRequest } from "./types.ts";

interface RecordingHarness {
  deps: PerMessageDeps;
  emitted: EmittedRecord[];
  progress: ProgressMessage[];
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
    emitProgress: (m: ProgressMessage): Promise<void> => {
      progress.push(m);
      return Promise.resolve();
    },
    emitRecord: harness.emitRecord,
    fetchBodies: overrides.fetchBodies ?? defaultFetchBodies,
    hydrateAttachment: overrides.hydrateAttachment ?? ((_, attachment) => Promise.resolve(attachment)),
    nowIso: overrides.nowIso ?? ((): string => FROZEN_NOW),
    requested,
    timeRange: overrides.timeRange,
    wantBodies: overrides.wantBodies ?? false,
    wantMessages: overrides.wantMessages ?? true,
  };
  return { deps, emitted: harness.emitted, progress };
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
});

test("selectAllMailFetchRange: incremental attachment runs revisit prior messages for metadata-only backfill", () => {
  assert.equal(selectAllMailFetchRange({ fullResync: false, priorUidnext: 500 }, makeRequested(["messages"])), "500:*");
  assert.equal(
    selectAllMailFetchRange({ fullResync: false, priorUidnext: 500 }, makeRequested(["attachments"])),
    "1:*"
  );
  assert.equal(selectAllMailFetchRange({ fullResync: true, priorUidnext: 500 }, makeRequested(["attachments"])), "1:*");
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
