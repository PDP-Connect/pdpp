// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Milestone acceptance test for `complete-ri-operator-console-reliability`
 * task 7.6: a browser/API connector acceptance path proving structured
 * attention AND remote-surface lease/status both feed the connection
 * projection.
 *
 * What this pins
 * --------------
 * 1. Browser surface evidence enters `projectConnectorSummaryConnectionHealth`
 *    via `getConnectorBrowserSurfaceProjection` reading the durable
 *    `browser_surface_leases` / `browser_surfaces` rows. The headline
 *    snapshot exposes the rolled-up axis at `snapshot.axes.remote_surface`
 *    and a non-secret `remote_surface` detail block.
 *
 * 2. Per design.md ("A remote browser surface capacity failure degrades
 *    the affected connection without changing source identity"), an
 *    `unhealthy` browser surface degrades the connection headline
 *    through the `degraded` rung. Routine `waiting_for_browser_surface`
 *    and `leased` states do NOT change the headline — they are axes /
 *    badges. This matches the packet's "Treat remote-surface state as
 *    an axis/detail/badge unless the existing design clearly says it
 *    should be headline health. Do not make a connector unhealthy
 *    merely because it is idle and has no active browser surface."
 *
 * 3. A blocked / waiting browser surface is still inspectable through
 *    the projection — it does not disappear from operator health. The
 *    axis carries the wait_reason so the dashboard can render
 *    "Waiting on surface: capacity_full".
 *
 * 4. Structured attention precedence is preserved: when an OTP attention
 *    is open AND a surface is failed, the headline is `needs_attention`
 *    (owner action beats backend cadence), but the remote_surface
 *    detail still surfaces the failure for diagnostics.
 *
 * 5. A browser-surface store outage marks `remote_surface_store` as an
 *    unreliable evidence source, demoting the headline to `unknown`
 *    rather than silently dropping the axis.
 *
 * Test layering
 * -------------
 * These tests assert against the same `projectConnectorSummaryConnectionHealth`
 * function the dashboard list / detail operations call, and against
 * `getConnectorBrowserSurfaceProjection` (the store-reading wrapper they
 * call ahead of it). One end-to-end test in this file goes through the
 * real SQLite-backed store; the rest pass synthetic evidence to keep the
 * suite deterministic and fast.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: this direct reference-implementation dependency is resolved by the reference test runner.
import type { BrowserSurfaceLease } from "@opendatalabs/remote-surface";
import { createAttention } from "../runtime/attention.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import type { ConnectorRunSummary } from "../server/ref-control.ts";
import {
  getConnectorBrowserSurfaceProjection,
  projectConnectorSummaryConnectionHealth,
} from "../server/ref-control.ts";
import type { BrowserSurfaceWithPersistenceMetadata } from "../server/stores/browser-surface-lease-store.ts";
import { createSqliteBrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";

const NOW_ISO = "2026-05-19T12:00:00.000Z";
const PRIOR_SUCCESS_ISO = "2026-05-19T10:00:00.000Z";
const FRESH = { captured_at: NOW_ISO, status: "current" as const };

function succeededRun(overrides: Partial<ConnectorRunSummary> = {}): ConnectorRunSummary {
  return {
    collection_facts: null,
    event_count: 12,
    failure_reason: null,
    finished_at: PRIOR_SUCCESS_ISO,
    first_at: "2026-05-19T09:55:00.000Z",
    known_gaps: [],
    last_at: PRIOR_SUCCESS_ISO,
    recovery_only: false,
    run_id: "run_prior_ok",
    started_at: "2026-05-19T09:55:00.000Z",
    status: "succeeded",
    terminal_reason: null,
    ...overrides,
  };
}

function withTempDb(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-remote-surface-acceptance-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn(dir);
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function leaseFixture(overrides: Partial<BrowserSurfaceLease> = {}): BrowserSurfaceLease {
  return {
    connector_id: "chatgpt",
    expires_at: "2026-05-19T12:30:00.000Z",
    fencing_token: 1,
    lease_id: "lease_default",
    priority_class: "background",
    profile_key: "chatgpt",
    requested_at: "2026-05-19T11:58:00.000Z",
    run_id: "run_default",
    status: "leased",
    ...overrides,
  };
}

function surfaceFixture(
  overrides: Partial<BrowserSurfaceWithPersistenceMetadata> = {}
): BrowserSurfaceWithPersistenceMetadata {
  return {
    backend: "neko",
    cdp_url: "http://neko:9222",
    connector_id: "chatgpt",
    created_at: "2026-05-19T11:00:00.000Z",
    health: "ready",
    last_used_at: "2026-05-19T11:59:00.000Z",
    profile_key: "chatgpt",
    stream_base_url: "http://neko:8080",
    surface_id: "surface_default",
    ...overrides,
  };
}

// ─── 7.6 end-to-end: durable lease evidence reaches the projection ────────

test(
  "7.6 acceptance: a `leased` browser-surface lease for a connector surfaces as a leased axis + detail through the real store",
  withTempDb(async () => {
    const store = createSqliteBrowserSurfaceLeaseStore();
    await store.upsertSurface(surfaceFixture({ active_lease_id: "lease_chatgpt" }));
    await store.upsertLease(
      leaseFixture({
        lease_id: "lease_chatgpt",
        leased_at: "2026-05-19T11:58:30.000Z",
        run_id: "run_chatgpt_live",
        surface_id: "surface_default",
      })
    );

    const projection = await getConnectorBrowserSurfaceProjection("chatgpt");
    assert.equal(projection.unreliable, false, "store read succeeded");
    assert.ok(projection.evidence, "evidence present for managed connector");
    assert.equal(projection.evidence.axis, "leased");
    assert.equal(projection.evidence.leaseId, "lease_chatgpt");
    assert.equal(projection.evidence.leaseStatus, "leased");
    assert.equal(projection.evidence.profileKey, "chatgpt");
    assert.equal(projection.evidence.surfaceId, "surface_default");
    assert.equal(projection.evidence.surfaceHealth, "ready");

    const snapshot = projectConnectorSummaryConnectionHealth({
      freshness: FRESH,
      lastRun: succeededRun(),
      lastSuccessfulRun: succeededRun(),
      nowIso: NOW_ISO,
      outbox: { axis: "idle" },
      remoteSurface: projection.evidence,
      schedule: {
        active_run_id: "run_chatgpt_live",
        enabled: true,
        last_successful_at: PRIOR_SUCCESS_ISO,
      },
    });

    // Routine `leased` does not change the headline — design.md keeps
    // surfaces as capacity, not source identity.
    assert.equal(snapshot.state, "healthy", "leased surface does not degrade a clean run");
    assert.equal(snapshot.axes.remote_surface, "leased");
    assert.ok(snapshot.remote_surface, "remote_surface detail is populated");
    assert.equal(snapshot.remote_surface.axis, "leased");
    assert.equal(snapshot.remote_surface.lease_id, "lease_chatgpt");
    assert.equal(snapshot.remote_surface.lease_status, "leased");
    assert.equal(snapshot.remote_surface.surface_health, "ready");
    // The active run still drives the syncing badge, as before.
    assert.equal(snapshot.badges.syncing, true);
  })
);

// ─── 7.6 waiting state does not vanish from operator health ──────────────

test(
  "7.6 acceptance: a `waiting_for_browser_surface` lease surfaces as the waiting axis with the wait_reason intact",
  withTempDb(async () => {
    const store = createSqliteBrowserSurfaceLeaseStore();
    await store.upsertLease(
      leaseFixture({
        connector_id: "gmail",
        lease_id: "lease_queued",
        profile_key: "gmail",
        run_id: "run_queued",
        status: "waiting_for_browser_surface",
        wait_reason: "capacity_full",
      })
    );

    const projection = await getConnectorBrowserSurfaceProjection("gmail");
    assert.equal(projection.unreliable, false);
    assert.equal(projection.evidence?.axis, "waiting");
    assert.equal(projection.evidence?.waitReason, "capacity_full");
    assert.equal(projection.evidence?.leaseStatus, "waiting_for_browser_surface");

    const snapshot = projectConnectorSummaryConnectionHealth({
      freshness: FRESH,
      lastRun: succeededRun({ run_id: "run_queued_prior" }),
      lastSuccessfulRun: succeededRun(),
      nowIso: NOW_ISO,
      outbox: { axis: "idle" },
      remoteSurface: projection.evidence,
      schedule: { active_run_id: "run_queued", enabled: true },
    });

    // Queued for a surface is not a failure — connection stays healthy.
    // The wait is still visible as a non-headline axis + detail so the
    // operator can see why the run is taking longer than usual.
    assert.equal(snapshot.state, "healthy");
    assert.equal(snapshot.axes.remote_surface, "waiting");
    assert.ok(snapshot.remote_surface);
    assert.equal(snapshot.remote_surface.wait_reason, "capacity_full");
    assert.equal(snapshot.remote_surface.lease_status, "waiting_for_browser_surface");
  })
);

// ─── 7.6 current lease-backed surface failure degrades the headline ──────

test(
  "7.6 acceptance: an unhealthy browser surface with a current lease degrades the connection per design.md",
  withTempDb(async () => {
    const store = createSqliteBrowserSurfaceLeaseStore();
    // The current lease-backed surface is unhealthy. That live failure, not
    // historical surface-row recency, is the canonical signal the runtime
    // keeps around for the dashboard.
    await store.upsertSurface(
      surfaceFixture({
        active_lease_id: "lease_chatgpt_current",
        health: "unhealthy",
        surface_id: "surface_chatgpt_unhealthy",
      })
    );
    await store.upsertLease(
      leaseFixture({
        lease_id: "lease_chatgpt_current",
        leased_at: "2026-05-19T11:58:30.000Z",
        run_id: "run_chatgpt_current",
        status: "leased",
        surface_id: "surface_chatgpt_unhealthy",
      })
    );

    const projection = await getConnectorBrowserSurfaceProjection("chatgpt");
    assert.equal(projection.evidence?.axis, "failed");
    assert.equal(projection.evidence?.surfaceHealth, "unhealthy");
    assert.equal(projection.evidence?.surfaceId, "surface_chatgpt_unhealthy");
    assert.equal(projection.evidence?.waitReason, "surface_unhealthy");

    const snapshot = projectConnectorSummaryConnectionHealth({
      freshness: FRESH,
      // A clean prior succeeded run — nothing else would degrade the
      // connection. The remote-surface failure must be what tips the
      // headline.
      lastRun: succeededRun(),
      lastSuccessfulRun: succeededRun(),
      nowIso: NOW_ISO,
      outbox: { axis: "idle" },
      remoteSurface: projection.evidence,
      schedule: { enabled: true, last_successful_at: PRIOR_SUCCESS_ISO },
    });

    assert.equal(snapshot.state, "degraded", "remote-surface failure degrades the connection");
    assert.equal(
      snapshot.reason_code,
      "remote_surface:surface_unhealthy",
      "degraded reason_code surfaces the wait_reason so the dashboard can render the cause"
    );
    assert.equal(snapshot.axes.remote_surface, "failed");
    assert.ok(snapshot.remote_surface);
    assert.equal(snapshot.remote_surface.axis, "failed");
    assert.equal(snapshot.remote_surface.surface_health, "unhealthy");
  })
);

test(
  "7.6 acceptance: stale unhealthy browser surfaces do not poison a newer ready surface for the same connector",
  withTempDb(async () => {
    const store = createSqliteBrowserSurfaceLeaseStore();
    await store.upsertSurface(
      surfaceFixture({
        created_at: "2026-05-19T10:00:00.000Z",
        health: "unhealthy",
        last_used_at: "2026-05-19T10:05:00.000Z",
        surface_id: "surface_chatgpt_released_history",
      })
    );
    await store.upsertLease(
      leaseFixture({
        lease_id: "lease_chatgpt_released_history",
        released_at: "2026-05-19T10:06:00.000Z",
        run_id: "run_chatgpt_released_history",
        status: "released",
        surface_id: "surface_chatgpt_released_history",
      })
    );
    await store.upsertSurface(
      surfaceFixture({
        created_at: "2026-05-19T11:00:00.000Z",
        health: "ready",
        last_used_at: "2026-05-19T11:59:00.000Z",
        surface_id: "surface_chatgpt_current_ready",
      })
    );

    const projection = await getConnectorBrowserSurfaceProjection("chatgpt");
    assert.equal(projection.unreliable, false);
    assert.equal(projection.evidence?.axis, "idle");
    assert.equal(projection.evidence?.surfaceHealth, "ready");
    assert.equal(projection.evidence?.surfaceId, "surface_chatgpt_current_ready");

    const snapshot = projectConnectorSummaryConnectionHealth({
      freshness: FRESH,
      lastRun: succeededRun(),
      lastSuccessfulRun: succeededRun(),
      nowIso: NOW_ISO,
      outbox: { axis: "idle" },
      remoteSurface: projection.evidence,
      schedule: { enabled: true, last_successful_at: PRIOR_SUCCESS_ISO },
    });

    assert.equal(snapshot.state, "healthy", "newer ready evidence wins over stale unhealthy history");
    assert.equal(snapshot.axes.remote_surface, "idle");
  })
);

test(
  "7.6 acceptance: retired browser-surface history with no current evidence projects unknown rather than degrading",
  withTempDb(async () => {
    const store = createSqliteBrowserSurfaceLeaseStore();
    await store.upsertSurface(
      surfaceFixture({
        created_at: "2026-05-19T10:00:00.000Z",
        health: "unhealthy",
        last_used_at: "2026-05-19T10:05:00.000Z",
        surface_id: "surface_chatgpt_retired_history",
      })
    );
    await store.upsertLease(
      leaseFixture({
        lease_id: "lease_chatgpt_retired_history",
        released_at: "2026-05-19T10:06:00.000Z",
        run_id: "run_chatgpt_retired_history",
        status: "released",
        surface_id: "surface_chatgpt_retired_history",
      })
    );

    const projection = await getConnectorBrowserSurfaceProjection("chatgpt");
    assert.equal(projection.unreliable, false);
    assert.equal(projection.evidence?.axis, "unknown");
    assert.equal(projection.evidence?.surfaceId, null);

    const snapshot = projectConnectorSummaryConnectionHealth({
      freshness: FRESH,
      lastRun: succeededRun(),
      lastSuccessfulRun: succeededRun(),
      nowIso: NOW_ISO,
      outbox: { axis: "idle" },
      remoteSurface: projection.evidence,
      schedule: { enabled: true, last_successful_at: PRIOR_SUCCESS_ISO },
    });

    assert.equal(snapshot.state, "unknown", "historical unhealthy surface rows do not become current authority");
    assert.equal(snapshot.axes.remote_surface, "unknown");
  })
);

test(
  "7.6 acceptance: a connector whose manifest declares no browser binding ignores retired browser-surface rows from an earlier setup flow",
  withTempDb(async () => {
    const store = createSqliteBrowserSurfaceLeaseStore();
    // Slack-shaped history: a fully torn-down browser phase from a since-
    // migrated (now static-secret) setup flow — every surface `stopping`,
    // every lease `released`, nothing active or unhealthy. Without the
    // manifest gate this still lands on `BROWSER_SURFACE_UNKNOWN_PROJECTION`
    // (see the "retired browser-surface history" test above), degrading the
    // headline to "unknown" forever even though the connector's current
    // design never places a managed remote surface at all.
    await store.upsertSurface(
      surfaceFixture({
        connector_id: "slack",
        health: "stopping",
        profile_key: "slack",
        surface_id: "surface_slack_legacy_browser_phase",
      })
    );
    await store.upsertLease(
      leaseFixture({
        connector_id: "slack",
        lease_id: "lease_slack_legacy_browser_phase",
        profile_key: "slack",
        released_at: "2026-05-19T10:06:00.000Z",
        run_id: "run_slack_legacy#browser-phase",
        status: "released",
        surface_id: "surface_slack_legacy_browser_phase",
      })
    );

    const withoutGate = await getConnectorBrowserSurfaceProjection("slack", { profileKey: "slack" });
    assert.equal(
      withoutGate.evidence?.axis,
      "unknown",
      "sanity check: the pre-fix call shape still reproduces the stuck-unknown bug"
    );

    const projection = await getConnectorBrowserSurfaceProjection("slack", {
      manifestHasBrowserBinding: false,
      profileKey: "slack",
    });
    assert.equal(projection.unreliable, false);
    assert.equal(
      projection.evidence,
      null,
      "no browser binding in the manifest means no remote-surface evidence at all"
    );

    const snapshot = projectConnectorSummaryConnectionHealth({
      freshness: FRESH,
      lastRun: succeededRun(),
      lastSuccessfulRun: succeededRun(),
      nowIso: NOW_ISO,
      outbox: { axis: "idle" },
      remoteSurface: projection.evidence,
      schedule: { enabled: true, last_successful_at: PRIOR_SUCCESS_ISO },
    });

    assert.equal(
      snapshot.state,
      "healthy",
      "a clean run must not be reported as unknown/not-measured because of a since-migrated connector's old browser-phase rows"
    );
    assert.equal(snapshot.axes.remote_surface, "none");
    assert.equal(snapshot.remote_surface, null);
  })
);

test(
  "7.6 acceptance: a browser-manifest connector on a deployment that dropped the neko overlay ignores retired neko-era rows",
  withTempDb(async () => {
    const store = createSqliteBrowserSurfaceLeaseStore();
    // Chase-shaped history: this connector's manifest genuinely requires a
    // browser binding, and it DID lease neko surfaces once -- but every
    // lease here is terminal (released/deferred/surface_failed) and every
    // surface is `stopping`. Nothing active, nothing unhealthy. A deployment
    // that no longer runs docker-compose.neko.yml will never add a new row
    // here again; today's runs succeed against the in-image managed
    // Chromium/Xvfb runtime instead, entirely outside this store.
    await store.upsertSurface(
      surfaceFixture({
        connector_id: "chase",
        health: "stopping",
        profile_key: "chase",
        surface_id: "surface_chase_legacy_neko_phase",
      })
    );
    await store.upsertLease(
      leaseFixture({
        connector_id: "chase",
        lease_id: "lease_chase_legacy_neko_phase",
        profile_key: "chase",
        released_at: "2026-05-19T10:06:00.000Z",
        run_id: "run_chase_legacy_neko_phase",
        status: "released",
        surface_id: "surface_chase_legacy_neko_phase",
      })
    );

    const withoutGate = await getConnectorBrowserSurfaceProjection("chase", {
      manifestHasBrowserBinding: true,
      profileKey: "chase",
    });
    assert.equal(
      withoutGate.evidence?.axis,
      "unknown",
      "sanity check: a browser-required manifest alone still reproduces the stuck-unknown bug"
    );

    const projection = await getConnectorBrowserSurfaceProjection("chase", {
      connectorUsesNekoSurface: false,
      manifestHasBrowserBinding: true,
      profileKey: "chase",
    });
    assert.equal(projection.unreliable, false);
    assert.equal(
      projection.evidence,
      null,
      "no neko surface in play on this deployment means no remote-surface evidence at all, despite the browser-required manifest"
    );

    const snapshot = projectConnectorSummaryConnectionHealth({
      freshness: FRESH,
      lastRun: succeededRun(),
      lastSuccessfulRun: succeededRun(),
      nowIso: NOW_ISO,
      outbox: { axis: "idle" },
      remoteSurface: projection.evidence,
      schedule: { enabled: true, last_successful_at: PRIOR_SUCCESS_ISO },
    });

    assert.equal(
      snapshot.state,
      "healthy",
      "a fully-collected run on the in-image browser must not be reported unknown because of a dropped neko overlay's old rows"
    );
    assert.equal(snapshot.axes.remote_surface, "none");
    assert.equal(snapshot.remote_surface, null);
  })
);

test(
  "7.6 acceptance: a connector actively using a neko surface still projects its live evidence even when connectorUsesNekoSurface is true",
  withTempDb(async () => {
    const store = createSqliteBrowserSurfaceLeaseStore();
    await store.upsertSurface(surfaceFixture({ active_lease_id: "lease_chatgpt_neko_active" }));
    await store.upsertLease(
      leaseFixture({
        lease_id: "lease_chatgpt_neko_active",
        leased_at: "2026-05-19T11:58:30.000Z",
        run_id: "run_chatgpt_neko_active",
        surface_id: "surface_default",
      })
    );

    const projection = await getConnectorBrowserSurfaceProjection("chatgpt", {
      connectorUsesNekoSurface: true,
      manifestHasBrowserBinding: true,
    });
    assert.equal(projection.unreliable, false);
    assert.equal(projection.evidence?.axis, "leased");
    assert.equal(projection.evidence?.surfaceId, "surface_default");
  })
);

test(
  "7.6 acceptance: released browser-surface lease history with no surface rows still projects unknown, not none",
  withTempDb(async () => {
    const store = createSqliteBrowserSurfaceLeaseStore();
    await store.upsertSurface(
      surfaceFixture({
        health: "unhealthy",
        surface_id: "surface_chatgpt_released_history_only",
      })
    );
    await store.upsertLease(
      leaseFixture({
        connector_id: "chatgpt",
        lease_id: "lease_chatgpt_released_history_only",
        profile_key: "chatgpt",
        released_at: "2026-05-19T10:06:00.000Z",
        run_id: "run_chatgpt_released_history_only",
        status: "released",
        surface_id: "surface_chatgpt_released_history_only",
      })
    );
    getDb().exec("PRAGMA foreign_keys = OFF");
    try {
      getDb().prepare("DELETE FROM browser_surfaces WHERE surface_id = ?").run("surface_chatgpt_released_history_only");
    } finally {
      getDb().exec("PRAGMA foreign_keys = ON");
    }

    const projection = await getConnectorBrowserSurfaceProjection("chatgpt");
    assert.equal(projection.unreliable, false);
    assert.equal(projection.evidence?.axis, "unknown");
    assert.equal(projection.evidence?.surfaceId, null);

    const snapshot = projectConnectorSummaryConnectionHealth({
      freshness: FRESH,
      lastRun: succeededRun(),
      lastSuccessfulRun: succeededRun(),
      nowIso: NOW_ISO,
      outbox: { axis: "idle" },
      remoteSurface: projection.evidence,
      schedule: { enabled: true, last_successful_at: PRIOR_SUCCESS_ISO },
    });

    assert.equal(snapshot.state, "unknown", "released lease history must not collapse to a false-green none axis");
    assert.equal(snapshot.axes.remote_surface, "unknown");
  })
);

// ─── 7.6 structured attention precedence over surface failure ────────────

test("7.6 acceptance: structured OTP attention beats remote-surface failure for the headline, but the surface detail still surfaces the failure", () => {
  const attentionRecord = createAttention({
    action_target: "dashboard",
    auto_detect: false,
    connection_id: "codex",
    dedupe_key: "codex:cin_codex_a:interaction:otp:conversations",
    expires_at: "2026-05-19T12:30:00.000Z",
    id: "att_combined",
    now: "2026-05-19T11:50:00.000Z",
    owner_action: "provide_value",
    progress_posture: "blocked",
    reason_code: "otp_required",
    response_contract: "response_required",
    run_id: "run_combined",
    sensitivity: "non_secret",
  });

  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [attentionRecord],
    freshness: FRESH,
    lastRun: succeededRun({ failure_reason: "manual_verification_required", status: "failed" }),
    lastSuccessfulRun: null,
    nowIso: NOW_ISO,
    outbox: { axis: "idle" },
    remoteSurface: {
      axis: "failed",
      leaseId: null,
      leaseStatus: null,
      profileKey: "codex",
      surfaceHealth: "unhealthy",
      surfaceId: "surface_combined",
      waitReason: "surface_unhealthy",
    },
    schedule: { enabled: true },
  });

  // Owner action precedence (rung 3) beats degraded (rung 6).
  assert.equal(snapshot.state, "needs_attention");
  assert.equal(snapshot.next_action?.source, "structured");
  assert.equal(snapshot.next_action?.reason_code, "otp_required");
  // Surface failure is still inspectable: a blocked/unhealthy surface
  // does not disappear from operator health when something more
  // urgent claims the headline.
  assert.equal(snapshot.axes.remote_surface, "failed");
  assert.ok(snapshot.remote_surface);
  assert.equal(snapshot.remote_surface.surface_health, "unhealthy");
  assert.equal(snapshot.remote_surface.wait_reason, "surface_unhealthy");
});

// ─── 7.6 idle connector without a surface does NOT become unhealthy ──────

test(
  "7.6 acceptance: an idle API connector with no managed remote surface keeps a `none` axis and a healthy headline (no false-degraded)",
  withTempDb(async () => {
    const store = createSqliteBrowserSurfaceLeaseStore();
    // Write evidence for a *different* connector to prove the
    // per-connector filter works correctly. Insert the surface before
    // the lease so the FK in `browser_surface_leases.surface_id`
    // resolves cleanly.
    await store.upsertSurface(surfaceFixture({ active_lease_id: "lease_other", surface_id: "surface_other" }));
    await store.upsertLease(
      leaseFixture({
        connector_id: "chatgpt",
        lease_id: "lease_other",
        run_id: "run_other",
        status: "leased",
        surface_id: "surface_other",
      })
    );

    // gmail in this fixture is unmanaged — no rows. The projection must
    // not invent evidence (no false `unknown`, no false `failed`).
    const projection = await getConnectorBrowserSurfaceProjection("gmail");
    assert.equal(projection.unreliable, false);
    assert.equal(projection.evidence, null, "unmanaged connectors get null evidence, not unknown");

    const snapshot = projectConnectorSummaryConnectionHealth({
      freshness: FRESH,
      lastRun: succeededRun(),
      lastSuccessfulRun: succeededRun(),
      nowIso: NOW_ISO,
      outbox: { axis: "idle" },
      remoteSurface: projection.evidence,
      schedule: { enabled: true, last_successful_at: PRIOR_SUCCESS_ISO },
    });

    assert.equal(snapshot.state, "healthy", "idle API connectors stay healthy when they have no surface");
    assert.equal(snapshot.axes.remote_surface, "none");
    assert.equal(snapshot.remote_surface, null, "no detail block for unmanaged connectors");
  })
);

// ─── 7.6 store outage marks remote_surface_store unreliable ──────────────

test("7.6 acceptance: a browser-surface lease store outage demotes the projection to unknown and names remote_surface_store", async () => {
  const failingStore = {
    listLeases() {
      throw new Error("simulated lease history outage");
    },
    listNonTerminalLeases() {
      throw new Error("simulated lease store outage");
    },
    listSurfaces() {
      throw new Error("simulated surface store outage");
    },
  };

  const projection = await getConnectorBrowserSurfaceProjection("chatgpt", { store: failingStore });
  assert.equal(projection.unreliable, true, "store throw marks projection unreliable");
  assert.equal(projection.evidence?.axis, "unknown");

  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: succeededRun(),
    lastSuccessfulRun: succeededRun(),
    nowIso: NOW_ISO,
    outbox: { axis: "idle" },
    remoteSurface: projection.evidence,
    schedule: { enabled: true },
    unreliableSources: projection.unreliable ? ["remote_surface_store"] : [],
  });

  assert.equal(snapshot.state, "unknown", "unreliable evidence forces unknown headline");
  assert.deepEqual(
    [...snapshot.unknown_reasons],
    ["remote_surface_store"],
    "dashboard sees the broken evidence source explicitly"
  );
  assert.equal(snapshot.axes.remote_surface, "unknown");
});

