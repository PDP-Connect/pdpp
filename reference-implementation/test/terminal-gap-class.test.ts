// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * §10-A Terminal gap class — failing tests (write first, then implement).
 *
 * Spec: a gap that exhausts a bounded recovery-attempt budget (maxRecoveryAttempts)
 * against a NON-TRANSIENT error (404/410/permanent-403, or N identical 5xx) transitions
 * pending→terminal. Terminal gaps are:
 *   - excluded from listPendingGaps / listPendingGapsForConnector (fillable-pending set)
 *   - counted via countGapsByStatusForConnector(connectorId, { status: 'terminal' })
 *   - NOT silently dropped
 *   - NOT subject to revival by upsertPendingGap (terminal is sticky like recovered)
 *
 * maxRecoveryAttempts is a ProviderProfile field; ChatGPT's value is the only concrete
 * value — NO cross-provider default for safety/pressure quantities (spec §3 rule 6).
 *
 * Ref: docs/research/slvp-ideal-whole-system-spec-2026-06-11.md §10-A
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
  classifyRecoveryError,
  isNonTransientError,
  maybeTerminateGap,
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

// ─── terminalGapProfileForConnector: manifest-declared value, NO default ─────

test(
  "terminalGapProfileForConnector resolves chatgpt (incl. instance-scoped ids) and returns null for unknown — no cross-provider default",
  withTempDb(async () => {
    await registerConnector(loadRawManifest("chatgpt"));
    assert.deepEqual(await terminalGapProfileForConnector("chatgpt"), CHATGPT_PROVIDER_PROFILE);
    assert.deepEqual(
      await terminalGapProfileForConnector("chatgpt:default"),
      CHATGPT_PROVIDER_PROFILE,
      "instance-scoped id resolves to base profile"
    );
    assert.deepEqual(
      await terminalGapProfileForConnector("chatgpt@everyone"),
      CHATGPT_PROVIDER_PROFILE,
      "account-scoped id resolves to base profile"
    );
    // §3 rule 6: a connector with no declared profile must NOT borrow ChatGPT's
    // budget — it returns null so the recovery path simply does not terminalize.
    assert.equal(await terminalGapProfileForConnector("gmail"), null);
    assert.equal(await terminalGapProfileForConnector("some-new-connector"), null);
    assert.equal(await terminalGapProfileForConnector(""), null);
    // @ts-expect-error -- proving the runtime `typeof connectorId !== "string"` guard rejects a non-string connectorId from an untyped JS caller, not a type-level assertion this call site would ever legitimately make.
    assert.equal(await terminalGapProfileForConnector(undefined), null);
  })
);

// The wired runtime adapter maps DETAIL_GAP last_error -> classifier errorInfo.
// Pin that mapping (last_error.http_status -> status, last_error.class ->
// errorClass) so the §10-A wiring in runtime/index.ts stays correct.
test("the DETAIL_GAP last_error -> errorInfo mapping classifies non-transient statuses correctly", () => {
  const map = (
    lastError: { http_status?: number; class?: string } | null
  ): Parameters<typeof classifyRecoveryError>[0] => {
    if (!lastError) {
      return null;
    }
    return {
      ...(lastError.http_status === undefined ? {} : { status: lastError.http_status }),
      ...(lastError.class === undefined ? {} : { errorClass: lastError.class }),
    };
  };
  assert.equal(classifyRecoveryError(map({ http_status: 404 })).nonTransient, true);
  assert.equal(classifyRecoveryError(map({ http_status: 410 })).nonTransient, true);
  assert.equal(classifyRecoveryError(map({ http_status: 401 })).reason, "auth_failure");
  assert.equal(classifyRecoveryError(map({ class: "http_403_permanent", http_status: 403 })).nonTransient, true);
  // run_cap_deferred / rate-limit shaped last_error (no http_status, or 429) stays transient.
  assert.equal(classifyRecoveryError(map({ class: "max_detail_fetches" })).nonTransient, false);
  assert.equal(classifyRecoveryError(map({ http_status: 429 })).nonTransient, false);
  assert.equal(classifyRecoveryError(map(null)).nonTransient, false);
});

