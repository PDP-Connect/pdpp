// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Client conformance cases. These cases run only when a ClientUnderTest is
// supplied in CaseContext. The fixture's inbound request log is the independent
// observation; a deliberately defective client is run against the same fixture
// in test/client-conformance.test.ts to prove each oracle can fail.

import type { ClientUnderTest } from "../harness/client-adapter.ts";
import { type ConformanceCase, fail, pass, skip, unsupported } from "../harness/runner.ts";

const STREAM = "fixture_stream";
const CHANGES_SINCE = "changes-since-fixture-token";
const BEGINNING = "beginning";
const NEXT_CURSOR = "opaque-page-cursor-fixture-token";

function requestAfter(client: ClientUnderTest, index: number) {
  return client.fixture.requestLog().slice(index);
}

export const CLIENT_CASES: readonly ConformanceCase[] = [
  // CL-1 and CL-6 remain honest skips: this batch does not add a client
  // envelope-only case or a storage-lifecycle oracle.

  // ------------------------------------------------------------- CL-2 / 10.7-2
  {
    caseId: "CL-2/grant-revocation-stops-further-requests",
    requirementId: "CL-2",
    assertion: "After 401 grant_revoked, the client makes no further request against that grant.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      client.fixture.configure({
        challenge: 'Bearer error="invalid_token"',
        code: "grant_revoked",
        kind: "error",
        status: 401,
        type: "authentication_error",
      });
      const before = client.fixture.requestLog().length;
      const result = await client.readPage(STREAM);
      const requests = requestAfter(client, before);
      const usedAccessToken = requests[0]?.headers.authorization === "Bearer client-fixture-access-token";
      return !result.ok &&
        result.status === 401 &&
        result.errorCode === "grant_revoked" &&
        requests.length === 1 &&
        usedAccessToken
        ? pass()
        : fail(
            `Expected one access-token request ending in 401 grant_revoked; observed ${requests.length} request(s), status ${result.status}, code ${String(result.errorCode)}.`
          );
    },
  },

  // ------------------------------------------------------------- CL-3 / 4.3-4
  {
    caseId: "CL-3/changes-since-does-not-reuse-next-cursor",
    requirementId: "CL-3",
    assertion: "The client keeps next_cursor and next_changes_since in distinct opaque token spaces.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      client.fixture.configure({ kind: "page", nextChangesSince: CHANGES_SINCE, nextCursor: NEXT_CURSOR });
      const before = client.fixture.requestLog().length;
      await client.syncOnce(STREAM);
      await client.syncAgain(STREAM);
      const [, second] = requestAfter(client, before);
      return second?.query.changes_since === CHANGES_SINCE
        ? pass()
        : fail(`Expected changes_since=${CHANGES_SINCE}; observed ${JSON.stringify(second?.query ?? {})}.`);
    },
  },

  // ------------------------------------------------------------- CL-4 / 8.9-16
  {
    caseId: "CL-4/stores-terminal-next-changes-since",
    requirementId: "CL-4",
    assertion: "The client stores next_changes_since from one terminal sync page for the next session.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      client.fixture.configure({ kind: "page", nextChangesSince: CHANGES_SINCE, nextCursor: NEXT_CURSOR });
      const before = client.fixture.requestLog().length;
      await client.syncOnce(STREAM);
      await client.syncAgain(STREAM);
      const requests = requestAfter(client, before);
      return requests[0]?.query.changes_since === BEGINNING && requests[1]?.query.changes_since === CHANGES_SINCE
        ? pass()
        : fail(
            `Expected a first session at changes_since=beginning followed by changes_since=${CHANGES_SINCE}; observed ${JSON.stringify(requests)}.`
          );
    },
  },

  // ------------------------------------------------------------- CL-5 / 4.3-3
  {
    caseId: "CL-5/full-resync-after-cursor-expired",
    requirementId: "CL-5",
    assertion: "After 410 cursor_expired, the client restarts from changes_since=beginning without the expired cursor.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      client.fixture.configure({ cursor: "full-resync-cursor", expiredCursor: CHANGES_SINCE, kind: "expired-cursor" });
      const before = client.fixture.requestLog().length;
      await client.syncOnce(STREAM);
      await client.syncAgain(STREAM);
      const [, , recovery] = requestAfter(client, before);
      return recovery && recovery.query.changes_since === BEGINNING && recovery.query.cursor === undefined
        ? pass()
        : fail(
            `Expected 410 followed by a restart at changes_since=beginning; observed ${JSON.stringify(requestAfter(client, before))}.`
          );
    },
  },

  // ------------------------------------------------------------- CL-5 / 8.9-12
  {
    caseId: "CL-5/endpoint-cursor-expiry-also-full-resyncs",
    requirementId: "CL-5",
    assertion:
      "The list-records cursor_expired path also restarts from changes_since=beginning rather than retrying the cursor.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      client.fixture.configure({ cursor: "full-resync-cursor", expiredCursor: CHANGES_SINCE, kind: "expired-cursor" });
      const before = client.fixture.requestLog().length;
      await client.syncOnce(STREAM);
      await client.syncAgain(STREAM);
      const [, , recovery] = requestAfter(client, before);
      return recovery && recovery.query.changes_since === BEGINNING && recovery.query.cursor === undefined
        ? pass()
        : fail(
            `Expected the recovery request to restart at changes_since=beginning with no page cursor; observed ${JSON.stringify(recovery?.query ?? {})}.`
          );
    },
  },

  // ------------------------------------------------------------- AS-7 / 5.3-4
  {
    caseId: "AS-7/client-does-not-override-display-descriptions",
    requirementId: "AS-7",
    assertion: "The client selection request does not add or override declaration-authored display descriptions.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      const before = client.fixture.requestLog().length;
      await client.authorize({ source: { id: "https://fixture.invalid/source" }, streams: [{ name: STREAM }] });
      const [request] = requestAfter(client, before);
      const body = request?.body as { authorization_details?: readonly Record<string, unknown>[] } | undefined;
      const selection = body?.authorization_details?.[0];
      return selection && !Object.hasOwn(selection, "display") && !Object.hasOwn(selection, "description")
        ? pass()
        : fail(`The selection carried a client-authored display field: ${JSON.stringify(selection ?? null)}.`);
    },
  },

  // ------------------------------------------------------------- CL-3 / 8.9-1
  {
    caseId: "CL-3/forwards-cursors-as-opaque-values",
    requirementId: "CL-3",
    assertion: "The client forwards a server-issued page cursor byte-for-byte without parsing or constructing it.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      const opaqueCursor = "eyJjdXJzb3IiOiLihJzihJ3ihJ4ifQ";
      client.fixture.configure({ kind: "page", nextCursor: opaqueCursor, nextChangesSince: CHANGES_SINCE });
      const before = client.fixture.requestLog().length;
      await client.readPage(STREAM, opaqueCursor);
      const [request] = requestAfter(client, before);
      return request?.query.cursor === opaqueCursor
        ? pass()
        : fail(`Expected cursor=${opaqueCursor}; observed ${JSON.stringify(request?.query ?? {})}.`);
    },
  },

  // ------------------------------------------------------------- CL-7 / 8.13-1
  {
    caseId: "CL-7/unknown-error-code-keeps-http-status-authoritative",
    requirementId: "CL-7",
    assertion: "An unknown error code remains opaque and cannot replace the actual HTTP status.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      client.fixture.configure({ code: "future_error_code", kind: "error", status: 403, type: "future_error_type" });
      const result = await client.readPage(STREAM);
      return !result.ok && result.status === 403 && result.errorCode === "future_error_code"
        ? pass()
        : fail(`Expected an opaque 403 future_error_code result; observed ${JSON.stringify(result)}.`);
    },
  },

  // ------------------------------------------------------------- CL-7 / 8.13-3
  {
    caseId: "CL-7/status-incompatible-code-does-not-override-status",
    requirementId: "CL-7",
    assertion: "A status-incompatible error code cannot turn a 403 response into a 410 control-flow result.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      client.fixture.configure({ code: "cursor_expired", kind: "error", status: 403, type: "gone_error" });
      const result = await client.readPage(STREAM);
      return !result.ok && result.status === 403 && result.errorCode === "cursor_expired"
        ? pass()
        : fail(`Expected the actual 403 to remain authoritative; observed ${JSON.stringify(result)}.`);
    },
  },

  // ------------------------------------------------------------- CL-7 / 8.13-4
  {
    caseId: "CL-7/unknown-error-identifiers-do-not-break-parser",
    requirementId: "CL-7",
    assertion: "Malformed unknown error identifiers do not make the client fail to parse a 403 response.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      client.fixture.configure({ code: { future: true }, kind: "error", status: 403, type: ["future_error"] });
      const result = await client.readPage(STREAM);
      return !result.ok && result.status === 403 && typeof result.errorCode === "object"
        ? pass()
        : fail(`Expected a parsed 403 with an opaque identifier; observed ${JSON.stringify(result)}.`);
    },
  },

  // ------------------------------------------------------------- CL-8 / 6.6-1
  {
    caseId: "CL-8/reads-source-kind-from-grant",
    requirementId: "CL-8",
    assertion:
      "A client that declares a provenance-dependent policy does not assert source.kind in selection and reads the provenance supplied by the grant before first use.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      if (!client.declaresProvenancePolicy) {
        return unsupported(
          "The client does not declare a provenance-dependent policy. Section 9 client item 8 binds only a client whose local policy depends on source provenance; one with no such policy has nothing to check."
        );
      }
      const before = client.fixture.requestLog().length;
      await client.authorize({ source: { id: "https://fixture.invalid/source" }, streams: [{ name: STREAM }] });
      const result = await client.readPage(STREAM);
      const [request] = requestAfter(client, before);
      const body = request?.body as { authorization_details?: readonly Record<string, unknown>[] } | undefined;
      const selection = body?.authorization_details?.[0];
      return result.ok &&
        result.sourceKindRead === "connector" &&
        selection &&
        !Object.hasOwn(selection, "source.kind") &&
        !JSON.stringify(selection).includes('"kind"')
        ? pass()
        : fail(
            `Expected grant-derived provenance with no source.kind assertion in selection; observed ${JSON.stringify(selection ?? null)}.`
          );
    },
  },
  // ------------------------------------------------------------- CL-9 / 10.7-9
  {
    caseId: "CL-9/invalid-token-challenge-stops-use-of-the-token",
    requirementId: "CL-9",
    assertion:
      "After a 401 carrying a Bearer invalid_token challenge, the client sends one request with that token and does not retry it.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      client.fixture.configure({
        challenge: 'Bearer error="invalid_token"',
        code: "authentication_error",
        kind: "error",
        status: 401,
        type: "authentication_error",
      });
      const before = client.fixture.requestLog().length;
      const result = await client.readPage(STREAM);
      const requests = requestAfter(client, before);
      return !result.ok && result.status === 401 && requests.length === 1
        ? pass()
        : fail(
            `Expected one request ending in 401 invalid_token and no retry with the same token; observed ${requests.length} request(s), status ${result.status}.`
          );
    },
  },

  // ------------------------------------------------------------ CL-9 / 10.7-10
  {
    caseId: "CL-9/inactive-token-is-not-recorded-as-revocation",
    requirementId: "CL-9",
    assertion:
      "A 401 for an inactive token whose cause is unknown does not make the client record the grant as revoked, while a grant_revoked error does.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      if (!client.grantState) {
        return skip(
          "The client under test does not expose grantState, so what it recorded about the grant is unobserved."
        );
      }
      const challenge = 'Bearer error="invalid_token"';
      await client.authorize({ source: { id: "https://fixture.invalid/source" }, streams: [{ name: STREAM }] });
      // Control: told the grant was revoked, the client records it. Without
      // this a client that records nothing would satisfy the negative.
      client.fixture.configure({
        challenge,
        code: "grant_revoked",
        kind: "error",
        status: 401,
        type: "authentication_error",
      });
      await client.readPage(STREAM);
      if (client.grantState() !== "revoked") {
        return skip(
          "The client did not record a grant_revoked error as revocation, so the inference case cannot be judged."
        );
      }
      await client.authorize({ source: { id: "https://fixture.invalid/source" }, streams: [{ name: STREAM }] });
      client.fixture.configure({
        challenge,
        code: "authentication_error",
        kind: "error",
        status: 401,
        type: "authentication_error",
      });
      const before = client.fixture.requestLog().length;
      const result = await client.readPage(STREAM);
      const sent = requestAfter(client, before).length;
      return sent === 1 && result.status === 401 && client.grantState() !== "revoked"
        ? pass()
        : fail(
            `After a 401 invalid_token whose cause is unknown (${sent} request(s), status ${result.status}), the client recorded the grant as ${String(client.grantState())}. Core Section 10: a client MUST NOT treat an inactive token as proof of revocation; the token may have expired or lost its refresh-token family.`
          );
    },
  },

  // ------------------------------------------------------------ CL-8 / 6.6-4
  {
    caseId: "CL-8/unrecognized-source-kind-not-treated-as-known",
    requirementId: "CL-8",
    assertion: "A grant reporting an unrecognized source.kind is not read as connector or provider_native.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      client.fixture.configureGrantSourceKind("vendor_native");
      try {
        const before = client.fixture.requestLog().length;
        const result = await client.authorize({
          source: { id: "https://fixture.invalid/source" },
          streams: [{ name: STREAM }],
        });
        if (result.ok) {
          await client.readPage(STREAM);
        }
        const sent = requestAfter(client, before).length;
        const read = result.sourceKindRead;
        return sent >= 1 && read !== "connector" && read !== "provider_native"
          ? pass()
          : fail(
              `A grant reporting source.kind 'vendor_native' was read as ${JSON.stringify(read)} after ${sent} request(s). Core Section 6: a client that reads an unrecognized source.kind MUST NOT treat it as either known value; it MAY reject the grant as unsupported.`
            );
      } finally {
        client.fixture.configureGrantSourceKind("connector");
      }
    },
  },

  // ----------------------------------------------------------- CL-10 / 4.3-14
  {
    caseId: "CL-10/tombstone-for-unheld-id-is-a-no-op",
    requirementId: "CL-10",
    assertion: "A tombstone for an ID the client does not hold leaves its stored copy unchanged and raises no error.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      if (!client.storedCopy) {
        return skip("The client under test does not expose its stored copy, so tombstone handling is unobserved.");
      }
      client.fixture.configure({ kind: "page", nextChangesSince: CHANGES_SINCE, records: [{ id: "held" }] });
      const first = await client.syncOnce(STREAM);
      client.fixture.configure({
        kind: "page",
        nextChangesSince: CHANGES_SINCE,
        records: [{ deleted: true, id: "never-held" }],
      });
      const before = client.fixture.requestLog().length;
      const second = await client.syncAgain(STREAM);
      const copy = client.storedCopy(STREAM);
      return first.ok && second.ok && requestAfter(client, before).length >= 1 && copy.join(",") === "held"
        ? pass()
        : fail(
            `Expected a tombstone for an unheld id to be a no-op; observed ok=${second.ok} and stored copy ${JSON.stringify(copy)}.`
          );
    },
  },

  // ------------------------------------------------------------ CL-5 / 4.3-15
  {
    caseId: "CL-5/beginning-session-replaces-the-stored-copy",
    requirementId: "CL-5",
    assertion:
      "After a completed changes_since=beginning session, the client's stored copy equals that session's result, not a merge with the earlier copy.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      if (!client.storedCopy) {
        return skip("The client under test does not expose its stored copy, so replacement is unobserved.");
      }
      client.fixture.configure({ kind: "page", nextChangesSince: CHANGES_SINCE, records: [{ id: "a" }, { id: "b" }] });
      await client.syncOnce(STREAM);
      const held = [...client.storedCopy(STREAM)].sort();
      client.fixture.configure({ kind: "page", nextChangesSince: CHANGES_SINCE, records: [{ id: "b" }, { id: "c" }] });
      const before = client.fixture.requestLog().length;
      await client.syncOnce(STREAM);
      const requests = requestAfter(client, before);
      const copy = [...client.storedCopy(STREAM)].sort();
      const unique = new Set(held).size === held.length && new Set(copy).size === copy.length;
      return unique &&
        held.join(",") === "a,b" &&
        requests[0]?.query.changes_since === BEGINNING &&
        copy.join(",") === "b,c"
        ? pass()
        : fail(
            `Expected the second beginning session to leave exactly b,c (first copy ${held}); observed ${copy}. Core Section 4: after a completed changes_since=beginning session the client MUST replace its copy of the stream with that session's result.`
          );
    },
  },
  // ------------------------------------------------------------ AS-16 / 5.8-1
  {
    caseId: "AS-16/client-does-not-introduce-authority-or-declaration-uri",
    requirementId: "AS-16",
    assertion:
      "The selection request carries no source authority or declaration URI beyond the source id the caller supplied.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      const supplied = "https://fixture.invalid/source";
      const before = client.fixture.requestLog().length;
      await client.authorize({ source: { id: supplied }, streams: [{ name: STREAM }] });
      const [request] = requestAfter(client, before);
      const selection = (request?.body as { authorization_details?: readonly Record<string, unknown>[] } | undefined)
        ?.authorization_details?.[0];
      if (!selection) {
        return fail("The client sent no selection, so what it asserted about the source is unobserved.");
      }
      const introduced: string[] = [];
      const source = selection.source as Record<string, unknown> | undefined;
      if (source?.id !== supplied) {
        introduced.push("source.id");
      }
      // Type, purpose, view and client-claim URIs do not assert source authority.
      for (const object of [selection, source]) {
        if (!object) {
          continue;
        }
        for (const key of Object.keys(object)) {
          if (key === "authority" || key.startsWith("declaration") || key === "source_authority") {
            introduced.push(key);
          }
        }
      }
      return introduced.length === 0
        ? pass()
        : fail(
            `The selection introduced ${JSON.stringify(introduced)} beyond the source id the caller supplied. Core Section 5: a client MUST NOT introduce a new source authority or declaration URI during authorization; the AS decides what it accepts as a declaration.`
          );
    },
  },
];
