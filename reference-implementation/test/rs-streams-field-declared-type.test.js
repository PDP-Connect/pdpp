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

import assert from 'node:assert/strict';
import test from 'node:test';

import { startServer } from '../server/index.js';

const CONNECTOR_ID = 'streams-field-declared-type';
const STREAM = 'transactions';

const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';

// A manifest whose `transactions` stream declares a presentation `type` through
// both accepted carriers: `amount_cents` uses the JSON Schema extension
// `x_pdpp_type`, while `posted_at` and `merchant` use the sandbox-shaped
// `fields[]` declarations. Other fields (`memo`, `id`) deliberately omit
// a declared presentation type. `amount_cents` and `count_minor` share an
// identical JSON-schema/range/lexical declaration; only `amount_cents` declares
// `x_pdpp_type`. That pairing lets us assert the declared type changes nothing
// but the `type` key.
const baseManifest = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Declared-Type Test Connector',
  capabilities: { human_interaction: [] },
  streams: [
    {
      name: STREAM,
      primary_key: ['id'],
      cursor_field: 'posted_at',
      consent_time_field: 'posted_at',
      schema: {
        type: 'object',
        required: ['id', 'amount_cents', 'posted_at'],
        properties: {
          id: { type: 'string' },
          // Declares a presentation type AND participates in exact + range +
          // lexical so we can prove the type rides alongside unchanged flags.
          amount_cents: { type: 'integer', x_pdpp_type: 'currency' },
          // Same shape as amount_cents but WITHOUT a declared type — the
          // capability-flag control field.
          count_minor: { type: 'integer' },
          posted_at: { type: 'string', format: 'date-time' },
          merchant: { type: 'string' },
          // No declared type.
          memo: { type: 'string' },
        },
      },
      fields: [
        {
          name: 'posted_at',
          type: 'timestamp',
          semantic_class: 'common',
          description: 'When the transaction posted.',
        },
        {
          name: 'merchant',
          type: 'string',
          semantic_class: 'identifying',
          description: 'Merchant display name.',
        },
      ],
      query: {
        // Both integer fields declare identical range operators; merchant +
        // memo both participate in lexical/semantic identically. The only
        // integer pair differs only by `x_pdpp_type`; text pair differs only
        // by the `fields[]` declaration.
        range_filters: {
          amount_cents: ['gte', 'lte'],
          count_minor: ['gte', 'lte'],
          posted_at: ['gte', 'lte'],
        },
        search: {
          lexical_fields: ['merchant', 'memo'],
          semantic_fields: ['merchant', 'memo'],
        },
      },
      selection: { fields: { mode: 'explicit' } },
    },
  ],
};

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: resp.status, body };
}

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function issueOwnerToken(asUrl, subjectId = 'owner_local') {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  });
  return tokenBody.access_token;
}

async function approveGrant(asUrl, subjectId, params) {
  const { body: initiate } = await fetchJson(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: params.client_id,
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          source: params.source || { kind: 'connector', id: params.connector_id },
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          access_mode: params.access_mode,
          streams: params.streams,
        },
      ],
    }),
  });
  if (!initiate?.request_uri) {
    throw new Error(`startGrantRequest returned no request_uri: ${JSON.stringify(initiate)}`);
  }
  const { body: approved } = await fetchJson(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: subjectId }),
  });
  return approved;
}

async function withHttpHarness(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseManifest),
    });
    assert.equal(registerResp.status, 201, 'register connector');
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

