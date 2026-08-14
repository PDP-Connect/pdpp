// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import tls from "node:tls";
// biome-ignore lint/correctness/noUnresolvedImports: Node and TypeScript resolve this declared runtime dependency.
import Database from "better-sqlite3";
import { Pool } from "pg";
import {
  createLiveDeclarationRetrievalDependencies,
  createPinnedDeclarationFetch,
} from "../server/source-declaration-trust/live-retrieval.ts";
import { retrieveSourceDeclaration } from "../server/source-declaration-trust/retrieval.ts";
import {
  acceptedRevisionEvidenceReference,
  createPostgresAcceptedSourceDeclarationRevisionStore,
  createSqliteAcceptedSourceDeclarationRevisionStore,
} from "../server/source-declaration-trust/revision-store.ts";
import {
  getAcceptedProviderNativeDeclarationRevision,
  retrieveAndAcceptProviderNativeDeclaration,
} from "../server/source-declaration-trust/service.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POINTER = "https://declarations.example.test/current.json";
const RESOURCE = "https://resource.example.test/owner/example";
const AUTHORITY_BINDING_RE = /authority binding/;
const FINGERPRINT_MISMATCH_RE = /fingerprint mismatch/;
const UNIQUE_CONSTRAINT_VIOLATION = /duplicate key value violates unique constraint/;
const VALID_DECLARATION = {
  declaration_version: "opaque:a",
  display: { name: "Example" },
  protocol_version: "0.1.0",
  publisher: { id: "https://publisher.example.test" },
  source: { id: RESOURCE, kind: "provider_native" },
  streams: [],
};

const policy = { maxAddresses: 4, maxBytes: 8192, maxRedirects: 1, timeoutMs: 1000 };

