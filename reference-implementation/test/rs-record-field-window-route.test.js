/**
 * HTTP route coverage for the bounded field-window read:
 *   GET /v1/streams/:stream/records/:id/field-window
 *
 * This route is the HTTP surface of the MCP content-ladder substrate
 * (`getRecordFieldWindow`, proven dual-backend in
 * `record-field-window-substrate.test.js`). The substrate test proves the
 * in-process reader enforces grant scope and clamps the window; THIS test
 * proves the HTTP wiring around it: auth, scope/binding resolution, the window
 * envelope shape, default + explicit bounds, paging via `offset_chars`, and the
 * typed-error -> HTTP status mapping for a missing selector and an absent
 * field.
 *
 * It runs the owner-token read path (a real `startServer` boot), which drives
 * the exact same route handler as a scoped client token. The cross-connection
 * fan-in and the grant-withheld-field 403 are covered at the substrate layer;
 * here we assert the route faithfully exposes the substrate envelope.
 *
 * Spec: openspec/changes/add-mcp-content-ladder/specs/mcp-adapter/spec.md
 *       (#"MCP bounded field reads SHALL be served by a grant-enforced
 *        resource-server path")
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { ingestRecord } from '../server/records.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../server/owner-auth.ts';

const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';

// A body long enough to exceed one default 4096-char window, so paging is
// observable. The substrate default `limit_chars` is 4096.
const LONG_BODY = 'The quick brown fox jumps over the lazy dog. '.repeat(300).trim();

const CONNECTOR_ID = 'field_window_route_demo';
const CONNECTOR_INSTANCE_ID = 'cin_field_window_route_demo';
const STREAM = 'emails';

const MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Field Window Route Demo',
  streams: [
    {
      name: STREAM,
      primary_key: ['id'],
      cursor_field: 'created_at',
      consent_time_field: 'created_at',
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          subject: { type: 'string' },
          body: { type: 'string' },
          read_count: { type: 'integer' },
        },
      },
      selection: { fields: true },
    },
  ],
};

const SEED = [
  {
    id: 'e1',
    created_at: '2026-01-01T00:00:00.000Z',
    subject: 'Hello',
    body: LONG_BODY,
    read_count: 3,
  },
];

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: resp.status, body };
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

async function startGrantRequest(asUrl, params) {
  return fetchJson(`${asUrl}/oauth/par`, {
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
}

async function approveGrantRequest(asUrl, requestUri, subjectId = 'owner_local') {
  return fetchJson(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_uri: requestUri, subject_id: subjectId }),
  });
}

async function approveGrant(asUrl, subjectId, params) {
  const { body: initiate } = await startGrantRequest(asUrl, params);
  const { body: approved } = await approveGrantRequest(asUrl, initiate.request_uri, subjectId);
  return approved;
}

async function registerManifest(asUrl, manifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id}`);
}

async function seedStream(
  _rsUrl,
  _ownerToken,
  connectorId,
  stream,
  records,
  ownerSubjectId = OWNER_AUTH_DEFAULT_SUBJECT_ID,
) {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    ownerSubjectId,
    connectorId,
    displayName: 'Field Window Route Demo',
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey: 'field-window-route@example.test',
    sourceBinding: { account: 'field-window-route@example.test' },
    createdAt: now,
    updatedAt: now,
  });
  for (const record of records) {
    const outcome = await ingestRecord({
      connector_id: connectorId,
      connector_instance_id: CONNECTOR_INSTANCE_ID,
    }, {
      stream,
      key: record.id,
      data: record,
      emitted_at: record.created_at,
    });
    assert.equal(outcome.changed, true, `seed ${stream}/${record.id}`);
  }
}

async function withHarness(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
  });
  try {
    await fn({
      server,
      asUrl: `http://localhost:${server.asPort}`,
      rsUrl: `http://localhost:${server.rsPort}`,
    });
  } finally {
    await closeServer(server);
  }
}

function fieldWindowUrl(rsUrl, stream, recordId, params) {
  const search = new URLSearchParams({
    connector_id: CONNECTOR_ID,
    ...params,
  });
  return (
    `${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}/field-window`
    + `?${search.toString()}`
  );
}

test('field-window route returns a bounded default window and pages with offset_chars', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
  const ownerToken = await issueOwnerToken(asUrl);
  await registerManifest(asUrl, MANIFEST);
  await seedStream(rsUrl, ownerToken, CONNECTOR_ID, STREAM, SEED);

    const auth = { headers: { Authorization: `Bearer ${ownerToken}` } };

    // Default window: no bounds -> offset 0, default 4096-char limit. The body
    // is longer than that, so the window is incomplete and advertises a next
    // offset for paging.
    const first = await fetchJson(fieldWindowUrl(rsUrl, STREAM, 'e1', { field: 'body' }), auth);
    assert.equal(first.status, 200, 'default window read succeeds');
    assert.equal(first.body.object, 'field_window');
    assert.equal(first.body.stream, STREAM);
    assert.equal(first.body.record_id, 'e1');
    assert.equal(first.body.field.path, 'body');
    assert.equal(first.body.field.type, 'string');

    const w1 = first.body.window;
    assert.equal(w1.start_chars, 0, 'default window starts at 0');
    assert.equal(w1.limit_chars, 4096, 'default limit is 4096');
    assert.equal(w1.total_chars, LONG_BODY.length, 'total_chars is the full field length');
    assert.equal(w1.complete, false, 'a long field is not complete in one default window');
    assert.equal(w1.has_more, true, 'more remains after the first window');
    assert.equal(typeof w1.text, 'string');
    assert.equal(w1.text.length, 4096, 'first window is exactly the default limit');
    assert.equal(w1.text, LONG_BODY.slice(0, 4096), 'first window is the leading slice');
    assert.equal(w1.next_offset_chars, w1.end_chars, 'next offset continues from end of window');
    assert.equal(w1.previous_offset_chars, null, 'no previous window before offset 0');

    const needle = 'lazy dog';
    const matchStart = LONG_BODY.indexOf(needle);
    const qWindow = await fetchJson(
      fieldWindowUrl(rsUrl, STREAM, 'e1', {
        field: 'body',
        q: needle,
        before_chars: '5',
        after_chars: '7',
      }),
      auth
    );
    assert.equal(qWindow.status, 200, 'q context window read succeeds');
    assert.equal(qWindow.body.window.start_chars, matchStart - 5, 'q context starts before match');
    assert.equal(qWindow.body.window.match_start_chars, matchStart, 'q match start is reported');
    assert.equal(qWindow.body.window.match_end_chars, matchStart + needle.length, 'q match end is reported');
    assert.equal(
      qWindow.body.window.text,
      LONG_BODY.slice(matchStart - 5, matchStart + needle.length + 7),
      'q context window is the bounded match slice'
    );

    // Walk every adjacent window to the end via the advertised next offset.
    // The reassembled text must equal the full field exactly, each window must
    // be the contiguous next slice, and only the final window reports
    // `has_more=false` / `next_offset_chars=null`.
    let assembled = w1.text;
    let cursorOffset = w1.next_offset_chars;
    let guard = 0;
    while (cursorOffset !== null) {
      guard += 1;
      assert.ok(guard < 100, 'paging terminates');
      const page = await fetchJson(
        fieldWindowUrl(rsUrl, STREAM, 'e1', { field: 'body', offset_chars: String(cursorOffset) }),
        auth,
      );
      assert.equal(page.status, 200, 'each subsequent window read succeeds');
      const w = page.body.window;
      assert.equal(w.start_chars, cursorOffset, 'window starts where the previous ended');
      assert.equal(
        w.text,
        LONG_BODY.slice(w.start_chars, w.start_chars + w.text.length),
        'window is the contiguous next slice',
      );
      assert.ok(w.previous_offset_chars !== null, 'a non-first window points back');
      assembled += w.text;
      if (w.has_more) {
        assert.notEqual(w.next_offset_chars, null, 'an incomplete window advertises a next offset');
      } else {
        assert.equal(w.next_offset_chars, null, 'the final window has no next offset');
        assert.equal(w.end_chars, LONG_BODY.length, 'the final window reaches the end of the field');
      }
      cursorOffset = w.next_offset_chars;
    }

    assert.equal(assembled, LONG_BODY, 'paged windows reconstruct the full field exactly');
  });
});

test('field-window route enforces client grant field projections', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, 'field_window_grant_owner');
    await registerManifest(asUrl, MANIFEST);
    await seedStream(
      rsUrl,
      ownerToken,
      CONNECTOR_ID,
      STREAM,
      SEED,
      'field_window_grant_owner',
    );

    const approved = await approveGrant(asUrl, 'field_window_grant_owner', {
      client_id: 'longview',
      source: { kind: 'connector', id: CONNECTOR_ID },
      purpose_code: 'https://pdpp.org/purpose/analytics',
      purpose_description: 'field window grant test',
      access_mode: 'continuous',
      streams: [{ name: STREAM, fields: ['id', 'created_at', 'body'] }],
    });
    assert.ok(approved.token, `expected issued grant token, got ${JSON.stringify(approved)}`);
    const auth = { headers: { Authorization: `Bearer ${approved.token}` } };

    const allowed = await fetchJson(
      fieldWindowUrl(rsUrl, STREAM, 'e1', { field: 'body', limit_chars: '32' }),
      auth
    );
    assert.equal(allowed.status, 200, 'granted field can be read through the route');
    assert.equal(allowed.body.window.text, LONG_BODY.slice(0, 32));

    const denied = await fetchJson(fieldWindowUrl(rsUrl, STREAM, 'e1', { field: 'subject' }), auth);
    assert.equal(denied.status, 403, 'ungranted field is rejected through the route');
    assert.equal(denied.body.error.code, 'field_not_granted');
  });
});

test('field-window route honors an explicit small window', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerManifest(asUrl, MANIFEST);
    await seedStream(rsUrl, ownerToken, CONNECTOR_ID, STREAM, SEED);
    const auth = { headers: { Authorization: `Bearer ${ownerToken}` } };

    const res = await fetchJson(
      fieldWindowUrl(rsUrl, STREAM, 'e1', { field: 'body', offset_chars: '10', limit_chars: '25' }),
      auth,
    );
    assert.equal(res.status, 200);
    const w = res.body.window;
    assert.equal(w.start_chars, 10);
    assert.equal(w.text, LONG_BODY.slice(10, 35));
    assert.equal(w.text.length, 25);
    assert.equal(w.limit_chars, 25);
    assert.equal(w.has_more, true);
  });
});

test('field-window route rejects non-integer numeric selectors with 400', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerManifest(asUrl, MANIFEST);
    await seedStream(rsUrl, ownerToken, CONNECTOR_ID, STREAM, SEED);
    const auth = { headers: { Authorization: `Bearer ${ownerToken}` } };

    const res = await fetchJson(
      fieldWindowUrl(rsUrl, STREAM, 'e1', { field: 'body', offset_chars: '1.5' }),
      auth
    );
    assert.equal(res.status, 400, 'non-integer offset is a malformed window selector');
    assert.equal(res.body.error.code, 'invalid_window');
    assert.equal(res.body.error.param, 'offset_chars');
  });
});

test('field-window route rejects a missing field selector with 400', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerManifest(asUrl, MANIFEST);
    await seedStream(rsUrl, ownerToken, CONNECTOR_ID, STREAM, SEED);
    const auth = { headers: { Authorization: `Bearer ${ownerToken}` } };

    const res = await fetchJson(
      `${rsUrl}/v1/streams/${STREAM}/records/e1/field-window?connector_id=${CONNECTOR_ID}`,
      auth,
    );
    assert.equal(res.status, 400, 'missing field is a 400');
    assert.equal(res.body.error.code, 'invalid_field_path');
  });
});

test('field-window route reports an absent field as 404', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerManifest(asUrl, MANIFEST);
    await seedStream(rsUrl, ownerToken, CONNECTOR_ID, STREAM, SEED);
    const auth = { headers: { Authorization: `Bearer ${ownerToken}` } };

    const res = await fetchJson(
      fieldWindowUrl(rsUrl, STREAM, 'e1', { field: 'subject_does_not_exist' }),
      auth,
    );
    assert.equal(res.status, 404, 'absent field is a 404');
    assert.equal(res.body.error.code, 'field_not_found');
  });
});

test('field-window route reports a non-text field as 422', async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerManifest(asUrl, MANIFEST);
    await seedStream(rsUrl, ownerToken, CONNECTOR_ID, STREAM, SEED);
    const auth = { headers: { Authorization: `Bearer ${ownerToken}` } };

    // `read_count` is an integer field — well-formed request, but it cannot be
    // served as a readable text window.
    const res = await fetchJson(
      fieldWindowUrl(rsUrl, STREAM, 'e1', { field: 'read_count' }),
      auth,
    );
    assert.equal(res.status, 422, 'non-text field is a 422');
    assert.equal(res.body.error.code, 'field_not_text');
  });
});
