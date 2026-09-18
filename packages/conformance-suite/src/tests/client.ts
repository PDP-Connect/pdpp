// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Client conformance cases. These cases run only when a ClientUnderTest is
// supplied in CaseContext. The fixture's inbound request log is the independent
// observation; a deliberately defective client is run against the same fixture
// in test/client-conformance.test.ts to prove each oracle can fail.

import type { ClientUnderTest } from "../harness/client-adapter.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";

const STREAM = "fixture_stream";
const CHANGES_SINCE = "changes-since-fixture-token";
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
    assertion: "After 403 grant_revoked, the client makes no further request against that grant.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
      }
      client.fixture.configure({ code: "grant_revoked", kind: "error", status: 403, type: "permission_error" });
      const before = client.fixture.requestLog().length;
      const result = await client.readPage(STREAM);
      const requests = requestAfter(client, before);
      const usedAccessToken = requests[0]?.headers.authorization === "Bearer client-fixture-access-token";
      return !result.ok &&
        result.status === 403 &&
        result.errorCode === "grant_revoked" &&
        requests.length === 1 &&
        usedAccessToken
        ? pass()
        : fail(
            `Expected one access-token request ending in 403 grant_revoked; observed ${requests.length} request(s), status ${result.status}, code ${String(result.errorCode)}.`
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
      return requests[0]?.query.changes_since === undefined && requests[1]?.query.changes_since === CHANGES_SINCE
        ? pass()
        : fail(
            `Expected an initial read followed by changes_since=${CHANGES_SINCE}; observed ${JSON.stringify(requests)}.`
          );
    },
  },

  // ------------------------------------------------------------- CL-5 / 4.3-3
  {
    caseId: "CL-5/full-resync-after-cursor-expired",
    requirementId: "CL-5",
    assertion: "After 410 cursor_expired, the client performs a full re-sync without the expired cursor.",
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
      return recovery && recovery.query.changes_since === undefined && recovery.query.cursor === undefined
        ? pass()
        : fail(`Expected 410 followed by a full resync; observed ${JSON.stringify(requestAfter(client, before))}.`);
    },
  },

  // ------------------------------------------------------------- CL-5 / 8.9-12
  {
    caseId: "CL-5/endpoint-cursor-expiry-also-full-resyncs",
    requirementId: "CL-5",
    assertion: "The list-records cursor_expired path also restarts a full sync rather than retrying the cursor.",
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
      return recovery && recovery.query.changes_since === undefined && recovery.query.cursor === undefined
        ? pass()
        : fail(
            `Expected the recovery request to omit both cursor spaces; observed ${JSON.stringify(recovery?.query ?? {})}.`
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
      "The client does not assert source.kind in selection and reads the provenance supplied by the grant before first use.",
    async run(context) {
      const { client } = context;
      if (!client) {
        return skip("Requires a ClientUnderTest adapter with a fixture request log.");
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
];
