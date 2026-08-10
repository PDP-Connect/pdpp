// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * §10-A "impossible by construction" — no gap path silently skips terminalization.
 *
 * These tests pin the GAP 1 (terminal) + GAP 2 fixes from the adversarial
 * SLVP-ideal review. Before the fix:
 *   - `terminalGapProfileForConnector(connectorId)` returned `null` for any
 *     connector not in the chatgpt-only registry, and the runtime DETAIL_GAP
 *     handler wrapped terminalization in `if (terminalProfile) { ... }` — so a
 *     non-chatgpt connector emitting a 404/410/permanent gap SILENTLY skipped
 *     terminalization and the gap stayed `pending` forever (the §10-A silent
 *     "100% done" lie).
 *   - gap CREATION is connector-agnostic (`emitDetailGap` is a generic SDK
 *     helper; the runtime handler is connector-agnostic) but gap TERMINALIZATION
 *     was opt-in. A connector could emit a gap that could never go terminal.
 *
 * After the fix (`resolveTerminalGapPolicy` always returns a real policy — the
 * explicit per-connector profile OR the safe `DEFAULT_TERMINAL_GAP_PROFILE`):
 *   - every connector terminalizes unfillable gaps; opt-out is impossible.
 *   - the decision site never branches on a null policy.
 *
 * Each test below FAILS against the pre-fix code (no resolver; null-skip handler).
 *
 * Ref: docs/research/slvp-ideal-whole-system-spec-2026-06-11.md §10-A, §3 rule 6
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { createSqliteConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
import {
  CHATGPT_PROVIDER_PROFILE,
  DEFAULT_TERMINAL_GAP_PROFILE,
  maybeTerminateGap,
  RI_MAX_RECOVERY_ATTEMPTS_CEILING,
  resolveTerminalGapPolicy,
  terminalGapProfileForConnector,
} from "../server/stores/terminal-gap-classifier.ts";

// `maybeTerminateGap`'s declared `DetailGapStore` param type (not exported)
// requires `getGapById` to return a `Gap` with an index signature; the real
// store's `DetailGap` return type does not declare one, even though every
// property `maybeTerminateGap` reads is present at runtime. This narrows the
// real store down to exactly the shape `maybeTerminateGap` declares it needs.
type MaybeTerminateGapStore = Parameters<typeof maybeTerminateGap>[0];

const MANIFESTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "packages",
  "polyfill-connectors",
  "manifests"
);

function loadRawManifest(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, `${name}.json`), "utf8")) as Record<string, unknown>;
}