// ─── 7.6 per-connector isolation ─────────────────────────────────────────

test(
  "7.6 acceptance: remote-surface evidence is scoped per connector_id — chatgpt failure does not contaminate gmail projection",
  withTempDb(async () => {
    const store = createSqliteBrowserSurfaceLeaseStore();
    // chatgpt: live capacity failure modeled by an unhealthy surface.
    await store.upsertSurface(
      surfaceFixture({
        connector_id: "chatgpt",
        health: "unhealthy",
        profile_key: "chatgpt",
        surface_id: "surface_chatgpt_unhealthy",
      })
    );
    // gmail: a separate connector with a queued lease — must not pick
    // up chatgpt's failure axis.
    await store.upsertLease(
      leaseFixture({
        connector_id: "gmail",
        lease_id: "lease_gmail_waiting",
        profile_key: "gmail",
        run_id: "run_gmail_waiting",
        status: "waiting_for_browser_surface",
        wait_reason: "surface_starting",
      })
    );

    const chatgpt = await getConnectorBrowserSurfaceProjection("chatgpt");
    const gmail = await getConnectorBrowserSurfaceProjection("gmail");

    assert.equal(chatgpt.evidence?.axis, "failed");
    assert.equal(chatgpt.evidence?.surfaceId, "surface_chatgpt_unhealthy");
    assert.equal(gmail.evidence?.axis, "waiting");
    assert.equal(gmail.evidence?.leaseId, "lease_gmail_waiting");
    assert.equal(gmail.evidence?.waitReason, "surface_starting");
  })
);