function streamBody(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validDeclaration(value: unknown) {
  const declaration = value as typeof VALID_DECLARATION;
  return declaration.source.id === RESOURCE && typeof declaration.declaration_version === "string"
    ? { declaration, ok: true as const }
    : { ok: false as const };
}

test("declaration retrieval binds every hop to fresh, policy-approved DNS answers and omits credentials", async () => {
  const dnsLookups: string[] = [];
  let redirectBodyCancelled = false;
  const connections: Array<{
    addresses: readonly string[];
    credentials: string;
    maxBytes: number;
    redirect: string;
    url: string;
  }> = [];
  const result = await retrieveSourceDeclaration({ acceptedPointer: POINTER, expectedSourceId: RESOURCE }, policy, {
    allowsUrl: ({ acceptedPointer, targetUrl }) =>
      targetUrl === acceptedPointer || targetUrl === "https://cdn.example.test/revision.json",
    fetch(request) {
      connections.push({
        addresses: request.validatedAddresses,
        credentials: request.credentials,
        maxBytes: request.maxBytes,
        redirect: request.redirect,
        url: request.url,
      });
      if (request.url === POINTER) {
        return Promise.resolve({
          body: new ReadableStream({
            cancel() {
              redirectBodyCancelled = true;
            },
          }),
          headers: { Location: "https://cdn.example.test/revision.json" },
          status: 302,
        });
      }
      return Promise.resolve({ body: streamBody(JSON.stringify(VALID_DECLARATION)), status: 200 });
    },
    resolveDns(hostname) {
      dnsLookups.push(hostname);
      return Promise.resolve(hostname === "declarations.example.test" ? ["203.0.113.5"] : ["2001:db8::5"]);
    },
    validateAddress: ({ address, hostname }) =>
      (hostname === "declarations.example.test" && address === "203.0.113.5") ||
      (hostname === "cdn.example.test" && address === "2001:db8::5"),
    validateDeclaration: validDeclaration,
  });

  assert.deepEqual(result, {
    ok: true,
    value: { declaration: VALID_DECLARATION, finalUrl: "https://cdn.example.test/revision.json" },
  });
  assert.deepEqual(dnsLookups, ["declarations.example.test", "cdn.example.test"]);
  assert.deepEqual(connections, [
    { addresses: ["203.0.113.5"], credentials: "omit", maxBytes: 8192, redirect: "manual", url: POINTER },
    {
      addresses: ["2001:db8::5"],
      credentials: "omit",
      maxBytes: 8192,
      redirect: "manual",
      url: "https://cdn.example.test/revision.json",
    },
  ]);
  assert.equal(redirectBodyCancelled, true, "redirect body is canceled before the next hop");
});

test("live declaration adapter creates a fresh pinned dispatcher for each redirect hop and closes it with the response", async () => {
  const dispatchers: Array<{ addresses: readonly string[]; closed: number }> = [];
  const requests: Array<{ credentials: string; method: string | undefined; redirect: string; url: string }> = [];
  const dependencies = createLiveDeclarationRetrievalDependencies({
    allowsUrl: ({ acceptedPointer, targetUrl }) =>
      targetUrl === acceptedPointer || targetUrl === "https://cdn.example.test/revision.json",
    dnsLookupImpl: async (hostname) => [
      { address: hostname === "declarations.example.test" ? "127.0.0.2" : "127.0.0.3" },
    ],
    fetchImpl: (url, init) => {
      requests.push({
        credentials: String(init?.credentials),
        method: init?.method,
        redirect: String(init?.redirect),
        url: String(url),
      });
      if (String(url) === POINTER) {
        return Promise.resolve({
          body: streamBody(""),
          headers: new Headers({ Location: "https://cdn.example.test/revision.json" }),
          status: 302,
        });
      }
      return Promise.resolve({
        body: streamBody(JSON.stringify(VALID_DECLARATION)),
        headers: new Headers(),
        status: 200,
      });
    },
    pinnedDispatcherFactory: (addresses) => {
      const dispatcher = { addresses: [...addresses], closed: 0 };
      dispatchers.push(dispatcher);
      return {
        close: () => {
          dispatcher.closed += 1;
          return Promise.resolve();
        },
      };
    },
    validateAddress: () => true,
    validateDeclaration: validDeclaration,
  });

  const result = await retrieveSourceDeclaration(
    { acceptedPointer: POINTER, expectedSourceId: RESOURCE },
    policy,
    dependencies
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    dispatchers.map(({ addresses }) => addresses),
    [["127.0.0.2"], ["127.0.0.3"]],
    "each redirect hop gets a dispatcher pinned to that hop's fresh DNS answer"
  );
  assert.deepEqual(requests, [
    { credentials: "omit", method: "GET", redirect: "manual", url: POINTER },
    {
      credentials: "omit",
      method: "GET",
      redirect: "manual",
      url: "https://cdn.example.test/revision.json",
    },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    dispatchers.map(({ closed }) => closed),
    [1, 1],
    "the transport dispatcher closes after redirect cancellation and response EOF"
  );
});

test("live declaration adapter dials only the validated literal while preserving TLS authority", async () => {
  // `.invalid` cannot resolve. Reaching tls.connect therefore proves that the
  // shared pinned dispatcher dialed the injected, accepted literal rather
  // than letting undici perform a second hostname lookup.
  const originalTlsConnect = tls.connect;
  const dialedHosts: Array<{ host: string | undefined; servername: string | undefined }> = [];
  tls.connect = ((options: { host?: string; servername?: string }, ...rest: unknown[]) => {
    dialedHosts.push({ host: options.host, servername: options.servername });
    return (originalTlsConnect as (...args: unknown[]) => ReturnType<typeof tls.connect>).apply(tls, [
      options,
      ...rest,
    ]);
  }) as typeof tls.connect;

  const pointer = "https://declaration-rebind-proof.invalid/current.json";
  try {
    const result = await retrieveSourceDeclaration(
      { acceptedPointer: pointer, expectedSourceId: RESOURCE },
      { ...policy, timeoutMs: 2000 },
      createLiveDeclarationRetrievalDependencies({
        dnsLookupImpl: async () => [{ address: "127.0.0.1" }],
        validateAddress: () => true,
        validateDeclaration: validDeclaration,
      })
    );
    assert.deepEqual(result, { ok: false, reason: "http_error" });
    assert.equal(dialedHosts.length, 1, "the bounded connector attempts the one validated address once");
    assert.deepEqual(dialedHosts[0], { host: "127.0.0.1", servername: "declaration-rebind-proof.invalid" });
  } finally {
    tls.connect = originalTlsConnect;
  }
});

test("live declaration adapter rejects direct empty or oversized connector sets", async () => {
  let fetches = 0;
  const fetch = createPinnedDeclarationFetch({
    fetchImpl: () => {
      fetches += 1;
      return Promise.resolve({ body: streamBody(""), headers: new Headers(), status: 200 });
    },
  });
  const request = {
    credentials: "omit" as const,
    maxBytes: 64,
    redirect: "manual" as const,
    signal: new AbortController().signal,
    url: POINTER,
  };
  await assert.rejects(() => fetch({ ...request, validatedAddresses: [] }));
  await assert.rejects(() =>
    fetch({ ...request, validatedAddresses: Array.from({ length: 9 }, (_, index) => `127.0.0.${index + 1}`) })
  );
  assert.equal(fetches, 0, "the actual socket adapter fails closed instead of truncating direct callers' address sets");
});

test("live declaration adapter closes a pinned dispatcher when fetch fails", async () => {
  let closes = 0;
  const fetch = createPinnedDeclarationFetch({
    fetchImpl: () => Promise.reject(new Error("connect failed")),
    pinnedDispatcherFactory: () => ({
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    }),
  });
  await assert.rejects(() =>
    fetch({
      credentials: "omit",
      maxBytes: 64,
      redirect: "manual",
      signal: new AbortController().signal,
      url: POINTER,
      validatedAddresses: ["127.0.0.1"],
    })
  );
  assert.equal(closes, 1);
});

test("a late fetch response after timeout is canceled and closes its pinned dispatcher", async () => {
  let bodyCancelled = false;
  let dispatcherCloses = 0;
  let markFetchStarted!: () => void;
  let resolveFetch!: (response: { body: ReadableStream<Uint8Array>; headers: Headers; status: number }) => void;
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  const lateResponse = new Promise<{ body: ReadableStream<Uint8Array>; headers: Headers; status: number }>(
    (resolve) => {
      resolveFetch = resolve;
    }
  );
  const result = retrieveSourceDeclaration(
    { acceptedPointer: POINTER, expectedSourceId: RESOURCE },
    { ...policy, timeoutMs: 25 },
    {
      fetch: createPinnedDeclarationFetch({
        fetchImpl: () => {
          markFetchStarted();
          return lateResponse;
        },
        pinnedDispatcherFactory: () => ({
          close: () => {
            dispatcherCloses += 1;
            return Promise.resolve();
          },
        }),
      }),
      resolveDns: () => Promise.resolve(["127.0.0.1"]),
      validateAddress: () => true,
      validateDeclaration: validDeclaration,
    }
  );
  await fetchStarted;
  assert.deepEqual(await result, { ok: false, reason: "timeout" });
  resolveFetch({
    body: new ReadableStream({
      cancel() {
        bodyCancelled = true;
      },
    }),
    headers: new Headers(),
    status: 200,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bodyCancelled, true);
  assert.equal(dispatcherCloses, 1);
});

test("live declaration adapter cancels an over-limit stream before retaining it", async () => {
  let cancelled = false;
  const fetch = createPinnedDeclarationFetch({
    fetchImpl: () =>
      Promise.resolve({
        body: new ReadableStream({
          cancel() {
            cancelled = true;
          },
          start(controller) {
            controller.enqueue(new TextEncoder().encode("12345"));
          },
        }),
        headers: new Headers(),
        status: 200,
      }),
  });
  const response = await fetch({
    credentials: "omit",
    maxBytes: 4,
    redirect: "manual",
    signal: new AbortController().signal,
    url: POINTER,
    validatedAddresses: ["127.0.0.1"],
  });
  await assert.rejects(() => response.body.getReader().read(), { name: "DeclarationResponseTooLargeError" });
  assert.equal(cancelled, true);
});

test("declaration retrieval fails closed before connecting when any fresh answer or redirect is not approved", async () => {
  let fetchCount = 0;
  const blockedAddress = await retrieveSourceDeclaration(
    { acceptedPointer: POINTER, expectedSourceId: RESOURCE },
    policy,
    {
      fetch: () => {
        fetchCount += 1;
        return Promise.resolve({ body: streamBody(JSON.stringify(VALID_DECLARATION)), status: 200 });
      },
      resolveDns: () => Promise.resolve(["203.0.113.4", "127.0.0.1"]),
      validateAddress: ({ address }) => address !== "127.0.0.1",
      validateDeclaration: validDeclaration,
    }
  );
  assert.deepEqual(blockedAddress, { ok: false, reason: "address_rejected" });
  assert.equal(fetchCount, 0);

  const excessiveAnswers = await retrieveSourceDeclaration(
    { acceptedPointer: POINTER, expectedSourceId: RESOURCE },
    policy,
    {
      fetch: () => {
        fetchCount += 1;
        return Promise.resolve({ body: streamBody(JSON.stringify(VALID_DECLARATION)), status: 200 });
      },
      resolveDns: () => Promise.resolve(["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4", "203.0.113.5"]),
      validateAddress: () => Promise.resolve(true),
      validateDeclaration: validDeclaration,
    }
  );
  assert.deepEqual(excessiveAnswers, { ok: false, reason: "address_rejected" });
  assert.equal(fetchCount, 0, "DNS answer bound prevents a connection attempt");

  const blockedRedirect = await retrieveSourceDeclaration(
    { acceptedPointer: POINTER, expectedSourceId: RESOURCE },
    policy,
    {
      allowsUrl: ({ acceptedPointer, targetUrl }) => targetUrl === acceptedPointer,
      fetch: () =>
        Promise.resolve({
          body: streamBody(""),
          headers: { location: "https://other.example.test/declaration.json" },
          status: 302,
        }),
      resolveDns: () => Promise.resolve(["203.0.113.4"]),
      validateAddress: () => Promise.resolve(true),
      validateDeclaration: validDeclaration,
    }
  );
  assert.deepEqual(blockedRedirect, { ok: false, reason: "invalid_redirect" });
});

test("declaration retrieval rejects oversized bodies and source IDs without fetching schemas", async () => {
  let validations = 0;
  const oversized = await retrieveSourceDeclaration(
    { acceptedPointer: POINTER, expectedSourceId: RESOURCE },
    { ...policy, maxBytes: 4 },
    {
      fetch: () => Promise.resolve({ body: streamBody(JSON.stringify(VALID_DECLARATION)), status: 200 }),
      resolveDns: () => Promise.resolve(["203.0.113.4"]),
      validateAddress: () => Promise.resolve(true),
      validateDeclaration: () => {
        validations += 1;
        return validDeclaration(VALID_DECLARATION);
      },
    }
  );
  assert.deepEqual(oversized, { ok: false, reason: "body_too_large" });
  assert.equal(validations, 0, "no declaration validation or schema retrieval occurs after a byte-bound failure");

  const mismatch = await retrieveSourceDeclaration({ acceptedPointer: POINTER, expectedSourceId: RESOURCE }, policy, {
    fetch: () =>
      Promise.resolve({
        body: streamBody(
          JSON.stringify({
            ...VALID_DECLARATION,
            source: { ...VALID_DECLARATION.source, id: "https://other.example.test" },
          })
        ),
        status: 200,
      }),
    resolveDns: () => Promise.resolve(["203.0.113.4"]),
    validateAddress: () => Promise.resolve(true),
    validateDeclaration: (value) => ({ declaration: value as typeof VALID_DECLARATION, ok: true }),
  });
  assert.deepEqual(mismatch, { ok: false, reason: "source_mismatch" });

  const validatorFailure = await retrieveSourceDeclaration(
    { acceptedPointer: POINTER, expectedSourceId: RESOURCE },
    policy,
    {
      fetch: () => Promise.resolve({ body: streamBody(JSON.stringify(VALID_DECLARATION)), status: 200 }),
      resolveDns: () => Promise.resolve(["203.0.113.4"]),
      validateAddress: () => Promise.resolve(true),
      validateDeclaration: () => {
        throw new Error("hostile declaration");
      },
    }
  );
  assert.deepEqual(validatorFailure, { ok: false, reason: "declaration_invalid" });
});

test("declaration retrieval cancels a response stream at the configured byte limit", async () => {
  let cancelled = false;
  const result = await retrieveSourceDeclaration(
    { acceptedPointer: POINTER, expectedSourceId: RESOURCE },
    { ...policy, maxBytes: 4 },
    {
      fetch: () =>
        Promise.resolve({
          body: new ReadableStream({
            cancel() {
              cancelled = true;
            },
            start(controller) {
              controller.enqueue(new TextEncoder().encode("12345"));
            },
          }),
          status: 200,
        }),
      resolveDns: () => Promise.resolve(["203.0.113.4"]),
      validateAddress: () => Promise.resolve(true),
      validateDeclaration: validDeclaration,
    }
  );
  assert.deepEqual(result, { ok: false, reason: "body_too_large" });
  assert.equal(cancelled, true);
});

test("declaration retrieval turns body-read failures into typed fail-closed outcomes", async () => {
  const dependencies = {
    resolveDns: () => Promise.resolve(["203.0.113.4"]),
    validateAddress: () => Promise.resolve(true),
    validateDeclaration: validDeclaration,
  };
  const readError = await retrieveSourceDeclaration({ acceptedPointer: POINTER, expectedSourceId: RESOURCE }, policy, {
    ...dependencies,
    fetch: () =>
      Promise.resolve({
        body: new ReadableStream({
          start(controller) {
            controller.error(new Error("peer ended stream"));
          },
        }),
        status: 200,
      }),
  });
  assert.deepEqual(readError, { ok: false, reason: "http_error" });

  let timedOutBodyCancelled = false;
  const readTimeout = await retrieveSourceDeclaration(
    { acceptedPointer: POINTER, expectedSourceId: RESOURCE },
    { ...policy, timeoutMs: 1 },
    {
      ...dependencies,
      fetch: () =>
        Promise.resolve({
          body: new ReadableStream({
            cancel() {
              timedOutBodyCancelled = true;
            },
          }),
          status: 200,
        }),
    }
  );
  assert.deepEqual(readTimeout, { ok: false, reason: "timeout" });
  assert.equal(timedOutBodyCancelled, true, "deadline cancels a body stream even when fetch ignores AbortSignal");
});

test("declaration retrieval rejects malformed UTF-8 and cancels non-success bodies", async () => {
  let errorBodyCancelled = false;
  const invalidUtf8 = await retrieveSourceDeclaration(
    { acceptedPointer: POINTER, expectedSourceId: RESOURCE },
    policy,
    {
      fetch: () =>
        Promise.resolve({
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([0xff]));
              controller.close();
            },
          }),
          status: 200,
        }),
      resolveDns: () => Promise.resolve(["203.0.113.4"]),
      validateAddress: () => Promise.resolve(true),
      validateDeclaration: validDeclaration,
    }
  );
  assert.deepEqual(invalidUtf8, { ok: false, reason: "declaration_invalid" });

  const httpError = await retrieveSourceDeclaration({ acceptedPointer: POINTER, expectedSourceId: RESOURCE }, policy, {
    fetch: () =>
      Promise.resolve({
        body: new ReadableStream({
          cancel() {
            errorBodyCancelled = true;
          },
        }),
        status: 500,
      }),
    resolveDns: () => Promise.resolve(["203.0.113.4"]),
    validateAddress: () => Promise.resolve(true),
    validateDeclaration: validDeclaration,
  });
  assert.deepEqual(httpError, { ok: false, reason: "http_error" });
  assert.equal(errorBodyCancelled, true);
});

