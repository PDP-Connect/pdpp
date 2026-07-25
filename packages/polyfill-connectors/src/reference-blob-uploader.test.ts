// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import { makeAttachmentHydrator } from "../connectors/gmail/index.ts";
import type { AttachmentRecord } from "../connectors/gmail/types.ts";
import { makeReferenceBlobUploader, ReferenceBlobUploadFailure } from "./reference-blob-uploader.ts";

const baseArgs = {
  connectorId: "https://registry.pdpp.org/connectors/test",
  content: [Buffer.from("attachment")],
  mimeType: "text/plain",
  recordKey: "record-key",
  stream: "attachments",
};

function expectFailureKind(
  err: unknown,
  kind: ReferenceBlobUploadFailure["kind"]
): asserts err is ReferenceBlobUploadFailure {
  assert.ok(err instanceof ReferenceBlobUploadFailure);
  assert.equal(err.kind, kind);
}

// Every fixture in this file drives makeReferenceBlobUploader, which always
// calls fetch with a streaming RequestInit.body — init is only optional in
// the ambient `typeof fetch` signature, never in practice here.
function requestBody(init: RequestInit | undefined): ReadableStream<Uint8Array> {
  assert.ok(init?.body, "test fixture fetch must receive a streaming RequestInit.body");
  return init.body as ReadableStream<Uint8Array>;
}

async function consumeBody(init: RequestInit): Promise<void> {
  const reader = requestBody(init).getReader();
  while (!(await reader.read()).done) {
    // Consume the upload stream so its local digest settles.
  }
}

const composedAttachment: AttachmentRecord = {
  blob_ref: null,
  content_id: null,
  content_sha256: null,
  content_type: "text/plain",
  encoding: null,
  filename: null,
  hydration_error: null,
  hydration_status: "deferred",
  id: "attachment-1",
  is_inline: false,
  message_id: "message-1",
  message_received_at: "2026-07-23T00:00:00.000Z",
  part_index: "1",
  size_bytes: null,
};

function composedHydrator(content: AsyncIterable<Buffer>, fetchFn: typeof fetch, maxBytes = 1024) {
  const uploadBlob = makeReferenceBlobUploader({
    fetchFn,
    ownerToken: "test-token",
    rsUrl: "https://pdpp.example.test",
  });
  return makeAttachmentHydrator({
    connectorId: "https://registry.pdpp.org/connectors/test",
    fetchAttachment: () => Promise.resolve({ content, expectedSize: null, mimeType: "text/plain" }),
    maxBytes,
    uploadBlob,
  });
}

test("makeReferenceBlobUploader: classifies transport and HTTP response families at the uploader boundary", async () => {
  const transportCause = new Error("network unavailable");
  const cases: ReadonlyArray<{
    fetchFn: typeof fetch;
    cause?: unknown;
    kind: ReferenceBlobUploadFailure["kind"];
  }> = [
    {
      fetchFn: async () => Promise.reject(transportCause),
      cause: transportCause,
      kind: "transport",
    },
    {
      fetchFn: async () => new Response(JSON.stringify({ error: "denied" }), { status: 403 }),
      kind: "http_4xx",
    },
    {
      fetchFn: async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
      kind: "http_5xx",
    },
  ];

  for (const { fetchFn, cause, kind } of cases) {
    const upload = makeReferenceBlobUploader({
      fetchFn,
      ownerToken: "test-token",
      rsUrl: "https://pdpp.example.test",
    });
    await assert.rejects(
      () => upload(baseArgs),
      (err) => {
        expectFailureKind(err, kind);
        assert.equal(err.cause, cause);
        return true;
      }
    );
  }
});

