/**
 * Explorer live presentation types — flagship pilot (chase + gmail).
 *
 * OpenSpec change `add-explorer-live-presentation-types`.
 *
 * The typed-card path is accepted and green (archived
 * `complete-explorer-slvp-ideal`): the reference server surfaces a declared
 * presentation `type` as `field_capabilities[field].type`, and the Explorer
 * prefers it over its heuristic when dispatching record cards. That path was
 * dormant on live data because no first-party manifest declared a type. This
 * pilot declares presentation types on two REAL first-party manifests so typed
 * money and message cards render on real connections.
 *
 * Unlike `rs-streams-field-declared-type.test.js` (which uses a synthetic
 * manifest), this suite loads the ACTUAL committed `chase.json` and `gmail.json`
 * manifests, registers each through the AS, and reads the live RS
 * `GET /v1/streams/:stream` path. It then proves the surfaced
 * `field_capabilities[].type`s drive the expected record-kind dispatch through
 * the real classification precedence. This guards against manifest drift
 * silently breaking the live typed-card dispatch — with zero runtime risk and no
 * browser dependency.
 *
 * The record-kind dispatch precedence (mirrored from
 * `apps/console/src/app/dashboard/lib/record-kind.ts`, kept in sync by the web
 * `record-kind.test.ts`): money > (person+text => message) > text(=titled) >
 * temporal(=event). This file reimplements only the tiny declared-type→kind
 * mapping so the reference test stays dependency-free; the web suite owns the
 * full classifier.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';

const __dir = dirname(fileURLToPath(import.meta.url));
// Resolve the first-party manifest directory. Defaults to the workspace's
// `packages/polyfill-connectors/manifests`; an override lets the suite run
// against a specific checkout's manifests when the test host's node_modules
// live in a different worktree (the manifests are plain JSON read at runtime).
const MANIFESTS_DIR =
  process.env.PDPP_TEST_MANIFESTS_DIR
  || join(__dir, '../../packages/polyfill-connectors/manifests');

const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';

// ─── Pilot expectations (also encoded in the OpenSpec spec delta) ────────────

const PILOT = {
  chase: {
    manifest: 'chase.json',
    stream: 'transactions',
    expectedTypes: { amount: 'currency', date: 'timestamp', name: 'text' },
    // A non-pilot field that MUST stay untyped (honest absence).
    untypedField: 'memo',
    expectedKind: 'money',
  },
  gmail: {
    manifest: 'gmail.json',
    stream: 'messages',
    expectedTypes: { from_name: 'person', subject: 'text', snippet: 'text', date: 'timestamp' },
    untypedField: 'from_email',
    expectedKind: 'message',
  },
};

// ─── Declared-type → record-kind mapping (mirrors record-kind.ts precedence) ─

const MONEY_TYPE_RE = /^(currency|currency_minor_units|money|monetary|amount|price|cents)$/;
const TEMPORAL_TYPE_RE = /^(timestamp|datetime|date[-_]?time|date|time)$/;
const PERSON_TYPE_RE = /^(person|actor|contact|author|sender|user)$/;
const TEXT_TYPE_RE = /^(text|message|body|content|richtext|rich_text|markdown|prose)$/;

function classifyByDeclaredTypes(typesByField) {
  let hasMoney = false;
  let hasPerson = false;
  let hasText = false;
  let hasTemporal = false;
  for (const raw of Object.values(typesByField)) {
    const t = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!t) continue;
    if (MONEY_TYPE_RE.test(t)) hasMoney = true;
    else if (PERSON_TYPE_RE.test(t)) hasPerson = true;
    else if (TEXT_TYPE_RE.test(t)) hasText = true;
    else if (TEMPORAL_TYPE_RE.test(t)) hasTemporal = true;
  }
  if (hasMoney) return 'money';
  if (hasPerson && hasText) return 'message';
  if (hasText) return 'titled';
  if (hasTemporal) return 'event';
  return null;
}

// ─── HTTP harness (mirrors rs-streams-field-declared-type.test.js) ───────────

function loadManifest(name) {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, name), 'utf8'));
}

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

async function withHttpHarness(manifest, fn) {
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
      body: JSON.stringify(manifest),
    });
    assert.equal(registerResp.status, 201, `register connector ${manifest.connector_key || manifest.connector_id}`);
    await fn({ asUrl, rsUrl, connectorId: manifest.connector_id });
  } finally {
    await closeServer(server);
  }
}

async function readFieldCapabilities(rsUrl, token, connectorId, stream) {
  const { status, body } = await fetchJson(
    `${rsUrl}/v1/streams/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(status, 200, `GET /v1/streams/${stream} should be 200`);
  assert.equal(body.object, 'stream_metadata');
  assert.ok(body.field_capabilities, 'field_capabilities present');
  return body.field_capabilities;
}

// ─── Per-connector pilot proof ──────────────────────────────────────────────

for (const [name, spec] of Object.entries(PILOT)) {
  test(`${name}: real manifest surfaces declared presentation types on ${spec.stream}`, async () => {
    const manifest = loadManifest(spec.manifest);
    await withHttpHarness(manifest, async ({ asUrl, rsUrl, connectorId }) => {
      const ownerToken = await issueOwnerToken(asUrl);
      const fc = await readFieldCapabilities(rsUrl, ownerToken, connectorId, spec.stream);

      for (const [field, expected] of Object.entries(spec.expectedTypes)) {
        assert.ok(fc[field], `${name}/${spec.stream}.${field} present in field_capabilities`);
        assert.equal(
          fc[field].type,
          expected,
          `${name}/${spec.stream}.${field} declared type should be '${expected}'`,
        );
      }
    });
  });

  test(`${name}: a non-pilot field omits the type key (honest absence)`, async () => {
    const manifest = loadManifest(spec.manifest);
    await withHttpHarness(manifest, async ({ asUrl, rsUrl, connectorId }) => {
      const ownerToken = await issueOwnerToken(asUrl);
      const fc = await readFieldCapabilities(rsUrl, ownerToken, connectorId, spec.stream);
      assert.ok(fc[spec.untypedField], `${spec.untypedField} present`);
      assert.equal(
        Object.hasOwn(fc[spec.untypedField], 'type'),
        false,
        `${name}/${spec.stream}.${spec.untypedField} must omit 'type' (never invented)`,
      );
    });
  });

  test(`${name}: surfaced declared types dispatch a '${spec.expectedKind}' card`, async () => {
    const manifest = loadManifest(spec.manifest);
    await withHttpHarness(manifest, async ({ asUrl, rsUrl, connectorId }) => {
      const ownerToken = await issueOwnerToken(asUrl);
      const fc = await readFieldCapabilities(rsUrl, ownerToken, connectorId, spec.stream);

      // Project the live field_capabilities into the declared-type map the
      // Explorer feeds to classifyRecordKind, then dispatch the kind.
      const typesByField = {};
      for (const [field, cap] of Object.entries(fc)) {
        if (cap && typeof cap.type === 'string' && cap.type.length > 0) {
          typesByField[field] = cap.type;
        }
      }
      assert.equal(
        classifyByDeclaredTypes(typesByField),
        spec.expectedKind,
        `${name}/${spec.stream} should dispatch a '${spec.expectedKind}' card from declared types`,
      );
    });
  });

  test(`${name}: declared type rides alongside unchanged capability flags`, async () => {
    const manifest = loadManifest(spec.manifest);
    await withHttpHarness(manifest, async ({ asUrl, rsUrl, connectorId }) => {
      const ownerToken = await issueOwnerToken(asUrl);
      const fc = await readFieldCapabilities(rsUrl, ownerToken, connectorId, spec.stream);

      // For every pilot field, the declared type is purely additive: the field
      // still carries real, independent capability flags. We assert the flags
      // exist and are well-formed (the accepted-change invariant test proves
      // byte-identity to an undeclared twin on a synthetic manifest; here we
      // prove the real field still behaves as a normal field, not a stub).
      for (const field of Object.keys(spec.expectedTypes)) {
        const cap = fc[field];
        assert.equal(typeof cap.granted, 'boolean', `${field}.granted is a boolean`);
        assert.ok(cap.exact_filter && typeof cap.exact_filter.declared === 'boolean',
          `${field}.exact_filter is well-formed`);
        assert.ok(cap.lexical_search && typeof cap.lexical_search.declared === 'boolean',
          `${field}.lexical_search is well-formed`);
        // The raw schema echo still carries the field's real JSON-schema type
        // (string/integer/etc.) — the presentation type did not replace it.
        assert.ok(cap.schema && typeof cap.schema === 'object', `${field}.schema echo present`);
      }
    });
  });
}