test("declaration retrieval bounds DNS work by the configured deadline", async () => {
  const result = await retrieveSourceDeclaration(
    { acceptedPointer: POINTER, expectedSourceId: RESOURCE },
    { ...policy, timeoutMs: 1 },
    {
      fetch: () => Promise.resolve({ body: streamBody(JSON.stringify(VALID_DECLARATION)), status: 200 }),
      resolveDns: () =>
        new Promise<readonly string[]>(() => {
          // Deliberately unresolved: the retriever, not DNS, owns the bound.
        }),
      validateAddress: () => Promise.resolve(true),
      validateDeclaration: validDeclaration,
    }
  );
  assert.deepEqual(result, { ok: false, reason: "timeout" });
});

function immutableRevisionCases(store: {
  accept: (input: {
    authorityBinding: string;
    declarationVersion: string;
    parsedDeclaration: unknown;
    sourceId: string;
  }) => Promise<unknown>;
  getByReference: (acceptedRevisionReference: string) => Promise<unknown>;
}) {
  const key = { authorityBinding: POINTER, declarationVersion: "opaque:1", sourceId: RESOURCE };
  const expectedReference = acceptedRevisionEvidenceReference(key);
  const sameParsedContentDifferentTextOrder = JSON.parse('{"streams":["a"],"display":{"name":"First"}}');
  return Promise.resolve().then(async () => {
    assert.equal(await store.getByReference(expectedReference), null);
    assert.deepEqual(await store.accept({ ...key, parsedDeclaration: sameParsedContentDifferentTextOrder }), {
      accepted: true,
      acceptedRevisionReference: expectedReference,
      existing: false,
    });
    assert.deepEqual(await store.getByReference(expectedReference), {
      acceptedRevisionReference: expectedReference,
      authorityBinding: key.authorityBinding,
      declarationVersion: key.declarationVersion,
      parsedDeclaration: { display: { name: "First" }, streams: ["a"] },
      sourceId: key.sourceId,
    });
    assert.deepEqual(
      await store.accept({ ...key, parsedDeclaration: { display: { name: "First" }, streams: ["a"] } }),
      {
        accepted: true,
        acceptedRevisionReference: expectedReference,
        existing: true,
      }
    );
    assert.deepEqual(
      await store.accept({ ...key, parsedDeclaration: { display: { name: "Changed" }, streams: ["a"] } }),
      {
        accepted: false,
        reason: "equivocation",
      }
    );
    assert.deepEqual(
      await store.accept({
        ...key,
        declarationVersion: "not-sortable:prior",
        parsedDeclaration: { display: { name: "Prior" } },
      }),
      {
        accepted: true,
        acceptedRevisionReference: acceptedRevisionEvidenceReference({
          ...key,
          declarationVersion: "not-sortable:prior",
        }),
        existing: false,
      },
      "versions are opaque keys; storage performs no ordering inference"
    );
    assert.notEqual(
      expectedReference,
      acceptedRevisionEvidenceReference({ ...key, authorityBinding: "metadata:https://other.example.test" }),
      "accepted revision evidence references are bound to the accepted authority"
    );
    assert.equal(
      await store.getByReference(
        acceptedRevisionEvidenceReference({ ...key, authorityBinding: "metadata:https://other.example.test" })
      ),
      null
    );
  });
}

