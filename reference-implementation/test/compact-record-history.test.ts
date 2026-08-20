// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the compact-record-history operational tool.
 *
 * Two layers:
 *   1. Pure-helper tests (no DB): fingerprint stability, retention
 *      selector across the rule matrix, parseLimitKeys, registry shape.
 *   2. Postgres-backed integration tests (gated on PDPP_TEST_POSTGRES_URL):
 *      seeded fixture per acceptance scenario from design.md.
 *
 * Spec: openspec/changes/compact-retained-record-history/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
import pg from "pg";

import {
  applyCompaction,
  assertCanonicalEligible,
  CANONICAL_CHANGE_MODEL,
  CANONICAL_REPRESENTATIVE_POLICY,
  COMPACTION_MODES,
  COMPACTION_POLICIES,
  type CompactionPolicy,
  findPolicy,
  type HistoryRow,
  isCanonicalEligible,
  markScopeDirty,
  parseLimitKeys,
  parseMode,
  planCompaction,
  recordFingerprint,
  selectRemovableVersions,
} from "../scripts/compact-record-history.ts";

const REGEXP_1 = /Registered policies/;
const REGEXP_2 = /no compaction policy registered/;
const REGEXP_3 = /no compaction policy registered/;
const REGEXP_4 = /PDPP_DATABASE_URL/;
const REGEXP_5 = /--limit-keys must be a positive integer/;
const REGEXP_6 = /canonical mode refused/;
const REGEXP_7 = /canonical mode refused/;
const REGEXP_8 = /requires changeModel="immutable_semantic"/;
const REGEXP_9 = /no registered policy/;
const REGEXP_10 = /no compaction policy registered/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, "..", "scripts", "compact-record-history.ts");

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// Repo-root-relative manifest roots, read directly from disk (test-only
// static-file access — the same pattern connector-key.test.ts already uses —
// NOT the runtime `getConnectorManifest` DB-catalog lookup version-disposition
// callers use in production). Used below to independently re-derive which
// (connector, stream) pairs declare each `compaction_class`, so the
// server-list-matches-script-list guardrail tests keep proving the two stay
// in sync without importing any list out of version-disposition.ts (which no
// longer exports one — compaction_class now lives on the manifest itself).
const MANIFEST_ROOTS_FOR_TEST = [
  path.resolve(__dirname, "..", "fixtures", "seed-manifests"),
  path.resolve(__dirname, "..", "..", "packages", "polyfill-connectors", "manifests"),
];

function manifestStreamPairsByCompactionClass(compactionClass: string): { connector: string; stream: string }[] {
  const pairs: { connector: string; stream: string }[] = [];
  for (const dir of MANIFEST_ROOTS_FOR_TEST) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      let manifest: {
        connector_key?: string;
        connector_id?: string;
        streams?: { name?: string; compaction_class?: string }[];
      };
      try {
        manifest = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
      } catch {
        continue;
      }
      const connector = manifest.connector_key || manifest.connector_id;
      if (!(connector && Array.isArray(manifest.streams))) {
        continue;
      }
      for (const stream of manifest.streams) {
        if (stream?.compaction_class === compactionClass && stream.name) {
          pairs.push({ connector, stream: stream.name });
        }
      }
    }
  }
  return pairs;
}

// ─── Pure-helper tests ──────────────────────────────────────────────────

test("recordFingerprint is stable across key order", () => {
  const a = { a: 1, b: 2, c: [3, 4] };
  const b = { a: 1, b: 2, c: [3, 4] };
  assert.equal(recordFingerprint(a), recordFingerprint(b));
});

test("recordFingerprint drops excluded keys before hashing", () => {
  const a = { fetched_at: "2026-05-26T00:00:00Z", id: "x", name: "n" };
  const b = { fetched_at: "2026-05-26T00:00:01Z", id: "x", name: "n" };
  assert.notEqual(recordFingerprint(a), recordFingerprint(b));
  assert.equal(recordFingerprint(a, ["fetched_at"]), recordFingerprint(b, ["fetched_at"]));
});

test("recordFingerprint changes when a non-excluded field changes", () => {
  const a = { id: "x", name: "A" };
  const b = { id: "x", name: "B" };
  assert.notEqual(recordFingerprint(a), recordFingerprint(b));
});

test("COMPACTION_POLICIES exposes the registered policies (short-name canonical form)", () => {
  const expected = [
    // connector-fingerprint family
    ["gmail", "threads"],
    ["slack", "workspace"],
    ["slack", "users"],
    ["slack", "files"],
    ["slack", "channel_memberships"],
    ["ynab", "payee_locations"],
    // run-clock / stored-body mirror family (forward gate added 2026-06-01)
    ["gmail", "labels"],
    ["usaa", "statements"],
    ["chase", "accounts"],
    // chase/statements + chase/transactions carry only the run-clock
    // `fetched_at` over content-addressed / immutable bodies; only
    // `fetched_at` is excluded (forward gate added 2026-06-03)
    ["chase", "statements"],
    ["chase", "transactions"],
    // usaa/accounts + usaa/credit_card_billing post-split carry identity +
    // settings + run-clock `fetched_at` only (balances/per-cycle metrics moved
    // to the `_stats` observation streams, split-usaa-account-balance-
    // observation-streams); only `fetched_at` is excluded. (gate added
    // 2026-06-02; bodies narrowed by the balance split)
    ["usaa", "accounts"],
    ["usaa", "credit_card_billing"],
    ["ynab", "budgets"],
    // usaa/transactions (CSV + PDF paths) + usaa/inbox_messages +
    // chase/current_activity carry only the run-clock `fetched_at` over
    // immutable bodies; only `fetched_at` is excluded (forward gate added
    // 2026-06-03). transactions/current_activity are partial scans (never
    // pruned); inbox_messages is a full-page scan (pruned).
    ["usaa", "transactions"],
    ["usaa", "inbox_messages"],
    ["chase", "current_activity"],
    // amazon/orders carries only the run-clock `fetched_at` over an
    // immutable id/total; only `fetched_at` is excluded. Year-freezing
    // already bounds the churn window; this is a partial scan (never
    // pruned). order_items has no fetched_at and no policy. (2026-06-03)
    ["amazon", "orders"],
    // chatgpt custom_instructions / shared_conversations re-emit a stable-id
    // body with NO run-clock field every run; the connector now gates emit
    // through a whole-body fingerprint cursor (excludeFromFingerprint []) and
    // this mirrors it with excludeKeys []. A no-op refresh collapses; a real
    // edit / new share is a boundary that survives. (2026-06-03)
    ["chatgpt", "custom_instructions"],
    ["chatgpt", "shared_conversations"],
    // exact stable-JSON identity family (codex)
    ["codex", "messages"],
    ["codex", "function_calls"],
    ["codex", "sessions"],
    ["codex", "skills"],
    ["codex", "prompts"],
    ["codex", "rules"],
    // exact stable-JSON identity family (claude-code)
    ["claude-code", "messages"],
    ["claude-code", "attachments"],
    ["claude-code", "sessions"],
    ["claude-code", "skills"],
    ["claude-code", "memory_notes"],
    ["claude-code", "slash_commands"],
    // inventory churn-gate family — inventory_only/defer metadata records
    // whose volatile mtime_epoch/size_bytes are excluded so an unchanged
    // store does not re-version on a file-stat tick. The inventory meaning
    // (path/type/classification/reason) stays a fingerprint boundary.
    // (forward gate added 2026-06-03)
    ["claude-code", "backup_inventory"],
    ["claude-code", "cache_inventory"],
    ["claude-code", "config_inventory"],
    ["claude-code", "file_history"],
    ["codex", "history"],
    ["codex", "session_index"],
    ["codex", "shell_snapshots"],
    ["codex", "config_inventory"],
    ["codex", "cache_inventory"],
  ];
  // ri-zero-knowledge-terminal-revise-0810: COMPACTION_POLICIES is now built
  // by iterating every shipped manifest's own streams (readdirSync order),
  // not a hand-curated array literal -- iteration ORDER is no longer a
  // meaningful invariant (findPolicy is a keyed lookup, never a positional
  // one), so this compares the same expected SET of (connector, stream)
  // pairs sorted, rather than requiring an exact incidental order match.
  const actual = COMPACTION_POLICIES.map((p) => [p.connectorIds[0], p.stream]);
  const sortPairs = (pairs: (readonly [string, string])[]) =>
    [...pairs].map(([c, s]) => `${c}/${s}`).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(sortPairs(actual as [string, string][]), sortPairs(expected as [string, string][]));
});

test("findPolicy returns null for unknown streams", () => {
  assert.equal(findPolicy("slack", "messages"), null);
  assert.equal(findPolicy("gmail", "messages"), null);
  assert.equal(findPolicy("codex", "unknown_stream"), null);
  assert.equal(findPolicy("claude-code", "unknown_stream"), null);
  assert.equal(findPolicy("chatgpt", "messages"), null);
});