// classifyRecoveryError's signature takes ONLY an errorInfo — no profile, no
// maxRecoveryAttempts, no connectorId. This is the structural guarantee behind
// the manifest-driven max_recovery_attempts redesign: a connector-declared
// recovery-attempt budget can only change WHEN a gap ALREADY classified
// non-transient flips to terminal (maybeTerminateGap's attempt_count compare);
// it can never redefine WHAT counts as non-transient, because the classifier
// has no channel through which a profile value could reach it.
test("classifyRecoveryError takes no profile/budget input — a connector cannot redefine what 'permanently gone' means", () => {
  assert.equal(classifyRecoveryError.length, 1, "classifyRecoveryError must declare exactly one parameter (errorInfo)");
  // The same errorInfo classifies identically regardless of any surrounding
  // profile value — there is no second argument to vary.
  const withoutExtraArgs = classifyRecoveryError({ status: 404 });
  // @ts-expect-error -- proving at runtime that a second (profile-shaped) argument is silently ignored, not consulted; classifyRecoveryError has no seam for connector-declared input.
  const withExtraArgIgnored = classifyRecoveryError({ status: 404 }, { maxRecoveryAttempts: 999_999_999 });
  assert.deepEqual(withExtraArgIgnored, withoutExtraArgs, "a second argument must have zero effect on classification");
});

// ─── Test helpers ───────────────────────────────────────────────────────────