test(
  "7.6 acceptance: remote-surface evidence can be scoped per connection profile so legacy same-connector failures do not contaminate the active connection",
  withTempDb(async () => {
    const store = createSqliteBrowserSurfaceLeaseStore();
    await store.upsertSurface(
      surfaceFixture({
        connector_id: "usaa",
        health: "unhealthy",
        profile_key: "usaa",
        surface_id: "surface_usaa_legacy_unhealthy",
      })
    );
    await store.upsertSurface(
      surfaceFixture({
        connector_id: "usaa",
        health: "ready",
        profile_key: "usaa:cin_active",
        surface_id: "surface_usaa_active_ready",
      })
    );

    const legacyRollup = await getConnectorBrowserSurfaceProjection("usaa");
    const activeConnection = await getConnectorBrowserSurfaceProjection("usaa", { profileKey: "usaa:cin_active" });

    assert.equal(legacyRollup.evidence?.axis, "failed");
    assert.equal(legacyRollup.evidence?.surfaceId, "surface_usaa_legacy_unhealthy");
    assert.equal(activeConnection.evidence?.axis, "idle");
    assert.equal(activeConnection.evidence?.surfaceHealth, "ready");
    assert.equal(activeConnection.evidence?.surfaceId, "surface_usaa_active_ready");
  })
);