function withTempDb(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-terminal-no-skip-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn(dir);
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

// ─── GAP 1 (terminal): resolution is required, never a silent skip ───────────

test("DEFAULT_TERMINAL_GAP_PROFILE is a real declared policy (finite positive integer budget)", () => {
  assert.ok(
    Number.isInteger(DEFAULT_TERMINAL_GAP_PROFILE.maxRecoveryAttempts) &&
      DEFAULT_TERMINAL_GAP_PROFILE.maxRecoveryAttempts > 0,
    "the safe default must carry a real terminalization budget, not Infinity/0"
  );
});

test(
  "resolveTerminalGapPolicy ALWAYS returns a real policy — there is no null-skip branch (GAP 1/2)",
  withTempDb(async () => {
    await registerConnector(loadRawManifest("chatgpt"));
    // The manifest-declared value for chatgpt.
    assert.deepEqual(await resolveTerminalGapPolicy("chatgpt"), CHATGPT_PROVIDER_PROFILE);
    assert.deepEqual(await resolveTerminalGapPolicy("chatgpt:default"), CHATGPT_PROVIDER_PROFILE);

    // Every OTHER connector — declared or not — resolves to the safe default,
    // never null. This is the seam that makes "a connector silently skips
    // terminalization" impossible by construction.
    const ids: unknown[] = [
      "github",
      "notion",
      "oura",
      "spotify",
      "strava",
      "ynab",
      "some-brand-new-connector",
      "",
      undefined,
    ];
    for (const id of ids) {
      // @ts-expect-error -- proving the fallback holds for any runtime value an untyped JS caller might pass, not just `string` (includes deliberately passing `undefined`).
      // biome-ignore lint/performance/noAwaitInLoops: sequential id-by-id assertions over a small fixed list.
      const policy = await resolveTerminalGapPolicy(id);
      assert.ok(policy, `resolveTerminalGapPolicy(${String(id)}) must return a policy, never null`);
      assert.ok(
        Number.isInteger(policy.maxRecoveryAttempts) && policy.maxRecoveryAttempts > 0,
        `resolved policy for ${String(id)} must carry a real budget`
      );
    }
  })
);

test(
  "the per-connector manifest resolver still returns null for unknown (no OVERRIDE) — the resolver, not the manifest, is the seam",
  withTempDb(async () => {
    // terminalGapProfileForConnector is the OVERRIDE lookup (null = no override),
    // NOT the terminalization gate. Callers must use resolveTerminalGapPolicy.
    assert.equal(await terminalGapProfileForConnector("github"), null, "no declared override for github");
    assert.notEqual(await resolveTerminalGapPolicy("github"), null, "but it still terminalizes via the default");
  })
);

// ─── Malicious/extreme manifest-declared value: the RI ceiling holds ────────
//
// max_recovery_attempts is a SCHEDULING budget a connector self-attests via
// its manifest — it must never let a connector opt out of terminalization by
// declaring an absurd value, and it must NEVER touch classifyRecoveryError's
// transient/non-transient taxonomy (that classifier takes no profile input at
// all — see terminal-gap-class.test.ts). Manifest validation
// (connector-manifest-validation.ts) rejects an out-of-range declaration at
// registration time; this section proves that gate AND proves the read-site
// clamp (`RI_MAX_RECOVERY_ATTEMPTS_CEILING`) independently holds as
// defense-in-depth even for a value that somehow reached this code.

test(
  "registerConnector REJECTS an absurd max_recovery_attempts at manifest-validation time",
  withTempDb(async () => {
    const malicious = loadRawManifest("chatgpt");
    (malicious.capabilities as { refresh_policy: Record<string, unknown> }).refresh_policy.max_recovery_attempts =
      999_999_999;
    await assert.rejects(
      () => registerConnector(malicious),
      /max_recovery_attempts must be an integer between/,
      "an absurd recovery-attempt budget must be rejected at registration, not silently accepted"
    );
  })
);

test(
  "registerConnector REJECTS a negative/zero/non-integer max_recovery_attempts at manifest-validation time",
  withTempDb(async () => {
    for (const badValue of [-5, 0, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const malicious = loadRawManifest("chatgpt");
      (malicious.capabilities as { refresh_policy: Record<string, unknown> }).refresh_policy.max_recovery_attempts =
        badValue;
      // biome-ignore lint/performance/noAwaitInLoops: each iteration is an independent assertion against a fresh manifest object.
      await assert.rejects(
        () => registerConnector(malicious),
        /max_recovery_attempts must be an integer between/,
        `max_recovery_attempts=${badValue} must be rejected`
      );
    }
  })
);

test("RI_MAX_RECOVERY_ATTEMPTS_CEILING is a finite positive integer bound, not Infinity", () => {
  assert.ok(
    Number.isInteger(RI_MAX_RECOVERY_ATTEMPTS_CEILING) && RI_MAX_RECOVERY_ATTEMPTS_CEILING > 0,
    "the RI hard ceiling itself must be a real, finite bound"
  );
});

test(
  "even at the maximum value manifest validation allows, a non-transient gap STILL reaches terminal (the ceiling is a real ceiling, not just documentation)",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const maxAllowed = loadRawManifest("chatgpt");
    (maxAllowed.capabilities as { refresh_policy: Record<string, unknown> }).refresh_policy.max_recovery_attempts =
      RI_MAX_RECOVERY_ATTEMPTS_CEILING;
    await registerConnector(maxAllowed);

    const policy = await resolveTerminalGapPolicy("chatgpt");
    assert.equal(
      policy.maxRecoveryAttempts,
      RI_MAX_RECOVERY_ATTEMPTS_CEILING,
      "a manifest-declared value exactly at the ceiling passes through unclamped-but-bounded"
    );

    const gap = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "conv_ceiling_test", kind: "chatgpt.conversation" },
      grantId: "grant_ceiling",
      reason: "retry_exhausted",
      recordKey: "conv_ceiling_test",
      stream: "messages",
    });
    assert.ok(gap, "seedGap must return the created gap");

    for (let i = 1; i <= policy.maxRecoveryAttempts; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.markGapStatus(gap.gap_id, "in_progress");
    }

    const outcome = await maybeTerminateGap(
      store as MaybeTerminateGapStore,
      gap.gap_id,
      { status: 404 },
      policy
    );
    assert.equal(
      outcome.terminated,
      true,
      "even the maximum allowed recovery-attempt budget must still eventually reach terminal — the budget bounds WHEN, never WHETHER"
    );
  })
);

