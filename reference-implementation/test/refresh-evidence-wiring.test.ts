// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ConnectionRefreshEvidence } from "../runtime/connection-health.ts";
import { isAssistedRefresh, isManualRefreshOnly } from "../runtime/connection-health.ts";
import { synthesizeRenderedVerdict } from "../runtime/rendered-verdict.ts";
import type { ReferenceFreshness } from "../server/freshness.ts";
import type { ConnectorRunSummary } from "../server/ref-control.ts";
import { projectConnectorSummaryConnectionHealth } from "../server/ref-control.ts";

// Task 6.3 (Risk 1, highest-leverage): verify ConnectionRefreshEvidence actually
// reaches the projection at RUNTIME for amazon / chase / reddit / usaa — traced
// end-to-end from the real committed manifests, NOT just asserted from a synthetic
// policy — so `isManualRefreshOnly` is true for them and a stale manual account does
// NOT fall through to `complete`; stale surfaces as an amber refresh advisory.
//
// The runtime path is:
//   manifest.capabilities.refresh_policy
//     → extractRefreshPolicy(manifest)            (ref-control)
//     → input.refreshPolicy
//     → buildRefreshEvidence(input.refreshPolicy) (ref-control, inside the projection)
//     → computeConnectionHealth({ refresh })      (connection-health)
//     → isManualRefreshOnly(refresh) === true
//
// `projectConnectorSummaryConnectionHealth` calls `buildRefreshEvidence(input.refreshPolicy)`
// internally, so feeding it the REAL manifest refresh_policy exercises the whole path.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_DIR = join(__dirname, "..", "..", "packages", "polyfill-connectors", "manifests");

const NOW = "2026-06-15T12:00:00.000Z";
const STALE_FRESHNESS: ReferenceFreshness = { captured_at: NOW, status: "stale" };

interface RefreshPolicyManifest {
  readonly assisted_after_owner_auth?: boolean;
  readonly background_safe?: boolean;
  readonly interaction_posture?: "credentials" | "manual_action_likely" | "none" | "otp_likely";
  readonly recommended_mode?: "automatic" | "manual" | "paused";
}

function readRefreshPolicy(connector: string): RefreshPolicyManifest {
  const manifest = JSON.parse(readFileSync(join(MANIFEST_DIR, `${connector}.json`), "utf8"));
  // Mirror ref-control's extractRefreshPolicy: capabilities.refresh_policy.
  return manifest.capabilities?.refresh_policy ?? {};
}

function succeededRun(): ConnectorRunSummary {
  return {
    collection_facts: null,
    event_count: 0,
    failure_reason: null,
    finished_at: "2026-05-15T00:00:00.000Z",
    first_at: "2026-05-15T00:00:00.000Z",
    known_gaps: [],
    last_at: "2026-05-15T00:00:00.000Z",
    recovery_only: false,
    run_id: "run_1",
    started_at: "2026-05-15T00:00:00.000Z",
    status: "succeeded",
    terminal_reason: null,
  };
}

const MANUAL_BACKGROUND_UNSAFE_CONNECTORS = ["chase", "usaa"];
// Session-persistent browser connectors: the owner's first login is
// interactive, but the session then survives in the browser profile, which
// each manifest states as `background_safe: true`. Mode is DERIVED from that
// pair (reference-implementation/runtime/refresh-mode-derivation.ts), so
// these are automatic — they are NOT manual-refresh-only, and a stale one
// with an enabled schedule is scheduled work, not owner-refresh-due.
//
// They keep `assisted_after_owner_auth: true`, which is a statement about a
// RUNNING job (it may ask for bounded help), not about whether it may start.
const SESSION_PERSISTENT_CONNECTORS = ["amazon", "reddit"];

test("6.3: the manual/background-unsafe committed manifests stay manual-only", () => {
  for (const connector of MANUAL_BACKGROUND_UNSAFE_CONNECTORS) {
    const policy = readRefreshPolicy(connector);
    assert.ok(policy, `${connector} manifest has a refresh_policy`);
    assert.equal(policy.recommended_mode, "manual", `${connector} recommended_mode is manual`);
    assert.equal(policy.background_safe, false, `${connector} background_safe is false`);
  }
});

test("6.3: Amazon and Reddit declare a persistent session and derive automatic", () => {
  for (const connector of SESSION_PERSISTENT_CONNECTORS) {
    const policy = readRefreshPolicy(connector);
    assert.ok(policy, `${connector} manifest has a refresh_policy`);
    assert.equal(policy.interaction_posture, "otp_likely", `${connector} first login is owner-present`);
    assert.equal(policy.background_safe, true, `${connector} background_safe is true`);
    assert.equal(policy.assisted_after_owner_auth, true, `${connector} assisted_after_owner_auth is true`);
    // The declared mode must equal what those facts derive.
    assert.equal(policy.recommended_mode, "automatic", `${connector} recommended_mode is automatic`);
  }
});