test("SQLite accepted revisions preserve parsed-content identity and reject equivocation", async () => {
  const database = new Database(":memory:");
  try {
    await immutableRevisionCases(createSqliteAcceptedSourceDeclarationRevisionStore(database));
  } finally {
    database.close();
  }
});

test("SQLite accepted revision lookup fails closed when stored evidence is tampered", async () => {
  const database = new Database(":memory:");
  const key = { authorityBinding: POINTER, declarationVersion: "opaque:tamper", sourceId: RESOURCE };
  const store = createSqliteAcceptedSourceDeclarationRevisionStore(database);
  const expectedReference = acceptedRevisionEvidenceReference(key);
  try {
    await store.accept({ ...key, parsedDeclaration: { display: { name: "Original" }, streams: ["a"] } });
    database
      .prepare("UPDATE accepted_source_declaration_revisions SET source_id = ? WHERE accepted_revision_reference = ?")
      .run("https://resource.example.test/owner/changed", expectedReference);
    await assert.rejects(store.getByReference(expectedReference), AUTHORITY_BINDING_RE);

    database
      .prepare("UPDATE accepted_source_declaration_revisions SET source_id = ? WHERE accepted_revision_reference = ?")
      .run(key.sourceId, expectedReference);
    database
      .prepare(
        "UPDATE accepted_source_declaration_revisions SET canonical_content = ? WHERE accepted_revision_reference = ?"
      )
      .run('{"display":{"name":"Changed"},"streams":["a"]}', expectedReference);
    await assert.rejects(store.getByReference(expectedReference), FINGERPRINT_MISMATCH_RE);
  } finally {
    database.close();
  }
});