test("findPolicy resolves codex and claude-code via short name or `local-device:` prefix", () => {
  const pairs: [string, string][] = [
    ["codex", "local-device:codex"],
    ["claude-code", "local-device:claude-code"],
  ];
  for (const [short, prefixed] of pairs) {
    const streams =
      short === "codex"
        ? ["messages", "function_calls", "sessions", "skills", "prompts", "rules"]
        : ["messages", "attachments", "sessions", "skills", "memory_notes", "slash_commands"];
    for (const stream of streams) {
      const a = findPolicy(short, stream);
      const b = findPolicy(prefixed, stream);
      assert.ok(a, `findPolicy(${short}, ${stream}) returned null`);
      assert.ok(b, `findPolicy(${prefixed}, ${stream}) returned null`);
      assert.equal(a, b, `${short} and ${prefixed} must resolve to the same policy entry`);
      assert.deepEqual(a.excludeKeys, [], `${short}/${stream} must use exact stable-JSON identity (excludeKeys=[])`);
    }
  }
});

test("findPolicy matches both short name and registry URL form for connector_id", () => {
  const a = findPolicy("slack", "workspace");
  const b = findPolicy("https://registry.pdpp.dev/connectors/slack", "workspace");
  assert.ok(a);
  assert.ok(b);
  assert.equal(a, b, "short-name and URL lookups must resolve to the same policy entry");
});

test("findPolicy returns the registered policy for Slack workspace with excludeKeys=[fetched_at]", () => {
  const p = findPolicy("slack", "workspace");
  assert.ok(p);
  assert.deepEqual(p.excludeKeys, ["fetched_at"]);
});

test("findPolicy returns the registered policy for Slack channel_memberships with excludeKeys=[fetched_at]", () => {
  // Mirrors the connector-side gate (FINGERPRINT_EXCLUDE.channel_memberships
  // in connectors/slack/index.ts, proven by connectors/slack/fingerprint.test.ts).
  // Excluding only the run-clock `fetched_at` leaves the membership identity
  // (id, channel_id, user_id) inside the fingerprint, so a membership
  // appearing or disappearing always remains a version boundary.
  const short = findPolicy("slack", "channel_memberships");
  const url = findPolicy("https://registry.pdpp.dev/connectors/slack", "channel_memberships");
  assert.ok(short, "slack/channel_memberships policy must be registered");
  assert.deepEqual(short.excludeKeys, ["fetched_at"]);
  assert.equal(short, url, "short-name and URL lookups must resolve to the same policy entry");
});

// ─── Point-in-time real-field guardrail ─────────────────────────────────
//
// These streams version on a GENUINELY changing real field carried on the
// same record as a stable identity — not on a run clock. The accepted
// direction (design-notes/real-field-version-churn-point-in-time-streams-
// 2026-06-02.md) is to split the volatile observation into its own
// append-keyed point-in-time stream, NOT to register a compaction policy
// or a fingerprint exclusion that would collapse real history. Registering
// any policy for these (connector, stream) pairs would let
// `compact-record-history.ts --apply` silently delete real
// point-in-time data. This test fails loudly the moment such a policy is
// added so the closeout's "needs design, not exclusion" boundary cannot be
// erased by accident.
//
// Both connector-id forms (short + registry URL) are checked because
// findPolicy resolves either.
const POINT_IN_TIME_REAL_FIELD_STREAMS = [
  { connector: "github", realField: "follower/repo/gist counts", stream: "user" },
  { connector: "slack", realField: "num_members", stream: "channels" },
  // ynab/accounts is the same class: the connector already split its balances
  // into the append-keyed `account_stats` observation stream
  // (split-ynab-account-balance-observation-stream), so the current entity
  // record no longer carries balance/cleared_balance/uncleared_balance. The
  // retained `accounts` history churns ONLY on those now-removed balance
  // fields (verified field-diff on the live proof DB: balance, cleared_balance,
  // uncleared_balance are the sole adjacent-version differences) — genuine
  // point-in-time observations that are the only surviving copy (the split
  // streams backfilled nothing). A compaction policy would delete real history.
  { connector: "ynab", realField: "balance/cleared_balance/uncleared_balance", stream: "accounts" },
];

for (const { connector, stream, realField } of POINT_IN_TIME_REAL_FIELD_STREAMS) {
  test(`no compaction policy is registered for the point-in-time real-field stream ${connector}/${stream}`, () => {
    const short = findPolicy(connector, stream);
    const url = findPolicy(`https://registry.pdpp.dev/connectors/${connector}`, stream);
    assert.equal(
      short,
      null,
      `${connector}/${stream} churns on a real field (${realField}); it must NOT have a compaction policy — split it into an append-keyed point-in-time stream instead (see design-notes/real-field-version-churn-point-in-time-streams-2026-06-02.md)`
    );
    assert.equal(url, null, `${connector}/${stream} (registry-URL form) must also have no compaction policy`);
  });
}

// USAA `accounts` and `credit_card_billing` are the subtle case. Post-split
// (split-usaa-account-balance-observation-streams) their volatile balance /
// per-cycle metrics moved to the `_stats` observation streams, so the entity
// bodies now carry a run-clock `fetched_at` plus: for `accounts`, identity
// only (id/type/name/last_four/status); for `credit_card_billing`, identity
// plus real SETTINGS state (credit_limit_cents, APRs, nickname, card_holders)
// whose changes are legitimate low-rate versions. Either way the policy must
// exclude ONLY `fetched_at`: excluding any retained body field would suppress
// real churn (a settings change on the card, an identity change on the
// account). This pins the cut line so a future edit can't widen excludeKeys
// past the run clock.
for (const stream of ["accounts", "credit_card_billing"]) {
  test(`usaa/${stream} compaction policy excludes the run clock only, never a real field`, () => {
    const policy = findPolicy("usaa", stream);
    assert.ok(policy, `usaa/${stream} policy must be registered`);
    assert.deepEqual(
      policy.excludeKeys,
      ["fetched_at"],
      `usaa/${stream} must exclude ONLY fetched_at; any real-field exclusion would compact real point-in-time history`
    );
  });
}

// ─── Manifest disposition-registry in-sync guardrail ──────────────────────
//
// version_disposition is DERIVED server-side
// (reference-implementation/server/version-disposition.ts) from this script's
// COMPACTION_POLICIES registry plus the manifest-declared `compaction_class`
// each connector's OWN manifest carries (`ri-zero-knowledge-terminal-
// revise-0810`: connector-identity facts live in connector-owned manifests,
// never in RI source or RI-committed JSON, so version-disposition.ts no
// longer exports a stream list to compare against — this test re-derives the
// manifest-declared pairs itself, directly from the manifest files on disk).
//
// These tests pin the structural invariants the derivation relies on:
//   - point-in-time split residuals must have NO compaction policy (a policy
//     would let `--apply` delete real history);
//   - recurring point-in-time snapshots (sessions) MUST have a compaction
//     policy — it is the regression safety net for a broken no-op gate — which
//     is exactly why the disposition cannot key on policy ABSENCE and must use
//     the manifest-declared class with precedence.

test("manifest-declared point-in-time real-field streams have NO compaction policy (split, never compact)", () => {
  const manifestPointInTime = manifestStreamPairsByCompactionClass("point_in_time_real_field");
  assert.ok(manifestPointInTime.length > 0, "expected at least one manifest to declare point_in_time_real_field");
  for (const { connector, stream } of manifestPointInTime) {
    assert.equal(
      findPolicy(connector, stream),
      null,
      `${connector}/${stream} is a point-in-time split residual; it must NOT have a compaction policy`
    );
    assert.equal(
      findPolicy(`https://registry.pdpp.dev/connectors/${connector}`, stream),
      null,
      `${connector}/${stream} (registry-URL form) must also have no compaction policy`
    );
  }
});

test("manifest point-in-time streams match this script's real-field guardrail list", () => {
  const manifestSet = new Set(
    manifestStreamPairsByCompactionClass("point_in_time_real_field").map(
      ({ connector, stream }) => `${connector}/${stream}`
    )
  );
  const scriptSet = new Set(POINT_IN_TIME_REAL_FIELD_STREAMS.map(({ connector, stream }) => `${connector}/${stream}`));
  assert.deepEqual(
    [...manifestSet].sort(),
    [...scriptSet].sort(),
    "manifest-declared point-in-time streams and script real-field guardrail must list the same pairs"
  );
});

test("manifest-declared recurring point-in-time snapshot streams DO have a registered compaction policy (regression safety net)", () => {
  // The design relies on this: sessions keep their policy as the catch for a
  // broken mtime gate, so the disposition must classify them by the
  // manifest-declared class with precedence, NOT by policy absence.
  const manifestRecurringSnapshot = manifestStreamPairsByCompactionClass("recurring_snapshot");
  assert.ok(manifestRecurringSnapshot.length > 0, "expected at least one manifest to declare recurring_snapshot");
  for (const { connector, stream } of manifestRecurringSnapshot) {
    assert.ok(
      findPolicy(connector, stream),
      `${connector}/${stream} is a recurring snapshot; it MUST keep a compaction policy as the no-op regression safety net`
    );
  }
});

test("manifest recurring-snapshot streams and point-in-time streams are disjoint", () => {
  const piSet = new Set(
    manifestStreamPairsByCompactionClass("point_in_time_real_field").map(
      ({ connector, stream }) => `${connector}/${stream}`
    )
  );
  for (const { connector, stream } of manifestStreamPairsByCompactionClass("recurring_snapshot")) {
    assert.equal(
      piSet.has(`${connector}/${stream}`),
      false,
      `${connector}/${stream} cannot be both a recurring snapshot and a point-in-time split residual`
    );
  }
});

