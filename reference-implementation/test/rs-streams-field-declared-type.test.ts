// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /v1/streams/:stream` declared presentation `type` on field_capabilities.
 *
 * Section 1 of `openspec/changes/complete-explorer-slvp-ideal/tasks.md`.
 *
 * The reference allows each stream-manifest field to carry an optional
 * presentation type either as a JSON Schema extension
 * (`schema.properties[field].x_pdpp_type`) or as a sandbox-shaped `fields[]`
 * declaration (`{ name, type, semantic_class }`). The
 * reference surfaces it read-only as `field_capabilities[field].type`. This
 * suite proves the contract end-to-end over the live HTTP
 * `GET /v1/streams/:stream` path:
 *
 *   - both declaration carriers surface `field_capabilities[field].type`;
 *   - a field whose manifest schema omits it surfaces no `type` key at all
 *     (the absence is honest — never `null`, never invented);
 *   - the declared `type` does NOT alter exact-filter, range-filter,
 *     lexical/semantic participation, or grant usability for that field: a
 *     declared-type field and an otherwise-identical undeclared field carry
 *     byte-identical capability flags apart from the `type` key.
 *
 * The harness mirrors `schema-granted-connections.test.js`: register a
 * manifest via the AS, mint an owner token, read the live RS surface.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

const CONNECTOR_KEY = "codex";
const CONNECTOR_ID = `https://registry.pdpp.dev/connectors/${CONNECTOR_KEY}`;
const STREAM = "transactions";

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";

