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
import type { BlobFixture, TargetAdapter } from "../harness/adapter.ts";
import { errorBody, type PdppResponse, request, requestBytes } from "../harness/http.ts";
import { isValidMediaType } from "../harness/media-type.ts";
import {
  arrange,
  type CaseContext,
  type CaseVerdict,
  type ConformanceCase,
  fail,
  pass,
  skip,
  unsupported,
} from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";
import { resolvedFieldAllowlist } from "./resolved-grant.ts";

/**
 * The field names a stream's owner-metadata schema declares, or null when the
 * document exposes no usable `schema.properties`.
 *
 * Extracted so the RS-10 owner-filter case reads as its steps rather than
 * interleaving shape validation with them; the checks are unchanged.
 */
function declaredSchemaFields(metadataJson: unknown): readonly string[] | null {
  const properties = (metadataJson as StreamMetadataBody | undefined)?.schema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return null;
  }
  const fields = Object.keys(properties);
  return fields.length === 0 ? null : fields;
}

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
/** A Content-Length header must be digits only, hoisted per useTopLevelRegex. */
const DIGITS_ONLY = /^[0-9]+$/;
const BEARER_SCHEME = /^Bearer\b/i;
const INVALID_TOKEN_ERROR = /error="?invalid_token"?/;

function asList(json: unknown): ListBody | undefined {
  return typeof json === "object" && json !== null ? (json as ListBody) : undefined;
}

/** Parses a Cache-Control header into its lowercased directive names, ignoring directive values. */
function cacheControlDirectives(header: string | null): ReadonlySet<string> {
  if (!header) {
    return new Set();
  }
  return new Set(
    header
      .split(",")
      .map((directive) => directive.split("=")[0]?.trim().toLowerCase())
      .filter((directive): directive is string => Boolean(directive))
  );
}

/** The MIME type without parameters (e.g. `; charset=utf-8`), lowercased for case-insensitive comparison. */
function mimeEssence(contentType: string | null | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

/**
 * Checks a blob-fetch 302's required headers (Section 8: `Location` and
 * `Cache-Control: no-store`). The suite cannot follow the signed URL or know
 * its expiry, so a well-formed redirect can only be SKIPped, never treated as
 * a full pass.
 */
function redirectHeaderFailure(evidence: Evidence, headers: Headers): CaseVerdict | undefined {
  if (!headers.get("location")) {
    return fail("The blob-fetch 302 carries no Location header.", [evidence]);
  }
  if (!cacheControlDirectives(headers.get("cache-control")).has("no-store")) {
    return fail(`The blob-fetch 302 must carry Cache-Control: no-store, got "${headers.get("cache-control") ?? ""}".`, [
      evidence,
    ]);
  }
  return undefined;
}

function verifyBlobRedirect(evidence: Evidence, headers: Headers): CaseVerdict {
  return (
    redirectHeaderFailure(evidence, headers) ??
    skip(
      "The blob-fetch endpoint redirected to a signed URL (valid Location and Cache-Control: no-store). Byte fidelity and signed-URL expiry are not checked: the suite does not follow the redirect."
    )
  );
}

/**
 * Checks a direct 200 blob-fetch response's required headers (Section 8:
 * `Cache-Control: private, no-store`, a `Content-Length` that matches the
 * actual body when present, and a Content-Type matching the fixture's
 * declared MIME type by essence, ignoring parameters like `; charset=`).
 */
function verifyDirectBlobHeaders(
  evidence: Evidence,
  headers: Headers,
  body: Uint8Array,
  expectedMimeType: string
): CaseVerdict | undefined {
  const cacheControl = cacheControlDirectives(headers.get("cache-control"));
  if (!(cacheControl.has("private") && cacheControl.has("no-store"))) {
    return fail(
      `A direct blob-fetch response must carry Cache-Control: private, no-store, got "${headers.get("cache-control") ?? ""}".`,
      [evidence]
    );
  }

  const contentLength = headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!(DIGITS_ONLY.test(contentLength) && Number.isSafeInteger(declared)) || declared !== body.length) {
      return fail(`Content-Length declared ${contentLength} bytes but the response body was ${body.length} bytes.`, [
        evidence,
      ]);
    }
  }

  const contentType = headers.get("content-type");
  if (mimeEssence(contentType) !== mimeEssence(expectedMimeType)) {
    return fail(`Expected Content-Type "${expectedMimeType}", got "${contentType}".`, [evidence]);
  }

  return undefined;
}

/**
 * Checks the fetched bytes against whichever independent proof the fixture
 * supplied: the exact retained bytes, or a sha256 digest plus length.
 */
function verifyBlobBytes(evidence: Evidence, body: Uint8Array, fixture: BlobFixture): CaseVerdict {
  if (fixture.rawBytes) {
    if (!Buffer.from(body).equals(Buffer.from(fixture.rawBytes))) {
      return fail(
        `The fetched blob bytes (${body.length} bytes) do not match the bytes stored at upload time (${fixture.rawBytes.length} bytes).`,
        [evidence]
      );
    }
    return pass([evidence]);
  }
  if (fixture.digest) {
    if (body.length !== fixture.digest.length) {
      return fail(`Expected ${fixture.digest.length} bytes (the length recorded at upload time), got ${body.length}.`, [
        evidence,
      ]);
    }
    const actualSha256 = createHash("sha256").update(body).digest("hex");
    if (actualSha256 !== fixture.digest.sha256) {
      return fail(`Expected sha256 ${fixture.digest.sha256} (recorded at upload time), got ${actualSha256}.`, [
        evidence,
      ]);
    }
    return pass([evidence]);
  }
  return skip("The blobFixture hook supplied neither rawBytes nor an independent digest to verify against.");
}

/**
 * Proves `token` reads real, populated, structurally valid records on
 * `recordsPath` before a negative case trusts a rejection on the same path.
 * Without this, a target that denies (or 400s) every read would pass a
 * negative oracle by refusing everything rather than by enforcing the rule
 * under test.
 */
async function verifyPositiveRecordsRead(
  adapter: TargetAdapter,
  recordsPath: string,
  token: string,
  query?: Record<string, string>
): Promise<CaseVerdict> {
  const response = await request(adapter.baseUrl, recordsPath, { token, ...(query ? { query } : {}) });
  if (response.status !== 200) {
    return fail(
      `A positive read on the same path/token returned ${response.status} instead of 200, so this run cannot distinguish a real rejection from a target that denies this read entirely.`,
      [response.evidence]
    );
  }
  const body = asList(response.json);
  if (body?.object !== "list" || !Array.isArray(body.data)) {
    return fail("The positive read did not return a well-formed Section 8 list envelope.", [response.evidence]);
  }
  if (body.data.length === 0) {
    return fail("The positive read returned zero records, so the seeded stream is not observably populated.", [
      response.evidence,
    ]);
  }
  return pass([response.evidence]);
}

/**
 * The `mime_type` of every `blob_ref` object a record's data carries: the
 * `blob_ref` member Section 4 names, and any other member holding an object
 * with a string `blob_id`. A `mime_type` that is PRESENT is returned whatever
 * its type (a number or null is a violation to report, not noise to drop); a
 * blob_ref with no `mime_type` member contributes nothing.
 */
function blobRefMimeTypes(data: Record<string, unknown> | undefined): unknown[] {
  const found: unknown[] = [];
  for (const [name, value] of Object.entries(data ?? {})) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const candidate = value as Record<string, unknown>;
    if ((name === "blob_ref" || typeof candidate.blob_id === "string") && "mime_type" in candidate) {
      found.push(candidate.mime_type);
    }
  }
  return found;
}

/**
 * Fetches `fixture.blobId` with `token` and verifies it against the fixture's
 * headers and bytes, exactly as RS-1/get-blob-bytes does. Negative blob cases
 * call this first: without proving the issued token actually reads the
 * fixture blob, a server that denies every request would pass the negative
 * assertion by refusing everything, not by enforcing the grant boundary.
 */