test("parseLimitKeys accepts positive integers, rejects everything else", () => {
  assert.equal(parseLimitKeys("1"), 1);
  assert.equal(parseLimitKeys("42"), 42);
  assert.equal(parseLimitKeys(undefined), null);
  // parseLimitKeys's `raw == null` check deliberately also catches a JS
  // caller passing `null` at runtime (see the source doc comment), even
  // though the declared parameter type is `string | boolean | undefined`.
  // Simulate that untyped-caller shape with a JSON round-trip so the value
  // is genuinely `null` at runtime without a type assertion.
  const nullableRaw: string | boolean | undefined = JSON.parse("null");
  assert.equal(parseLimitKeys(nullableRaw), null);
  assert.equal(parseLimitKeys(""), null);
  assert.equal(parseLimitKeys("0"), "invalid");
  assert.equal(parseLimitKeys("-3"), "invalid");
  assert.equal(parseLimitKeys("1.5"), "invalid");
  assert.equal(parseLimitKeys("abc"), "invalid");
  assert.equal(parseLimitKeys(true), "invalid");
});

// selectRemovableVersions ───────────────────────────────────────────────

const WORKSPACE_POLICY = findPolicy("slack", "workspace");
const THREADS_POLICY = findPolicy("gmail", "threads");
assert.ok(WORKSPACE_POLICY, "slack/workspace policy must be registered");
assert.ok(THREADS_POLICY, "gmail/threads policy must be registered");

function row(version: number, payload: unknown, { deleted = false }: { deleted?: boolean } = {}): HistoryRow {
  return { deleted, payload_bytes: null, record_json: payload, version };
}

test("selectRemovableVersions: empty history → nothing to remove", () => {
  assert.deepEqual(selectRemovableVersions([], 0, THREADS_POLICY), []);
});

test("selectRemovableVersions: single-version history → nothing to remove", () => {
  const rows = [row(1, { id: "x", name: "A" })];
  assert.deepEqual(selectRemovableVersions(rows, 1, THREADS_POLICY), []);
});

test("selectRemovableVersions: all distinct fingerprints → nothing to remove", () => {
  const rows = [
    row(1, { id: "x", n: 1 }),
    row(2, { id: "x", n: 2 }),
    row(3, { id: "x", n: 3 }),
    row(4, { id: "x", n: 4 }),
  ];
  assert.deepEqual(selectRemovableVersions(rows, 4, THREADS_POLICY), []);
});

test("selectRemovableVersions: adjacent same-fingerprint runs collapse to first; current and first retained", () => {
  // versions: 1 (first, A) 2 (A) 3 (A) 4 (B) 5 (current, B)
  const rows = [
    row(1, { id: "x", kind: "A" }),
    row(2, { id: "x", kind: "A" }),
    row(3, { id: "x", kind: "A" }),
    row(4, { id: "x", kind: "B" }),
    row(5, { id: "x", kind: "B" }),
  ];
  // 2 and 3 collapse to 1; 5 is current so retained; 4 is the most-recent-prior
  // with a different fingerprint from current (wait — 4 and 5 have the same
  // fingerprint so 4 is also same-as-current; the most-recent-differing-prior
  // is version 3, but 3 is being marked removable). Let's reason carefully:
  //   - current is v5, fingerprint B
  //   - most recent prior with different fingerprint = v3 (A) — must be retained
  //   - v1: first → retain
  //   - v2: prev surviving is v1 (A), same fp → remove
  //   - v3: prev surviving is v1 (A), same fp BUT v3 is pinned as the
  //         most-recent-differing-prior → retain
  //   - v4: prev surviving is v3 (A), different fp (B) → retain
  //   - v5: current → retain
  // Hold on — v3's fingerprint IS A, current is B, so v3 IS the most-recent
  // prior with different fingerprint. Retained. Result: [2].
  const removable = selectRemovableVersions(rows, 5, WORKSPACE_POLICY);
  assert.deepEqual(
    removable.sort((a, b) => a - b),
    [2]
  );
});

test("selectRemovableVersions: long same-fingerprint run before current collapses to first", () => {
  // versions: 1 (A) 2 (A) 3 (A) 4 (A) 5 (current, A)
  const rows = [
    row(1, { id: "x", kind: "A" }),
    row(2, { id: "x", kind: "A" }),
    row(3, { id: "x", kind: "A" }),
    row(4, { id: "x", kind: "A" }),
    row(5, { id: "x", kind: "A" }),
  ];
  //   - current=5 (A); no prior version with different fp exists
  //   - v1: first → retain
  //   - v2, v3, v4: same fp as surviving anchor v1 → remove
  //   - v5: current → retain
  const removable = selectRemovableVersions(rows, 5, WORKSPACE_POLICY);
  assert.deepEqual(
    removable.sort((a, b) => a - b),
    [2, 3, 4]
  );
});

test("selectRemovableVersions: tombstones bound compaction", () => {
  // versions: 1 (A) 2 (A) 3 (tombstone) 4 (A) 5 (current, A)
  const rows = [
    row(1, { id: "x", kind: "A" }),
    row(2, { id: "x", kind: "A" }),
    row(3, null, { deleted: true }),
    row(4, { id: "x", kind: "A" }),
    row(5, { id: "x", kind: "A" }),
  ];
  //   - v1: first → retain
  //   - v2: same fp as v1 → remove
  //   - v3: tombstone → retain (boundary)
  //   - v4: predecessor is a tombstone → retain (resurrection)
  //   - v5: current → retain
  // The "most recent prior with different fingerprint" from current is the
  // tombstone v3 (fingerprint != A); v3 is already retained.
  const removable = selectRemovableVersions(rows, 5, WORKSPACE_POLICY);
  assert.deepEqual(
    removable.sort((a, b) => a - b),
    [2]
  );
});

test("selectRemovableVersions: workspace fetched_at-only churn collapses under fetched_at exclusion", () => {
  // versions whose only difference is fetched_at — the slack workspace
  // case the policy is designed for.
  const rows = [
    row(1, { fetched_at: "2026-05-26T00:00:00Z", id: "T1", name: "W" }),
    row(2, { fetched_at: "2026-05-26T00:01:00Z", id: "T1", name: "W" }),
    row(3, { fetched_at: "2026-05-26T00:02:00Z", id: "T1", name: "W" }),
    row(4, { fetched_at: "2026-05-26T00:03:00Z", id: "T1", name: "W" }),
    row(5, { fetched_at: "2026-05-26T00:04:00Z", id: "T1", name: "W" }),
  ];
  const removable = selectRemovableVersions(rows, 5, WORKSPACE_POLICY);
  assert.deepEqual(
    removable.sort((a, b) => a - b),
    [2, 3, 4]
  );
});

test("selectRemovableVersions: channel_memberships fetched_at-only churn collapses, but a real membership field move is a boundary", () => {
  // The live offender shape: the membership identity {id, channel_id,
  // user_id} is stable across runs and only the run-clock `fetched_at`
  // moves, so under the fetched_at exclusion every version shares one
  // fingerprint and the intermediates collapse to the v1 anchor + current
  // pin. A version that changes a REAL membership field (here user_id, as
  // if the row were re-keyed) is a fingerprint boundary that survives.
  const MEMBERSHIPS_POLICY = findPolicy("slack", "channel_memberships");
  assert.ok(MEMBERSHIPS_POLICY, "slack/channel_memberships policy must be registered");
  const member = (userId: string, ts: string) => ({
    channel_id: "C1",
    fetched_at: ts,
    id: `C1:${userId}`,
    user_id: userId,
  });
  const churnRows = [
    row(1, member("U1", "2026-05-26T00:00:00Z")),
    row(2, member("U1", "2026-05-26T00:01:00Z")),
    row(3, member("U1", "2026-05-26T00:02:00Z")),
    row(4, member("U1", "2026-05-26T00:03:00Z")),
  ];
  // All four share one fingerprint (fetched_at excluded) → 2,3 collapse to
  // v1; v4 is current → retained.
  assert.deepEqual(
    selectRemovableVersions(churnRows, 4, MEMBERSHIPS_POLICY).sort((a, b) => a - b),
    [2, 3]
  );
  // A real membership field move (user_id) is a fingerprint boundary that is
  // never collapsed — it is pinned as the most-recent-differing-prior.
  const boundaryRows = [
    row(1, member("U1", "2026-05-26T00:00:00Z")),
    row(2, member("U1", "2026-05-26T00:01:00Z")),
    row(3, member("U2", "2026-05-26T00:02:00Z")),
    row(4, member("U2", "2026-05-26T00:03:00Z")),
  ];
  // current = v4 (U2). most-recent prior with different fp = v2 (U1) → pinned.
  //   v1 first → retain; v2 differing-prior pin → retain; v3 different fp from
  //   v2 → retain; v4 current → retain. Nothing removable: the U1→U2 boundary
  //   and the only intermediate are all protected.
  assert.deepEqual(selectRemovableVersions(boundaryRows, 4, MEMBERSHIPS_POLICY), []);
});