function withTempDb(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-terminal-gap-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn(dir);
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

type SeedGapStore = ReturnType<typeof createSqliteConnectorDetailGapStore>;
type SeedGapOverrides = Partial<Parameters<SeedGapStore["upsertPendingGap"]>[0]>;

function seedGap(store: SeedGapStore, overrides: SeedGapOverrides = {}) {
  return store.upsertPendingGap({
    connectorId: "chatgpt",
    detailLocator: { conversation_id: overrides.recordKey ?? "conv_test_001", kind: "chatgpt.conversation" },
    grantId: "grant_test",
    reason: overrides.reason ?? "retry_exhausted",
    recordKey: overrides.recordKey ?? "conv_test_001",
    stream: "messages",
    ...overrides,
  });
}

// ─── classifyRecoveryError / isNonTransientError pure-function tests ────────

test("classifyRecoveryError: 404 is non-transient (deleted resource)", () => {
  const result = classifyRecoveryError({ status: 404 });
  assert.equal(result.nonTransient, true);
  assert.equal(result.reason, "not_found");
});

test("classifyRecoveryError: 410 is non-transient (gone)", () => {
  const result = classifyRecoveryError({ status: 410 });
  assert.equal(result.nonTransient, true);
  assert.equal(result.reason, "gone");
});

test("classifyRecoveryError: 403 permanent (no retry hint) is non-transient", () => {
  const result = classifyRecoveryError({ errorClass: "http_403_permanent", status: 403 });
  assert.equal(result.nonTransient, true);
  assert.equal(result.reason, "permanent_forbidden");
});

test("classifyRecoveryError: 403 without permanent marker is transient (may be auth refresh)", () => {
  // A bare 403 without an explicit permanent marker is considered transient —
  // it may resolve after a credential refresh. Only 403 with the permanent
  // errorClass is non-transient.
  const result = classifyRecoveryError({ status: 403 });
  assert.equal(result.nonTransient, false);
});

test("classifyRecoveryError: 429 is transient (rate pressure, must never terminalize)", () => {
  const result = classifyRecoveryError({ status: 429 });
  assert.equal(result.nonTransient, false);
});

test("classifyRecoveryError: 500 is transient on the first occurrence", () => {
  // A single 5xx is transient — the server may have been briefly unhealthy.
  const result = classifyRecoveryError({ status: 500 });
  assert.equal(result.nonTransient, false);
});

test("classifyRecoveryError: 503 is transient", () => {
  const result = classifyRecoveryError({ status: 503 });
  assert.equal(result.nonTransient, false);
});

test("classifyRecoveryError: null/undefined status is transient (safe default)", () => {
  assert.equal(classifyRecoveryError({}).nonTransient, false);
  // @ts-expect-error -- proving the runtime `typeof status === "number" ? status : null` guard tolerates a non-number status (e.g. a malformed DETAIL_GAP row) rather than throwing.
  assert.equal(classifyRecoveryError({ status: null }).nonTransient, false);
  assert.equal(classifyRecoveryError(null).nonTransient, false);
});

test("isNonTransientError convenience wrapper agrees with classifyRecoveryError", () => {
  assert.equal(isNonTransientError({ status: 404 }), true);
  assert.equal(isNonTransientError({ status: 410 }), true);
  assert.equal(isNonTransientError({ status: 429 }), false);
  assert.equal(isNonTransientError({ status: 500 }), false);
  assert.equal(isNonTransientError(null), false);
});

// ─── CHATGPT_PROVIDER_PROFILE pinned constants ───────────────────────────────
//
// maxRecoveryAttempts is a ProviderProfile field — NO cross-provider default.
// The ChatGPT value is pinned here so any drift is intentional.

test("CHATGPT_PROVIDER_PROFILE.maxRecoveryAttempts is a finite positive integer", () => {
  assert.ok(
    Number.isInteger(CHATGPT_PROVIDER_PROFILE.maxRecoveryAttempts) && CHATGPT_PROVIDER_PROFILE.maxRecoveryAttempts > 0,
    `CHATGPT_PROVIDER_PROFILE.maxRecoveryAttempts must be a positive integer, got ${CHATGPT_PROVIDER_PROFILE.maxRecoveryAttempts}`
  );
});

test("CHATGPT_PROVIDER_PROFILE has no cross-provider default key — only chatgpt-specific values", () => {
  // Structural guard: the profile must not include a "default" or "fallback"
  // key that other connectors could silently inherit. Each connector declares
  // its own profile. This test makes the "no cross-provider default" rule
  // mechanically verifiable (§3 rule 6).
  assert.equal("default" in CHATGPT_PROVIDER_PROFILE, false);
  assert.equal("fallback" in CHATGPT_PROVIDER_PROFILE, false);
});

// ─── maybeTerminateGap — pending → terminal transition ──────────────────────

test(
  "maybeTerminateGap: gap hitting non-transient error N times → terminal, leaves pending count unchanged",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const gap = await seedGap(store, { recordKey: "conv_terminal_404" });
    assert.ok(gap, "seedGap must return the created gap");

    // Simulate the gap being attempted maxRecoveryAttempts times against a 404.
    // Each call marks in_progress (incrementing attempt_count) then transitions.
    // After exhausting the budget, the gap must be terminal.
    const profile = { maxRecoveryAttempts: 3 };
    const errorInfo = { status: 404 };

    // Attempts 1..3: attempt_count should increment via in_progress, then
    // maybeTerminateGap returns false until budget is exhausted.
    for await (const _ of Array.from({ length: profile.maxRecoveryAttempts })) {
      await store.markGapStatus(gap.gap_id, "in_progress");
    }

    // After exhausting the budget, maybeTerminateGap transitions to terminal.
    const result = await maybeTerminateGap(store as MaybeTerminateGapStore, gap.gap_id, errorInfo, profile);
    assert.equal(result.terminated, true, "gap must be marked terminal after budget exhaustion");

    // Terminal gap must NOT appear in listPendingGaps.
    const pending = await store.listPendingGaps({
      connectorId: "chatgpt",
      grantId: "grant_test",
      streams: ["messages"],
    });
    assert.equal(pending.length, 0, "terminal gap must not appear in listPendingGaps");

    // Terminal gap must NOT appear in listPendingGapsForConnector.
    const pendingForConnector = await store.listPendingGapsForConnector("chatgpt", { limit: 100 });
    assert.equal(pendingForConnector.length, 0, "terminal gap must not appear in listPendingGapsForConnector");

    // Terminal gap must be counted by countGapsByStatusForConnector.
    const terminalCount = await store.countGapsByStatusForConnector("chatgpt", { status: "terminal" });
    assert.equal(terminalCount, 1, "terminal gap must be counted separately");
  })
);

test(
  "maybeTerminateGap: transient error (429) does NOT terminalize, regardless of attempt count",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const gap = await seedGap(store, { recordKey: "conv_transient_429" });
    assert.ok(gap, "seedGap must return the created gap");

    const profile = { maxRecoveryAttempts: 3 };
    const errorInfo = { status: 429 };

    // Drive attempt_count past maxRecoveryAttempts.
    for await (const _ of Array.from({ length: profile.maxRecoveryAttempts + 2 })) {
      await store.markGapStatus(gap.gap_id, "in_progress");
    }

    const result = await maybeTerminateGap(store as MaybeTerminateGapStore, gap.gap_id, errorInfo, profile);
    assert.equal(result.terminated, false, "429 must never terminalize a gap");

    // Gap must still be countable as non-terminal (it remains in_progress after the loop).
    const terminalCount = await store.countGapsByStatusForConnector("chatgpt", { status: "terminal" });
    assert.equal(terminalCount, 0, "no terminal gaps for transient errors");
  })
);