test("6.3: the projected refresh evidence makes isManualRefreshOnly true for each manual connector", () => {
  // Reproduce buildRefreshEvidence's projection from the raw manifest policy and
  // assert the predicate the projection uses returns true. (buildRefreshEvidence is
  // not exported; this mirrors its exact field mapping and the projection proves the
  // full path below.)
  for (const connector of MANUAL_BACKGROUND_UNSAFE_CONNECTORS) {
    const policy = readRefreshPolicy(connector);
    const refresh: ConnectionRefreshEvidence = {
      backgroundSafe: policy.background_safe ?? null,
      interactionPosture: policy.interaction_posture ?? null,
      recommendedMode: policy.recommended_mode ?? null,
    };
    assert.equal(isManualRefreshOnly(refresh), true, `${connector} is manual-refresh-only`);
  }
  // The same wiring must classify a session-persistent connector the other
  // way. Asserting both directions is what keeps this a real test of the
  // predicate rather than of the connector list.
  for (const connector of SESSION_PERSISTENT_CONNECTORS) {
    const policy = readRefreshPolicy(connector);
    const refresh: ConnectionRefreshEvidence = {
      backgroundSafe: policy.background_safe ?? null,
      interactionPosture: policy.interaction_posture ?? null,
      recommendedMode: policy.recommended_mode ?? null,
    };
    assert.equal(isManualRefreshOnly(refresh), false, `${connector} is not manual-refresh-only`);
  }
});

test("6.3: a stale manual/background-unsafe account projects owner_refresh_due without degrading collection health", () => {
  for (const connector of MANUAL_BACKGROUND_UNSAFE_CONNECTORS) {
    const run = succeededRun();
    const snap = projectConnectorSummaryConnectionHealth({
      freshness: STALE_FRESHNESS,
      lastRun: run,
      lastSuccessfulRun: run,
      nowIso: NOW,
      outbox: { axis: "idle" },
      refreshPolicy: readRefreshPolicy(connector), // the REAL committed manifest policy
      schedule: { enabled: true },
    });
    // The projection routes stale manual to the owner-refresh advisory; the
    // rendered verdict turns that typed disposition into an actionable state.
    assert.equal(snap.state, "idle", `${connector} projects idle advisory`);
    assert.equal(snap.reason_code, "stale_manual_refresh", `${connector} reason is stale_manual_refresh`);
    assert.equal(snap.axes.freshness, "stale");
    assert.equal(snap.badges.stale, true);
    assert.equal(snap.forward_disposition, "owner_refresh_due", `${connector} disposition is owner_refresh_due`);
  }
});

test("6.3: a stale session-persistent connection with an enabled schedule is an assisted advisory, not manual", () => {
  for (const connector of SESSION_PERSISTENT_CONNECTORS) {
    const run = succeededRun();
    const policy = readRefreshPolicy(connector);
    const snap = projectConnectorSummaryConnectionHealth({
      freshness: STALE_FRESHNESS,
      lastRun: run,
      lastSuccessfulRun: run,
      nowIso: NOW,
      outbox: { axis: "idle" },
      refreshPolicy: policy,
      schedule: { enabled: true },
    });
    // Not `stale_manual_refresh`: these connectors are automatic, so a stale
    // window is not an owner-refresh obligation. They land on the
    // purpose-built assisted advisory instead — "refreshes on schedule and
    // may ask for bounded owner help" — which is `idle`/advisory rather than
    // `degraded`, because being between scheduled refreshes is honest
    // operation, not a failure.
    assert.equal(snap.state, "idle", `${connector} is an advisory, not a failure`);
    assert.equal(snap.reason_code, "stale_assisted_refresh", `${connector} reason is stale_assisted_refresh`);
    assert.notEqual(snap.reason_code, "stale_manual_refresh");
    assert.equal(snap.axes.freshness, "stale");
    assert.equal(snap.badges.stale, true);
    // Disposition is `owner_refresh_due`, matching every other assisted
    // connector (ChatGPT has projected exactly this since the assisted
    // branch was introduced): the connection refreshes on schedule but its
    // posture predicts bounded owner help, so the disposition names that
    // rather than re-encoding staleness as a coverage gap. This is the
    // pre-existing rule, unchanged by the derivation — Amazon and Reddit
    // simply join the assisted class they always belonged to.
    assert.equal(snap.forward_disposition, "owner_refresh_due", `${connector} disposition names owner assistance`);
  }
});