test("makeReferenceBlobUploader: classifies invalid successful responses and integrity mismatches", async () => {
  const invalidResponseUpload = makeReferenceBlobUploader({
    fetchFn: async () => new Response(JSON.stringify({ object: "not-a-blob" }), { status: 200 }),
    ownerToken: "test-token",
    rsUrl: "https://pdpp.example.test",
  });
  await assert.rejects(
    () => invalidResponseUpload(baseArgs),
    (err) => {
      expectFailureKind(err, "invalid_response");
      return true;
    }
  );

  const integrityUpload = makeReferenceBlobUploader({
    fetchFn: async (_input, init) => {
      await consumeBody(init as RequestInit);
      return new Response(
        JSON.stringify({
          blob_id: "blob-1",
          mime_type: "text/plain",
          object: "blob",
          sha256: "not-the-local-hash",
          size_bytes: 10,
        }),
        { status: 200 }
      );
    },
    ownerToken: "test-token",
    rsUrl: "https://pdpp.example.test",
  });
  await assert.rejects(
    () => integrityUpload(baseArgs),
    (err) => {
      expectFailureKind(err, "integrity_mismatch");
      return true;
    }
  );
});

test("makeReferenceBlobUploader: classifies source stream failures separately from blob transport", async () => {
  const sourceFailure = new Error("IMAP stream failed");
  const brokenContent: AsyncIterable<Buffer> = {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(sourceFailure) }),
  };
  const upload = makeReferenceBlobUploader({
    fetchFn: async (_input, init) => {
      await consumeBody(init as RequestInit);
      return new Response(null, { status: 200 });
    },
    ownerToken: "test-token",
    rsUrl: "https://pdpp.example.test",
  });
  await assert.rejects(
    () => upload({ ...baseArgs, content: brokenContent }),
    (err) => {
      assert.ok(err instanceof ReferenceBlobUploadFailure);
      assert.equal(err.kind, "source_content_failed");
      assert.equal(err.cause, sourceFailure);
      return true;
    }
  );
});

test("makeAttachmentHydrator + makeReferenceBlobUploader: preserves streamed size-policy, source, cancellation, and transport boundaries", async () => {
  const consumeThenReject: typeof fetch = async (_input, init) => {
    await consumeBody(init as RequestInit);
    throw new Error("socket failure");
  };
  const tooLarge = await composedHydrator(
    Readable.from([Buffer.from("four")]),
    consumeThenReject,
    3
  )({} as never, composedAttachment);
  assert.equal(tooLarge.record.hydration_status, "too_large");
  assert.equal(tooLarge.failure, null);

  const sourceFailure = new Error("IMAP source iterator failed");
  const sourceFailed = await composedHydrator(
    { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(sourceFailure) }) },
    consumeThenReject
  )({} as never, composedAttachment);
  assert.equal(sourceFailed.record.hydration_status, "failed");
  assert.equal(sourceFailed.failure?.stage, "imap_download_failed");
  assert.match(sourceFailed.record.hydration_error ?? "", /IMAP source iterator failed/);

  const cancelThenReject: typeof fetch = async (_input, init) => {
    await requestBody(init).cancel("consumer cancelled");
    throw new Error("socket failure after cancellation");
  };
  const cancelled = await composedHydrator(Readable.from([Buffer.from("content")]), cancelThenReject)(
    {} as never,
    composedAttachment
  );
  assert.equal(cancelled.failure?.stage, "blob_upload_transport_failed");
  assert.match(cancelled.record.hydration_error ?? "", /socket failure after cancellation/);

  const cancelThenSuccess: typeof fetch = async (_input, init) => {
    const reader = requestBody(init).getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    await reader.cancel("consumer cancelled");
    const bytes = first.value;
    return new Response(
      JSON.stringify({
        blob_id: "partial",
        mime_type: "text/plain",
        object: "blob",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size_bytes: bytes.byteLength,
      }),
      { status: 200 }
    );
  };
  const partial = await composedHydrator(
    Readable.from([Buffer.from("first"), Buffer.from("second")]),
    cancelThenSuccess
  )({} as never, composedAttachment);
  assert.equal(partial.record.hydration_status, "failed");
  assert.equal(partial.record.blob_ref, null);
  assert.equal(partial.failure?.stage, "blob_upload_transport_failed");
  assert.match(partial.record.hydration_error ?? "", /consumer cancelled/);

  const rejected = await composedHydrator(Readable.from([Buffer.from("content")]), async () =>
    Promise.reject(new Error("socket failure before consumption"))
  )({} as never, composedAttachment);
  assert.equal(rejected.failure?.stage, "blob_upload_transport_failed");
  assert.match(rejected.record.hydration_error ?? "", /socket failure before consumption/);

  const transportCause = new Error("immediate socket rejection");
  const sourceFailureAfterTransport = new Error("late independent source failure");
  let releaseSourceFailure: () => void = () => undefined;
  const sourceFailureReleased = new Promise<void>((resolve) => {
    releaseSourceFailure = resolve;
  });
  let sourcePullStarted: () => void = () => undefined;
  const sourcePullStartedPromise = new Promise<void>((resolve) => {
    sourcePullStarted = resolve;
  });
  const racingSource: AsyncIterable<Buffer> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        sourcePullStarted();
        await sourceFailureReleased;
        throw sourceFailureAfterTransport;
      },
    }),
  };
  const immediateTransport = await composedHydrator(racingSource, async (_input, init) => {
    const read = requestBody(init).getReader().read();
    read.catch(() => undefined);
    await sourcePullStartedPromise;
    throw transportCause;
  })({} as never, composedAttachment);
  assert.equal(immediateTransport.record.hydration_status, "failed");
  assert.equal(immediateTransport.failure?.stage, "blob_upload_transport_failed");
  assert.match(immediateTransport.record.hydration_error ?? "", /immediate socket rejection/);
  releaseSourceFailure();
});

