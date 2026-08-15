// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CollectionReportEntry, RuntimeCollectionFact } from "../server/ref-control.ts";
import { buildCollectionReport } from "../server/ref-control.ts";

type ManifestStreamFixture = Parameters<typeof buildCollectionReport>[0]["manifestStreams"][number];

// Deterministic reproductions for the 2026-07-10 live-audit rows
// (openspec/changes/define-stream-coverage-freshness-evidence tasks.md 8.4):
// parse the REAL shipped manifests and feed the steady-state fact block each
// connector emits, then assert the projected per-stream coverage condition.
// This pins the whole declaration+classification chain — a manifest edit that
// drops a strategy, or a classifier change that stops honoring one, fails
// here by name rather than resting unmeasured on the live instance.

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = join(HERE, "..", "..", "packages", "polyfill-connectors", "manifests");

interface ShippedManifest {
  file: string;
  manifest: Record<string, unknown>;
}

function shippedPolyfillManifests(): ShippedManifest[] {
  return readdirSync(MANIFESTS_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      manifest: JSON.parse(readFileSync(join(MANIFESTS_DIR, file), "utf8")) as Record<string, unknown>,
    }));
}

function manifestStreamsFromValue(manifest: Record<string, unknown>): ManifestStreamFixture[] {
  const { streams } = manifest;
  assert.ok(Array.isArray(streams) && streams.length > 0, "manifest declares streams");
  return streams as ManifestStreamFixture[];
}

function manifestStreams(connectorId: string): ManifestStreamFixture[] {
  const manifest: unknown = JSON.parse(readFileSync(join(MANIFESTS_DIR, `${connectorId}.json`), "utf8"));
  assert.ok(
    manifest && typeof manifest === "object" && !Array.isArray(manifest),
    `${connectorId} manifest is an object`
  );
  return manifestStreamsFromValue(manifest as Record<string, unknown>);
}

/** A steady-state committed-checkpoint fact (STATE emitted, zero new records). */
function committedFact(stream: string): RuntimeCollectionFact {
  return {
    checkpoint: "committed",
    collected: 0,
    considered: null,
    covered: null,
    pending_detail_gaps: 0,
    skipped: null,
    stream,
  };
}

/** A steady-state parent-detail fact: enumerated denominator, everything accounted. */
function accountedFact(stream: string, considered: number): RuntimeCollectionFact {
  return {
    checkpoint: "not_staged",
    collected: 0,
    considered,
    covered: considered,
    pending_detail_gaps: 0,
    skipped: null,
    stream,
  };
}

function report(connectorId: string, streams: readonly RuntimeCollectionFact[]): CollectionReportEntry[] {
  return buildCollectionReport({
    attentionOpen: false,
    collectionFacts: { streams },
    freshness: "fresh",
    manifestStreams: manifestStreams(connectorId),
    refresh: null,
  });
}

function condition(entries: readonly CollectionReportEntry[], stream: string): string {
  const entry = entries.find((e) => e.stream === stream);
  assert.ok(entry, `entry for ${stream}`);
  return entry.coverage_condition;
}

// The audit-named streams, per connector, with the steady-state fact class
// the connector emits at HEAD for each (checkpoint commit vs accounted
// parent-detail denominator).
//
// These two blocks now split on the ruling that a committed checkpoint alone
// never proves coverage. `ACCOUNTED_PROOF_CASES` carries a measured denominator
// and stays `complete`. `CHECKPOINT_ONLY_CASES` carries no coverage evidence at
// all — only a committed cursor — so it reads `unknown`: honest "not proven",
// NOT a claim that data is missing. The connectors below close this by
// declaring `considered` at their enumeration sites; until they do, the
// projection must not synthesize completeness on their behalf.
const CHECKPOINT_ONLY_CASES = {
  amazon: ["orders"],
  chase: ["current_activity"],
  chatgpt: ["custom_gpts", "custom_instructions", "memories", "shared_conversations"],
  github: ["user", "user_stats"],
  gmail: ["messages", "threads", "labels"],
  reddit: ["comments", "downvoted", "hidden", "saved", "submitted", "upvoted"],
  usaa: ["account_stats", "credit_card_billing", "credit_card_billing_stats", "inbox_messages"],
  whatsapp: ["chats", "messages"],
  ynab: [
    "accounts",
    "account_stats",
    "categories",
    "category_groups",
    "month_categories",
    "months",
    "payee_locations",
    "payees",
    "scheduled_transactions",
    "transactions",
  ],
};

