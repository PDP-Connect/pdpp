// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Resource Server conformance cases against Core Section 9 "Resource Server
// conformance" and the Section 8 interface it refers to.
//
// These are weighted toward NEGATIVE oracles, deliberately. A resource server
// that returns records to an authorized client is the easy half and the half a
// vendor will have exercised in its own tests; the half that decides whether
// grant enforcement is real is what happens when the request exceeds the grant.
// A suite that only asked for the happy path would certify a server that
// ignores grants entirely, because such a server returns the records too.
//
// Each negative case therefore pairs with a positive control on the same
// surface where one exists, so that "rejected everything" cannot pass either:
// RS-2 asserts the granted stream is readable AND the ungranted one is refused.

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { errorBody, request, requestBytes } from "../harness/http.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";

/** Records as returned in a Section 8 list envelope. */
interface ListBody {
  data?: { id?: string; data?: Record<string, unknown> }[];
  has_more?: boolean;
  meta?: { warnings?: { code?: string }[] };
  next_changes_since?: string;
  next_cursor?: string;
  object?: string;
}

// The challenge shape RS-16 checks. The Bearer scheme and the challenge itself
// come from RFC 6750 Section 3; the `error="invalid_token"` requirement is
// PDPP's own strengthening in Core Section 8, not something RFC 6750 mandates.
const BEARER_SCHEME = /^Bearer\b/i;
const INVALID_TOKEN_ERROR = /error="?invalid_token"?/;

function asList(json: unknown): ListBody | undefined {
  return typeof json === "object" && json !== null ? (json as ListBody) : undefined;
}

/** Owner-token stream metadata, the shape RS-14 and RS-15 both read. */
interface StreamMetadataBody {
  query?: Record<string, unknown>;
  relationships?: unknown[];
  schema?: { properties?: Record<string, { items?: { type?: unknown }; type?: unknown }>; required?: unknown };
  views?: unknown[];
}

/** Compare declared capabilities without treating JSON object-key order as meaningful. */
function declaredCapabilityMismatch(
  declared: readonly unknown[] | Readonly<Record<string, unknown>> | undefined,
  exposed: unknown
): boolean {
  const declaredIsEmpty = Array.isArray(declared) ? declared.length === 0 : Object.keys(declared ?? {}).length === 0;
  if (declaredIsEmpty) {
    return false;
  }
  return !isDeepStrictEqual(exposed, declared);
}

/**
 * Declared schema field types that the exposed schema either omits or states
 * differently, against the fixture's own retained per-field type declaration.
 * Distinguishes a truncated schema (checked separately, by field presence)
 * from one that keeps every field name but silently changes a field's type.
 */
function corruptedSchemaFields(
  declared: Readonly<Record<string, string>> | undefined,
  exposedProperties: Record<string, { type?: unknown }> | undefined
): readonly string[] {
  if (!declared) {
    return [];
  }
  return Object.entries(declared)
    .filter(([field, type]) => exposedProperties?.[field]?.type !== type)
    .map(([field]) => field);
}

/**
 * Declared nested per-field constraints (e.g. array `items.type`) that the
 * exposed schema states differently, against the fixture's own retained
 * declaration. Separate from `corruptedSchemaFields`: a target can keep a
 * field's own flat `type` correct while still narrowing or dropping what it
 * declares about that field's nested content (Core Section 5's stream schema
 * is JSON Schema, not just a flat field/type map).
 */
function corruptedNestedConstraints(
  declared: Readonly<Record<string, string>> | undefined,
  exposedProperties: Record<string, { items?: { type?: unknown } }> | undefined
): readonly string[] {
  if (!declared) {
    return [];
  }
  return Object.entries(declared)
    .filter(([field, itemType]) => exposedProperties?.[field]?.items?.type !== itemType)
    .map(([field]) => field);
}

/**
 * Declared required fields the exposed schema's `required` array omits,
 * order-independent (Core Section 5 requires the field set, not a specific
 * array ordering) and restricted to fields this read actually exposes (a
 * field outside the exposed schema cannot be required by it).
 */
function missingRequiredFields(
  declared: readonly string[] | undefined,
  exposedFields: readonly string[],
  exposedRequired: unknown
): readonly string[] {
  if (!declared || declared.length === 0) {
    return [];
  }
  const required = new Set(Array.isArray(exposedRequired) ? exposedRequired : []);
  return declared.filter((f) => exposedFields.includes(f) && !required.has(f));
}