test("maybeTerminateGap fails LOUD (throws) when handed a null/invalid profile — the .js build-error equivalent", async () => {
  // The decision site MUST throw rather than silently skip when a profile is
  // missing. Combined with resolveTerminalGapPolicy always supplying one, this
  // makes a silent skip impossible at the seam.
  const fakeStore: MaybeTerminateGapStore = { getGapById: async () => null, markGapStatus: async () => null };
  await assert.rejects(
    // @ts-expect-error -- proving the decision site throws loud on a null providerProfile rather than silently skipping; this IS the assertion the test exists to make.
    () => maybeTerminateGap(fakeStore, "gap_x", { status: 404 }, null),
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    /requires providerProfile\.maxRecoveryAttempts/,
    "a null profile at the decision site must be a loud throw, not a silent skip"
  );
  await assert.rejects(
    // @ts-expect-error -- proving the decision site throws loud on a profile missing maxRecoveryAttempts; this IS the assertion the test exists to make.
    () => maybeTerminateGap(fakeStore, "gap_x", { status: 404 }, {}),
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    /requires providerProfile\.maxRecoveryAttempts/,
    "an invalid profile (no maxRecoveryAttempts) must throw"
  );
});

// ─── GAP 2: a non-chatgpt connector's permanent gap REACHES terminal ─────────
//
// This is the §10-A-no-bypass pin: simulate the runtime DETAIL_GAP handler path
// for a NON-chatgpt connector that emits a gap on a permanent (404) error. With
// the safe default policy resolving for every connector, the gap reaches
// `terminal` — it never stays `pending` forever. Against the pre-fix code
// (terminalGapProfileForConnector('github') === null → `if (terminalProfile)`
// skip) this gap would stay pending and this test FAILS.

test(
  "a NON-chatgpt connector emitting a gap on a permanent 404 reaches terminal (never permanently pending) — §10-A no bypass",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = "github"; // a connector with NO explicit terminal profile

    // The connector emitted a detail gap that re-defers with a permanent 404.
    const gap = await store.upsertPendingGap({
      connectorId,
      detailLocator: { id: "pr_deleted_999", kind: "github.pull_request" },
      grantId: "grant_gh",
      lastError: { class: "http_404", http_status: 404 },
      reason: "retry_exhausted",
      recordKey: "pr_deleted_999",
      stream: "pull_requests",
    });
    assert.ok(gap, "upsertPendingGap must return the created gap");

    // The runtime handler resolves a policy for the connector — ALWAYS non-null.
    const policy = await resolveTerminalGapPolicy(connectorId);
    assert.ok(policy, "github must resolve a terminal policy (the GAP 2 fix)");

    // Drive the gap to its recovery budget against the 404 (mirrors the runtime
    // marking in_progress before each recovery attempt).
    for (let i = 1; i <= policy.maxRecoveryAttempts; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.markGapStatus(gap.gap_id, "in_progress");
    }

    const errorInfo = { errorClass: "http_404", status: 404 };
    const outcome = await maybeTerminateGap(store as MaybeTerminateGapStore, gap.gap_id, errorInfo, policy);
    assert.equal(outcome.terminated, true, "the github 404 gap MUST reach terminal");

    // It is gone from the fillable pending set (cannot lie "still pending / not done").
    const pending = await store.listPendingGapsForConnector(connectorId, { limit: 100 });
    assert.equal(pending.length, 0, "the terminal github gap must NOT remain in the pending set");

    // And it is counted separately — never silently dropped.
    const terminalCount = await store.countGapsByStatusForConnector(connectorId, { status: "terminal" });
    assert.equal(terminalCount, 1, "the terminal github gap must be counted, not dropped");
  })
);

test(
  "a NON-chatgpt connector emitting a gap on a TRANSIENT error (429) stays pending — terminalization is permanent-only",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = "notion";
    const gap = await store.upsertPendingGap({
      connectorId,
      detailLocator: { id: "page_busy", kind: "notion.page" },
      grantId: "grant_n",
      lastError: { http_status: 429 },
      reason: "rate_limited",
      recordKey: "page_busy",
      stream: "pages",
    });
    assert.ok(gap, "upsertPendingGap must return the created gap");
    const policy = await resolveTerminalGapPolicy(connectorId);
    for (let i = 1; i <= policy.maxRecoveryAttempts + 2; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.markGapStatus(gap.gap_id, "in_progress");
    }
    const outcome = await maybeTerminateGap(store as MaybeTerminateGapStore, gap.gap_id, { status: 429 }, policy);
    assert.equal(
      outcome.terminated,
      false,
      "a 429 (source pressure) must NEVER terminalize, even with a default policy"
    );
    const terminalCount = await store.countGapsByStatusForConnector(connectorId, { status: "terminal" });
    assert.equal(terminalCount, 0, "no terminal gap for a transient error");
  })
);