const ACCOUNTED_PROOF_CASES = {
  chase: ["statements", "transactions", "balances"],
  usaa: ["statements", "transactions"],
};

for (const [connectorId, streams] of Object.entries(CHECKPOINT_ONLY_CASES)) {
  test(`shipped ${connectorId} manifest: a committed checkpoint alone leaves the audit-named streams unproven`, () => {
    const entries = report(
      connectorId,
      streams.map((stream) => committedFact(stream))
    );
    for (const stream of streams) {
      assert.equal(condition(entries, stream), "unknown", `${connectorId}/${stream}`);
    }
  });

  test(`shipped ${connectorId} manifest: a measured enumeration boundary proves the audit-named streams complete`, () => {
    const entries = report(
      connectorId,
      streams.map((stream) => ({ ...committedFact(stream), considered: 3, covered: 3 }))
    );
    for (const stream of streams) {
      assert.equal(condition(entries, stream), "complete", `${connectorId}/${stream}`);
    }
  });
}

for (const [connectorId, streams] of Object.entries(ACCOUNTED_PROOF_CASES)) {
  test(`shipped ${connectorId} manifest: steady-state accounted denominators classify the audit-named parent-detail streams complete`, () => {
    const entries = report(
      connectorId,
      streams.map((stream) => accountedFact(stream, 4))
    );
    for (const stream of streams) {
      assert.equal(condition(entries, stream), "complete", `${connectorId}/${stream}`);
    }
  });
}

for (const { file, manifest } of shippedPolyfillManifests()) {
  const fullInventoryStreams = manifestStreamsFromValue(manifest).filter(
    (stream) => stream.coverage_strategy === "full_inventory"
  );
  if (fullInventoryStreams.length === 0) {
    continue;
  }

  test(`shipped ${file}: full-inventory evidence is required and record count is not evidence`, () => {
    const streams = fullInventoryStreams.map((stream) => stream.name);
    const measured = report(
      file.slice(0, -5),
      streams.map((stream) => accountedFact(stream, 6551))
    );
    const unmeasured = report(
      file.slice(0, -5),
      streams.map((stream) => ({ ...committedFact(stream), collected: 6551 }))
    );

    for (const stream of streams) {
      assert.equal(condition(measured, stream), "complete", `${file}/${stream} measured boundary`);
      assert.equal(condition(unmeasured, stream), "unknown", `${file}/${stream} record count without evidence`);
    }
  });
}

test("shipped usaa manifest: a zero-candidate steady-state run (considered 0 / covered 0) classifies complete, not unmeasured", () => {
  const entries = report("usaa", [accountedFact("statements", 0), accountedFact("transactions", 0)]);
  assert.equal(condition(entries, "statements"), "complete");
  assert.equal(condition(entries, "transactions"), "complete");
});

test("shipped chase manifest: every considered account no_activity this run (zero balance records, considered==covered) classifies complete, not unmeasured (the 2026-07-10 live regression)", () => {
  const entries = report("chase", [accountedFact("balances", 2)]);
  assert.equal(condition(entries, "balances"), "complete");
});

test("shipped chase manifest: zero eligible accounts after a completed enumeration classifies BOTH balances and transactions complete, not unmeasured (the systemic account-detail known-zero fix)", () => {
  const entries = report("chase", [accountedFact("balances", 0), accountedFact("transactions", 0)]);
  assert.equal(condition(entries, "balances"), "complete");
  assert.equal(condition(entries, "transactions"), "complete");
});