test("SQLite accepted revision store migrates the prior table shape idempotently", async () => {
  const database = new Database(":memory:");
  const key = { authorityBinding: POINTER, declarationVersion: "opaque:legacy", sourceId: RESOURCE };
  const canonicalContent = '{"display":{"name":"Legacy"},"streams":["a"]}';
  try {
    database.exec(`
      CREATE TABLE accepted_source_declaration_revisions (
        authority_binding TEXT NOT NULL,
        source_id TEXT NOT NULL,
        declaration_version TEXT NOT NULL,
        canonical_content TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        PRIMARY KEY (authority_binding, source_id, declaration_version)
      );
    `);
    database
      .prepare(
        `INSERT INTO accepted_source_declaration_revisions
         (authority_binding, source_id, declaration_version, canonical_content, content_fingerprint)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(key.authorityBinding, key.sourceId, key.declarationVersion, canonicalContent, sha256(canonicalContent));

    const store = createSqliteAcceptedSourceDeclarationRevisionStore(database);
    const expectedReference = acceptedRevisionEvidenceReference(key);
    assert.deepEqual(
      await store.accept({ ...key, parsedDeclaration: { display: { name: "Legacy" }, streams: ["a"] } }),
      {
        accepted: true,
        acceptedRevisionReference: expectedReference,
        existing: true,
      }
    );
    assert.deepEqual(
      await store.accept({ ...key, parsedDeclaration: { display: { name: "Changed" }, streams: ["a"] } }),
      {
        accepted: false,
        reason: "equivocation",
      }
    );
    const migratedReference = (
      database.prepare("SELECT accepted_revision_reference FROM accepted_source_declaration_revisions") as {
        get: () => { accepted_revision_reference: string } | undefined;
      }
    ).get();
    assert.deepEqual(migratedReference, { accepted_revision_reference: expectedReference });
    const migratedColumns = (
      database.prepare("PRAGMA table_info(accepted_source_declaration_revisions)") as {
        all: () => Array<{ name: string; notnull: number }>;
      }
    ).all();
    assert.equal(migratedColumns.find((row) => row.name === "accepted_revision_reference")?.notnull, 1);

    const idempotentStore = createSqliteAcceptedSourceDeclarationRevisionStore(database);
    assert.deepEqual(
      await idempotentStore.accept({ ...key, parsedDeclaration: { display: { name: "Legacy" }, streams: ["a"] } }),
      {
        accepted: true,
        acceptedRevisionReference: expectedReference,
        existing: true,
      }
    );
  } finally {
    database.close();
  }
});

test("standalone trust service persists only a retrieved, source-matching declaration", async () => {
  const database = new Database(":memory:");
  const revisionStore = createSqliteAcceptedSourceDeclarationRevisionStore(database);
  try {
    const result = await retrieveAndAcceptProviderNativeDeclaration(
      {
        acceptedPointer: POINTER,
        authorityBinding: "metadata:https://resource.example.test",
        expectedSourceId: RESOURCE,
      },
      {
        fetch: () => Promise.resolve({ body: streamBody(JSON.stringify(VALID_DECLARATION)), status: 200 }),
        resolveDns: () => Promise.resolve(["203.0.113.4"]),
        revisionStore,
        validateAddress: () => Promise.resolve(true),
        validateDeclaration: validDeclaration,
      },
      policy
    );
    assert.deepEqual(result, {
      acceptedRevisionReference: acceptedRevisionEvidenceReference({
        authorityBinding: "metadata:https://resource.example.test",
        declarationVersion: "opaque:a",
        sourceId: RESOURCE,
      }),
      declarationVersion: "opaque:a",
      finalUrl: POINTER,
      ok: true,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      await getAcceptedProviderNativeDeclarationRevision(
        { acceptedRevisionReference: result.acceptedRevisionReference },
        { revisionStore }
      ),
      {
        acceptedRevisionReference: result.acceptedRevisionReference,
        authorityBinding: "metadata:https://resource.example.test",
        declarationVersion: "opaque:a",
        parsedDeclaration: VALID_DECLARATION,
        sourceId: RESOURCE,
      }
    );
  } finally {
    database.close();
  }
});

test("standalone trust service rejects provider-native discovery when the declaration kind is not provider_native", async () => {
  const database = new Database(":memory:");
  try {
    const result = await retrieveAndAcceptProviderNativeDeclaration(
      {
        acceptedPointer: POINTER,
        authorityBinding: "metadata:https://resource.example.test",
        expectedSourceId: RESOURCE,
      },
      {
        fetch: () =>
          Promise.resolve({
            body: streamBody(
              JSON.stringify({
                ...VALID_DECLARATION,
                source: { ...VALID_DECLARATION.source, kind: "connector" },
              })
            ),
            status: 200,
          }),
        resolveDns: () => Promise.resolve(["203.0.113.4"]),
        revisionStore: createSqliteAcceptedSourceDeclarationRevisionStore(database),
        validateAddress: () => Promise.resolve(true),
        validateDeclaration: (value) => ({ declaration: value as typeof VALID_DECLARATION, ok: true }),
      },
      policy
    );
    assert.deepEqual(result, { ok: false, reason: "source_kind_mismatch" });
  } finally {
    database.close();
  }
});

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
let postgresCounter = 0;

if (POSTGRES_URL) {
  test("PostgreSQL accepted revisions have the same immutable parsed-content behavior as SQLite", async () => {
    postgresCounter += 1;
    await withTemporaryPostgresDatabase(
      {
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_source_declaration_trust_${process.pid}_${postgresCounter}`,
      },
      async (databaseUrl) => {
        const pool = new Pool({ connectionString: databaseUrl });
        try {
          await immutableRevisionCases(await createPostgresAcceptedSourceDeclarationRevisionStore(pool));
        } finally {
          await pool.end();
        }
      }
    );
  });

  test("PostgreSQL accepted revision store migrates the prior table shape idempotently", async () => {
    postgresCounter += 1;
    await withTemporaryPostgresDatabase(
      {
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_source_declaration_trust_${process.pid}_${postgresCounter}`,
      },
      async (databaseUrl) => {
        const pool = new Pool({ connectionString: databaseUrl });
        const key = { authorityBinding: POINTER, declarationVersion: "opaque:legacy", sourceId: RESOURCE };
        const canonicalContent = '{"display":{"name":"Legacy"},"streams":["a"]}';
        try {
          await pool.query(`
            CREATE TABLE accepted_source_declaration_revisions (
              authority_binding TEXT NOT NULL,
              source_id TEXT NOT NULL,
              declaration_version TEXT NOT NULL,
              canonical_content TEXT NOT NULL,
              content_fingerprint TEXT NOT NULL,
              PRIMARY KEY (authority_binding, source_id, declaration_version)
            );
          `);
          await pool.query(
            `INSERT INTO accepted_source_declaration_revisions
             (authority_binding, source_id, declaration_version, canonical_content, content_fingerprint)
             VALUES ($1, $2, $3, $4, $5)`,
            [key.authorityBinding, key.sourceId, key.declarationVersion, canonicalContent, sha256(canonicalContent)]
          );

          const store = await createPostgresAcceptedSourceDeclarationRevisionStore(pool);
          const expectedReference = acceptedRevisionEvidenceReference(key);
          assert.deepEqual(
            await store.accept({ ...key, parsedDeclaration: { display: { name: "Legacy" }, streams: ["a"] } }),
            {
              accepted: true,
              acceptedRevisionReference: expectedReference,
              existing: true,
            }
          );
          assert.deepEqual(
            await store.accept({ ...key, parsedDeclaration: { display: { name: "Changed" }, streams: ["a"] } }),
            {
              accepted: false,
              reason: "equivocation",
            }
          );
          assert.deepEqual(
            (await pool.query("SELECT accepted_revision_reference FROM accepted_source_declaration_revisions")).rows,
            [{ accepted_revision_reference: expectedReference }]
          );
          const duplicateReferenceKey = {
            authorityBinding: "metadata:https://duplicate.example.test",
            declarationVersion: "opaque:legacy-duplicate",
            sourceId: RESOURCE,
          };
          await assert.rejects(
            pool.query(
              `INSERT INTO accepted_source_declaration_revisions
               (authority_binding, source_id, declaration_version, accepted_revision_reference, canonical_content, content_fingerprint)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                duplicateReferenceKey.authorityBinding,
                duplicateReferenceKey.sourceId,
                duplicateReferenceKey.declarationVersion,
                expectedReference,
                canonicalContent,
                sha256(canonicalContent),
              ]
            ),
            UNIQUE_CONSTRAINT_VIOLATION
          );
          assert.deepEqual(
            (
              await pool.query(
                `SELECT attnotnull
                   FROM pg_attribute
                  WHERE attrelid = 'accepted_source_declaration_revisions'::regclass
                    AND attname = 'accepted_revision_reference'`
              )
            ).rows,
            [{ attnotnull: true }]
          );

          const idempotentStore = await createPostgresAcceptedSourceDeclarationRevisionStore(pool);
          assert.deepEqual(
            await idempotentStore.accept({
              ...key,
              parsedDeclaration: { display: { name: "Legacy" }, streams: ["a"] },
            }),
            {
              accepted: true,
              acceptedRevisionReference: expectedReference,
              existing: true,
            }
          );
          assert.deepEqual(await idempotentStore.getByReference(expectedReference), {
            acceptedRevisionReference: expectedReference,
            authorityBinding: key.authorityBinding,
            declarationVersion: key.declarationVersion,
            parsedDeclaration: { display: { name: "Legacy" }, streams: ["a"] },
            sourceId: key.sourceId,
          });
          assert.equal(
            await idempotentStore.getByReference(
              acceptedRevisionEvidenceReference({ ...key, sourceId: "https://resource.example.test/other" })
            ),
            null
          );
        } finally {
          await pool.end();
        }
      }
    );
  });

  test("PostgreSQL accepted revision lookup fails closed when stored evidence is tampered", async () => {
    postgresCounter += 1;
    await withTemporaryPostgresDatabase(
      {
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_source_declaration_trust_${process.pid}_${postgresCounter}`,
      },
      async (databaseUrl) => {
        const pool = new Pool({ connectionString: databaseUrl });
        const key = { authorityBinding: POINTER, declarationVersion: "opaque:tamper", sourceId: RESOURCE };
        const expectedReference = acceptedRevisionEvidenceReference(key);
        try {
          const store = await createPostgresAcceptedSourceDeclarationRevisionStore(pool);
          await store.accept({ ...key, parsedDeclaration: { display: { name: "Original" }, streams: ["a"] } });
          await pool.query(
            "UPDATE accepted_source_declaration_revisions SET source_id = $1 WHERE accepted_revision_reference = $2",
            ["https://resource.example.test/owner/changed", expectedReference]
          );
          await assert.rejects(store.getByReference(expectedReference), AUTHORITY_BINDING_RE);

          await pool.query(
            "UPDATE accepted_source_declaration_revisions SET source_id = $1 WHERE accepted_revision_reference = $2",
            [key.sourceId, expectedReference]
          );
          await pool.query(
            "UPDATE accepted_source_declaration_revisions SET canonical_content = $1 WHERE accepted_revision_reference = $2",
            ['{"display":{"name":"Changed"},"streams":["a"]}', expectedReference]
          );
          await assert.rejects(store.getByReference(expectedReference), FINGERPRINT_MISMATCH_RE);
        } finally {
          await pool.end();
        }
      }
    );
  });
} else {
  test("PostgreSQL accepted revision parity (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    // Environment-gated real backend proof.
  });
}