test("makeReferenceBlobUploader: source proximity never replaces an independent transport cause", async () => {
  const upload = makeReferenceBlobUploader({
    ownerToken: "test-token",
    rsUrl: "https://pdpp.example.test",
    fetchFn: async (_input, init) => {
      const reader = requestBody(init).getReader();
      const read = reader.read();
      read.catch(() => undefined);
      await sourcePullStartedPromise;
      setTimeout(releaseSourceFailure, 0);
      throw transportCause;
    },
  });
  const transportCause = new Error("immediate transport rejection");
  const sourceFailure = new Error("source failure in attribution window");
  let releaseSourceFailure: () => void = () => undefined;
  const sourceFailureReleased = new Promise<void>((resolve) => {
    releaseSourceFailure = resolve;
  });
  let sourcePullStarted: () => void = () => undefined;
  const sourcePullStartedPromise = new Promise<void>((resolve) => {
    sourcePullStarted = resolve;
  });
  let sourceFailureObserved: () => void = () => undefined;
  const sourceFailureObservedPromise = new Promise<void>((resolve) => {
    sourceFailureObserved = resolve;
  });
  const sourceDuringTimerWindow: AsyncIterable<Buffer> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        sourcePullStarted();
        await sourceFailureReleased;
        sourceFailureObserved();
        throw sourceFailure;
      },
    }),
  };
  await assert.rejects(
    () => upload({ ...baseArgs, content: sourceDuringTimerWindow }),
    (err) => {
      expectFailureKind(err, "transport");
      assert.equal(err.cause, transportCause);
      assert.equal(err.message, "immediate transport rejection");
      return true;
    }
  );
  await sourceFailureObservedPromise;

  const sourceAlreadyRecorded = new Error("source failure already recorded");
  const sourceAlreadyRecordedContent: AsyncIterable<Buffer> = {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(sourceAlreadyRecorded) }),
  };
  const transportAfterSource = new Error("transport after source marker");
  const uploadAfterSource = makeReferenceBlobUploader({
    ownerToken: "test-token",
    rsUrl: "https://pdpp.example.test",
    fetchFn: async (_input, init) => {
      const reader = requestBody(init).getReader();
      await reader.read().catch(() => undefined);
      throw transportAfterSource;
    },
  });
  await assert.rejects(
    () => uploadAfterSource({ ...baseArgs, content: sourceAlreadyRecordedContent }),
    (err) => {
      expectFailureKind(err, "transport");
      assert.equal(err.cause, transportAfterSource);
      assert.equal(err.message, "transport after source marker");
      return true;
    }
  );
});