test("shipped slack manifest: stars/user_groups/reminders/dm_read_states are ordinary collected full-inventory streams, not accepted absence", () => {
  // As of complete-slack-bundled-connector-coverage, these four streams are
  // directly collected via the connector's existing xoxc+cookie credential
  // (stars.list/usergroups.list/reminders.list/conversations.info) — they no
  // longer declare coverage_policy:deferred. With a measured boundary they
  // classify complete exactly like channel_stats; absent any fact, per the
  // audit contract, they rest honestly unknown, never a stale
  // accepted-absence label.
  const measured = (stream: string): RuntimeCollectionFact => ({
    ...committedFact(stream),
    considered: 3,
    covered: 3,
  });
  const proven = report("slack", [
    measured("channel_stats"),
    measured("stars"),
    measured("user_groups"),
    measured("reminders"),
    measured("dm_read_states"),
  ]);
  for (const stream of ["channel_stats", "stars", "user_groups", "reminders", "dm_read_states"]) {
    assert.equal(condition(proven, stream), "complete", `${stream} classifies complete once measured`);
  }

  // A committed checkpoint with no measurement is not accepted-absence either —
  // it is simply unproven.
  const committedOnly = report("slack", [committedFact("stars")]);
  assert.equal(condition(committedOnly, "stars"), "unknown", "a committed cursor alone proves nothing");

  const unmeasured = report("slack", [committedFact("channel_stats")]);
  for (const stream of ["stars", "user_groups", "reminders", "dm_read_states"]) {
    assert.equal(
      condition(unmeasured, stream),
      "unknown",
      `${stream} rests unknown with no fact, not accepted-absence`
    );
  }
});

test("shipped gmail manifest: message_bodies inherits the messages checkpoint through state_stream within one run", () => {
  const entries = buildCollectionReport({
    attentionOpen: false,
    collectionFacts: {
      streams: [
        committedFact("messages"),
        {
          checkpoint: "not_staged",
          collected: 0,
          // A measured boundary the child's OWN numerator does not satisfy
          // (0 of 2): as a `checkpoint_window` stream its `collected` counts
          // only changed records, so reaching `complete` requires the window to
          // be closed — which here can only come from the parent's inherited
          // committed checkpoint. That keeps the inheritance load-bearing.
          considered: 2,
          covered: null,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "message_bodies",
        },
      ],
    },
    collectionFactsRunId: "run_now",
    freshness: "fresh",
    manifestStreams: manifestStreams("gmail"),
    refresh: null,
  });
  assert.equal(condition(entries, "message_bodies"), "complete");
});

test("shipped gmail manifest: bounded pages stay retryable until final per-run coverage is complete", () => {
  const manifest = manifestStreams("gmail");
  const messages = manifest.find((stream) => stream.name === "messages");
  assert.ok(messages, "the shipped Gmail manifest declares messages");
  assert.equal(messages.coverage_strategy, "checkpoint_window");
  assert.equal(messages.freshness_strategy, "scheduled_window");

  const boundedPages = [
    report("gmail", [
      {
        checkpoint: "committed",
        collected: 2,
        considered: null,
        covered: null,
        pending_detail_gaps: 0,
        skipped: { reason: "historical_backfill_pending", recovery_action: "retry_by_runtime" },
        stream: "messages",
      },
    ]),
    report("gmail", [
      {
        checkpoint: "committed",
        collected: 2,
        considered: 2,
        covered: 2,
        pending_detail_gaps: 0,
        skipped: null,
        stream: "messages",
      },
    ]),
  ] as const;
  assert.equal(condition(boundedPages[0], "messages"), "retryable_gap");
  assert.equal(condition(boundedPages[1], "messages"), "complete");

  const threadPartial = report("gmail", [
    {
      checkpoint: "committed",
      collected: 1,
      considered: null,
      covered: null,
      pending_detail_gaps: 0,
      skipped: { reason: "historical_backfill_pending", recovery_action: "retry_by_runtime" },
      stream: "threads",
    },
  ]);
  assert.equal(condition(threadPartial, "threads"), "retryable_gap");

  const poison = report("gmail", [
    {
      checkpoint: "committed",
      collected: 1,
      considered: null,
      covered: null,
      pending_detail_gaps: 0,
      skipped: { reason: "historical_message_unaccounted" },
      stream: "messages",
    },
  ]);
  assert.equal(condition(poison, "messages"), "terminal_gap");
});

test("shipped manifests: a required stream with NO steady-state fact still rests unknown (the audit contract, not a blanket green)", () => {
  const entries = report("chase", [committedFact("current_activity")]);
  assert.equal(condition(entries, "balances"), "unknown", "no fact -> unknown; only real evidence classifies complete");
});