test(
  "maybeTerminateGap: gap below budget is NOT terminalized even on non-transient error",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const gap = await seedGap(store, { recordKey: "conv_below_budget" });
    assert.ok(gap, "seedGap must return the created gap");

    const profile = { maxRecoveryAttempts: 5 };
    const errorInfo = { status: 404 };

    // Only 2 attempts — below the budget of 5.
    for await (const _ of Array.from({ length: 2 })) {
      await store.markGapStatus(gap.gap_id, "in_progress");
    }

    const result = await maybeTerminateGap(store as MaybeTerminateGapStore, gap.gap_id, errorInfo, profile);
    assert.equal(result.terminated, false, "gap must not be terminalized below the budget");

    const terminalCount = await store.countGapsByStatusForConnector("chatgpt", { status: "terminal" });
    assert.equal(terminalCount, 0);
  })
);

// ─── Terminal gaps do not appear in non-pressure recoverable count ───────────
//
// The §4 recovery lane counts non-pressure pending gaps as the trigger for
// recovery-only dispatch. Terminal gaps must NEVER appear in that count.

test(
  "terminal gap is excluded from pending count but still counted as terminal",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();

    // Create two gaps: one that will be terminalized, one that stays pending.
    const terminalGap = await seedGap(store, { recordKey: "conv_will_terminal" });
    assert.ok(terminalGap, "seedGap must return the created gap");
    await seedGap(store, { recordKey: "conv_stays_pending" });

    const profile = { maxRecoveryAttempts: 2 };

    // Exhaust the budget on one gap.
    for await (const _ of Array.from({ length: profile.maxRecoveryAttempts })) {
      await store.markGapStatus(terminalGap.gap_id, "in_progress");
    }
    await maybeTerminateGap(store as MaybeTerminateGapStore, terminalGap.gap_id, { status: 404 }, profile);

    // Only 1 pending remains (the non-terminal one).
    const pending = await store.listPendingGaps({ connectorId: "chatgpt", grantId: "grant_test" });
    assert.equal(pending.length, 1, "only the non-terminal gap is in pending set");
    assert.ok(pending[0], "expected exactly one pending gap");
    assert.equal(pending[0].record_key, "conv_stays_pending");

    // Terminal count is 1.
    const terminalCount = await store.countGapsByStatusForConnector("chatgpt", { status: "terminal" });
    assert.equal(terminalCount, 1);
  })
);

// ─── Terminal status is sticky (upsertPendingGap does not revive terminal) ───
//
// The ON CONFLICT path in upsertPendingGap must preserve 'terminal' status
// just as it preserves 'recovered' — a terminalized gap must not be silently
// resurrected into the fillable-pending set by a re-upsert.

test(
  "upsertPendingGap does not revive a terminal gap (terminal is sticky like recovered)",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const gap = await seedGap(store, { recordKey: "conv_terminal_sticky" });
    assert.ok(gap, "seedGap must return the created gap");

    // Terminalize it.
    await store.markGapStatus(gap.gap_id, "terminal", { lastError: { message: "not found", status: 404 } });

    const afterTerminal = await store.countGapsByStatusForConnector("chatgpt", { status: "terminal" });
    assert.equal(afterTerminal, 1, "one terminal gap before re-upsert");

    // Re-upsert the same logical gap (same identity fields → hits ON CONFLICT).
    await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "conv_terminal_sticky", kind: "chatgpt.conversation" },
      grantId: "grant_test",
      reason: "retry_exhausted",
      recordKey: "conv_terminal_sticky",
      stream: "messages",
    });

    // Must still be terminal — not resurrected to pending.
    const pending = await store.listPendingGaps({
      connectorId: "chatgpt",
      grantId: "grant_test",
      streams: ["messages"],
    });
    assert.equal(pending.length, 0, "terminal gap must NOT be revived to pending by re-upsert");

    const stillTerminal = await store.countGapsByStatusForConnector("chatgpt", { status: "terminal" });
    assert.equal(stillTerminal, 1, "terminal gap count must be unchanged after re-upsert");
  })
);