test("selectRemovableVersions: workspace fetched_at-only churn does NOT collapse under threads policy (no exclude)", () => {
  // Same rows, but a hypothetical policy with no exclude would treat each
  // fetched_at change as a real fingerprint change.
  const rows = [
    row(1, { fetched_at: "2026-05-26T00:00:00Z", id: "T1", name: "W" }),
    row(2, { fetched_at: "2026-05-26T00:01:00Z", id: "T1", name: "W" }),
    row(3, { fetched_at: "2026-05-26T00:02:00Z", id: "T1", name: "W" }),
  ];
  // Gmail threads policy has excludeKeys: [] — every row's fp differs.
  const removable = selectRemovableVersions(rows, 3, THREADS_POLICY);
  assert.deepEqual(removable, []);
});

test("selectRemovableVersions: ynab budgets last_month/last_modified_on-only churn collapses under the budgets exclusion", () => {
  // The historical offender shape: every run re-emitted the budget with a
  // fresh last_month (calendar rollover) / last_modified_on (any in-budget
  // edit), none of which changed the budget-summary fields. Excluding both
  // fields, every version has the same fingerprint → intermediates collapse.
  const BUDGETS_POLICY = findPolicy("ynab", "budgets");
  assert.ok(BUDGETS_POLICY, "ynab/budgets policy must be registered");
  assert.deepEqual(BUDGETS_POLICY.excludeKeys, ["last_month", "last_modified_on"]);
  const budget = (lastMonth: string, lastModified: string) => ({
    currency_iso_code: "USD",
    date_format_string: "MM/DD/YYYY",
    deleted: false,
    first_month: "2024-01-01",
    id: "b_1",
    last_modified_on: lastModified,
    last_month: lastMonth,
    name: "My Budget",
  });
  const rows = [
    row(1, budget("2026-01-01", "2026-01-15T00:00:00Z")),
    row(2, budget("2026-02-01", "2026-02-03T00:00:00Z")),
    row(3, budget("2026-03-01", "2026-03-09T00:00:00Z")),
    row(4, budget("2026-04-01", "2026-04-21T00:00:00Z")),
    row(5, budget("2026-05-01", "2026-05-30T00:00:00Z")),
  ];
  // All five share one fingerprint → collapse to the v1 anchor and the
  // current pin (v5). No prior version differs from current, so no
  // most-recent-differing-prior pin exists.
  const removable = selectRemovableVersions(rows, 5, BUDGETS_POLICY);
  assert.deepEqual(
    removable.sort((a, b) => a - b),
    [2, 3, 4]
  );
});

test("selectRemovableVersions: ynab budgets genuine summary edit is a fingerprint boundary, not collapsed", () => {
  // A real edit to a projected field (rename) must remain a version
  // transition even though the calendar fields also moved.
  const BUDGETS_POLICY = findPolicy("ynab", "budgets");
  assert.ok(BUDGETS_POLICY, "ynab/budgets policy must be registered");
  const budget = (name: string, lastMonth: string) => ({
    currency_iso_code: "USD",
    date_format_string: "MM/DD/YYYY",
    deleted: false,
    first_month: "2024-01-01",
    id: "b_1",
    last_modified_on: "2026-05-30T00:00:00Z",
    last_month: lastMonth,
    name,
  });
  const rows = [
    row(1, budget("Old Name", "2026-01-01")), // first → retain
    row(2, budget("Old Name", "2026-02-01")), // calendar-only churn after v1
    row(3, budget("New Name", "2026-03-01")), // genuine rename → boundary
    row(4, budget("New Name", "2026-04-01")), // calendar-only churn after rename
  ];
  // current = v4 (New Name = FP_B).
  //   most-recent prior with fp != FP_B is v2 ("Old Name" = FP_A) → pinned.
  //   v1 first → retain
  //   v2 is the most-recent-differing-prior pin → retain (NOT removable, even
  //      though it shares FP_A with v1; the pin wins over the collapse rule)
  //   v3 rename: predecessor surviving anchor is v2 (FP_A), v3 is FP_B,
  //      different fp → retain
  //   v4 current → retain
  // The genuine rename is preserved as a boundary and no real history is
  // collapsed; the only calendar-only intermediate (v2) is protected here by
  // the differing-prior pin rather than removed. Removable = [].
  const removable = selectRemovableVersions(rows, 4, BUDGETS_POLICY);
  assert.deepEqual(removable, []);
});

test("selectRemovableVersions: current-row pin holds even when current matches a removable run", () => {
  // versions: 1 (A) 2 (A) 3 (current, A) 4 (A)
  // (a possible state if compaction is run while a later equal-fingerprint row exists
  //  — shouldn't happen in practice but the selector must be robust)
  const rows = [
    row(1, { id: "x", kind: "A" }),
    row(2, { id: "x", kind: "A" }),
    row(3, { id: "x", kind: "A" }),
    row(4, { id: "x", kind: "A" }),
  ];
  const removable = selectRemovableVersions(rows, 3, WORKSPACE_POLICY);
  // v1 first, v3 current. v2 collapses into v1. v4 same fp as surviving
  // anchor (v3, current) → removable.
  assert.deepEqual(
    removable.sort((a, b) => a - b),
    [2, 4]
  );
});

// ─── Canonical-mode eligibility (task 1.2 / 2.1) ─────────────────────────

test("COMPACTION_MODES is exactly [audit, canonical] and audit is the default of parseMode", () => {
  assert.deepEqual(COMPACTION_MODES, ["audit", "canonical"]);
  assert.equal(parseMode(undefined), "audit");
  // parseMode's `raw == null` check deliberately also catches a JS caller
  // passing `null` at runtime (see the source doc comment), even though the
  // declared parameter type is `string | boolean | undefined`. Simulate that
  // untyped-caller shape with a JSON round-trip so the value is genuinely
  // `null` at runtime without a type assertion.
  const nullableModeRaw: string | boolean | undefined = JSON.parse("null");
  assert.equal(parseMode(nullableModeRaw), "audit");
  assert.equal(parseMode(""), "audit");
  assert.equal(parseMode("audit"), "audit");
  assert.equal(parseMode("canonical"), "canonical");
  assert.equal(parseMode("strict"), "invalid");
  assert.equal(parseMode("CANONICAL"), "invalid", "mode is case-sensitive");
  assert.equal(parseMode(true), "invalid", "a bare --mode flag (boolean) is invalid");
});

test("canonical-eligible policies are exactly chase/transactions + chase/statements + usaa/statements (task 2.1/2.3)", () => {
  const eligible = COMPACTION_POLICIES.filter(isCanonicalEligible).map((p) => `${p.connectorIds[0]}/${p.stream}`);
  // chase/statements and usaa/statements join chase/transactions as canonical-eligible
  // (add-statement-content-fingerprint — content-gated exclusion makes them immutable_semantic).
  assert.deepEqual(
    // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
    eligible.sort(),
    ["chase/statements", "chase/transactions", "usaa/statements"].sort(),
    "exactly these three streams are canonical-eligible"
  );
});

test("chase/transactions declares the canonical policy fields exactly (task 2.1)", () => {
  const p = findPolicy("chase", "transactions");
  assert.ok(p);
  assert.equal(p.changeModel, CANONICAL_CHANGE_MODEL);
  assert.equal(p.representativePolicy, CANONICAL_REPRESENTATIVE_POLICY);
  // Fingerprint exclusions stay aligned with the connector runtime (task 2.2).
  assert.deepEqual(p.excludeKeys, ["fetched_at", "source"]);
  assert.ok(isCanonicalEligible(p));
});

test("no other stream beyond the three approved canonical policies is canonical-eligible (task 2.3)", () => {
  // Only these three streams may be canonical-eligible. Every other registered
  // policy must be canonical-INELIGIBLE (missing both fields). This is the
  // fail-closed guarantee for the whole registry, pinned so a future edit
  // cannot silently widen canonical scope.
  const APPROVED_CANONICAL = new Set(["chase/transactions", "chase/statements", "usaa/statements"]);
  for (const p of COMPACTION_POLICIES) {
    const pair = `${p.connectorIds[0]}/${p.stream}`;
    if (APPROVED_CANONICAL.has(pair)) {
      continue;
    }
    assert.equal(isCanonicalEligible(p), false, `${pair} must NOT be canonical-eligible`);
    assert.equal(p.changeModel, undefined, `${pair} must not declare changeModel`);
    assert.equal(p.representativePolicy, undefined, `${pair} must not declare representativePolicy`);
  }
});