async function verifyAuthorizedBlobFetch(
  adapter: TargetAdapter,
  path: (suffix: string) => string,
  fixture: BlobFixture,
  token: string
): Promise<CaseVerdict> {
  const response = await requestBytes(adapter.baseUrl, path(`/blobs/${encodeURIComponent(fixture.blobId)}`), {
    token,
  });

  if (response.status === 302) {
    return verifyBlobRedirect(response.evidence, response.headers);
  }
  if (response.status !== 200) {
    return fail(`Expected 200 (or a 302 to a signed URL) reading the fixture blob itself, got ${response.status}.`, [
      response.evidence,
    ]);
  }
  const headerFailure = verifyDirectBlobHeaders(response.evidence, response.headers, response.body, fixture.mimeType);
  if (headerFailure) {
    return headerFailure;
  }
  return verifyBlobBytes(response.evidence, response.body, fixture);
}

/** Owner-token stream metadata, the shape RS-14 and RS-15 both read. */
interface StreamMetadataBody {
  query?: Record<string, unknown>;
  relationships?: unknown[];
  schema?: { properties?: Record<string, { items?: { type?: unknown }; type?: unknown }>; required?: unknown };
  views?: unknown[];
}

/** Prefer the protocol name; tolerate the bundled fixture's legacy id field. */
function relationIdentifier(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const { id, name } = entry as Record<string, unknown>;
  if (typeof name === "string") {
    return name;
  }
  return typeof id === "string" ? id : undefined;
}

/**
 * Relation names this owner-token metadata read structurally declares
 * (`relationships`) and names it declares expandable (`query.expand`),
 * derived from the ACTUAL HTTP response body, never from a fixture's
 * retained expectation. Fails on malformed metadata (present but not an
 * array of identifiable entries) rather than silently treating it as empty,
 * since an empty result must mean "declares nothing", not "could not read".
 */
export function declaredRelationNames(
  input: unknown
): { declared: ReadonlySet<string>; expandable: ReadonlySet<string> } | { malformed: string } {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (input as Record<string, unknown>).object !== "stream_metadata"
  ) {
    return { malformed: "Expected a stream_metadata object." };
  }
  const body = input as StreamMetadataBody;
  if (body.query !== undefined && (!body.query || typeof body.query !== "object" || Array.isArray(body.query))) {
    return { malformed: "`query` is present but not an object." };
  }
  const { relationships } = body;
  if (relationships !== undefined && !Array.isArray(relationships)) {
    return { malformed: "`relationships` is present but not an array." };
  }
  const declared = new Set<string>();
  for (const entry of relationships ?? []) {
    const id = relationIdentifier(entry);
    if (id === undefined) {
      return { malformed: "`relationships` contains an entry with no string `id` or `name`." };
    }
    declared.add(id);
  }

  const expand = body.query?.expand;
  if (expand !== undefined && !Array.isArray(expand)) {
    return { malformed: "`query.expand` is present but not an array." };
  }
  const expandable = new Set<string>();
  for (const entry of expand ?? []) {
    const id = relationIdentifier(entry);
    if (id === undefined) {
      return { malformed: "`query.expand` contains an entry with no string `id` or `name`." };
    }
    expandable.add(id);
  }

  return { declared, expandable };
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

/**
 * Judges a foreign owner token's 200: only a record the seeded subject alone
 * owns is a disclosure. See the RS-12 case for why a bare 200 is not one.
 */
async function judgeForeignRecords(
  adapter: TargetAdapter,
  streamName: string,
  seeded: PdppResponse,
  response: PdppResponse,
  seededRecords: NonNullable<ListBody["data"]>
): Promise<CaseVerdict> {
  const returned = asList(response.json)?.data ?? [];
  const ownIdList = await adapter.foreignSubjectRecordIds?.(streamName);
  const seededIds = new Map(seededRecords.map((r) => [r.id, r]));
  const sameAsSeeded = returned.filter((r) => {
    const mine = seededIds.get(r.id);
    return mine !== undefined && isDeepStrictEqual(mine.data, r.data);
  });
  const evidence = [seeded.evidence, response.evidence];
  // Nothing the seeded subject owns came back: the foreign subject's own (valid)
  // store, or an empty one.
  if (sameAsSeeded.length === 0) {
    return pass(evidence);
  }
  // Absent hook and a null answer both mean "unknown" (the hook's documented
  // contract), never "the foreign store is empty".
  if (!ownIdList) {
    return skip(
      "The foreign owner token was served records identical to the seeded subject's, but the adapter cannot say what the foreign subject's own store holds, so a disclosure cannot be told from two identically seeded stores."
    );
  }
  const ownIds = new Set(ownIdList);
  const disclosed = sameAsSeeded.filter((r) => !ownIds.has(r.id ?? ""));
  return disclosed.length > 0
    ? fail(
        `Cross-subject leak: an owner token scoped to another subject returned ${disclosed.length} record(s) that belong only to the seeded subject's store. Section 9 item 12 requires owner access to be scoped to a single subject's data store.`,
        evidence
      )
    : pass(evidence);
}

/**
 * Shared body of the two excluded-reference blob cases: the fixture names a
 * blob and a grant that must be refused it although the same grant can fetch
 * `fixture.blobId`.
 */
async function excludedReferenceCase(
  { adapter, path }: CaseContext,
  key: "projectionExcluded" | "windowExcluded"
): Promise<CaseVerdict> {
  if (!adapter.blobFixture) {
    return skip(
      "The adapter implements no blobFixture hook, so RS-1's blob-authorization boundary has no known blob to check."
    );
  }
  const fixture = await adapter.blobFixture();
  if (!fixture) {
    return skip("The target reported no seeded blob to check RS-1's blob-authorization boundary against.");
  }
  const excluded = fixture[key];
  if (!excluded) {
    return skip(
      `The adapter's blobFixture supplied no ${key}, so there is no blob whose reference the grant excludes.`
    );
  }
  const grant = await adapter.issueGrant(excluded.grantRequest);
  if (!grant) {
    return skip("The target could not issue the grant the excluded-reference blob case needs.");
  }
  const positive = await arrange("positive-control blob fetch", () =>
    verifyAuthorizedBlobFetch(adapter, path, fixture, grant.accessToken)
  );
  if (positive.outcome !== "pass") {
    return positive;
  }
  const response = await requestBytes(adapter.baseUrl, path(`/blobs/${encodeURIComponent(excluded.blobId)}`), {
    token: grant.accessToken,
  });
  const evidence = [...(positive.evidence ?? []), response.evidence];
  if (response.status === 200 || response.status === 302) {
    return fail(
      `Overbroad access: a grant that can fetch blob "${fixture.blobId}" was served blob "${excluded.blobId}", which no record the grant may read references through its ${key === "projectionExcluded" ? "field projection" : "time window"}. Got ${response.status}.`,
      evidence
    );
  }
  if (response.status !== 403 && response.status !== 404) {
    return fail(
      `Expected 403 or 404 for a blob the grant's ${key === "projectionExcluded" ? "projection" : "window"} excludes, got ${response.status}.`,
      evidence
    );
  }
  return pass(evidence);
}

/**
 * A string field and one of its values held by some but not all of `records`,
 * so an exact filter on it must return a proper, non-empty subset.
 */
function pickDiscriminatingFilter(
  records: NonNullable<ListBody["data"]>
): { readonly field: string; readonly value: string } | undefined {
  const first = records[0]?.data;
  if (!first || records.length < 2) {
    return undefined;
  }
  for (const [field, value] of Object.entries(first)) {
    if (typeof value !== "string") {
      continue;
    }
    const matches = records.filter((r) => r.data?.[field] === value).length;
    if (matches > 0 && matches < records.length) {
      return { field, value };
    }
  }
  return undefined;
}