// A manifest whose `transactions` stream declares a presentation `type` through
// both accepted carriers: `amount_cents` uses the JSON Schema extension
// `x_pdpp_type`, while `posted_at` and `merchant` use the sandbox-shaped
// `fields[]` declarations. Other fields (`memo`, `id`) deliberately omit
// a declared presentation type. `amount_cents` and `count_minor` share an
// identical JSON-schema/range/lexical declaration; only `amount_cents` declares
// `x_pdpp_type`. That pairing lets us assert the declared type changes nothing
// but the `type` key.
const baseManifest = {
  capabilities: { human_interaction: [] },
  connector_id: CONNECTOR_ID,
  display_name: "Declared-Type Test Connector",
  protocol_version: "0.1.0",
  streams: [
    {
      consent_time_field: "posted_at",
      cursor_field: "posted_at",
      fields: [
        {
          description: "When the transaction posted.",
          name: "posted_at",
          semantic_class: "common",
          type: "timestamp",
        },
        {
          description: "Merchant display name.",
          name: "merchant",
          semantic_class: "identifying",
          type: "string",
        },
      ],
      name: STREAM,
      primary_key: ["id"],
      query: {
        // Both integer fields declare identical range operators; merchant +
        // memo both participate in lexical/semantic identically. The only
        // integer pair differs only by `x_pdpp_type`; text pair differs only
        // by the `fields[]` declaration.
        range_filters: {
          amount_cents: ["gte", "lte"],
          count_minor: ["gte", "lte"],
          posted_at: ["gte", "lte"],
        },
        search: {
          lexical_fields: ["merchant", "memo"],
          semantic_fields: ["merchant", "memo"],
        },
      },
      schema: {
        properties: {
          // Declares a presentation type AND participates in exact + range +
          // lexical so we can prove the type rides alongside unchanged flags.
          amount_cents: { type: "integer", x_pdpp_type: "currency" },
          // Same shape as amount_cents but WITHOUT a declared type — the
          // capability-flag control field.
          count_minor: { type: "integer" },
          id: { type: "string" },
          // No declared type.
          memo: { type: "string" },
          merchant: { type: "string" },
          posted_at: { format: "date-time", type: "string" },
        },
        required: ["id", "amount_cents", "posted_at"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

// Established pattern, see rs-record-field-window-route.test.ts /
// connector-gap-severity.test.ts: closeAllConnections (Node 18.2+) and the
// single-error-arg close callback genuinely exist on the real http.Server
// instances startServer returns.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ body: unknown; status: number }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
}

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
}

interface DeviceTokenResponse {
  access_token: string;
}

interface GrantRequestInitiateResponse {
  request_uri: string;
}

interface ApprovedGrant {
  token?: string;
}

interface ApproveGrantParams {
  access_mode: string;
  client_id: string;
  connector_id?: string;
  purpose_code: string;
  purpose_description: string;
  source?: { id: string; kind: string };
  streams: unknown;
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(deviceBody, "expected a device_authorization response body");
  const device = deviceBody as DeviceAuthorizationResponse;
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenResponseBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(tokenResponseBody, "expected an oauth/token response body");
  const tokenBody = tokenResponseBody as DeviceTokenResponse;
  return tokenBody.access_token;
}

async function approveGrant(asUrl: string, subjectId: string, params: ApproveGrantParams): Promise<ApprovedGrant> {
  const { body: initiateBody } = await fetchJson(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: params.access_mode,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          source: params.source || { id: params.connector_id, kind: "connector" },
          streams: params.streams,
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: params.client_id,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const initiate = initiateBody as GrantRequestInitiateResponse | null;
  if (!initiate?.request_uri) {
    throw new Error(`startGrantRequest returned no request_uri: ${JSON.stringify(initiate)}`);
  }
  const review = await fetchJson(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: subjectId }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const reviewRevision = (review.body as Record<string, unknown>).approval_review_revision;
  assert.equal(typeof reviewRevision, "string", "consent review must return approval_review_revision");
  const { body: approvedBody } = await fetchJson(`${asUrl}/consent/approve`, {
    body: JSON.stringify({ approval_review_revision: reviewRevision, request_uri: initiate.request_uri }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  return approvedBody as ApprovedGrant;
}

async function withHttpHarness(fn: (urls: { asUrl: string; rsUrl: string }) => Promise<void>): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(baseManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201, "register connector");
    const connectorInstanceId = makeDefaultAccountConnectorInstanceId("owner_local", CONNECTOR_KEY);
    const now = new Date().toISOString();
    await createRequestConnectorInstanceStore().upsert({
      connectorId: CONNECTOR_KEY,
      connectorInstanceId,
      createdAt: now,
      displayName: "Declared-Type Test Account",
      ownerSubjectId: "owner_local",
      sourceBinding: { fixture: "rs-streams-field-declared-type" },
      sourceBindingKey: connectorInstanceId,
      sourceKind: "account",
      status: "active",
      updatedAt: now,
    });
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

interface FieldCapabilityFilter {
  declared: boolean;
  usable: boolean;
  [extra: string]: unknown;
}

interface FieldCapabilityRangeFilter extends FieldCapabilityFilter {
  operators?: string[];
}

interface FieldCapability {
  exact_filter?: FieldCapabilityFilter;
  granted?: boolean;
  lexical_search?: FieldCapabilityFilter;
  range_filter?: FieldCapabilityRangeFilter;
  schema?: unknown;
  semantic_search?: FieldCapabilityFilter;
  type?: string;
  [extra: string]: unknown;
}

async function readStreamMetadata(rsUrl: string, token: string): Promise<Record<string, FieldCapability>> {
  const { status, body } = await fetchJson(
    `${rsUrl}/v1/streams/${encodeURIComponent(STREAM)}?connector_id=${encodeURIComponent(CONNECTOR_KEY)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  assert.equal(status, 200, `GET /v1/streams/${STREAM} should be 200`);
  assert.ok(body, "expected a stream_metadata response body");
  const metadata = body as { object: string; field_capabilities?: Record<string, FieldCapability> };
  assert.equal(metadata.object, "stream_metadata");
  assert.ok(metadata.field_capabilities, "field_capabilities present");
  return metadata.field_capabilities;
}

// ─── Declared type surfaces ────────────────────────────────────────────────

test("declared field types surface from x_pdpp_type and sandbox-shaped fields[]", async () => {
  await withHttpHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const fc = await readStreamMetadata(rsUrl, ownerToken);

    assert.ok(fc.amount_cents, "amount_cents field_capabilities present");
    assert.ok(fc.posted_at, "posted_at field_capabilities present");
    assert.ok(fc.merchant, "merchant field_capabilities present");
    assert.equal(fc.amount_cents.type, "currency");
    assert.equal(fc.posted_at.type, "timestamp");
    assert.equal(fc.merchant.type, "string");
  });
});

// ─── Undeclared fields omit the type key entirely ───────────────────────────

test("fields without a declared type omit the type key (no null, no invention)", async () => {
  await withHttpHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const fc = await readStreamMetadata(rsUrl, ownerToken);

    for (const field of ["id", "count_minor", "memo"]) {
      const capability = fc[field];
      assert.ok(capability, `${field} field_capabilities present`);
      assert.equal(
        Object.hasOwn(capability, "type"),
        false,
        `field '${field}' must omit 'type' when the manifest does not declare it`
      );
    }
  });
});

// ─── Declared type is purely additive: it changes no capability flag ─────────

test("declared type does not alter exact/range/lexical/semantic/grant flags", async () => {
  await withHttpHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const fc = await readStreamMetadata(rsUrl, ownerToken);
    assert.ok(fc.amount_cents, "amount_cents field_capabilities present");
    assert.ok(fc.count_minor, "count_minor field_capabilities present");
    assert.ok(fc.merchant, "merchant field_capabilities present");
    assert.ok(fc.memo, "memo field_capabilities present");
    const amountCents = fc.amount_cents;
    const countMinor = fc.count_minor;
    const merchantField = fc.merchant;
    const memoField = fc.memo;

    // amount_cents (declared currency) and count_minor (no declared type)
    // share an identical manifest declaration apart from `x_pdpp_type`. The
    // only differences the declared type introduces are (1) the additive
    // `type` capability key and (2) the `x_pdpp_type` key echoed inside the
    // raw `schema` (which is the declaration's verbatim source of truth, an
    // `additionalProperties: true` object). Every CAPABILITY FLAG —
    // exact_filter, range_filter, lexical/semantic, aggregation, granted —
    // must be byte-identical. Compare with `type` and `schema` removed.
    assert.equal(amountCents.type, "currency");
    const { schema: _declaredSchema, type: _declaredType, ...declared } = amountCents;
    const { schema: _undeclaredSchema, ...undeclared } = countMinor;
    assert.deepEqual(
      declared,
      undeclared,
      "declared-type field must carry byte-identical capability flags to its undeclared twin"
    );
    // The schema echo differs ONLY by the x_pdpp_type extension key — every
    // other JSON-schema property is identical.
    assert.deepEqual(amountCents.schema, { type: "integer", x_pdpp_type: "currency" });
    assert.deepEqual(countMinor.schema, { type: "integer" });

    // Spot-check the individual flags on the declared field stand on their own
    // (the type rode alongside real, unchanged capabilities — not a stub).
    assert.equal(amountCents.granted, true);
    assert.ok(amountCents.exact_filter, "amount_cents exact_filter present");
    assert.equal(amountCents.exact_filter.declared, true);
    assert.equal(amountCents.exact_filter.usable, true);
    assert.ok(amountCents.range_filter, "amount_cents range_filter present");
    assert.equal(amountCents.range_filter.declared, true);
    assert.deepEqual(amountCents.range_filter.operators, ["gte", "lte"]);

    // merchant (declared through sandbox-shaped fields[]) vs memo
    // (undeclared) — identical lexical + semantic participation; only the
    // additive capability `type` differs.
    assert.equal(merchantField.type, "string");
    const { schema: _merchantSchema, type: _merchantType, ...merchant } = merchantField;
    const { schema: _memoSchema, ...memo } = memoField;
    assert.deepEqual(merchant, memo, "declared-type lexical/semantic field must match its undeclared twin");
    assert.deepEqual(merchantField.schema, { type: "string" });
    assert.deepEqual(memoField.schema, { type: "string" });
    assert.ok(merchantField.lexical_search, "merchant lexical_search present");
    assert.equal(merchantField.lexical_search.declared, true);
    assert.ok(merchantField.semantic_search, "merchant semantic_search present");
    assert.equal(merchantField.semantic_search.declared, true);
  });
});

// ─── Grant projection: declared type does not affect grant usability ─────────

test("declared type does not alter grant usability under a client token", async () => {
  await withHttpHarness(async ({ asUrl, rsUrl }) => {
    // Grant only the declared-type field `amount_cents` (plus the primary key
    // and cursor field). The declared `type` must not influence which fields
    // the grant marks granted/usable.
    const approved = await approveGrant(asUrl, "owner_local", {
      access_mode: "continuous",
      client_id: "longview",
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "declared-type grant-usability test",
      source: { id: CONNECTOR_ID, kind: "connector" },
      streams: [{ fields: ["id", "amount_cents", "posted_at"], name: STREAM }],
    });
    assert.ok(approved.token, "expected client token");

    const fc = await readStreamMetadata(rsUrl, approved.token);

    // The grant projection carries only field names. Current presentation
    // types are not authorization evidence and are therefore omitted.
    assert.ok(fc.amount_cents, "amount_cents field_capabilities present");
    assert.equal(fc.amount_cents.type, undefined);
    assert.equal(fc.amount_cents.granted, true);

    // merchant declares a type but is NOT in the grant: the declared type does
    // not rescue grant usability — granted is false, just like undeclared
    // ungranted fields.
    assert.equal(fc.merchant, undefined);
  });
});