test("isCanonicalEligible fails closed for partial / wrong field values (task 1.2)", () => {
  assert.equal(isCanonicalEligible(null), false);
  assert.equal(isCanonicalEligible(undefined), false);
  // isCanonicalEligible only ever reads `.changeModel` / `.representativePolicy`
  // off its argument (see the source), and is exercised here against
  // intentionally partial / wrong-value shapes for exactly those two fields —
  // the whole point of a fail-closed test. Every other CompactionPolicy field
  // is irrelevant to the function's behavior, so fill them with a fixed,
  // otherwise-valid base and vary only the two fields under test — no cast,
  // every fixture is a real, fully-typed CompactionPolicy.
  const BASE: CompactionPolicy = {
    connectorIds: ["fixture"],
    connectorSource: "test fixture",
    excludeKeys: [],
    stream: "fixture_stream",
  };
  assert.equal(isCanonicalEligible({ ...BASE }), false, "no fields → ineligible");
  assert.equal(
    isCanonicalEligible({ ...BASE, changeModel: "immutable_semantic" }),
    false,
    "changeModel alone is not enough"
  );
  assert.equal(
    isCanonicalEligible({ ...BASE, representativePolicy: "current" }),
    false,
    "representativePolicy alone is not enough"
  );
  // These two probe a policy carrying a WRONG runtime value for one field
  // despite a correct value for the other (e.g. a JS/JSON caller bypassing
  // the literal-union type). Build each full fixture by round-tripping
  // through JSON so the wrong-value fields are genuine `any`-sourced runtime
  // values assignable to CompactionPolicy's literal-union fields without a
  // type assertion.
  const mutableChangeModelPolicy: CompactionPolicy = JSON.parse(
    JSON.stringify({ ...BASE, changeModel: "mutable", representativePolicy: "current" })
  );
  assert.equal(isCanonicalEligible(mutableChangeModelPolicy), false, "a mutable change model is never eligible");
  const wrongRepresentativePolicyPolicy: CompactionPolicy = JSON.parse(
    JSON.stringify({ ...BASE, changeModel: "immutable_semantic", representativePolicy: "first" })
  );
  assert.equal(
    isCanonicalEligible(wrongRepresentativePolicyPolicy),
    false,
    'representativePolicy must be exactly "current" in this slice'
  );
});

test("assertCanonicalEligible throws for ineligible policies and is a no-op for chase/transactions", () => {
  // Denial path (spec scenario "Ineligible stream fails closed"): a non-eligible
  // policy must throw rather than allow a canonical delete.
  assert.throws(() => assertCanonicalEligible(findPolicy("chase", "accounts"), "chase", "accounts"), REGEXP_7);
  assert.throws(() => assertCanonicalEligible(findPolicy("usaa", "transactions"), "usaa", "transactions"), REGEXP_8);
  assert.throws(() => assertCanonicalEligible(null, "mystery", "widgets"), REGEXP_9);
  // Eligible policy → no throw.
  assert.doesNotThrow(() => assertCanonicalEligible(findPolicy("chase", "transactions"), "chase", "transactions"));
});

// ─── Canonical-mode selector (task 1.3 / 3.1 / 3.2) ──────────────────────

const CHASE_TX_POLICY = findPolicy("chase", "transactions");
assert.ok(CHASE_TX_POLICY, "chase/transactions policy must be registered");

// A chase-transaction-shaped body: identity (id/fitid) + immutable fields, with
// the excluded run/acquisition metadata (fetched_at, source). Two bodies with
// the same `key` part share one canonical fingerprint; a `field` override moves
// it (a real transaction change).
function tx(
  version: number,
  {
    run = "r",
    field = -4599,
    fetchedAt = `2026-06-0${version}T00:00:00Z`,
  }: { run?: string; field?: number; fetchedAt?: string } = {}
): HistoryRow {
  return row(version, {
    account_id: "INTACC123",
    amount: field,
    date: "2026-04-10",
    fetched_at: fetchedAt,
    fitid: "FITID-0001",
    id: "INTACC123|FITID-0001",
    name: "COFFEE SHOP",
    source: `qfx_download_${run}`,
  });
}

test("canonical: immutable same-fingerprint run converges to the current survivor (spec scenario 2)", () => {
  // Five versions differing ONLY on excluded metadata → one fingerprint.
  const rows = [
    tx(1, { run: "all" }),
    tx(2, { run: "since" }),
    tx(3, { run: "all" }),
    tx(4, { run: "since" }),
    tx(5, { run: "all" }),
  ];
  // Canonical keeps ONLY the current row (v5); audit keeps first+current.
  assert.deepEqual(
    selectRemovableVersions(rows, 5, CHASE_TX_POLICY, "canonical").sort((a, b) => a - b),
    [1, 2, 3, 4],
    "canonical collapses the whole same-fingerprint run to the current row"
  );
  assert.deepEqual(
    selectRemovableVersions(rows, 5, CHASE_TX_POLICY, "audit").sort((a, b) => a - b),
    [2, 3, 4],
    "audit still keeps the first observation + current"
  );
});

test("canonical: distinct canonical fingerprints each keep a survivor (spec scenario 3)", () => {
  // A A B B with current = v4 (B). Real field move at v3 is a boundary.
  const rows = [tx(1, { field: -4599 }), tx(2, { field: -4599 }), tx(3, { field: -5000 }), tx(4, { field: -5000 })];
  // Survivors: v1 (first of run A) + v4 (current, run B). Removable: v2, v3.
  assert.deepEqual(
    selectRemovableVersions(rows, 4, CHASE_TX_POLICY, "canonical").sort((a, b) => a - b),
    [2, 3]
  );
});

test("canonical: current row in the middle of a same-fingerprint run is the sole survivor", () => {
  const rows = [tx(1), tx(2), tx(3), tx(4)];
  // current = v3; the whole run shares one fingerprint → only v3 survives.
  assert.deepEqual(
    selectRemovableVersions(rows, 3, CHASE_TX_POLICY, "canonical").sort((a, b) => a - b),
    [1, 2, 4]
  );
});

test("canonical: tombstone and resurrection boundary are hard survivors (spec scenario 4)", () => {
  // A A TOMB A A with current = v5. The resurrection boundary (v4) is pinned
  // even though it shares the current run's fingerprint; only the pre-tombstone
  // duplicate v2 collapses.
  const rows = [tx(1), tx(2), row(3, null, { deleted: true }), tx(4), tx(5)];
  const removable = selectRemovableVersions(rows, 5, CHASE_TX_POLICY, "canonical").sort((a, b) => a - b);
  assert.deepEqual(removable, [2], "survivors: v1, v3(tombstone), v4(resurrection), v5(current)");
});

test("canonical: a tombstone never collapses across the resurrection (multi-duplicate post-tombstone run)", () => {
  // TOMB then A A A with current = v5. v2 tombstone + v3 resurrection pinned;
  // v4 is the only removable duplicate; v5 current survives.
  const rows = [tx(1), row(2, null, { deleted: true }), tx(3), tx(4), tx(5)];
  const removable = selectRemovableVersions(rows, 5, CHASE_TX_POLICY, "canonical").sort((a, b) => a - b);
  assert.deepEqual(removable, [4], "survivors: v1, v2(tombstone), v3(resurrection), v5(current)");
});

test("canonical: the current row is NEVER removable (no current-anchor orphaning)", () => {
  // Across a spread of shapes, the current version must never appear in the
  // removable set — the design.md "current anchor orphaning" guard.
  const shapes = [
    { current: 1, rows: [tx(1), tx(2), tx(3)] },
    { current: 2, rows: [tx(1), tx(2), tx(3)] },
    { current: 3, rows: [tx(1), tx(2), tx(3)] },
    { current: 2, rows: [tx(1), tx(2, { field: -1 }), tx(3)] },
    { current: 3, rows: [tx(1), row(2, null, { deleted: true }), tx(3)] },
  ];
  for (const { rows, current } of shapes) {
    const removable = selectRemovableVersions(rows, current, CHASE_TX_POLICY, "canonical");
    assert.ok(
      !removable.includes(current),
      `current v${current} must not be removable (got ${JSON.stringify(removable)})`
    );
  }
});

test("canonical: a single-version history removes nothing", () => {
  assert.deepEqual(selectRemovableVersions([tx(1)], 1, CHASE_TX_POLICY, "canonical"), []);
  assert.deepEqual(selectRemovableVersions([], 1, CHASE_TX_POLICY, "canonical"), []);
});

test("canonical: all-distinct-fingerprint history removes nothing (every version is a real boundary)", () => {
  const rows = [tx(1, { field: -1 }), tx(2, { field: -2 }), tx(3, { field: -3 })];
  assert.deepEqual(selectRemovableVersions(rows, 3, CHASE_TX_POLICY, "canonical"), []);
});

test("canonical floor is at or below the audit floor for the same history", () => {
  // Canonical can never RETAIN more than audit for any chase/transactions shape:
  // it removes a superset of audit's removable versions.
  const shapes = [
    [tx(1), tx(2), tx(3), tx(4), tx(5)],
    [tx(1), tx(2), tx(3, { field: -5000 }), tx(4, { field: -5000 })],
    [tx(1), tx(2), row(3, null, { deleted: true }), tx(4), tx(5)],
    [tx(1), tx(2, { field: -2 }), tx(3), tx(4, { field: -4 }), tx(5)],
  ];
  for (const rows of shapes) {
    const lastRow = rows.at(-1);
    assert.ok(lastRow, "shape must have at least one row");
    const current = lastRow.version;
    const auditRemovable: Set<number> = new Set(selectRemovableVersions(rows, current, CHASE_TX_POLICY, "audit"));
    const canonicalRemovable: Set<number> = new Set(
      selectRemovableVersions(rows, current, CHASE_TX_POLICY, "canonical")
    );
    for (const v of auditRemovable) {
      assert.ok(canonicalRemovable.has(v), `canonical must also remove audit-removable v${v}`);
    }
  }
});

// ─── Postgres-backed integration tests ──────────────────────────────────