test("6.3: a stale session-persistent connection with no schedule is still automatic, not owner-refresh-due", () => {
  // Before the mode was derived, an unscheduled Amazon/Reddit projected
  // `stale_manual_refresh`/`owner_refresh_due` because its manifest called
  // itself manual. It no longer does: the connector is automatic, so an
  // absent schedule is an enrollment gap, not an owner-refresh obligation.
  for (const connector of SESSION_PERSISTENT_CONNECTORS) {
    const run = succeededRun();
    const policy = readRefreshPolicy(connector);
    const snap = projectConnectorSummaryConnectionHealth({
      freshness: STALE_FRESHNESS,
      lastRun: run,
      lastSuccessfulRun: run,
      nowIso: NOW,
      outbox: { axis: "idle" },
      refreshPolicy: policy,
      schedule: null,
    });
    assert.equal(snap.state, "idle", `${connector} stays idle unscheduled`);
    // The reason is the assisted advisory, NOT the manual one: an absent
    // schedule on an automatic connector is an enrollment gap, not an owner
    // refresh obligation.
    assert.equal(snap.reason_code, "stale_assisted_refresh");
    assert.notEqual(snap.reason_code, "stale_manual_refresh");
    assert.equal(snap.axes.freshness, "stale");
    assert.equal(snap.badges.stale, true);
  }
});

test("6.3: the synthesized verdict for a stale manual account is Needs refresh/advisory with Refresh now", () => {
  for (const connector of MANUAL_BACKGROUND_UNSAFE_CONNECTORS) {
    const run = succeededRun();
    const policy = readRefreshPolicy(connector);
    const snap = projectConnectorSummaryConnectionHealth({
      freshness: STALE_FRESHNESS,
      lastRun: run,
      lastSuccessfulRun: run,
      nowIso: NOW,
      outbox: { axis: "idle" },
      refreshPolicy: policy,
      schedule: { enabled: true },
    });
    const refresh: ConnectionRefreshEvidence = {
      backgroundSafe: policy.background_safe ?? null,
      interactionPosture: policy.interaction_posture ?? null,
      recommendedMode: policy.recommended_mode ?? null,
    };
    const verdict = synthesizeRenderedVerdict(
      snap,
      [
        {
          attention_open: false,
          collected: null,
          considered: null,
          coverage: "complete",
          gap_retryable: false,
          priority: "required",
          stream_id: "s1",
        },
      ],
      refresh,
      true,
      { last_refreshed_at: "2026-05-15T00:00:00.000Z", mode: "manual", retained_records: 100 }
    );
    assert.equal(verdict.pill.tone, "amber", `${connector} is visibly refresh-due while stale`);
    assert.equal(verdict.pill.label, "Needs refresh");
    assert.equal(verdict.channel, "advisory");
    assert.ok(
      verdict.required_actions.some((a) => a.kind === "refresh_now" && a.audience === "owner"),
      `${connector} offers an owner Refresh now action`
    );
    assert.ok(verdict.annotations.some((a) => a.kind === "freshness"));
  }
});

test("6.4: ChatGPT — automatic + background-safe + assisted posture is NOT manual-refresh-only (zero-credential account is valid)", () => {
  const policy = readRefreshPolicy("chatgpt");
  const refresh: ConnectionRefreshEvidence = {
    backgroundSafe: policy.background_safe ?? null,
    interactionPosture: policy.interaction_posture ?? null,
    recommendedMode: policy.recommended_mode ?? null,
  };
  assert.equal(isManualRefreshOnly(refresh), false, "ChatGPT is not manual-refresh-only");
  assert.equal(isAssistedRefresh(refresh), true, "ChatGPT is assisted-refresh");
  // A fresh ChatGPT-shaped account with zero credentials is a valid green verdict —
  // no account⇒credential invariant is imposed.
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: { captured_at: NOW, status: "current" },
    lastRun: succeededRun(),
    lastSuccessfulRun: succeededRun(),
    nowIso: NOW,
    outbox: { axis: "idle" },
    refreshPolicy: policy,
    schedule: { enabled: true },
  });
  const verdict = synthesizeRenderedVerdict(
    snap,
    [
      {
        attention_open: false,
        collected: null,
        considered: null,
        coverage: "complete",
        gap_retryable: false,
        priority: "required",
        stream_id: "s1",
      },
    ],
    refresh,
    true,
    { gaps_drained_last_run: 2532, mode: "deferred", retained_records: 126_000 }
  );
  assert.equal(verdict.pill.tone, "green");
  assert.ok(!verdict.required_actions.some((a) => a.kind === "reauth"));
});
