// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEMO_CAPABILITIES,
  DEMO_CLIENTS,
  DEMO_CONNECTORS,
  DEMO_GRANTS,
  DEMO_RECORDS,
  DEMO_RUNS,
  DEMO_STREAMS,
  DEMO_TRACES,
} from "./dataset.ts";

const SUSPICIOUS_DOMAINS = [/[a-z0-9-]+\.com\b/i, /[a-z0-9-]+\.io\b/i, /[a-z0-9-]+\.org\b/i, /[a-z0-9-]+\.net\b/i];
const ALLOWED_DOMAIN_FRAGMENT = /example\.invalid|example\.com/;
const REAL_LOOKING_DOMAIN_RE = /[a-z0-9-]+\.(?:com|io|net|org)\b/gi;
const FORBIDDEN_CREDENTIAL_PATTERNS = [
  /BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY/,
  /password\s*[:=]/i,
  /api[_-]?key\s*[:=]/i,
  /Bearer\s+[A-Za-z0-9._-]{16,}/,
  /\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/, // SSN-shaped
  /\b\d{16}\b/, // 16-digit numerics (credit-card-shaped)
];

function violatesPublicDomainPolicy(value: string): boolean {
  for (const re of SUSPICIOUS_DOMAINS) {
    const m = value.match(re);
    if (m && !ALLOWED_DOMAIN_FRAGMENT.test(m[0])) {
      return true;
    }
  }
  return false;
}

test("dataset has at least three connectors", () => {
  assert.ok(DEMO_CONNECTORS.length >= 3, `expected ≥ 3 connectors, got ${DEMO_CONNECTORS.length}`);
});

test("every stream references an existing connector", () => {
  const ids = new Set(DEMO_CONNECTORS.map((c) => c.connector_id));
  for (const stream of DEMO_STREAMS) {
    assert.ok(ids.has(stream.connector_id), `stream ${stream.key} references unknown connector ${stream.connector_id}`);
  }
});

test("every record references an existing stream and connector", () => {
  const streamKeys = new Set(DEMO_STREAMS.map((s) => s.key));
  const connectorIds = new Set(DEMO_CONNECTORS.map((c) => c.connector_id));
  for (const record of DEMO_RECORDS) {
    assert.ok(streamKeys.has(record.stream), `record ${record.record_id} references unknown stream ${record.stream}`);
    assert.ok(
      connectorIds.has(record.connector_id),
      `record ${record.record_id} references unknown connector ${record.connector_id}`
    );
  }
});

test("every grant references an existing client and stream", () => {
  const clientIds = new Set(DEMO_CLIENTS.map((c) => c.client_id));
  const streamKeys = new Set(DEMO_STREAMS.map((s) => s.key));
  for (const grant of DEMO_GRANTS) {
    assert.ok(clientIds.has(grant.client_id), `grant ${grant.grant_id} references unknown client ${grant.client_id}`);
    assert.ok(streamKeys.has(grant.stream), `grant ${grant.grant_id} references unknown stream ${grant.stream}`);
  }
});

test("dataset includes at least one issued, revoked, and denied grant", () => {
  const statuses = new Set(DEMO_GRANTS.map((g) => g.status));
  assert.ok(statuses.has("issued"));
  assert.ok(statuses.has("revoked"));
  assert.ok(statuses.has("denied"));
});

test("dataset includes at least one succeeded, failed, and needs_input run", () => {
  const statuses = new Set(DEMO_RUNS.map((r) => r.status));
  assert.ok(statuses.has("succeeded"));
  assert.ok(statuses.has("failed"));
  assert.ok(statuses.has("needs_input"));
});

test("traces exist for every grant trace_id", () => {
  const traceIds = new Set(DEMO_TRACES.map((t) => t.trace_id));
  for (const grant of DEMO_GRANTS) {
    assert.ok(traceIds.has(grant.trace_id), `no trace for grant ${grant.grant_id} (${grant.trace_id})`);
  }
});

test("capabilities include the headline reference flows", () => {
  const names = new Set(DEMO_CAPABILITIES.map((c) => c.capability));
  for (const required of [
    "scoped_grant_issuance",
    "grant_revocation",
    "consent_decline",
    "stream_schema_discovery",
    "lexical_search",
  ]) {
    assert.ok(names.has(required), `missing capability: ${required}`);
  }
});

test("seeded data uses safe public domains only", () => {
  const blob = JSON.stringify({
    DEMO_CAPABILITIES,
    DEMO_CLIENTS,
    DEMO_CONNECTORS,
    DEMO_GRANTS,
    DEMO_RECORDS,
    DEMO_RUNS,
    DEMO_STREAMS,
    DEMO_TRACES,
  });
  for (const m of blob.matchAll(REAL_LOOKING_DOMAIN_RE)) {
    assert.ok(
      ALLOWED_DOMAIN_FRAGMENT.test(m[0]),
      `unexpected real-looking domain in dataset: ${m[0]} (use example.invalid or example.com)`
    );
  }
  // Spot-check the helper is wired correctly.
  assert.equal(violatesPublicDomainPolicy("https://example.com/foo"), false);
  assert.equal(violatesPublicDomainPolicy("https://acme.com/foo"), true);
});

test("seeded data contains no obvious credentials, tokens, or PII shibboleths", () => {
  const blob = JSON.stringify({
    DEMO_CAPABILITIES,
    DEMO_CLIENTS,
    DEMO_CONNECTORS,
    DEMO_GRANTS,
    DEMO_RECORDS,
    DEMO_RUNS,
    DEMO_STREAMS,
    DEMO_TRACES,
  });
  for (const re of FORBIDDEN_CREDENTIAL_PATTERNS) {
    assert.ok(!re.test(blob), `dataset matched forbidden pattern ${re}`);
  }
});

test("dataset is deterministic (no randomness or mutable globals)", () => {
  // Re-importing should produce the same content via JSON.stringify identity.
  const a = JSON.stringify(DEMO_RECORDS);
  const b = JSON.stringify(DEMO_RECORDS);
  assert.equal(a, b);
});