if (POSTGRES_URL) {
  // Create the tables needed by compact-record-history on a fresh database.
  // This mirrors the schema in server/postgres-storage.js so that the tests
  // can run standalone against any empty Postgres database without requiring
  // initPostgresStorage() to have been called first.
  async function setupSchema(pool: pg.Pool): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS records (
        id BIGSERIAL PRIMARY KEY,
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        record_json JSONB NOT NULL,
        emitted_at TEXT NOT NULL,
        version BIGINT NOT NULL DEFAULT 1,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TEXT,
        cursor_value TEXT,
        primary_key_text TEXT NOT NULL,
        UNIQUE(connector_instance_id, stream, record_key)
      );
      CREATE TABLE IF NOT EXISTS record_changes (
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        version BIGINT NOT NULL,
        record_json JSONB,
        emitted_at TEXT NOT NULL,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TEXT,
        PRIMARY KEY(connector_instance_id, stream, version)
      );
      CREATE TABLE IF NOT EXISTS version_counter (
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        max_version BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY(connector_instance_id, stream)
      );
      CREATE TABLE IF NOT EXISTS retained_size_stream (
        connector_instance_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        current_record_json_bytes BIGINT NOT NULL DEFAULT 0,
        record_history_json_bytes BIGINT NOT NULL DEFAULT 0,
        blob_bytes BIGINT NOT NULL DEFAULT 0,
        record_count BIGINT NOT NULL DEFAULT 0,
        record_history_count BIGINT NOT NULL DEFAULT 0,
        blob_count BIGINT NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 1,
        computed_at TEXT,
        PRIMARY KEY(connector_instance_id, stream)
      );
      CREATE TABLE IF NOT EXISTS retained_size_connection (
        connector_instance_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        current_record_json_bytes BIGINT NOT NULL DEFAULT 0,
        record_history_json_bytes BIGINT NOT NULL DEFAULT 0,
        blob_bytes BIGINT NOT NULL DEFAULT 0,
        record_count BIGINT NOT NULL DEFAULT 0,
        record_history_count BIGINT NOT NULL DEFAULT 0,
        blob_count BIGINT NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 1,
        computed_at TEXT
      );
    `);
  }

  interface FixtureContext {
    backupTable: string;
    connectorId: string;
    connectorInstanceId: string;
    pool: pg.Pool;
    runId: string;
    stream: string;
  }

  async function withFixture(fn: (ctx: FixtureContext) => Promise<void>): Promise<void> {
    const pool = new Pool({ connectionString: POSTGRES_URL });
    await setupSchema(pool);
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_compact_${suffix}`;
    const connectorId = `slack_compact_${suffix}`;
    const stream = "workspace";
    const runId = `test_${suffix}`;
    const backupTable = `compact_record_history_backup_${runId}`;
    try {
      await fn({ backupTable, connectorId, connectorInstanceId, pool, runId, stream });
    } finally {
      try {
        await pool.query(`DROP TABLE IF EXISTS "${backupTable}"`);
      } catch {
        /* intentionally empty */
      }
      await pool.query("DELETE FROM record_changes WHERE connector_instance_id = $1", [connectorInstanceId]);
      await pool.query("DELETE FROM records WHERE connector_instance_id = $1", [connectorInstanceId]);
      await pool.query("DELETE FROM version_counter WHERE connector_instance_id = $1", [connectorInstanceId]);
      try {
        await pool.query("DELETE FROM retained_size_stream WHERE connector_instance_id = $1", [connectorInstanceId]);
      } catch {
        /* intentionally empty */
      }
      try {
        await pool.query("DELETE FROM retained_size_connection WHERE connector_instance_id = $1", [
          connectorInstanceId,
        ]);
      } catch {
        /* intentionally empty */
      }
      await pool.end();
    }
  }

  async function seedWorkspaceChurn({
    pool,
    connectorInstanceId,
    connectorId,
    stream,
    recordKey,
  }: {
    connectorId: string;
    connectorInstanceId: string;
    pool: pg.Pool;
    recordKey: string;
    stream: string;
  }): Promise<void> {
    // Seed the canonical churn shape — every version has the same
    // record_json modulo fetched_at, which is excluded from the slack
    // workspace fingerprint. v6 is the current row; the three
    // intermediates (v2, v3, v4) collapse into the v1 anchor; v5 is
    // retained because the selector pins the most-recent prior row
    // whose fingerprint differs from the current row when one exists.
    // In this fixture every row's fingerprint matches v6, so no such
    // pin exists and v5 collapses into v1 too — giving the canonical
    // shape: 6 versions in, removable = {2, 3, 4, 5}, retained = {1, 6}.
    //
    // We assert removableVersions === 4 (not 3) — the design.md hint of
    // "three intermediate, one fingerprint-differing" matches a different
    // shape that this test does not seed; the live offender (slack
    // workspace, 31k versions for a single fingerprint-stable record)
    // is closer to this seed.
    const payloadStable = (ts: string) => ({
      fetched_at: ts,
      id: recordKey,
      name: "Workspace",
      url: "https://example.com/",
    });
    const rows = [
      { p: payloadStable("2026-05-26T00:00:00Z"), v: 1 },
      { p: payloadStable("2026-05-26T00:01:00Z"), v: 2 },
      { p: payloadStable("2026-05-26T00:02:00Z"), v: 3 },
      { p: payloadStable("2026-05-26T00:03:00Z"), v: 4 },
      { p: payloadStable("2026-05-26T00:04:00Z"), v: 5 },
      { p: payloadStable("2026-05-26T00:05:00Z"), v: 6 },
    ];

    await pool.query(
      `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
       VALUES($1, $2, $3, $4)
       ON CONFLICT (connector_instance_id, stream) DO UPDATE SET max_version = EXCLUDED.max_version`,
      [connectorId, connectorInstanceId, stream, 6]
    );
    for (const r of rows) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await pool.query(
        `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
         VALUES($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE)`,
        [connectorId, connectorInstanceId, stream, recordKey, r.v, JSON.stringify(r.p), "2026-05-26T00:00:00Z"]
      );
    }
    // Current row points at v6.
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const currentRow = rows[5];
    assert.ok(currentRow, "seedWorkspaceChurn must seed a v6 row");
    await pool.query(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
       VALUES($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, $4)`,
      [connectorId, connectorInstanceId, stream, recordKey, JSON.stringify(currentRow.p), "2026-05-26T00:05:00Z", 6]
    );
  }

  test("plan reports removableVersions=4 for the canonical workspace fetched_at-only churn fixture", async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream }) => {
      const recordKey = "T-AAA";
      await seedWorkspaceChurn({ connectorId, connectorInstanceId, pool, recordKey, stream });
      const policy = findPolicy("slack", "workspace");
      assert.ok(policy, "slack/workspace policy must be registered");
      const plan = await planCompaction({ connectorInstanceId, limitKeys: null, policy, pool, stream });
      assert.equal(plan.scannedKeys, 1);
      assert.equal(plan.scannedVersions, 6);
      assert.equal(plan.removableVersions, 4);
      assert.equal(plan.retainedVersionsAfter, 2);
      assert.ok(plan.estimatedRemovedBytes > 0, "estimatedRemovedBytes should be positive");
    });
  });

  test("apply removes exactly the planned versions, populates backup, leaves current/version_counter untouched", async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream, runId, backupTable }) => {
      const recordKey = "T-BBB";
      await seedWorkspaceChurn({ connectorId, connectorInstanceId, pool, recordKey, stream });
      const policy = findPolicy("slack", "workspace");
      assert.ok(policy, "slack/workspace policy must be registered");

      // Snapshot the surviving rows + current + counter for byte-identity check.
      const beforeChanges = await pool.query(
        `SELECT version, record_json::text AS rj, emitted_at, deleted FROM record_changes
          WHERE connector_instance_id = $1 AND stream = $2 ORDER BY version`,
        [connectorInstanceId, stream]
      );
      const beforeRecord = await pool.query(
        "SELECT record_json::text AS rj, version FROM records WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      const beforeCounter = await pool.query(
        "SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = $2",
        [connectorInstanceId, stream]
      );

      const plan = await planCompaction({ connectorInstanceId, limitKeys: null, policy, pool, stream });
      const result = await applyCompaction({ plan, pool, runId });

      assert.equal(result.deleted, 4);
      assert.equal(result.inserted, 4);
      assert.equal(result.backupTable, backupTable);

      // Backup table has exactly four rows.
      const backupRows = await pool.query(`SELECT COUNT(*)::int AS c FROM "${backupTable}"`);
      assert.equal(backupRows.rows[0].c, 4);

      // The retained versions are 1 (first) and 6 (current).
      const remainingVersions = (
        await pool.query(
          "SELECT version FROM record_changes WHERE connector_instance_id = $1 AND stream = $2 ORDER BY version",
          [connectorInstanceId, stream]
        )
      ).rows.map((r) => Number(r.version));
      assert.deepEqual(remainingVersions, [1, 6]);

      // Surviving rows are byte-identical to before (compare on the rows that remain).
      const afterChangesMap = new Map(
        (
          await pool.query(
            `SELECT version, record_json::text AS rj, emitted_at, deleted FROM record_changes
            WHERE connector_instance_id = $1 AND stream = $2 ORDER BY version`,
            [connectorInstanceId, stream]
          )
        ).rows.map((r) => [Number(r.version), r])
      );
      for (const b of beforeChanges.rows) {
        const v = Number(b.version);
        if (![1, 6].includes(v)) {
          continue;
        }
        const a = afterChangesMap.get(v);
        assert.ok(a, `version ${v} must survive`);
        assert.equal(a.rj, b.rj, `version ${v} record_json must be byte-identical`);
        assert.equal(a.emitted_at, b.emitted_at);
        assert.equal(!!a.deleted, !!b.deleted);
      }

      // Current row untouched.
      const afterRecord = await pool.query(
        "SELECT record_json::text AS rj, version FROM records WHERE connector_instance_id = $1",
        [connectorInstanceId]
      );
      assert.equal(afterRecord.rows[0].rj, beforeRecord.rows[0].rj);
      assert.equal(Number(afterRecord.rows[0].version), Number(beforeRecord.rows[0].version));

      // version_counter untouched.
      const afterCounter = await pool.query(
        "SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = $2",
        [connectorInstanceId, stream]
      );
      assert.equal(Number(afterCounter.rows[0].max_version), Number(beforeCounter.rows[0].max_version));
    });
  });

  test("markScopeDirty flips retained_size_stream.dirty for the scope", async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream }) => {
      // Seed a retained_size_stream row in the clean state so we can
      // observe the flip.
      await pool.query(
        `INSERT INTO retained_size_stream
           (connector_instance_id, connector_id, stream,
            current_record_json_bytes, record_history_json_bytes, blob_bytes,
            record_count, record_history_count, blob_count,
            dirty, computed_at)
         VALUES($1, $2, $3, 0, 0, 0, 0, 0, 0, 0, NOW()::text)
         ON CONFLICT (connector_instance_id, stream) DO UPDATE
           SET dirty = 0`,
        [connectorInstanceId, connectorId, stream]
      );
      const before = await pool.query(
        `SELECT dirty FROM retained_size_stream
           WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream]
      );
      assert.equal(Number(before.rows[0].dirty), 0);

      await markScopeDirty({ connectorInstanceId, pool, stream });

      const after = await pool.query(
        `SELECT dirty FROM retained_size_stream
           WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream]
      );
      assert.equal(Number(after.rows[0].dirty), 1, "markScopeDirty must flip dirty=1");
    });
  });

  test("CLI: unknown (connector_id, stream) pair refuses to run", () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--connector-instance-id=cin_unknown", "--stream=messages", "--connector-id=slack"],
      { encoding: "utf8", env: { ...process.env, PDPP_TEST_POSTGRES_URL: POSTGRES_URL } }
    );
    assert.notEqual(r.status, 0, "must exit non-zero for unknown policy");
    assert.match(r.stderr + r.stdout, REGEXP_10);
    assert.match(r.stderr + r.stdout, REGEXP_1);
  });

  test("CLI: unknown stream on a registered connector still refuses", () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--connector-instance-id=cin_unknown", "--stream=context_mode", "--connector-id=codex"],
      { encoding: "utf8", env: { ...process.env, PDPP_TEST_POSTGRES_URL: POSTGRES_URL } }
    );
    assert.notEqual(r.status, 0, "must exit non-zero for unknown stream under a registered connector");
    assert.match(r.stderr + r.stdout, REGEXP_2);
  });

  test("CLI: unknown connector (chatgpt) refuses even on a stream name that exists elsewhere", () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--connector-instance-id=cin_unknown", "--stream=messages", "--connector-id=chatgpt"],
      { encoding: "utf8", env: { ...process.env, PDPP_TEST_POSTGRES_URL: POSTGRES_URL } }
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, REGEXP_3);
  });

  test("CLI: --apply without database credentials refuses to run", () => {
    const env = { ...process.env };
    env.PDPP_DATABASE_URL = undefined;
    env.PDPP_TEST_POSTGRES_URL = undefined;
    const r = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--connector-instance-id=cin_anything", "--stream=workspace", "--connector-id=slack", "--apply"],
      { encoding: "utf8", env }
    );
    assert.notEqual(r.status, 0, "must exit non-zero without DB creds");
    assert.match(r.stderr + r.stdout, REGEXP_4);
  });

  test("CLI: invalid --limit-keys refuses to run", () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--connector-instance-id=cin_x", "--stream=workspace", "--connector-id=slack", "--limit-keys=-3"],
      { encoding: "utf8", env: { ...process.env, PDPP_TEST_POSTGRES_URL: POSTGRES_URL } }
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, REGEXP_5);
  });

  test("exact-JSON identity policy compacts codex/messages adjacent duplicates and pins boundaries", async () => {
    // Seed a codex/messages key with the shape we see in the live DB:
    // adjacent versions whose record_json is byte-identical (no fetched_at
    // to exclude). The selector should collapse adjacent same-JSON runs
    // while pinning the first version, the current version, and the
    // most-recent prior version with a *different* fingerprint.
    const pool = new Pool({ connectionString: POSTGRES_URL });
    await setupSchema(pool);
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_compact_codex_${suffix}`;
    const connectorId = "local-device:codex";
    const stream = "messages";
    const recordKey = `session_${suffix}:1`;
    const runId = `test_${suffix}`;
    const backupTable = `compact_record_history_backup_${runId}`;
    try {
      // Sequence: A A A B B (current is v5)
      //   v1 first → retain
      //   v2 same fp as v1 surviving anchor → remove
      //   v3 same fp as v1 surviving anchor → remove
      //   v4: prev surviving is v1 (A), different fp (B) → retain
      //        (also: most-recent-prior-with-different-fp from v5 is v4? no —
      //         v4 has same fp (B) as current v5. The most-recent-prior with
      //         a *different* fp is v3 (A). v3 was marked removable above —
      //         but the selector pins it as most-recent-differing-prior, so
      //         it must be retained instead. So removable = [v2], retained
      //         = [v1, v3, v4, v5]).
      //   v5: current → retain
      const payloadA = {
        content: "hello",
        id: recordKey,
        role: "user",
        session_id: `session_${suffix}`,
        timestamp: "2026-05-26T10:00:00.000Z",
        type: "user",
      };
      const payloadB = {
        ...payloadA,
        content: "hello world",
      };
      const rows = [
        { p: payloadA, v: 1 },
        { p: payloadA, v: 2 },
        { p: payloadA, v: 3 },
        { p: payloadB, v: 4 },
        { p: payloadB, v: 5 },
      ];
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, $4)
         ON CONFLICT (connector_instance_id, stream) DO UPDATE SET max_version = EXCLUDED.max_version`,
        [connectorId, connectorInstanceId, stream, 5]
      );
      for (const r of rows) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        await pool.query(
          `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
           VALUES($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE)`,
          [connectorId, connectorInstanceId, stream, recordKey, r.v, JSON.stringify(r.p), "2026-05-26T10:00:00.000Z"]
        );
      }
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, $4)`,
        [connectorId, connectorInstanceId, stream, recordKey, JSON.stringify(payloadB), "2026-05-26T10:00:05.000Z", 5]
      );

      const policy = findPolicy("codex", "messages");
      assert.ok(policy, "codex/messages policy must be registered");

      const plan = await planCompaction({ connectorInstanceId, limitKeys: null, policy, pool, stream });
      assert.equal(plan.scannedKeys, 1);
      assert.equal(plan.scannedVersions, 5);
      assert.equal(
        plan.removableVersions,
        1,
        "only v2 should be removable (v3 pinned as most-recent-differing-prior wrt B, v4 retained as different fp)"
      );
      assert.ok(plan.connectorIdsSeen.includes("local-device:codex"));

      const result = await applyCompaction({ plan, pool, runId });
      assert.equal(result.deleted, 1);
      assert.equal(result.inserted, 1);
      assert.equal(result.backupTable, backupTable);

      const remaining = (
        await pool.query(
          "SELECT version FROM record_changes WHERE connector_instance_id = $1 AND stream = $2 ORDER BY version",
          [connectorInstanceId, stream]
        )
      ).rows.map((r) => Number(r.version));
      assert.deepEqual(remaining, [1, 3, 4, 5]);

      const backupRows = await pool.query(`SELECT version FROM "${backupTable}" ORDER BY version`);
      assert.deepEqual(
        backupRows.rows.map((r) => Number(r.version)),
        [2]
      );
    } finally {
      try {
        await pool.query(`DROP TABLE IF EXISTS "${backupTable}"`);
      } catch {
        /* intentionally empty */
      }
      await pool.query("DELETE FROM record_changes WHERE connector_instance_id = $1", [connectorInstanceId]);
      await pool.query("DELETE FROM records WHERE connector_instance_id = $1", [connectorInstanceId]);
      await pool.query("DELETE FROM version_counter WHERE connector_instance_id = $1", [connectorInstanceId]);
      try {
        await pool.query("DELETE FROM retained_size_stream WHERE connector_instance_id = $1", [connectorInstanceId]);
      } catch {
        /* intentionally empty */
      }
      try {
        await pool.query("DELETE FROM retained_size_connection WHERE connector_instance_id = $1", [
          connectorInstanceId,
        ]);
      } catch {
        /* intentionally empty */
      }
      await pool.end();
    }
  });

  test("apply on an already-clean stream removes zero rows and creates no rows in backup", async () => {
    await withFixture(async ({ pool, connectorInstanceId, connectorId, stream, runId }) => {
      const recordKey = "T-CCC";
      // Seed only two distinct-fingerprint versions and current.
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, 2)`,
        [connectorId, connectorInstanceId, stream]
      );
      for (const v of [
        { p: { id: recordKey, name: "A" }, v: 1 },
        { p: { id: recordKey, name: "B" }, v: 2 },
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        await pool.query(
          `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
           VALUES($1, $2, $3, $4, $5, $6::jsonb, '2026-05-26T00:00:00Z', FALSE)`,
          [connectorId, connectorInstanceId, stream, recordKey, v.v, JSON.stringify(v.p)]
        );
      }
      await pool.query(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES($1, $2, $3, $4, $5::jsonb, '2026-05-26T00:00:00Z', 2, FALSE, $4)`,
        [connectorId, connectorInstanceId, stream, recordKey, JSON.stringify({ id: recordKey, name: "B" })]
      );
      const policy = findPolicy("slack", "workspace");
      assert.ok(policy, "slack/workspace policy must be registered");
      const plan = await planCompaction({ connectorInstanceId, limitKeys: null, policy, pool, stream });
      assert.equal(plan.removableVersions, 0);
      const result = await applyCompaction({ plan, pool, runId });
      assert.equal(result.deleted, 0);
      assert.equal(result.inserted, 0);
      assert.equal(result.backupTable, null, "no-op apply does not create a backup table");
    });
  });

  // ─── Canonical-mode convergence regression (task 3.5) ──────────────────

  test("canonical: chase/transactions metadata-churn history compacts to one retained current survivor per key", async () => {
    // Reproduces the live offender shape (chase-transaction-immutable-ratio-
    // 20260605.md): every transaction was re-emitted each run with a fresh
    // `fetched_at`/`source`, so each key accumulated many versions that share
    // ONE canonical fingerprint after the policy exclusions. Canonical mode must
    // converge each key to exactly its current `records.version` row (the 4605→
    // 1145 / 1.000-ratio shape), while audit mode keeps the conservative
    // first+current (the 4605→2289 / ~2.0-ratio shape).
    const pool = new Pool({ connectionString: POSTGRES_URL });
    await setupSchema(pool);
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_compact_chasetx_${suffix}`;
    const connectorId = "chase";
    const stream = "transactions";
    const runId = `test_${suffix}`;
    const backupTable = `compact_record_history_backup_${runId}`;

    // Three keys, each with 5 metadata-churn versions (only fetched_at/source
    // move). Per key: stored=5, semantic=1 → canonical keeps 1 (current),
    // audit keeps 2 (first+current).
    const keyCount = 3;
    const versionsPerKey = 5;
    const txBody = (key: string, run: string, ts: string) => ({
      account_id: "INTACC123",
      amount: -4599,
      check_number: null,
      currency: "USD",
      date: "2026-04-10",
      fetched_at: ts,
      fitid: key.split("|")[1],
      id: key,
      memo: null,
      name: "COFFEE SHOP",
      reference_number: null,
      source: `qfx_download_${run}_2026-04-10`,
      type: "DEBIT",
    });

    try {
      await pool.query(
        `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
         VALUES($1, $2, $3, $4)
         ON CONFLICT (connector_instance_id, stream) DO UPDATE SET max_version = EXCLUDED.max_version`,
        [connectorId, connectorInstanceId, stream, keyCount * versionsPerKey]
      );
      let version = 0;
      for (let k = 0; k < keyCount; k += 1) {
        const recordKey = `INTACC123|FITID-${String(k).padStart(4, "0")}`;
        let lastBody: ReturnType<typeof txBody> | undefined;
        for (let v = 0; v < versionsPerKey; v += 1) {
          version += 1;
          // Alternate the acquisition mode + advance the run clock so EVERY
          // version differs on excluded metadata only.
          const run = v % 2 === 0 ? "all" : "since_last_statement";
          const ts = `2026-06-0${v + 1}T10:00:00.000Z`;
          lastBody = txBody(recordKey, run, ts);
          // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
          await pool.query(
            `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
             VALUES($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE)`,
            [connectorId, connectorInstanceId, stream, recordKey, version, JSON.stringify(lastBody), ts]
          );
        }
        // Current row = the last (highest-version) observation for this key.
        assert.ok(lastBody, `at least one version must have been seeded for ${recordKey}`);
        await pool.query(
          `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
           VALUES($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, $4)`,
          [connectorId, connectorInstanceId, stream, recordKey, JSON.stringify(lastBody), lastBody.fetched_at, version]
        );
      }

      const policy = findPolicy("chase", "transactions");
      assert.ok(policy, "chase/transactions policy must be registered");
      assert.ok(isCanonicalEligible(policy), "chase/transactions must be canonical-eligible");

      const totalVersions = keyCount * versionsPerKey;

      // Audit mode: keeps first + current per key → 2 retained per key.
      const auditPlan = await planCompaction({
        connectorInstanceId,
        limitKeys: null,
        mode: "audit",
        policy,
        pool,
        stream,
      });
      assert.equal(auditPlan.scannedKeys, keyCount);
      assert.equal(auditPlan.scannedVersions, totalVersions);
      assert.equal(auditPlan.retainedVersionsAfter, keyCount * 2, "audit keeps first + current per key");

      // Canonical mode: keeps only the current row per key → 1 retained per key.
      const canonicalPlan = await planCompaction({
        connectorInstanceId,
        limitKeys: null,
        mode: "canonical",
        policy,
        pool,
        stream,
      });
      assert.equal(canonicalPlan.mode, "canonical");
      assert.equal(canonicalPlan.scannedVersions, totalVersions);
      assert.equal(
        canonicalPlan.removableVersions,
        totalVersions - keyCount,
        "canonical removes all but one (current) version per key"
      );
      assert.equal(
        canonicalPlan.retainedVersionsAfter,
        keyCount,
        "canonical converges to one retained current survivor per key (1.000 ratio)"
      );

      // Apply canonical and confirm convergence on disk.
      const result = await applyCompaction({ plan: canonicalPlan, pool, runId });
      assert.equal(result.deleted, totalVersions - keyCount);

      const retained = (
        await pool.query(
          "SELECT count(*)::int AS c FROM record_changes WHERE connector_instance_id = $1 AND stream = $2",
          [connectorInstanceId, stream]
        )
      ).rows[0].c;
      assert.equal(retained, keyCount, "one retained history version per key after canonical apply");

      // Every current row still has a matching retained history row at its
      // version (no current-anchor orphaning — the design.md safety assertion).
      const orphans = (
        await pool.query(
          `SELECT count(*)::int AS c
           FROM records r
          WHERE r.connector_instance_id = $1 AND r.stream = $2
            AND NOT EXISTS (
              SELECT 1 FROM record_changes c
               WHERE c.connector_instance_id = r.connector_instance_id
                 AND c.stream = r.stream
                 AND c.record_key = r.record_key
                 AND c.version = r.version)`,
          [connectorInstanceId, stream]
        )
      ).rows[0].c;
      assert.equal(orphans, 0, "every current records.version has a matching retained history row");

      // Idempotence: re-running canonical after apply finds nothing more.
      const idempotentPlan = await planCompaction({
        connectorInstanceId,
        limitKeys: null,
        mode: "canonical",
        policy,
        pool,
        stream,
      });
      assert.equal(idempotentPlan.removableVersions, 0, "canonical apply is idempotent");
    } finally {
      try {
        await pool.query(`DROP TABLE IF EXISTS "${backupTable}"`);
      } catch {
        /* intentionally empty */
      }
      await pool.query("DELETE FROM record_changes WHERE connector_instance_id = $1", [connectorInstanceId]);
      await pool.query("DELETE FROM records WHERE connector_instance_id = $1", [connectorInstanceId]);
      await pool.query("DELETE FROM version_counter WHERE connector_instance_id = $1", [connectorInstanceId]);
      try {
        await pool.query("DELETE FROM retained_size_stream WHERE connector_instance_id = $1", [connectorInstanceId]);
      } catch {
        /* intentionally empty */
      }
      try {
        await pool.query("DELETE FROM retained_size_connection WHERE connector_instance_id = $1", [
          connectorInstanceId,
        ]);
      } catch {
        /* intentionally empty */
      }
      await pool.end();
    }
  });

  test("canonical: planCompaction refuses an ineligible stream (fail-closed apply guard)", async () => {
    // The deny-by-default gate must throw before any planning for a policy that
    // is not canonical-eligible — an ineligible stream can never reach the
    // destructive path even via the programmatic API.
    const pool = new Pool({ connectionString: POSTGRES_URL });
    try {
      const policy = findPolicy("chase", "accounts");
      assert.ok(policy && !isCanonicalEligible(policy));
      await assert.rejects(
        () =>
          planCompaction({
            connectorInstanceId: "cin_does_not_matter",
            limitKeys: null,
            mode: "canonical",
            policy,
            pool,
            stream: "accounts",
          }),
        REGEXP_6
      );
    } finally {
      await pool.end();
    }
  });
} else {
  test("compact-record-history DB tests (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    /* intentionally empty */
  });
}