/** Whether two id lists hold the same members, ignoring order. */
function sameMembers(a: readonly (string | undefined)[], b: readonly (string | undefined)[]): boolean {
  return a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
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
        return skip(
          "The adapter implements no blobFixture hook, so RS-1's blob-fetch endpoint has no known blob to check."
        );
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

      // Section 8 permits either a direct 200 or a 302 to a short-lived signed
      // URL. The suite has no way to fetch through a signed URL or know its
      // expiry, so a 302 can only be checked for the headers Section 8
      // requires on the redirect itself, never for byte fidelity — SKIP rather
      // than fail or claim a full pass either side of that gap.
      if (response.status === 302) {
        return verifyBlobRedirect(response.evidence, response.headers);
      }

      if (response.status !== 200) {
        return fail(`Expected 200 (or a 302 to a signed URL) from the blob-fetch endpoint, got ${response.status}.`, [
          response.evidence,
        ]);
      }

      const headerFailure = verifyDirectBlobHeaders(
        response.evidence,
        response.headers,
        response.body,
        fixture.mimeType
      );
      if (headerFailure) {
        return headerFailure;
      }

      return verifyBlobBytes(response.evidence, response.body, fixture);
    },
  },

  // Clause 8.12-2: a direct response MUST include `Accept-Ranges: bytes` "if
  // range requests are supported". Whether a target supports them is itself
  // observable: it answers a `Range` request with 206. A target that ignores
  // `Range` (200) owes nothing here; one that honours it must say so.
  {
    caseId: "RS-1/blob-range-support-is-advertised",
    requirementId: "RS-1",
    assertion:
      "A blob endpoint that answers a Range request with 206 advertises Accept-Ranges: bytes on its direct response.",
    async run({ adapter, path }) {
      if (!adapter.blobFixture) {
        return skip(
          "The adapter implements no blobFixture hook, so RS-1's blob-fetch endpoint has no known blob to check."
        );
      }
      const fixture = await adapter.blobFixture();
      if (!fixture) {
        return skip("The target reported no seeded blob to check RS-1's blob-fetch endpoint against.");
      }
      const grant = await adapter.issueGrant(fixture.grantRequest);
      if (!grant) {
        return skip("The target could not issue the grant needed to read the blob's referencing record.");
      }
      const blobPath = path(`/blobs/${encodeURIComponent(fixture.blobId)}`);
      const full = await arrange("direct blob fetch", () =>
        requestBytes(adapter.baseUrl, blobPath, { token: grant.accessToken })
      );
      if (full.status !== 200) {
        return skip(
          `The blob endpoint answered ${full.status} rather than a direct 200, so there is no direct response to check for Accept-Ranges.`
        );
      }
      const ranged = await requestBytes(adapter.baseUrl, blobPath, {
        token: grant.accessToken,
        headers: { Range: "bytes=0-3" },
      });
      if (ranged.status !== 206) {
        return unsupported(
          `The target answered a Range request with ${ranged.status} rather than 206, so it does not support range requests and the Accept-Ranges obligation does not arise.`
        );
      }
      const evidence = [full.evidence, ranged.evidence];
      if (ranged.body.length !== 4) {
        return fail(`A Range request for bytes=0-3 returned a 206 with ${ranged.body.length} bytes, not 4.`, evidence);
      }
      if (
        !(full.headers.get("accept-ranges") ?? "")
          .toLowerCase()
          .split(",")
          .map((v) => v.trim())
          .includes("bytes")
      ) {
        return fail(
          `The blob endpoint honoured a Range request (206) but its direct response carries Accept-Ranges "${full.headers.get("accept-ranges") ?? ""}". Section 8: a direct response MUST include Accept-Ranges: bytes if range requests are supported.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // Clause 4.8-1: "`mime_type` MUST be a valid IANA media type", stated where
  // Core defines the record's `data.blob_ref`. It binds what a record carries,
  // so the observation is a served record, not a declaration. A target with no
  // blob fixture, or whose fixture records carry no `blob_ref.mime_type`, is
  // `skip`: the suite does not invent a blob_ref to judge.
  {
    caseId: "RS-1/blob-ref-mime-type-valid",
    requirementId: "RS-1",
    assertion: "Every blob_ref.mime_type on the records served for the blob fixture's grant is a valid media type.",
    async run({ adapter, path }) {
      if (!adapter.blobFixture) {
        return skip(
          "The adapter implements no blobFixture hook, so there is no record known to carry a blob_ref to check."
        );
      }
      const fixture = await adapter.blobFixture();
      if (!fixture) {
        return skip("The target reported no seeded blob, so no record is known to carry a blob_ref.");
      }
      const grant = await adapter.issueGrant(fixture.grantRequest);
      if (!grant) {
        return skip("The target could not issue the grant needed to read the blob's referencing record.");
      }
      const observed: { readonly stream: string; readonly mimeType: unknown }[] = [];
      const evidence: Evidence[] = [];
      for (const stream of fixture.grantRequest.streams) {
        // biome-ignore lint/performance/noAwaitInLoops: one read per granted stream, in order, so evidence stays attributable.
        const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`), {
          token: grant.accessToken,
        });
        if (response.status !== 200) {
          return skip(
            `Reading the blob fixture's records returned ${response.status}, so no blob_ref could be observed.`
          );
        }
        evidence.push(response.evidence);
        for (const record of asList(response.json)?.data ?? []) {
          for (const mimeType of blobRefMimeTypes(record.data)) {
            observed.push({ stream: stream.name, mimeType });
          }
        }
      }
      if (observed.length === 0) {
        return skip(
          "No record served for the blob fixture's grant carried a blob_ref.mime_type, so clause 4.8-1 was not observed."
        );
      }
      const invalid = observed.filter((o) => typeof o.mimeType !== "string" || !isValidMediaType(o.mimeType));
      if (invalid.length > 0) {
        return fail(
          `Records carry a blob_ref.mime_type that is not a valid IANA media type: ${invalid
            .map((o) => `${JSON.stringify(o.mimeType)} (stream ${o.stream})`)
            .join(", ")}. Core Section 4: "\`mime_type\` MUST be a valid IANA media type".`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // The redirect-only half of Section 8 "Get a blob", split out of
  // get-blob-bytes so a direct 200 can never supply evidence for a clause that
  // binds only a 302. A target that serves blobs directly makes this case
  // `unsupported`, not `pass`.
  {
    caseId: "RS-1/blob-redirect-response-valid",
    requirementId: "RS-1",
    assertion:
      "When the blob-fetch endpoint answers with a 302, the response carries a Location header and Cache-Control: no-store. A direct response is not applicable.",
    async run({ adapter, path }) {
      if (!adapter.blobFixture) {
        return skip(
          "The adapter implements no blobFixture hook, so RS-1's blob-fetch endpoint has no known blob to check."
        );
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
      if (response.status === 200) {
        return unsupported(
          "The target served the blob directly (200), so the redirect-only obligations of Section 8 do not apply; RS-1/get-blob-bytes covers the direct response."
        );
      }
      if (response.status !== 302) {
        return skip(
          `The blob-fetch endpoint answered ${response.status}, neither a direct response nor a redirect, so there is no redirect to check; RS-1/get-blob-bytes reports the unexpected status.`
        );
      }
      return redirectHeaderFailure(response.evidence, response.headers) ?? pass([response.evidence]);
    },
  },

  // Section 8 "Get a blob" bullet 4: "A `blob_id` alone does not grant
  // access. The client MUST have discovered the blob through an authorized
  // record." Proves the issued token actually works against `fixture.blobId`
  // before trusting its denial on a second id — otherwise a deny-everything
  // server would pass by refusing both. Needs `outOfGrantBlobId`, a real
  // persisted blob the grant does not reference: a 404 on a fabricated id
  // can't distinguish enforcement from a target that 404s every id.
  {
    caseId: "RS-1/blob-outside-grant-refused",
    requirementId: "RS-1",
    assertion:
      "A grant that can read one blob's referencing record is still refused a second, real blob id no record in the grant references (Section 8: 'a blob_id alone does not grant access').",
    async run({ adapter, path }) {
      if (!adapter.blobFixture) {
        return skip(
          "The adapter implements no blobFixture hook, so RS-1's blob-authorization boundary has no known blob to check."
        );
      }
      const fixture = await adapter.blobFixture();
      if (!fixture) {
        return skip("The target reported no seeded blob to check RS-1's blob-authorization boundary against.");
      }
      if (!fixture.outOfGrantBlobId) {
        return skip(
          "The adapter's blobFixture supplied no outOfGrantBlobId, so there is no second, real blob known to exist outside the grant to prove the boundary against."
        );
      }
      const grant = await adapter.issueGrant(fixture.grantRequest);
      if (!grant) {
        return skip("The target could not issue the grant needed to read the fixture blob's referencing record.");
      }

      const positive = await verifyAuthorizedBlobFetch(adapter, path, fixture, grant.accessToken);
      if (positive.outcome !== "pass") {
        return positive;
      }
      const positiveEvidence = positive.evidence ?? [];

      const response = await requestBytes(
        adapter.baseUrl,
        path(`/blobs/${encodeURIComponent(fixture.outOfGrantBlobId)}`),
        { token: grant.accessToken }
      );

      if (response.status === 200 || response.status === 302) {
        return fail(
          `Overbroad access: a grant scoped to blob "${fixture.blobId}"'s referencing record was served blob "${fixture.outOfGrantBlobId}", which no record in that grant references. Got ${response.status}.`,
          [...positiveEvidence, response.evidence]
        );
      }
      if (response.status !== 403 && response.status !== 404) {
        return fail(
          `Expected 403 or 404 for a real blob id outside the grant, got ${response.status}. Section 8 binds an unknown or stale blob_id to 404 blob_not_found; a permission failure has no more specific code.`,
          [...positiveEvidence, response.evidence]
        );
      }
      return pass([...positiveEvidence, response.evidence]);
    },
  },

  // Section 8 "Get a blob", conditions 2 and 3 for a client token: the
  // referencing record must pass the grant's filters, and the field holding the
  // `blob_ref` must be in the grant's field projection. The out-of-grant case
  // above covers condition 1 (a stream the grant lists); a target that checks
  // only that can still serve a blob through a record the grant cannot see or a
  // field it cannot read. Each case first proves the SAME token fetches
  // `fixture.blobId`, so a deny-everything server cannot pass.
  {
    caseId: "RS-1/blob-referenced-outside-projection-refused",
    requirementId: "RS-1",
    assertion:
      "A grant whose projection excludes the field holding a blob's only reference is refused that blob, while the same token still fetches the fixture blob (Section 8 'Get a blob': the blob_ref field is in the grant's authorized field projection).",
    run: (context) => excludedReferenceCase(context, "projectionExcluded"),
  },
  {
    caseId: "RS-1/blob-referencing-record-outside-window-refused",
    requirementId: "RS-1",
    assertion:
      "A grant whose time window excludes a blob's only referencing record is refused that blob, while the same token still fetches the fixture blob (Section 8 'Get a blob': the referencing record passes all grant filters).",
    run: (context) => excludedReferenceCase(context, "windowExcluded"),
  },

  // Section 8: client operations use `Authorization: Bearer <access_token>` —
  // the blob endpoint is not exempt from the authentication boundary RS-16
  // already checks for record reads. Proves the SAME token reads the SAME
  // blob successfully before trusting its absence is what triggers the
  // refusal, so a deny-everything server cannot pass by luck.
  {
    caseId: "RS-1/blob-unauthenticated-refused",
    requirementId: "RS-1",
    assertion: "A blob fetch with no access token is refused rather than served, mirroring RS-16 for record reads.",
    async run({ adapter, path }) {
      if (!adapter.blobFixture) {
        return skip(
          "The adapter implements no blobFixture hook, so RS-1's blob-authorization boundary has no known blob to check."
        );
      }
      const fixture = await adapter.blobFixture();
      if (!fixture) {
        return skip("The target reported no seeded blob to check RS-1's blob-authorization boundary against.");
      }
      const grant = await adapter.issueGrant(fixture.grantRequest);
      if (!grant) {
        return skip("The target could not issue the grant needed to read the fixture blob's referencing record.");
      }

      const positive = await verifyAuthorizedBlobFetch(adapter, path, fixture, grant.accessToken);
      if (positive.outcome !== "pass") {
        return positive;
      }
      const positiveEvidence = positive.evidence ?? [];

      const response = await requestBytes(adapter.baseUrl, path(`/blobs/${encodeURIComponent(fixture.blobId)}`));

      if (response.status === 200 || response.status === 302) {
        return fail(
          `Unauthorized access: blob "${fixture.blobId}" was served to a request carrying no access token. Got ${response.status}.`,
          [...positiveEvidence, response.evidence]
        );
      }
      if (response.status !== 401) {
        return fail(`Expected 401 for a blob fetch carrying no token, got ${response.status}.`, [
          ...positiveEvidence,
          response.evidence,
        ]);
      }
      return pass([...positiveEvidence, response.evidence]);
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
      const granted = await resolvedFieldAllowlist(adapter, grant, stream.name);
      if (!granted) {
        return skip(
          "The resolved field allowlist is not observable (no grant body and no introspection route), so records cannot be judged against what the AS froze."
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
      // Populated control. An empty list or a body that is not a Section 8
      // envelope shows no projection at all, so it cannot pass.
      const body = asList(response.json);
      if (body?.object !== "list" || !Array.isArray(body.data)) {
        return fail("The read under a field-narrowed grant did not return a well-formed Section 8 list envelope.", [
          response.evidence,
        ]);
      }
      const populated = body.data.filter((record) => record.data && Object.keys(record.data).length > 0);
      if (populated.length === 0) {
        return skip(
          "The read under a field-narrowed grant returned no record with data, so projection enforcement was not observed."
        );
      }
      // Every returned field must be in the resolved allowlist, including
      // fields the seeded schema never declared.
      const leaked = new Set<string>();
      for (const record of populated) {
        for (const field of Object.keys(record.data ?? {})) {
          if (!granted.includes(field)) {
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
      // Nothing leaked, but if the AS resolved every declared field there was
      // nothing to withhold either, so no projection was observed.
      if (stream.fields.every((f) => granted.includes(f))) {
        return skip(
          `The authorization server resolved the narrowed request to every declared field (${granted.join(", ")}), so no declared field was withheld and projection enforcement is not observable on this stream.`
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

  // ----------------------------------------------------------------- 8.2-3 ---
  // Token kind extensibility. Core Section 8: "This specification defines
  // `owner` and `client`. Deployments MAY introduce additional token kinds in
  // companion profiles. A resource server that receives a `pdpp_token_kind`
  // value it does not recognize MUST treat the token as unauthorized for ALL
  // operations defined in this specification."
  //
  // Distinct from RS-4/token-kind-not-inferred-from-syntax above, and the
  // distinction is the point. That case sends a string the target never issued,
  // which a conforming server rejects at authentication. This one sends a
  // GENUINE, grant-bound token whose introspection result names a kind the
  // server does not know — it authenticates perfectly, and the only question is
  // what the server does next. A server passing that case can still fail this
  // one, because the two failures live in different branches.
  //
  // Every Core operation is probed, not just the records read: the clause says
  // "all operations", and a server gating only its records route would still
  // serve stream listings and metadata to a token it admits it cannot classify.
  {
    caseId: "RS-4/unrecognized-token-kind-is-unauthorized",
    requirementId: "RS-4",
    assertion:
      "A genuine grant-bound token whose introspection reports an unrecognized pdpp_token_kind is unauthorized for every Section 8 operation, while an ordinary client token still reads.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      if (!adapter.tokenWithIntrospectedKind) {
        return skip(
          "The adapter has no tokenWithIntrospectedKind hook, so no token can be made to introspect as an unrecognized kind. The suite will not forge a token instead: Section 8 makes token format opaque to the RS, so a fabricated string is a token of NO kind — rejected at authentication for a different reason — and the case would pass against a server that never implemented this rule."
        );
      }
      const grantRequest = { streams: [{ name: stream.name, fields: [...stream.fields] }] };

      // The positive control: an ordinary client token on the same surface.
      // Without it, a server that refuses everything satisfies the negative.
      const ordinary = await adapter.issueGrant(grantRequest);
      if (!ordinary) {
        return skip("The target issued no ordinary grant, so there is no positive control for this surface.");
      }
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
      const control = await request(adapter.baseUrl, recordsPath, { token: ordinary.accessToken });
      if (control.status !== 200) {
        return skip(
          `The positive control read with an ordinary client token returned ${control.status}, so a refusal of an unrecognized-kind token could not be attributed to its kind.`
        );
      }

      // A kind Core does not define and no companion profile plausibly claims.
      const probe = await adapter.tokenWithIntrospectedKind("pdpp-conformance-unknown-kind", grantRequest);
      if (!probe) {
        return skip(
          "The target minted no token reporting an unrecognized kind, so clause 8.2-3 has nothing to act on."
        );
      }

      // "All operations defined in this specification" — the Section 8 surface,
      // not the records route alone.
      const operations = [
        { label: "list streams", suffix: "/streams" },
        { label: "stream metadata", suffix: `/streams/${encodeURIComponent(stream.name)}` },
        { label: "list records", suffix: `/streams/${encodeURIComponent(stream.name)}/records` },
      ];
      const evidence: Evidence[] = [control.evidence];
      const served: string[] = [];
      for (const operation of operations) {
        // biome-ignore lint/performance/noAwaitInLoops: each probe is a separate authorization decision against shared target state.
        const response = await request(adapter.baseUrl, path(operation.suffix), { token: probe.accessToken });
        evidence.push(response.evidence);
        if (response.status < 400) {
          served.push(`${operation.label} (${response.status})`);
        }
      }
      if (served.length > 0) {
        return fail(
          `A token whose introspection reports the unrecognized kind 'pdpp-conformance-unknown-kind' was served: ${served.join(", ")}. Core Section 8 "Token kind extensibility": an RS receiving a \`pdpp_token_kind\` it does not recognize MUST treat the token as unauthorized for all operations defined in this specification. Serving it means applying the rules of a kind this token is not, to permissions this specification never defined.`,
          evidence
        );
      }
      return pass(evidence);
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

  // Section 8's client-token parameter table, the `view` row (clause 8.9-3):
  // "Client-token records requests MUST reject `view`; clients use explicit
  // `fields` or the field projection already frozen into the grant."
  //
  // Distinct from the filter and expand rows above, and the distinction is the
  // point. A view is a NAMED projection resolved against CURRENT serving
  // metadata, while a client grant froze its field set at issuance. A server
  // that honours `view` on a client token therefore serves whatever that view
  // means today — which may be wider than the field list the owner approved,
  // and grows silently every time the view definition gains a field. That is
  // the same widening Section 5 forbids at issuance, arriving through the query
  // surface instead.
  //
  // The positive control is the identical request with `view` removed: without
  // it, a server that refuses every client-token read passes the refusal
  // assertion while being unusable.
  {
    caseId: "RS-9/client-token-view-rejected",
    requirementId: "RS-9",
    assertion:
      "A client-token view parameter is rejected with 400 invalid_request, while the same read without it succeeds.",
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
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);

      const response = await request(adapter.baseUrl, recordsPath, {
        token: grant.accessToken,
        query: { view: "pdpp_conformance_any_view" },
      });
      if (response.status === 200) {
        return fail(
          "A client-token request carrying `view` was served instead of rejected. Section 8's parameter table makes `view` an owner-token current-capability request and requires client-token records requests to reject it: a view resolves against current serving metadata, so honouring one serves whatever the view means now rather than the field projection frozen into the grant at issuance.",
          [response.evidence]
        );
      }
      if (response.status !== 400) {
        return fail(`Expected 400 for a client-token view parameter, got ${response.status}.`, [response.evidence]);
      }
      const error = errorBody(response);
      if (error?.code !== "invalid_request") {
        return fail(`Expected error code invalid_request, got ${error?.code ?? "no structured error"}.`, [
          response.evidence,
        ]);
      }

      // Positive control: the same read without `view` must succeed, so a
      // blanket refusal of client-token reads cannot masquerade as enforcement.
      const control = await request(adapter.baseUrl, recordsPath, { token: grant.accessToken });
      if (control.status !== 200) {
        return skip(
          `The control read without \`view\` was also refused (${control.status}), so this run cannot distinguish rejection of the parameter from a target that refuses every client-token read.`
        );
      }
      return pass([response.evidence, control.evidence]);
    },
  },

  // The second half of clause 8.9-3: `view` is "Mutually exclusive with
  // `fields`". Owner-token `view` is optional ("MAY support ... `view`"), so a
  // target that answers a bare `view` with 400 is `unsupported`; one that serves
  // it must refuse the request that also names `fields`, because "unsupported
  // query shapes MUST be rejected with HTTP 400 and MUST NOT be silently
  // ignored" -- serving one of the two quietly drops the other. Each parameter
  // alone is the positive control.
  {
    caseId: "RS-9/owner-view-and-fields-are-mutually-exclusive",
    requirementId: "RS-9",
    appliesWhen: (adapter) => adapter.capabilities.ownerTokens && adapter.capabilities.views,
    assertion:
      "An owner-token read naming both view and fields is rejected with 400, while each parameter alone is served.",
    async run({ adapter, streams, path }) {
      const owner = await adapter.ownerToken();
      const view = (await adapter.declaredViews?.())?.find((v) => streams.some((s) => s.name === v.stream));
      if (!(owner && view)) {
        return skip("The adapter exposes no owner token or no declared view to request.");
      }
      const [field] = view.fields;
      if (field === undefined) {
        return skip(`The declared view '${view.view}' lists no field to name beside it.`);
      }
      const recordsPath = path(`/streams/${encodeURIComponent(view.stream)}/records`);
      const ownerQuery = adapter.ownerReadParams ? { ...adapter.ownerReadParams } : {};
      const viewOnly = await request(adapter.baseUrl, recordsPath, {
        token: owner,
        query: { ...ownerQuery, view: view.view },
      });
      if (viewOnly.status === 400) {
        return unsupported(
          `The target rejects an owner-token view (${view.view}) with 400. Owner views are optional in v0.1, so their exclusivity with fields does not apply.`
        );
      }
      const fieldsOnly = await request(adapter.baseUrl, recordsPath, {
        token: owner,
        query: { ...ownerQuery, fields: field },
      });
      if (viewOnly.status !== 200 || fieldsOnly.status !== 200) {
        return skip(
          `Each parameter alone should be served (view ${viewOnly.status}, fields ${fieldsOnly.status}), so a refusal of the pair cannot be attributed to their combination.`
        );
      }
      const both = await request(adapter.baseUrl, recordsPath, {
        token: owner,
        query: { ...ownerQuery, view: view.view, fields: field },
      });
      const evidence = [viewOnly.evidence, fieldsOnly.evidence, both.evidence];
      if (both.status === 200) {
        return fail(
          "An owner-token read naming both `view` and `fields` was served. Section 8: `view` is mutually exclusive with `fields`, and an unsupported query shape MUST be rejected with 400 rather than silently ignoring one of the two.",
          evidence
        );
      }
      if (both.status !== 400) {
        return fail(`Expected 400 for an owner-token read naming both view and fields, got ${both.status}.`, evidence);
      }
      return pass(evidence);
    },
  },

  // Clause 8.9-9, the half the exact-filter case above leaves open: the
  // rejection "applies regardless of whether the field or operator would
  // otherwise be declared". A server that consults serving metadata first
  // answers an undeclared field or operator with a different error (the code an
  // owner read would get), so each shape must still be 400 invalid_request.
  {
    caseId: "RS-9/client-token-filter-rejected-whether-or-not-declared",
    requirementId: "RS-9",
    assertion:
      "A client-token filter naming an undeclared field, an undeclared operator, or a range operator is rejected with 400 invalid_request, as a declared exact filter is.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      const field = stream?.fields[0];
      if (!(stream && field)) {
        return skip("A seeded stream with at least one field is required.");
      }
      const grant = await adapter.issueGrant({ streams: [{ name: stream.name, fields: [...stream.fields] }] });
      if (!grant) {
        return skip("The target could not issue a grant for a seeded stream.");
      }
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
      const control = await request(adapter.baseUrl, recordsPath, { token: grant.accessToken });
      if (control.status !== 200) {
        return skip(
          `The control read without a filter was refused (${control.status}), so a rejection cannot be told from a target that refuses every client-token read.`
        );
      }
      const absent = stream.fields.includes("pdpp_conformance_absent_field")
        ? "pdpp_conformance_absent_field_"
        : "pdpp_conformance_absent_field";
      const shapes: [string, string][] = [
        ["a field the stream does not declare", `filter[${absent}]`],
        ["an operator no declaration defines", `filter[${field}][pdpp_conformance_operator]`],
        ["a range operator", `filter[${field}][gte]`],
      ];
      const evidence = [control.evidence];
      for (const [label, key] of shapes) {
        // biome-ignore lint/performance/noAwaitInLoops: three short probes against one target, reported in order.
        const response = await request(adapter.baseUrl, recordsPath, {
          token: grant.accessToken,
          query: { [key]: "any-value" },
        });
        evidence.push(response.evidence);
        const code = errorBody(response)?.code;
        if (response.status !== 400 || code !== "invalid_request") {
          return fail(
            `A client-token request with ${label} (${key}) returned ${response.status}${code ? ` ${code}` : ""}, not 400 invalid_request. Section 8 requires the rejection regardless of whether the field or operator would otherwise be declared, before serving metadata is consulted.`,
            evidence
          );
        }
      }
      return pass(evidence);
    },
  },

  // Section 8 clause 8.9-5, the `expand_limit[{relation}]` row: "Client-token
  // requests MUST reject this parameter in v0.1."
  //
  // A separate row from `expand[]` (covered above) and a separate case, because
  // a server can reject the one and accept the other: `expand[]` names what to
  // expand, `expand_limit[...]` only bounds how much. Section 8 states the
  // reason they are both out of the client surface — "a v0.1 resolved grant
  // does not freeze relationship identity, target stream, foreign-key join
  // semantics, cardinality, or expansion limits", so current relationship
  // metadata cannot interpret client grant rights at all. A server that accepts
  // a limit while rejecting the selector is reading a parameter it has no
  // frozen basis to honour.
  {
    caseId: "RS-9/client-token-expand-limit-rejected",
    requirementId: "RS-9",
    assertion:
      "A client-token expand_limit[...] parameter is rejected with 400 invalid_request, while the same read without it succeeds.",
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
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);

      const response = await request(adapter.baseUrl, recordsPath, {
        token: grant.accessToken,
        query: { "expand_limit[pdpp_conformance_relation]": "5" },
      });
      if (response.status === 200) {
        return fail(
          "A client-token request carrying expand_limit[...] was served instead of rejected. Section 8 requires client-token requests containing `expand[]` or `expand_limit[...]` to be rejected with 400 invalid_request before the RS consults current metadata, because a v0.1 resolved grant freezes no expansion limits for that metadata to be read against.",
          [response.evidence]
        );
      }
      if (response.status !== 400) {
        return fail(`Expected 400 for a client-token expand_limit[...] parameter, got ${response.status}.`, [
          response.evidence,
        ]);
      }
      const error = errorBody(response);
      if (error?.code !== "invalid_request") {
        return fail(`Expected error code invalid_request, got ${error?.code ?? "no structured error"}.`, [
          response.evidence,
        ]);
      }

      const control = await request(adapter.baseUrl, recordsPath, { token: grant.accessToken });
      if (control.status !== 200) {
        return skip(
          `The control read without expand_limit[...] was also refused (${control.status}), so this run cannot distinguish rejection of the parameter from a target that refuses every client-token read.`
        );
      }
      return pass([response.evidence, control.evidence]);
    },
  },

  // Depth on RS-10 (unknown parameters / unsupported query shapes): an
  // owner-token filter[...] naming a field absent from the target's own
  // metadata document must also 400, not be silently ignored.
  {
    caseId: "RS-10/owner-filter-unknown-field-rejected",
    requirementId: "RS-10",
    appliesWhen: (adapter) => adapter.capabilities.ownerTokens,
    assertion:
      "An owner-token filter[...] on a field absent from the target's own declared schema is rejected with 400.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream || stream.recordCount < 1) {
        return skip("A seeded stream with at least one record is required.");
      }
      const owner = await adapter.ownerToken();
      if (!owner) {
        return skip("The target declares owner tokens but the adapter produced none.");
      }
      const ownerQuery = adapter.ownerReadParams ? { ...adapter.ownerReadParams } : {};

      const metadata = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}`), {
        token: owner,
        query: { ...ownerQuery },
      });
      if (metadata.status !== 200) {
        return fail(`An owner token could not read stream metadata for "${stream.name}": got ${metadata.status}.`, [
          metadata.evidence,
        ]);
      }
      const declaredFields = declaredSchemaFields(metadata.json);
      if (!declaredFields) {
        return fail("Owner metadata did not expose a usable schema for choosing an absent filter field.", [
          metadata.evidence,
        ]);
      }

      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
      const control = await request(adapter.baseUrl, recordsPath, { token: owner, query: { ...ownerQuery } });
      if (control.status !== 200) {
        return fail(
          `An unfiltered owner-token read returned ${control.status}, so this run cannot distinguish filter rejection from a target that refuses this read entirely.`,
          [control.evidence]
        );
      }
      const controlRecords = asList(control.json)?.data ?? [];
      if (controlRecords.length === 0) {
        return fail(
          "The unfiltered owner-token read returned no records for an available owner token, so the seeded stream is not observably populated.",
          [control.evidence]
        );
      }

      let absentField = "pdpp_conformance_absent_field__c7e2f9a1";
      while (declaredFields.includes(absentField)) {
        absentField = `${absentField}_`;
      }

      const exactFiltered = await request(adapter.baseUrl, recordsPath, {
        token: owner,
        query: { ...ownerQuery, [`filter[${absentField}]`]: "any-value" },
      });
      if (exactFiltered.status === 200) {
        return fail(
          `An owner-token filter[${absentField}] on a field absent from the declared schema was served (200) instead of rejected. Section 8 requires 400 invalid_request or unknown_field for an unknown filter field.`,
          [control.evidence, exactFiltered.evidence]
        );
      }
      if (exactFiltered.status !== 400) {
        return fail(`Expected 400 for an owner-token filter on an unknown field, got ${exactFiltered.status}.`, [
          exactFiltered.evidence,
        ]);
      }
      const exactError = errorBody(exactFiltered);
      if (exactError?.code !== "invalid_request" && exactError?.code !== "unknown_field") {
        return fail(
          `Expected error code invalid_request or unknown_field, got ${exactError?.code ?? "no structured error"}.`,
          [exactFiltered.evidence]
        );
      }

      const rangeFiltered = await request(adapter.baseUrl, recordsPath, {
        token: owner,
        query: { ...ownerQuery, [`filter[${absentField}][gte]`]: "0" },
      });
      if (rangeFiltered.status === 200) {
        return fail(
          `An owner-token filter[${absentField}][gte] on a field absent from the declared schema was served (200) instead of rejected.`,
          [control.evidence, rangeFiltered.evidence]
        );
      }
      if (rangeFiltered.status !== 400) {
        return fail(`Expected 400 for an owner-token range filter on an unknown field, got ${rangeFiltered.status}.`, [
          rangeFiltered.evidence,
        ]);
      }
      const rangeError = errorBody(rangeFiltered);
      if (rangeError?.code !== "invalid_request" && rangeError?.code !== "unknown_field") {
        return fail(
          `Expected error code invalid_request or unknown_field, got ${rangeError?.code ?? "no structured error"}.`,
          [rangeFiltered.evidence]
        );
      }

      return pass([control.evidence, exactFiltered.evidence, rangeFiltered.evidence]);
    },
  },

  // Section 8 "Grant enforcement" / clause 8.1-1a: for an owner-token read "the
  // effective filter is the permitted owner request filter alone ... Request
  // filters can only narrow the current owner read and cannot widen it." Owner
  // exact filters are optional (a target may answer them 400 invalid_request),
  // so a target that rejects a filter on a declared field is `unsupported`.
  //
  // The expected result is computed from the same owner's UNFILTERED read: the
  // filtered records must be exactly the matching members of it, and a filter
  // that matches nothing must return nothing -- a server that falls back to the
  // unfiltered read when the filter is empty has widened the result to the
  // whole owner scope.
  {
    caseId: "RS-5/owner-filter-narrows-and-never-widens",
    requirementId: "RS-5",
    appliesWhen: (adapter) => adapter.capabilities.ownerTokens,
    assertion:
      "An owner-token exact filter on a declared field returns exactly the matching records of the unfiltered owner read, and a filter that matches nothing returns nothing.",
    async run({ adapter, streams, path }) {
      const owner = await adapter.ownerToken();
      if (!owner) {
        return skip("The target declares owner tokens but the adapter produced none.");
      }
      const stream = streams.find((s) => s.recordCount >= 2);
      if (!stream) {
        return skip("No seeded stream has two records, so a filter cannot be shown to narrow.");
      }
      const ownerQuery = { ...(adapter.ownerReadParams ?? {}), limit: "100" };
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
      const control = await request(adapter.baseUrl, recordsPath, { token: owner, query: ownerQuery });
      const records = asList(control.json)?.data;
      if (control.status !== 200 || !records || asList(control.json)?.has_more) {
        return skip(
          "The unfiltered owner read was not a single served page, so the expected filter result is unknown."
        );
      }
      const choice = pickDiscriminatingFilter(records);
      if (!choice) {
        return skip("No string field separates the stream's records, so a filter cannot be shown to narrow.");
      }
      const expected = records.filter((r) => r.data?.[choice.field] === choice.value).map((r) => r.id);
      const filterKey = `filter[${choice.field}]`;
      const filtered = await request(adapter.baseUrl, recordsPath, {
        token: owner,
        query: { ...ownerQuery, [filterKey]: choice.value },
      });
      if (filtered.status === 400) {
        return unsupported(
          `The target rejects an owner exact filter on declared field "${choice.field}" (400). Owner filters are optional in v0.1 ("MAY accept exact filters"), so the narrowing property does not apply.`
        );
      }
      const got = (asList(filtered.json)?.data ?? []).map((r) => r.id);
      if (filtered.status !== 200 || !sameMembers(got, expected)) {
        return fail(
          `${filterKey}=${choice.value} returned ${filtered.status} with records [${got.join(", ")}], not exactly the matching members [${expected.join(", ")}] of the same owner's unfiltered read. Section 8: request filters can only narrow the current owner read.`,
          [control.evidence, filtered.evidence]
        );
      }
      // A value no record holds: the result must be empty, not the unfiltered scope.
      let absent = "pdpp_conformance_absent_value";
      while (records.some((r) => r.data?.[choice.field] === absent)) {
        absent = `${absent}_`;
      }
      const empty = await request(adapter.baseUrl, recordsPath, {
        token: owner,
        query: { ...ownerQuery, [filterKey]: absent },
      });
      const emptyIds = (asList(empty.json)?.data ?? []).map((r) => r.id);
      if (empty.status !== 200 || emptyIds.length > 0) {
        return fail(
          `${filterKey}=${absent} matches no record, yet the read returned ${empty.status} with [${emptyIds.join(", ")}]. A filter that matches nothing must narrow the owner read to nothing, not widen it to the unfiltered scope.`,
          [control.evidence, empty.evidence]
        );
      }
      return pass([control.evidence, filtered.evidence, empty.evidence]);
    },
  },

  // Prove each token can read before checking unsupported query rejection.
  {
    caseId: "RS-10/unsupported-bracketed-shape-rejected",
    requirementId: "RS-10",
    assertion:
      "limit[x], an unsupported bracketed shape of a known parameter, is rejected with 400 on both client-token and owner-token reads, each proved live by a populated positive read first.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream || stream.recordCount < 1) {
        return skip("A seeded stream with at least one record is required.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
      });
      if (!grant) {
        return skip("The target could not issue a grant for a seeded stream.");
      }
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);

      const clientPositive = await verifyPositiveRecordsRead(adapter, recordsPath, grant.accessToken);
      if (clientPositive.outcome !== "pass") {
        return clientPositive;
      }
      const evidence = [...(clientPositive.evidence ?? [])];

      const clientResponse = await request(adapter.baseUrl, recordsPath, {
        token: grant.accessToken,
        query: { "limit[x]": "5" },
      });
      evidence.push(clientResponse.evidence);
      if (clientResponse.status === 200) {
        return fail(
          "A client-token request with limit[x] (an unsupported bracketed shape of the known 'limit' parameter) was served (200) instead of rejected. Section 8 requires unsupported query shapes to be rejected with 400, not silently ignored.",
          evidence
        );
      }
      if (clientResponse.status !== 400) {
        return fail(`Expected 400 for a client-token limit[x], got ${clientResponse.status}.`, evidence);
      }

      if (!adapter.capabilities.ownerTokens) {
        return pass(evidence);
      }

      // The capability is advertised, so owner coverage is required, not
      // optional: an owner token that fails to materialize is incomplete
      // evidence, not grounds to pass on the client leg alone.
      const owner = await adapter.ownerToken();
      if (!owner) {
        return skip(
          "The target declares owner tokens but the adapter produced none, so owner-token coverage of this requirement is incomplete. The client-token leg passed: see evidence."
        );
      }
      const ownerQuery = adapter.ownerReadParams ? { ...adapter.ownerReadParams } : {};

      const ownerPositive = await verifyPositiveRecordsRead(adapter, recordsPath, owner, ownerQuery);
      if (ownerPositive.outcome !== "pass") {
        return ownerPositive;
      }
      evidence.push(...(ownerPositive.evidence ?? []));

      const ownerResponse = await request(adapter.baseUrl, recordsPath, {
        token: owner,
        query: { ...ownerQuery, "limit[x]": "5" },
      });
      evidence.push(ownerResponse.evidence);
      if (ownerResponse.status === 200) {
        return fail(
          "An owner-token request with limit[x] was served (200) instead of rejected. Section 8 binds the unsupported-shape rejection to both token kinds.",
          evidence
        );
      }
      if (ownerResponse.status !== 400) {
        return fail(`Expected 400 for an owner-token limit[x], got ${ownerResponse.status}.`, evidence);
      }

      return pass(evidence);
    },
  },

  // Choose an undeclared relation from metadata returned by this target.
  {
    caseId: "RS-10/owner-expand-undeclared-relation-rejected",
    requirementId: "RS-10",
    appliesWhen: (adapter) => adapter.capabilities.ownerTokens,
    assertion:
      "An owner-token expand[] naming a relation absent from the target's ACTUAL returned metadata (relationships and query.expand) is rejected with 400 invalid_expand.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream || stream.recordCount < 1) {
        return skip("A seeded stream with at least one record is required.");
      }
      const owner = await adapter.ownerToken();
      if (!owner) {
        return skip("The target declares owner tokens but the adapter produced none.");
      }
      const ownerQuery = adapter.ownerReadParams ? { ...adapter.ownerReadParams } : {};
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
      const metadataPath = path(`/streams/${encodeURIComponent(stream.name)}`);

      const positive = await verifyPositiveRecordsRead(adapter, recordsPath, owner, ownerQuery);
      if (positive.outcome !== "pass") {
        return positive;
      }
      const evidence = [...(positive.evidence ?? [])];

      const metadataResponse = await request(adapter.baseUrl, metadataPath, { token: owner, query: { ...ownerQuery } });
      evidence.push(metadataResponse.evidence);
      if (metadataResponse.status !== 200) {
        return fail(
          `An owner token could not read stream metadata for "${stream.name}": got ${metadataResponse.status}.`,
          evidence
        );
      }
      const relations = declaredRelationNames(metadataResponse.json as StreamMetadataBody | undefined);
      if ("malformed" in relations) {
        return fail(`Owner-token stream metadata is malformed: ${relations.malformed}`, evidence);
      }

      let undeclaredRelation = "pdpp_conformance_undeclared_relation__c7e2f9a1";
      while (relations.declared.has(undeclaredRelation) || relations.expandable.has(undeclaredRelation)) {
        undeclaredRelation = `${undeclaredRelation}_`;
      }

      const expanded = await request(adapter.baseUrl, recordsPath, {
        token: owner,
        query: { ...ownerQuery, "expand[]": undeclaredRelation },
      });
      evidence.push(expanded.evidence);
      if (expanded.status === 200) {
        return fail(
          `An owner-token expand[]=${undeclaredRelation} naming a relation absent from the target's returned metadata was served (200) instead of rejected. Section 8 makes structural presence under 'relationships' distinct from expandability under 'query.expand'; a relation this stream's own metadata never declared cannot be expanded.`,
          evidence
        );
      }
      if (expanded.status !== 400) {
        return fail(
          `Expected 400 for an owner-token expand[] naming an undeclared relation, got ${expanded.status}.`,
          evidence
        );
      }
      const expandError = errorBody(expanded);
      if (expandError?.code !== "invalid_expand") {
        return fail(`Expected error code invalid_expand, got ${expandError?.code ?? "no structured error"}.`, evidence);
      }

      return pass(evidence);
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

  // ---------------------------------------------------------------- 7.4-2 ---
  // The OTHER version axis. Core Section 7 "Version layering" names three and
  // says they "MUST NOT be conflated": `grant.version` is the grant schema,
  // `PDPP-Version` is the HTTP API contract, and `source_declaration.version`
  // is opaque evidence metadata. The case above covers the header axis; this
  // one covers the grant axis, which no case could reach until the adapter
  // could mint a grant at an arbitrary schema version.
  //
  // The distinction has teeth. A server that validates only the header will
  // pass the case above and then enforce a grant written against a schema it
  // has never seen — reading the fields it recognizes, ignoring the ones it
  // does not, and calling the result an authorization decision. Any constraint
  // expressed in the part it skipped is simply not applied.
  {
    caseId: "RS-11/unsupported-grant-schema-version-rejected",
    requirementId: "RS-11",
    assertion:
      "A token bound to a grant whose schema major version is unsupported is rejected with 400 unsupported_version, while a grant at the supported version still reads.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const supportedVersion = adapter.supportedGrantSchemaVersion;
      if (!(adapter.grantWithSchemaVersion && supportedVersion)) {
        return skip(
          "The adapter has no grantWithSchemaVersion hook and supportedGrantSchemaVersion, so no token can be bound to a grant at a chosen schema version and the grant-schema axis is unobservable. The suite will not forge a grant body: the obligation is on the RS's handling of a grant its own AS issued, and a suite-authored artifact would test the suite's idea of the grant schema."
        );
      }
      const grantRequest = { streams: [{ name: stream.name, fields: [...stream.fields] }] };
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
      // Derived from the target's OWN supported version rather than fixed:
      // Core pins no value for `grant.version`, so a hardcoded constant would
      // test this suite's assumption and would call a conforming target at any
      // other version broken. Prefixing the major keeps every other component
      // well-formed, so the only thing wrong with the result is the major.
      const unsupportedVersion = `${Number(supportedVersion.split(".")[0] ?? 0) + 9000}.0`;

      // The positive control FIRST, and it is not optional: a target that
      // refuses every token this hook produces would satisfy the negative below
      // while being unable to serve anything. Minted through the same hook, so
      // the only difference between the two tokens is the schema version.
      const supported = await adapter.grantWithSchemaVersion(supportedVersion, grantRequest);
      if (!supported) {
        return skip(
          `The target minted no grant at its own declared supported schema version '${supportedVersion}', so there is no positive control and a refusal of the unsupported version could not be attributed to the version.`
        );
      }
      const control = await request(adapter.baseUrl, recordsPath, { token: supported.accessToken });
      if (control.status !== 200) {
        return skip(
          `The positive control read returned ${control.status}: this target does not serve a grant minted at schema version '${supportedVersion}' at all, so a refusal of an unsupported version proves nothing about version checking.`
        );
      }

      const unsupported_ = await adapter.grantWithSchemaVersion(unsupportedVersion, grantRequest);
      if (!unsupported_) {
        return skip(
          `The target declined to mint a grant at schema version '${unsupportedVersion}'. Refusing to ISSUE such a grant is not the obligation clause 7.4-2 states, which is on the RS refusing to ENFORCE one, so this is recorded as missing evidence rather than as compliance.`
        );
      }
      const response = await request(adapter.baseUrl, recordsPath, { token: unsupported_.accessToken });
      const evidence = [control.evidence, response.evidence];

      if (response.status === 200) {
        return fail(
          `A token bound to a grant at schema version '${unsupportedVersion}' was honoured and served records, while '${supportedVersion}' is what this target declares it supports. Core Section 7 "Version layering": the RS MUST reject grants with unsupported major versions, returning 400 unsupported_version. Enforcing a grant written against an unknown schema means applying the parts the server happens to recognize and silently ignoring the rest, including any constraint the owner relied on.`,
          evidence
        );
      }
      if (response.status !== 400) {
        return fail(
          `A grant at unsupported schema version '${unsupportedVersion}' was refused with ${response.status} rather than 400. Core names 400 unsupported_version for this axis specifically; a 401 or 403 tells the client its credential or permissions are at fault and invites a retry that can never succeed.`,
          evidence
        );
      }
      const error = errorBody(response);
      if (error?.code !== "unsupported_version") {
        return fail(
          `The grant was refused with 400 but classified as "${error?.code ?? "no structured error"}" rather than unsupported_version.`,
          evidence
        );
      }
      return pass(evidence);
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
      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);
      const readParams = adapter.ownerReadParams ? { query: { ...adapter.ownerReadParams } } : {};

      // Control: what the SEEDED subject's own owner token reads. An owner
      // token selects a subject's store, so a foreign token reading a stream of
      // the same name reads its own records; only a record the seeded subject
      // owns, appearing under the foreign token, is a disclosure.
      const ownerToken = await adapter.ownerToken();
      if (!ownerToken) {
        return skip("The adapter returned no seeded-subject owner token to establish what the seeded store holds.");
      }
      const seeded = await request(adapter.baseUrl, recordsPath, { token: ownerToken, ...readParams });
      const seededRecords = seeded.status === 200 ? (asList(seeded.json)?.data ?? []) : [];
      if (seededRecords.length === 0) {
        return skip(
          `The seeded subject's own owner read returned ${seeded.status === 200 ? "no records" : seeded.status}, so there is no record whose disclosure could be detected.`
        );
      }

      const response = await request(adapter.baseUrl, recordsPath, { token: foreign, ...readParams });
      if (response.status === 200) {
        return await judgeForeignRecords(adapter, stream.name, seeded, response, seededRecords);
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
  // ------------------------------------------------------------- 8.14-1 ---
  // The absent-header half of the clause: "If the `PDPP-Version` header is
  // absent, the RS uses the current stable version and returns the selected
  // version in the `PDPP-Version` response header." A client that sends no
  // header can learn which contract it is talking to only from this.
  {
    caseId: "RS-11/absent-version-header-reports-the-selected-version",
    requirementId: "RS-11",
    assertion: "A request with no PDPP-Version header is served and the response carries a PDPP-Version header.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const grant = await adapter.issueGrant({ streams: [{ name: stream.name, fields: [...stream.fields] }] });
      if (!grant) {
        return skip("The target could not issue a grant for a seeded stream.");
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`), {
        token: grant.accessToken,
      });
      if (response.status !== 200) {
        return skip(
          `The control read without a PDPP-Version header returned ${response.status}, so the response header cannot be judged.`
        );
      }
      const selected = response.headers.get("pdpp-version");
      if (selected === null || selected.trim() === "") {
        return fail(
          "A request that sent no PDPP-Version header was served with no PDPP-Version response header. Core Section 8: when the header is absent the RS uses the current stable version and returns the selected version in the PDPP-Version response header, which is the only way such a client learns the contract it is talking to.",
          [response.evidence]
        );
      }
      return pass([response.evidence]);
    },
  },
];
