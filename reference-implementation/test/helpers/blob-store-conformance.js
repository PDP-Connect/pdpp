/**
 * Blob-store conformance harness.
 *
 * Test-only helper. Defines the durable blob-persistence obligations of
 * the reference architecture as reusable scenarios that any candidate
 * driver can be run against by supplying a small driver object.
 *
 * The driver shape is intentionally narrow and *semantic*: it speaks in
 * terms of putting content-addressed bytes, getting bytes back by id,
 * recording (connector_id, stream, record_key) bindings, and listing
 * those bindings. It does not expose raw SQL, framework routes,
 * authorization, or a generic `BlobStore` repository surface. It is not
 * exported from production code and SHALL NOT be treated as a production
 * `BlobStore` contract — the production reference still routes
 * `/v1/blobs` through `persistContentAddressedBlob` directly.
 *
 * Driver shape:
 *
 *   {
 *     async setup(): void
 *     async teardown(): void
 *
 *     // Backend identity. Drivers MUST advertise enough metadata that
 *     // callers can reason about portability without inspecting code.
 *     identity(): {
 *       backend_kind: string,                       // free-form, e.g. 'sqlite-blob-rows', 'memory-content-addressed'
 *       content_address: {
 *         algorithm: 'sha256' | string,             // hash algorithm used to derive blob_id
 *         id_prefix: string,                        // e.g. 'blob_sha256_'
 *       },
 *       dedupe: 'content_addressed' | 'none' | string,
 *       binding_kind: 'composite' | string,         // (blob_id, connector_id, stream, record_key) composite
 *     }
 *
 *     // Store bytes addressed by `blobId`. The caller computes the id
 *     // from the bytes and passes it through; the driver SHALL persist
 *     // (or coalesce with an existing identical row). Returns the
 *     // canonical stored metadata. If a row already exists with the
 *     // same blobId but different sha256/size_bytes, the driver SHALL
 *     // throw with an error whose `code === 'collision'` (or set such a
 *     // code on the thrown error). Successful coalesce MUST be
 *     // observable through `getBlob` returning identical metadata.
 *     async putBlob({
 *       blobId, connectorId, stream, recordKey,
 *       mimeType, sizeBytes, sha256, data,
 *     }): { blob_id, mime_type, size_bytes, sha256 }
 *
 *     // Fetch the stored row metadata + bytes by blobId. Returns null
 *     // (not throwing) if nothing is stored under that id.
 *     async getBlob(blobId): {
 *       blob_id, mime_type, size_bytes, sha256, data: Buffer | Uint8Array
 *     } | null
 *
 *     // Record that `(connectorId, stream, recordKey)` references
 *     // `blobId`. Idempotent: re-binding the same tuple is a no-op.
 *     async putBinding({ blobId, connectorId, stream, recordKey }): void
 *
 *     // Return every binding tuple (blob_id, connector_id, stream,
 *     // record_key) for a given record. Order is implementation-defined.
 *     async listBindingsForRecord({ connectorId, stream, recordKey }):
 *       Array<{ blobId, connectorId, stream, recordKey }>
 *
 *     // Return every binding tuple for a given blob_id. Order is
 *     // implementation-defined.
 *     async listBindingsForBlob(blobId):
 *       Array<{ blobId, connectorId, stream, recordKey }>
 *   }
 *
 * Spec: openspec/changes/add-blob-store-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const CONNECTOR_A = 'https://test.pdpp.org/connectors/blob-a';
const CONNECTOR_B = 'https://test.pdpp.org/connectors/blob-b';
const STREAM_ATTACHMENTS = 'attachments';
const STREAM_PHOTOS = 'photos';

function bytesOf(text) {
  return Buffer.from(String(text), 'utf8');
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function blobIdFor(prefix, bytes) {
  return `${prefix}${sha256Hex(bytes)}`;
}

function buildPut(driver, { connectorId, stream, recordKey, mimeType, text }) {
  const data = bytesOf(text);
  const sha256 = sha256Hex(data);
  const id = driver.identity();
  const blobId = `${id.content_address.id_prefix}${sha256}`;
  return {
    blobId,
    connectorId,
    stream,
    recordKey,
    mimeType,
    sizeBytes: data.byteLength,
    sha256,
    data,
  };
}

function bindingsHave(bindings, expected) {
  return bindings.some(
    (b) =>
      b.blobId === expected.blobId &&
      b.connectorId === expected.connectorId &&
      b.stream === expected.stream &&
      b.recordKey === expected.recordKey,
  );
}

function toBuffer(maybeBytes) {
  if (Buffer.isBuffer(maybeBytes)) return maybeBytes;
  if (maybeBytes instanceof Uint8Array) return Buffer.from(maybeBytes);
  if (maybeBytes && typeof maybeBytes === 'object' && 'length' in maybeBytes) {
    return Buffer.from(maybeBytes);
  }
  return Buffer.from(maybeBytes ?? '');
}

/**
 * Run the blob-store conformance suite against a driver.
 *
 * @param {object} options
 * @param {string} options.label                              distinguishes the driver in test names
 * @param {(name: string, fn: () => Promise<void>) => void} options.test  test runner (e.g. node:test's `test`)
 * @param {() => Promise<object> | object} options.makeDriver returns a fresh driver per scenario
 */