async function readStreamMetadata(rsUrl, token) {
  const { status, body } = await fetchJson(
    `${rsUrl}/v1/streams/${encodeURIComponent(STREAM)}?connector_id=${encodeURIComponent(CONNECTOR_ID)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(status, 200, `GET /v1/streams/${STREAM} should be 200`);
  assert.equal(body.object, 'stream_metadata');
  assert.ok(body.field_capabilities, 'field_capabilities present');
  return body.field_capabilities;
}

// ─── Declared type surfaces ────────────────────────────────────────────────

test('declared field types surface from x_pdpp_type and sandbox-shaped fields[]', async () => {
  await withHttpHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const fc = await readStreamMetadata(rsUrl, ownerToken);

    assert.equal(fc.amount_cents.type, 'currency');
    assert.equal(fc.posted_at.type, 'timestamp');
    assert.equal(fc.merchant.type, 'string');
  });
});

// ─── Undeclared fields omit the type key entirely ───────────────────────────

test('fields without a declared type omit the type key (no null, no invention)', async () => {
  await withHttpHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const fc = await readStreamMetadata(rsUrl, ownerToken);

    for (const field of ['id', 'count_minor', 'memo']) {
      assert.equal(
        Object.hasOwn(fc[field], 'type'),
        false,
        `field '${field}' must omit 'type' when the manifest does not declare it`,
      );
    }
  });
});

// ─── Declared type is purely additive: it changes no capability flag ─────────

test('declared type does not alter exact/range/lexical/semantic/grant flags', async () => {
  await withHttpHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const fc = await readStreamMetadata(rsUrl, ownerToken);

    // amount_cents (declared currency) and count_minor (no declared type)
    // share an identical manifest declaration apart from `x_pdpp_type`. The
    // only differences the declared type introduces are (1) the additive
    // `type` capability key and (2) the `x_pdpp_type` key echoed inside the
    // raw `schema` (which is the declaration's verbatim source of truth, an
    // `additionalProperties: true` object). Every CAPABILITY FLAG —
    // exact_filter, range_filter, lexical/semantic, aggregation, granted —
    // must be byte-identical. Compare with `type` and `schema` removed.
    const declared = { ...fc.amount_cents };
    assert.equal(declared.type, 'currency');
    delete declared.type;
    delete declared.schema;
    const undeclared = { ...fc.count_minor };
    delete undeclared.schema;
    assert.deepEqual(
      declared,
      undeclared,
      'declared-type field must carry byte-identical capability flags to its undeclared twin',
    );
    // The schema echo differs ONLY by the x_pdpp_type extension key — every
    // other JSON-schema property is identical.
    assert.deepEqual(fc.amount_cents.schema, { type: 'integer', x_pdpp_type: 'currency' });
    assert.deepEqual(fc.count_minor.schema, { type: 'integer' });

    // Spot-check the individual flags on the declared field stand on their own
    // (the type rode alongside real, unchanged capabilities — not a stub).
    assert.equal(fc.amount_cents.granted, true);
    assert.equal(fc.amount_cents.exact_filter.declared, true);
    assert.equal(fc.amount_cents.exact_filter.usable, true);
    assert.equal(fc.amount_cents.range_filter.declared, true);
    assert.deepEqual(fc.amount_cents.range_filter.operators, ['gte', 'lte']);

    // merchant (declared through sandbox-shaped fields[]) vs memo
    // (undeclared) — identical lexical + semantic participation; only the
    // additive capability `type` differs.
    const merchant = { ...fc.merchant };
    assert.equal(merchant.type, 'string');
    delete merchant.type;
    delete merchant.schema;
    const memo = { ...fc.memo };
    delete memo.schema;
    assert.deepEqual(
      merchant,
      memo,
      'declared-type lexical/semantic field must match its undeclared twin',
    );
    assert.deepEqual(fc.merchant.schema, { type: 'string' });
    assert.deepEqual(fc.memo.schema, { type: 'string' });
    assert.equal(fc.merchant.lexical_search.declared, true);
    assert.equal(fc.merchant.semantic_search.declared, true);
  });
});

// ─── Grant projection: declared type does not affect grant usability ─────────

test('declared type does not alter grant usability under a client token', async () => {
  await withHttpHarness(async ({ asUrl, rsUrl }) => {
    // Grant only the declared-type field `amount_cents` (plus the primary key
    // and cursor field). The declared `type` must not influence which fields
    // the grant marks granted/usable.
    const approved = await approveGrant(asUrl, 'owner_local', {
      client_id: 'longview',
      source: { kind: 'connector', id: CONNECTOR_ID },
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'declared-type grant-usability test',
      access_mode: 'continuous',
      streams: [{ name: STREAM, fields: ['id', 'amount_cents', 'posted_at'] }],
    });
    assert.ok(approved.token, 'expected client token');

    const fc = await readStreamMetadata(rsUrl, approved.token);

    // amount_cents is granted: type present AND granted true.
    assert.equal(fc.amount_cents.type, 'currency');
    assert.equal(fc.amount_cents.granted, true);

    // merchant declares a type but is NOT in the grant: the declared type does
    // not rescue grant usability — granted is false, just like undeclared
    // ungranted fields.
    if (fc.merchant) {
      assert.equal(fc.merchant.type, 'string');
      assert.equal(fc.merchant.granted, false);
      assert.equal(fc.merchant.exact_filter.usable, false);
    }
  });
});