export const RESOURCE_SERVER_CASES: readonly ConformanceCase[] = [
  // ---------------------------------------------------------------- RS-1 ---
  {
    caseId: "RS-1/list-streams-envelope",
    requirementId: "RS-1",
    assertion: "GET {queryBase}/streams returns a Section 8 list envelope for an authorized client token.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
      });
      if (!grant) {
        return skip("The target could not issue a grant for a seeded stream.");
      }
      const response = await request(adapter.baseUrl, path("/streams"), {
        token: grant.accessToken,
      });
      if (response.status !== 200) {
        return fail(`Expected 200 from the list-streams endpoint, got ${response.status}.`, [response.evidence]);
      }
      const body = asList(response.json);
      if (body?.object !== "list" || !Array.isArray(body.data)) {
        return fail('The list-streams response is not a Section 8 list envelope ({ object: "list", data: [] }).', [
          response.evidence,
        ]);
      }
      return pass([response.evidence]);
    },
  },

  // RS-1 also names "get a blob" as a Section 8 query endpoint. It is checked
  // separately from list-streams because it needs its own precondition: a
  // persisted blob and a record that references it via `blob_ref`, which the
  // suite cannot seed itself (Core leaves blob storage deployment-specific).
  // Declaring `capabilities.blobs` is not sufficient evidence on its own — a
  // target can declare the capability without this run having a seeded blob
  // to point at — so the case relies on the adapter's `blobFixture` hook and
  // reports `skip` naming it when absent, rather than reading the declared
  // flag as proof the endpoint works.
  {
    caseId: "RS-1/get-blob-bytes",
    requirementId: "RS-1",
    assertion:
      "GET {queryBase}/blobs/:blobId returns the exact stored bytes, mimeType, and length under a grant that can read the referencing record.",
    async run({ adapter, path }) {
      if (!adapter.blobFixture) {
        return skip("The adapter implements no blobFixture hook, so RS-1's blob-fetch endpoint has no known blob to check.");
      }
      const fixture = await adapter.blobFixture();
      if (!fixture) {
        return skip("The target reported no seeded blob to check RS-1's blob-fetch endpoint against.");
      }
      const grant = await adapter.issueGrant(fixture.grantRequest);
      if (!grant) {
        return skip("The target could not issue the grant needed to read the blob's referencing record.");
      }

      const response = await requestBytes(adapter.baseUrl, path(`/blobs/${encodeURIComponent(fixture.blobId)}`), {
        token: grant.accessToken,
      });
      if (response.status !== 200) {
        return fail(`Expected 200 from the blob-fetch endpoint, got ${response.status}.`, [response.evidence]);
      }

      const contentType = response.headers.get("content-type");
      if (contentType !== fixture.mimeType) {
        return fail(`Expected Content-Type "${fixture.mimeType}", got "${contentType}".`, [response.evidence]);
      }

      if (fixture.rawBytes) {
        if (!Buffer.from(response.body).equals(Buffer.from(fixture.rawBytes))) {
          return fail(
            `The fetched blob bytes (${response.body.length} bytes) do not match the bytes stored at upload time (${fixture.rawBytes.length} bytes).`,
            [response.evidence]
          );
        }
      } else if (fixture.digest) {
        if (response.body.length !== fixture.digest.length) {
          return fail(
            `Expected ${fixture.digest.length} bytes (the length recorded at upload time), got ${response.body.length}.`,
            [response.evidence]
          );
        }
        const actualSha256 = createHash("sha256").update(response.body).digest("hex");
        if (actualSha256 !== fixture.digest.sha256) {
          return fail(`Expected sha256 ${fixture.digest.sha256} (recorded at upload time), got ${actualSha256}.`, [
            response.evidence,
          ]);
        }
      } else {
        return skip("The blobFixture hook supplied neither rawBytes nor an independent digest to verify against.");
      }

      return pass([response.evidence]);
    },
  },

  // ---------------------------------------------------------------- RS-2 ---
  // The central grant-enforcement oracle, in three parts: the granted stream
  // is readable (positive control), an ungranted stream is refused, and the
  // field projection is not exceeded. Without the positive control, a server
  // that 403s everything would score as enforcing.
  {
    caseId: "RS-2/granted-stream-readable",
    requirementId: "RS-2",
    assertion: "A client token can read the stream its grant names (positive control for the enforcement oracles).",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
      });
      if (!grant) {
        return skip("The target could not issue a grant for a seeded stream.");
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`), {
        token: grant.accessToken,
      });
      if (response.status !== 200) {
        return fail(`A grant naming stream "${stream.name}" did not permit reading it: got ${response.status}.`, [
          response.evidence,
        ]);
      }
      return pass([response.evidence]);
    },
  },
  {
    caseId: "RS-2/ungranted-stream-refused",
    requirementId: "RS-2",
    assertion: "A client token is refused a stream absent from its grant (enforcement only; classification is RS-6).",
    async run({ adapter, streams, path }) {
      const [granted] = streams;
      const ungranted = streams.find((s) => s.name !== granted?.name);
      if (!(granted && ungranted)) {
        return skip("Two seeded streams are required to test stream-membership enforcement.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: granted.name, fields: [...granted.fields] }],
      });
      if (!grant) {
        return skip("The target could not issue a single-stream grant.");
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(ungranted.name)}/records`), {
        token: grant.accessToken,
      });
      if (response.status === 200) {
        return fail(
          `Overbroad access: a grant naming only "${granted.name}" returned records for "${ungranted.name}".`,
          [response.evidence]
        );
      }
      // Enforcement (RS-2) is satisfied: the request was refused. Whether the
      // refusal carries the status and code Section 8's error table specifies is
      // a separate requirement, RS-6, and is asserted by its own case below.
      // Keeping them apart matters: a server that denies correctly but classifies
      // the denial differently has an interoperability defect, not an
      // access-control one, and the report should not conflate the two.
      return pass([response.evidence]);
    },
  },
  {
    caseId: "RS-2/field-projection-not-exceeded",
    requirementId: "RS-2",
    assertion: "Records returned under a field-narrowed grant carry no field outside the grant's fields allowlist.",
    async run({ adapter, streams, path }) {
      const stream = streams.find((s) => s.fields.length >= 2);
      if (!stream) {
        return skip("A stream with at least two declared fields is required to narrow a projection.");
      }
      // Narrow to the primary key plus one field, leaving at least one out.
      const keep = [...new Set([...stream.primaryKey, stream.fields[0]])].filter(
        (f): f is string => typeof f === "string"
      );
      const omitted = stream.fields.filter((f) => !keep.includes(f));
      if (omitted.length === 0) {
        return skip("Narrowing left no omitted field to check for leakage.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: keep }],
      });
      if (!grant) {
        return skip("The target could not issue a field-narrowed grant.");
      }

      // Judge against the fields the AS RESOLVED, not the ones requested.
      // Section 5 requires schema-required fields to be present in every
      // resolved allowlist, so a conforming AS legitimately widens a narrow
      // request. Comparing against the request would report that correct
      // behaviour as a leak; the question is whether the RS returns anything
      // beyond what the grant actually froze.
      const granted = grant.streams.find((s) => s.name === stream.name)?.fields ?? keep;
      const stillOmitted = stream.fields.filter((f) => !granted.includes(f));
      if (stillOmitted.length === 0) {
        return skip(
          `The authorization server resolved the narrowed request to every declared field (${granted.join(", ")}), so no field was withheld and projection enforcement is not observable on this stream.`
        );
      }

      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`), {
        token: grant.accessToken,
      });
      if (response.status !== 200) {
        return fail(`A field-narrowed grant did not permit reading its stream: got ${response.status}.`, [
          response.evidence,
        ]);
      }
      const records = asList(response.json)?.data ?? [];
      const leaked = new Set<string>();
      for (const record of records) {
        for (const field of Object.keys(record.data ?? {})) {
          if (stillOmitted.includes(field)) {
            leaked.add(field);
          }
        }
      }
      if (leaked.size > 0) {
        return fail(
          `Overbroad access: fields outside the grant's resolved projection appeared in records: ${[...leaked].join(", ")}. The grant froze ${granted.join(", ")}.`,
          [response.evidence]
        );
      }
      return pass([response.evidence]);
    },
  },

  // --------------------------------------------------------------- RS-16 ---
  // This is the authentication boundary, not token-kind discrimination: a
  // request with no credential must be challenged rather than served. It is
  // filed under RS-16 because that requirement owns the 401 challenge path.
  // It was previously mislabelled RS-4, which made RS-4 read as covered while
  // nothing tested what RS-4 actually requires.
  {
    caseId: "RS-16/unauthenticated-request-refused",
    requirementId: "RS-16",
    assertion: "A record read with no access token is refused with 401 rather than served.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`));
      if (response.status !== 401) {
        return fail(`Expected 401 for a request carrying no token, got ${response.status}.`, [response.evidence]);
      }
      return pass([response.evidence]);
    },
  },

  // ---------------------------------------------------------------- RS-6 ---
  // Section 9 RS item 6 requires structured errors "as defined in Section 8
  // (unified error table)". That table binds stream-not-in-grant to HTTP 403 with
  // code `grant_stream_not_allowed`. A server that refuses the request but
  // classifies it differently is enforcing correctly while breaking the contract
  // a client branches on, so this is reported separately from RS-2 enforcement.
  {
    caseId: "RS-6/ungranted-stream-error-classification",
    requirementId: "RS-6",
    assertion:
      "Refusing a stream outside the grant uses 403 grant_stream_not_allowed, as the Section 8 error table defines.",
    async run({ adapter, streams, path }) {
      const [granted] = streams;
      const ungranted = streams.find((s) => s.name !== granted?.name);
      if (!(granted && ungranted)) {
        return skip("Two seeded streams are required to test error classification.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: granted.name, fields: [...granted.fields] }],
      });
      if (!grant) {
        return skip("The target could not issue a single-stream grant.");
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(ungranted.name)}/records`), {
        token: grant.accessToken,
      });
      if (response.status === 200) {
        return skip(
          "The request was served rather than refused, so there is no error to classify. RS-2 reports that as the enforcement failure it is."
        );
      }
      const error = errorBody(response);
      if (response.status !== 403) {
        return fail(
          `Expected 403 for a stream outside the grant, got ${response.status} with code ${error?.code ?? "none"}. Section 8's error table binds stream-not-in-grant to 403 grant_stream_not_allowed. Access was correctly refused, so this is a classification defect rather than an access-control one: a client branching on the documented code will not recognise this response.`,
          [response.evidence]
        );
      }
      if (error?.code !== "grant_stream_not_allowed") {
        return fail(`Expected error code grant_stream_not_allowed, got ${error?.code ?? "no structured error"}.`, [
          response.evidence,
        ]);
      }
      return pass([response.evidence]);
    },
  },

  // ---------------------------------------------------------------- RS-4 ---
  // What RS-4 actually requires: token kind comes from the introspection
  // response, never from token syntax. The defect this catches is a server that
  // branches on a prefix or other shape in the token string — it behaves
  // correctly for every well-formed token its own AS mints, and grants owner
  // powers to anyone who can guess the naming convention.
  //
  // The probe is a bearer string shaped like the target's own owner credential
  // but never issued by it. A server reading introspection rejects it as
  // unknown; a server reading syntax treats it as an owner token.
  {
    caseId: "RS-4/token-kind-not-inferred-from-syntax",
    requirementId: "RS-4",
    appliesWhen: (adapter) => adapter.capabilities.ownerTokens,
    assertion:
      "An unissued bearer string shaped like an owner token is rejected, not treated as an owner token by syntax.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const realOwner = await adapter.ownerToken();
      if (!realOwner) {
        return skip("The adapter produced no owner token, so its syntactic shape is unknown.");
      }

      // Derive a forgery from the real token's own shape, so the probe tracks
      // whatever convention the target uses instead of guessing one. The suffix
      // makes it a string the target cannot have issued.
      const forged = `${realOwner}-pdpp-conformance-unissued`;

      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
      const response = await request(adapter.baseUrl, recordsPath, { token: forged });

      if (response.status === 200) {
        return fail(
          "A bearer string the target never issued, differing from a real owner token only by a suffix, was served records. Section 8 requires the RS to determine the token's properties solely from the introspection response and never from token syntax.",
          [response.evidence]
        );
      }
      if (response.status !== 401 && response.status !== 403) {
        return fail(`Expected 401 or 403 for an unissued token, got ${response.status}.`, [response.evidence]);
      }

      // Positive control: the genuine owner token must still work, otherwise the
      // rejection above could just be a server that refuses every owner read.
      const control = await request(adapter.baseUrl, recordsPath, {
        token: realOwner,
        ...(adapter.ownerReadParams ? { query: { ...adapter.ownerReadParams } } : {}),
      });
      if (control.status === 401 || control.status === 403) {
        return skip(
          `The genuine owner token was also refused (${control.status}), so this run cannot distinguish syntax-based token handling from a target that rejects all owner reads.`
        );
      }
      return pass([response.evidence, control.evidence]);
    },
  },

  // ---------------------------------------------------------------- RS-9 ---
  // Section 8: client-token filter[...] MUST be rejected with 400
  // invalid_request BEFORE the RS consults declaration metadata. The case
  // asserts the status and code; "before declaration lookup" is not
  // black-box observable, and the suite does not claim to test it.
  {
    caseId: "RS-9/client-token-exact-filter-rejected",
    requirementId: "RS-9",
    assertion: "A client-token exact filter[...] parameter is rejected with 400 invalid_request.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      const field = stream?.fields[0];
      if (!(stream && field)) {
        return skip("A seeded stream with at least one field is required.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
      });
      if (!grant) {
        return skip("The target could not issue a grant for a seeded stream.");
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`), {
        token: grant.accessToken,
        query: { [`filter[${field}]`]: "any-value" },
      });
      if (response.status === 200) {
        return fail(
          `A client-token request carrying filter[${field}] was served instead of rejected. Section 8 removes request-time predicate filters from the v0.1 client surface.`,
          [response.evidence]
        );
      }
      if (response.status !== 400) {
        return fail(`Expected 400 for a client-token filter parameter, got ${response.status}.`, [response.evidence]);
      }
      const error = errorBody(response);
      if (error?.code !== "invalid_request") {
        return fail(`Expected error code invalid_request, got ${error?.code ?? "no structured error"}.`, [
          response.evidence,
        ]);
      }
      return pass([response.evidence]);
    },
  },
  {
    caseId: "RS-9/client-token-expand-rejected",
    requirementId: "RS-9",
    assertion: "A client-token expand[] parameter is rejected with 400 invalid_request.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
      });
      if (!grant) {
        return skip("The target could not issue a grant for a seeded stream.");
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`), {
        token: grant.accessToken,
        query: { "expand[]": "anything" },
      });
      if (response.status !== 400) {
        return fail(`Expected 400 for a client-token expand[] parameter, got ${response.status}.`, [response.evidence]);
      }
      return pass([response.evidence]);
    },
  },

  // --------------------------------------------------------------- RS-10 ---
  {
    caseId: "RS-10/unknown-parameter-rejected",
    requirementId: "RS-10",
    assertion: "An unknown query parameter is rejected with 400 rather than silently ignored.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
      });
      if (!grant) {
        return skip("The target could not issue a grant for a seeded stream.");
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`), {
        token: grant.accessToken,
        query: { pdpp_conformance_unknown_param: "1" },
      });
      if (response.status === 200) {
        return fail("An unknown query parameter was silently ignored and the request served. Section 8 requires 400.", [
          response.evidence,
        ]);
      }
      if (response.status !== 400) {
        return fail(`Expected 400 for an unknown query parameter, got ${response.status}.`, [response.evidence]);
      }
      return pass([response.evidence]);
    },
  },

  // --------------------------------------------------------------- RS-11 ---
  {
    caseId: "RS-11/unsupported-version-rejected",
    requirementId: "RS-11",
    assertion: "An unsupported PDPP-Version header is rejected with 400 unsupported_version.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
      });
      if (!grant) {
        return skip("The target could not issue a grant for a seeded stream.");
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`), {
        token: grant.accessToken,
        // A date far outside any plausible supported set.
        headers: { "PDPP-Version": "1999-01-01" },
      });
      if (response.status !== 400) {
        return fail(`Expected 400 for an unsupported PDPP-Version, got ${response.status}.`, [response.evidence]);
      }
      const error = errorBody(response);
      if (error?.code !== "unsupported_version") {
        return fail(`Expected error code unsupported_version, got ${error?.code ?? "no structured error"}.`, [
          response.evidence,
        ]);
      }
      return pass([response.evidence]);
    },
  },

  // --------------------------------------------------------------- RS-12 ---
  // Cross-subject isolation. Without a second subject the target cannot
  // DEMONSTRATE scoping, so the case is skipped rather than passed: absence of
  // a foreign token is absence of evidence, not evidence of isolation.
  {
    caseId: "RS-12/foreign-subject-cannot-read",
    requirementId: "RS-12",
    appliesWhen: (adapter) => adapter.capabilities.ownerTokens,
    assertion: "An owner token for another subject cannot read the seeded subject's records.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      if (!adapter.foreignSubjectOwnerToken) {
        return skip("The adapter cannot mint a second subject's owner token, so subject scoping is not demonstrable.");
      }
      const foreign = await adapter.foreignSubjectOwnerToken();
      if (!foreign) {
        return skip("The adapter returned no foreign-subject owner token.");
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`), {
        token: foreign,
        ...(adapter.ownerReadParams ? { query: { ...adapter.ownerReadParams } } : {}),
      });
      if (response.status === 200) {
        const records = asList(response.json)?.data ?? [];
        if (records.length > 0) {
          return fail(
            `Cross-subject leak: an owner token scoped to another subject returned ${records.length} record(s) from the seeded subject's store.`,
            [response.evidence]
          );
        }
        return fail(
          "An owner token for another subject was accepted (200) on the seeded subject's stream. Section 9 item 12 requires owner access to be scoped to a single subject's data store.",
          [response.evidence]
        );
      }
      if (response.status !== 403 && response.status !== 404) {
        return fail(`Expected the foreign-subject read to be refused with 403 or 404, got ${response.status}.`, [
          response.evidence,
        ]);
      }
      return pass([response.evidence]);
    },
  },

  // --------------------------------------------------------------- RS-13 ---
  {
    caseId: "RS-13/self-export-supported",
    requirementId: "RS-13",
    appliesWhen: (adapter) => adapter.capabilities.selfExport,
    assertion:
      "An owner token reads the owner's own records through the client query endpoints without a client grant.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const owner = await adapter.ownerToken();
      if (!owner) {
        return skip("The target declares self-export but the adapter produced no owner token.");
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`), {
        token: owner,
        ...(adapter.ownerReadParams ? { query: { ...adapter.ownerReadParams } } : {}),
      });
      if (response.status !== 200) {
        return fail(
          `The target declares pdpp_self_export_supported, but an owner-token read returned ${response.status}.`,
          [response.evidence]
        );
      }
      return pass([response.evidence]);
    },
  },

  // --------------------------------------------------------------- RS-14 ---
  // The owner-metadata completeness oracle: the mirror image of RS-15. An
  // owner token carries no grant, so Section 9 item 14 requires the WHOLE
  // current document back — schema, and current query/view/relationship
  // capability — never truncated as if a grant were being projected against.
  //
  // The expectation is the adapter's own retained declaration
  // (`expectedOwnerMetadata`), not the metadata endpoint under test: a case
  // that compared the endpoint to itself could never observe truncation.
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    requirementId: "RS-14",
    appliesWhen: (adapter) => adapter.capabilities.ownerTokens,
    assertion:
      "An owner-token stream-metadata read returns the full current schema and declared query/view/relationship capabilities, not a grant-projected subset.",
    async run({ adapter, streams, path }) {
      const stream = streams.find((s) => s.fields.length >= 2);
      if (!stream) {
        return skip("A stream with at least two declared fields is required to detect schema truncation.");
      }
      const owner = await adapter.ownerToken();
      if (!owner) {
        return skip("The target declares owner tokens but the adapter produced none.");
      }
      const expected = stream.expectedOwnerMetadata;
      if (!expected) {
        return skip(
          `The adapter supplied no retained declaration of "${stream.name}"'s query/view/relationship capabilities to check against.`
        );
      }

      // Arrange a client grant that narrows the field projection, so the
      // fixture also proves the owner read is not merely echoing whatever a
      // concurrent grant happens to allow: a field outside the grant, plus the
      // stream's actual declared capabilities, are both in the known fixture.
      const keep = [...new Set([...stream.primaryKey, stream.fields[0]])].filter(
        (f): f is string => typeof f === "string"
      );
      await adapter.issueGrant({ streams: [{ name: stream.name, fields: keep }] });

      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}`), {
        token: owner,
        ...(adapter.ownerReadParams ? { query: { ...adapter.ownerReadParams } } : {}),
      });
      if (response.status !== 200) {
        return fail(`An owner token could not read stream metadata for "${stream.name}": got ${response.status}.`, [
          response.evidence,
        ]);
      }
      const body = response.json as StreamMetadataBody | undefined;

      const exposedProperties = body?.schema?.properties ?? {};
      const exposed = Object.keys(exposedProperties);
      const missingFields = stream.fields.filter((f) => !exposed.includes(f));
      if (missingFields.length > 0) {
        return fail(
          `Owner-token stream metadata omitted declared schema field(s): ${missingFields.join(", ")}. Section 9 item 14 requires the full current schema, not a client-grant projection (a concurrent client grant narrowed to ${keep.join(", ")} does not authorize this shortfall).`,
          [response.evidence]
        );
      }

      // Field presence alone cannot catch a target that keeps every field name
      // but silently changes what one of them declares (e.g. narrows a type),
      // which is why this checks declared per-field type content separately.
      const corruptedFields = corruptedSchemaFields(expected.schemaFieldTypes, exposedProperties);
      if (corruptedFields.length > 0) {
        return fail(
          `Owner-token stream metadata declared schema field(s) with the wrong type: ${corruptedFields.join(", ")}. Section 9 item 14 requires the full CURRENT schema, and this target's declaration of ${corruptedFields.join(", ")} does not match its own retained schema.`,
          [response.evidence]
        );
      }

      // Nested per-field constraints (e.g. array items.type) are part of the
      // current schema too; a target can keep a field's flat type correct
      // while still narrowing or dropping what it declares about its content.
      const corruptedNested = corruptedNestedConstraints(expected.schemaFieldItemTypes, exposedProperties);
      if (corruptedNested.length > 0) {
        return fail(
          `Owner-token stream metadata declared schema field(s) with the wrong nested constraint: ${corruptedNested.join(", ")}. Section 9 item 14 requires the full CURRENT schema, and this target's declaration of ${corruptedNested.join(", ")}'s nested content does not match its own retained schema.`,
          [response.evidence]
        );
      }

      const missingRequired = missingRequiredFields(expected.schemaRequired, exposed, body?.schema?.required);
      if (missingRequired.length > 0) {
        return fail(
          `Owner-token stream metadata's schema omitted declared required field(s) from \`required\`: ${missingRequired.join(", ")}. Section 9 item 14 requires the full current schema, and this target's own retained declaration marks ${missingRequired.join(", ")} required.`,
          [response.evidence]
        );
      }

      if (declaredCapabilityMismatch(expected.views, body?.views)) {
        return fail(
          "Owner-token stream metadata omitted or misstated the stream's declared views. Section 9 item 14 requires current view capability to be included, matching the stream's own retained declaration, for an owner-token read.",
          [response.evidence]
        );
      }
      if (declaredCapabilityMismatch(expected.relationships, body?.relationships)) {
        return fail(
          "Owner-token stream metadata omitted or misstated the stream's declared relationships. Section 9 item 14 requires current relationship capability to be included, matching the stream's own retained declaration, for an owner-token read.",
          [response.evidence]
        );
      }
      if (declaredCapabilityMismatch(expected.query, body?.query)) {
        return fail(
          "Owner-token stream metadata omitted or misstated the stream's declared query capability. Section 9 item 14 requires current query capability to be included, matching the stream's own retained declaration, for an owner-token read.",
          [response.evidence]
        );
      }

      return pass([response.evidence]);
    },
  },

  // --------------------------------------------------------------- RS-15 ---
  // The metadata-projection oracle. A client-token stream-metadata read must
  // not disclose current capability or post-issuance declaration changes. This
  // is the quiet leak: the records endpoint can be perfectly enforced while
  // metadata hands the client the full current schema.
  {
    caseId: "RS-15/client-metadata-projection-closed",
    requirementId: "RS-15",
    assertion:
      "Client-token stream metadata exposes only granted fields and omits current view/relationship/query capability.",
    async run({ adapter, streams, path }) {
      const stream = streams.find((s) => s.fields.length >= 2);
      if (!stream) {
        return skip("A stream with at least two declared fields is required to narrow a projection.");
      }
      const keep = [...new Set([...stream.primaryKey, stream.fields[0]])].filter(
        (f): f is string => typeof f === "string"
      );
      const omitted = stream.fields.filter((f) => !keep.includes(f));
      if (omitted.length === 0) {
        return skip("Narrowing left no omitted field to check for disclosure.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: keep }],
      });
      if (!grant) {
        return skip("The target could not issue a field-narrowed grant.");
      }

      // As in the records case: the resolved allowlist is the oracle, because a
      // conforming AS adds schema-required fields to a narrow request.
      const granted = grant.streams.find((s) => s.name === stream.name)?.fields ?? keep;
      const stillOmitted = stream.fields.filter((f) => !granted.includes(f));
      if (stillOmitted.length === 0) {
        return skip(
          `The authorization server resolved the narrowed request to every declared field (${granted.join(", ")}), so metadata projection is not observable on this stream.`
        );
      }

      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}`), {
        token: grant.accessToken,
      });
      if (response.status !== 200) {
        return fail(
          `A client token holding a grant on "${stream.name}" could not read its stream metadata: got ${response.status}.`,
          [response.evidence]
        );
      }
      const body = response.json as
        | {
            schema?: { properties?: Record<string, unknown> };
            views?: unknown[];
            relationships?: unknown[];
            query?: Record<string, unknown>;
          }
        | undefined;

      const exposed = Object.keys(body?.schema?.properties ?? {});
      const leakedFields = exposed.filter((f) => stillOmitted.includes(f));
      if (leakedFields.length > 0) {
        return fail(
          `Client-token stream metadata disclosed ungranted schema fields: ${leakedFields.join(", ")}. The grant froze ${granted.join(", ")}.`,
          [response.evidence]
        );
      }
      if (Array.isArray(body?.views) && body.views.length > 0) {
        return fail(
          "Client-token stream metadata disclosed current views. Section 9 item 15 closes the client projection to frozen grant facts.",
          [response.evidence]
        );
      }
      if (Array.isArray(body?.relationships) && body.relationships.length > 0) {
        return fail(
          "Client-token stream metadata disclosed current relationships, which a v0.1 grant does not freeze.",
          [response.evidence]
        );
      }
      if (body?.query && Object.keys(body.query).length > 0) {
        return fail(
          `Client-token stream metadata disclosed current query capability (${Object.keys(body.query).join(", ")}), which a v0.1 grant does not freeze.`,
          [response.evidence]
        );
      }
      return pass([response.evidence]);
    },
  },

  // --------------------------------------------------------------- RS-16 ---
  {
    caseId: "RS-16/protected-resource-metadata-published",
    requirementId: "RS-16",
    assertion: "RFC 9728 protected resource metadata is published with `resource` and the four pdpp_ members.",
    async run({ adapter, wellKnownPath }) {
      const response = await request(adapter.baseUrl, wellKnownPath());
      if (response.status !== 200) {
        return fail(`Expected 200 at the RFC 9728 metadata location, got ${response.status}.`, [response.evidence]);
      }
      const body = response.json as Record<string, unknown> | undefined;
      if (!body || typeof body.resource !== "string") {
        return fail("The metadata document is missing the RFC 9728 `resource` member.", [response.evidence]);
      }
      const required = [
        "pdpp_core_query_base",
        "pdpp_token_kinds_supported",
        "pdpp_self_export_supported",
        "pdpp_provider_connect_version",
      ];
      const missing = required.filter((member) => !(member in body));
      if (missing.length > 0) {
        return fail(`The metadata document is missing PDPP members: ${missing.join(", ")}.`, [response.evidence]);
      }
      return pass([response.evidence]);
    },
  },
  {
    caseId: "RS-16/401-carries-resource-metadata-challenge",
    requirementId: "RS-16",
    assertion: "A 401 carries a WWW-Authenticate: Bearer challenge with the resource_metadata parameter.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`), {
        token: "pdpp-conformance-invalid-token",
      });
      if (response.status !== 401) {
        return fail(`Expected 401 for a rejected token, got ${response.status}.`, [response.evidence]);
      }
      const challenge = response.headers.get("www-authenticate");
      if (!challenge) {
        return fail(
          'The 401 on a REJECTED token carries no WWW-Authenticate header. RFC 6750 Section 3 requires the challenge on every 401, and Core Section 8 requires it to carry resource_metadata plus error="invalid_token" when a token was presented and rejected. Note this is the rejected-token path specifically: a server may answer a request with no Authorization header correctly and still omit the challenge here.',
          [response.evidence]
        );
      }
      if (!BEARER_SCHEME.test(challenge)) {
        return fail(`Expected a Bearer challenge, got "${challenge}".`, [response.evidence]);
      }
      if (!challenge.includes("resource_metadata=")) {
        return fail(`The Bearer challenge omits the RFC 9728 resource_metadata parameter: "${challenge}".`, [
          response.evidence,
        ]);
      }
      if (!INVALID_TOKEN_ERROR.test(challenge)) {
        return fail(
          `A token was presented and rejected, so the challenge must set error="invalid_token": "${challenge}". This is a PDPP requirement, not an inherited one: RFC 6750 Section 3 makes the error attribute optional ("MAY"/"SHOULD" depending on the parameter), while Core Section 8 "Protected resource metadata" states the resource server "MUST set error="invalid_token" when a token was presented and rejected".`,
          [response.evidence]
        );
      }
      return pass([response.evidence]);
    },
  },
];