export function runBlobStoreConformance({ label, test, makeDriver }) {
  const t = (name, fn) => test(`[blob-store-conformance:${label}] ${name}`, fn);

  // 1. Backend identity is honest and machine-readable.
  //
  // The harness accepts a wide range of identities. What it refuses is
  // a driver that fails to advertise the content-address algorithm and
  // id prefix it actually uses — those are the gates that let the
  // harness compute blob ids consistently across drivers.
  t('advertises required backend identity fields', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const id = driver.identity();
      assert.equal(typeof id, 'object', 'identity() must return an object');
      assert.equal(typeof id.backend_kind, 'string', 'backend_kind required');
      assert.ok(id.backend_kind.length > 0, 'backend_kind must be non-empty');
      assert.equal(typeof id.content_address, 'object', 'content_address required');
      assert.equal(
        typeof id.content_address.algorithm,
        'string',
        'content_address.algorithm required',
      );
      assert.ok(
        id.content_address.algorithm.length > 0,
        'content_address.algorithm must be non-empty',
      );
      assert.equal(
        typeof id.content_address.id_prefix,
        'string',
        'content_address.id_prefix required',
      );
      assert.equal(typeof id.dedupe, 'string', 'dedupe required');
      assert.equal(typeof id.binding_kind, 'string', 'binding_kind required');
    } finally {
      await driver.teardown();
    }
  });

  // 2. put-then-get round-trip.
  //
  // The fundamental obligation: bytes that go in come out byte-identical
  // along with consistent metadata. This pins that the storage layer
  // does not silently transcode, truncate, or re-encode bytes.
  t('putBlob then getBlob returns identical bytes and metadata', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const args = buildPut(driver, {
        connectorId: CONNECTOR_A,
        stream: STREAM_ATTACHMENTS,
        recordKey: 'rec-1',
        mimeType: 'text/plain',
        text: 'hello pdpp blob',
      });
      const stored = await driver.putBlob(args);
      assert.equal(stored.blob_id, args.blobId, 'putBlob must echo blob_id');
      assert.equal(stored.mime_type, args.mimeType, 'mime_type round-trip');
      assert.equal(Number(stored.size_bytes), args.sizeBytes, 'size_bytes round-trip');
      assert.equal(stored.sha256, args.sha256, 'sha256 round-trip');

      const got = await driver.getBlob(args.blobId);
      assert.ok(got, 'getBlob must return a row for a stored blob');
      assert.equal(got.blob_id, args.blobId, 'getBlob blob_id matches');
      assert.equal(got.mime_type, args.mimeType, 'getBlob mime_type matches');
      assert.equal(Number(got.size_bytes), args.sizeBytes, 'getBlob size_bytes matches');
      assert.equal(got.sha256, args.sha256, 'getBlob sha256 matches');
      const gotBytes = toBuffer(got.data);
      assert.ok(gotBytes.equals(args.data), 'getBlob bytes are byte-identical');
    } finally {
      await driver.teardown();
    }
  });

  // 3. Content-address dedupe.
  //
  // Two callers store the same bytes (same sha256). The driver SHALL
  // collapse them into one logical blob: the same blob_id is returned,
  // and getBlob still returns identical metadata. This pins the
  // dedupe-on-content-hash invariant that the SQLite implementation
  // expresses via INSERT OR IGNORE on the blob_id primary key.
  t('putBlob with identical bytes dedupes on content address', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const text = 'duplicate-bytes-test';
      const first = buildPut(driver, {
        connectorId: CONNECTOR_A,
        stream: STREAM_ATTACHMENTS,
        recordKey: 'rec-dup-1',
        mimeType: 'text/plain',
        text,
      });
      const second = buildPut(driver, {
        connectorId: CONNECTOR_B,
        stream: STREAM_PHOTOS,
        recordKey: 'rec-dup-2',
        mimeType: 'text/plain',
        text,
      });
      assert.equal(first.blobId, second.blobId, 'identical bytes derive identical blob_id');

      const a = await driver.putBlob(first);
      const b = await driver.putBlob(second);
      assert.equal(a.blob_id, b.blob_id, 'dedupe returns the same blob_id');
      assert.equal(a.sha256, b.sha256, 'dedupe preserves sha256');
      assert.equal(Number(a.size_bytes), Number(b.size_bytes), 'dedupe preserves size_bytes');

      const got = await driver.getBlob(first.blobId);
      assert.ok(got, 'deduped blob is still readable');
      const gotBytes = toBuffer(got.data);
      assert.ok(gotBytes.equals(first.data), 'deduped blob bytes unchanged');
    } finally {
      await driver.teardown();
    }
  });

  // 4. Content-address collision rejection.
  //
  // If a caller forges a put that claims an existing blob_id but
  // carries different bytes (different sha256 or size), the driver
  // SHALL refuse it. Otherwise, content-addressed identity becomes a
  // lie. The SQLite implementation expresses this by re-reading the
  // stored row after INSERT OR IGNORE and comparing sha256/size.
  t('putBlob rejects content-address collision', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const real = buildPut(driver, {
        connectorId: CONNECTOR_A,
        stream: STREAM_ATTACHMENTS,
        recordKey: 'rec-collide-1',
        mimeType: 'text/plain',
        text: 'real bytes',
      });
      await driver.putBlob(real);

      const fake = {
        blobId: real.blobId,
        connectorId: CONNECTOR_A,
        stream: STREAM_ATTACHMENTS,
        recordKey: 'rec-collide-2',
        mimeType: 'text/plain',
        sizeBytes: 4,
        sha256: 'deadbeef'.repeat(8),
        data: bytesOf('FAKE'),
      };

      let threw = false;
      try {
        await driver.putBlob(fake);
      } catch (err) {
        threw = true;
        assert.ok(err, 'collision must throw a real error');
      }
      assert.ok(threw, 'collision-claiming put must throw');

      // The originally-stored bytes must still be present and unchanged.
      const got = await driver.getBlob(real.blobId);
      assert.ok(got, 'original blob still present after collision attempt');
      assert.equal(got.sha256, real.sha256, 'sha256 unchanged');
      assert.equal(Number(got.size_bytes), real.sizeBytes, 'size_bytes unchanged');
      const gotBytes = toBuffer(got.data);
      assert.ok(gotBytes.equals(real.data), 'bytes unchanged');
    } finally {
      await driver.teardown();
    }
  });

  // 5. Binding idempotency.
  //
  // Re-binding the same (blob_id, connector_id, stream, record_key)
  // tuple is a no-op. A connector that re-emits the same record on a
  // subsequent ingest run MUST NOT inflate the bindings table. The
  // SQLite implementation expresses this via the composite primary key
  // and INSERT OR IGNORE.
  t('putBinding is idempotent on the composite key', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const args = buildPut(driver, {
        connectorId: CONNECTOR_A,
        stream: STREAM_ATTACHMENTS,
        recordKey: 'rec-idempotent',
        mimeType: 'text/plain',
        text: 'idempotent binding',
      });
      await driver.putBlob(args);

      await driver.putBinding({
        blobId: args.blobId,
        connectorId: args.connectorId,
        stream: args.stream,
        recordKey: args.recordKey,
      });
      await driver.putBinding({
        blobId: args.blobId,
        connectorId: args.connectorId,
        stream: args.stream,
        recordKey: args.recordKey,
      });

      const byRecord = await driver.listBindingsForRecord({
        connectorId: args.connectorId,
        stream: args.stream,
        recordKey: args.recordKey,
      });
      const matches = byRecord.filter((b) => b.blobId === args.blobId);
      assert.equal(matches.length, 1, 'duplicate putBinding must collapse to a single row');
    } finally {
      await driver.teardown();
    }
  });

  // 6. Binding fan-out: one blob, many records.
  //
  // The same content-addressed blob may legitimately be referenced by
  // multiple distinct (connector, stream, record_key) tuples — e.g. a
  // shared attachment across two messages. The bindings table SHALL
  // record each tuple separately.
  t('one blob can be bound by multiple distinct record tuples', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const text = 'shared attachment bytes';
      const a = buildPut(driver, {
        connectorId: CONNECTOR_A,
        stream: STREAM_ATTACHMENTS,
        recordKey: 'msg-1',
        mimeType: 'text/plain',
        text,
      });
      const b = buildPut(driver, {
        connectorId: CONNECTOR_A,
        stream: STREAM_ATTACHMENTS,
        recordKey: 'msg-2',
        mimeType: 'text/plain',
        text,
      });
      const c = buildPut(driver, {
        connectorId: CONNECTOR_B,
        stream: STREAM_PHOTOS,
        recordKey: 'photo-x',
        mimeType: 'text/plain',
        text,
      });
      assert.equal(a.blobId, b.blobId, 'identical bytes must derive identical blob_id');
      assert.equal(a.blobId, c.blobId, 'identical bytes must derive identical blob_id');

      await driver.putBlob(a);
      await driver.putBlob(b);
      await driver.putBlob(c);
      await driver.putBinding({
        blobId: a.blobId,
        connectorId: a.connectorId,
        stream: a.stream,
        recordKey: a.recordKey,
      });
      await driver.putBinding({
        blobId: b.blobId,
        connectorId: b.connectorId,
        stream: b.stream,
        recordKey: b.recordKey,
      });
      await driver.putBinding({
        blobId: c.blobId,
        connectorId: c.connectorId,
        stream: c.stream,
        recordKey: c.recordKey,
      });

      const byBlob = await driver.listBindingsForBlob(a.blobId);
      assert.ok(
        bindingsHave(byBlob, {
          blobId: a.blobId,
          connectorId: a.connectorId,
          stream: a.stream,
          recordKey: a.recordKey,
        }),
        'binding for msg-1 must be listed',
      );
      assert.ok(
        bindingsHave(byBlob, {
          blobId: b.blobId,
          connectorId: b.connectorId,
          stream: b.stream,
          recordKey: b.recordKey,
        }),
        'binding for msg-2 must be listed',
      );
      assert.ok(
        bindingsHave(byBlob, {
          blobId: c.blobId,
          connectorId: c.connectorId,
          stream: c.stream,
          recordKey: c.recordKey,
        }),
        'binding for photo-x must be listed',
      );
      assert.equal(byBlob.length, 3, 'exactly three distinct bindings expected');
    } finally {
      await driver.teardown();
    }
  });

  // 7. listBindingsForRecord returns all bindings for that record only.
  //
  // A record may legitimately attach multiple blobs (e.g. an email with
  // two attachments). Listing by record SHALL return every blob bound
  // to that record and SHALL NOT leak bindings from other records.
  t('listBindingsForRecord scopes to the requested record tuple', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const recA1 = buildPut(driver, {
        connectorId: CONNECTOR_A,
        stream: STREAM_ATTACHMENTS,
        recordKey: 'rec-A',
        mimeType: 'text/plain',
        text: 'attachment one',
      });
      const recA2 = buildPut(driver, {
        connectorId: CONNECTOR_A,
        stream: STREAM_ATTACHMENTS,
        recordKey: 'rec-A',
        mimeType: 'text/plain',
        text: 'attachment two',
      });
      const recB = buildPut(driver, {
        connectorId: CONNECTOR_A,
        stream: STREAM_ATTACHMENTS,
        recordKey: 'rec-B',
        mimeType: 'text/plain',
        text: 'attachment three',
      });
      await driver.putBlob(recA1);
      await driver.putBlob(recA2);
      await driver.putBlob(recB);
      for (const r of [recA1, recA2, recB]) {
        await driver.putBinding({
          blobId: r.blobId,
          connectorId: r.connectorId,
          stream: r.stream,
          recordKey: r.recordKey,
        });
      }
      const aBindings = await driver.listBindingsForRecord({
        connectorId: CONNECTOR_A,
        stream: STREAM_ATTACHMENTS,
        recordKey: 'rec-A',
      });
      const blobIds = new Set(aBindings.map((b) => b.blobId));
      assert.ok(blobIds.has(recA1.blobId), 'recA1 binding present');
      assert.ok(blobIds.has(recA2.blobId), 'recA2 binding present');
      assert.ok(!blobIds.has(recB.blobId), 'recB binding must not leak into rec-A listing');
    } finally {
      await driver.teardown();
    }
  });

  // 8. getBlob on an unknown id returns null without throwing.
  t('getBlob returns null for an unknown blob_id', async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const id = driver.identity();
      const unknownId = blobIdFor(id.content_address.id_prefix, bytesOf('never-stored'));
      const got = await driver.getBlob(unknownId);
      assert.equal(got, null, 'unknown id must return null, not throw');
    } finally {
      await driver.teardown();
    }
  });
}
