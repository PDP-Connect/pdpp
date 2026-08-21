// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Auto-enrollment for proven, env-wired connectors.
 *
 * Covers the boot-time helper that closes the "registered, listed,
 * proven, env-wired, silently unscheduled" gap for connectors like
 * Notion, Oura, and Strava. The contract under test:
 *
 *   - Eligible-with-env: a manifest that DERIVES automatic (see
 *     runtime/refresh-mode-derivation.ts), is listed as supported, and
 *     declares `capabilities.auth.required` whose env names are all
 *     populated on `process.env` gets a new enabled schedule row at the
 *     manifest-recommended interval.
 *   - Eligible-without-env: the same manifest with one env name unset
 *     produces no row.
 *   - Ineligible policy: a connector whose declared interaction posture
 *     needs a per-run owner gesture, or an explicit `paused`, or an
 *     unproven tier, produces no row even when env is set.
 *   - Derived, not declared: a hand-written `recommended_mode` cannot
 *     override the facts the connector declares, in either direction.
 *   - Idempotency: a second pass over the same controller is a no-op;
 *     an operator-paused row stays paused.
 *
 * Spec: openspec/changes/auto-enroll-eligible-connector-schedules/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorSchedulePatch, ScheduleApi } from "../runtime/controller.ts";
import {
  type AutoEnrollConnectorRow,
  type AutoEnrollControllerLike,
  autoEnrollEligibleSchedules,
} from "../server/auto-enroll-eligible-schedules.ts";

interface TestRefreshPolicy {
  assisted_after_owner_auth?: boolean;
  background_safe: boolean;
  interaction_posture?: string;
  recommended_interval_seconds?: number;
  recommended_mode: string;
}

interface TestPublicListing {
  tier: "supported" | "preview" | "development";
}

interface TestAuthRequirement {
  kind: string;
  required: ReadonlyArray<string | readonly [string, string]>;
}

interface TestManifest {
  capabilities: {
    auth?: TestAuthRequirement;
    public_listing: TestPublicListing;
    refresh_policy: TestRefreshPolicy;
  };
  connector_id: string;
  version: string;
}

function manifest(overrides: Partial<TestManifest> = {}): TestManifest {
  return {
    capabilities: {
      auth: {
        kind: "env",
        required: ["WIDGET_TOKEN"],
      },
      public_listing: {
        tier: "supported",
      },
      refresh_policy: {
        background_safe: true,
        recommended_interval_seconds: 1800,
        recommended_mode: "automatic",
      },
    },
    connector_id: "https://registry.example.test/connectors/widget",
    version: "0.1.0",
    ...overrides,
  };
}

/**
 * `AutoEnrollControllerLike` declares `getSchedule`/`upsertSchedule` against
 * the real `ScheduleApi` shape, but this pass only ever checks the returned
 * schedule for truthiness (see `attachScheduleForEligibleConnector` in
 * `server/auto-enroll-eligible-schedules.ts`) — it never reads any field
 * beyond that. This factory fabricates a fully valid `ScheduleApi` so the
 * fake stays a real implementer of the interface instead of a cast.
 */
function makeFakeSchedule(connectorId: string, patch: ConnectorSchedulePatch, createdAt: string): ScheduleApi {
  const now = new Date().toISOString();
  return {
    active_run_id: null,
    automation_mode: "unattended",
    automation_summary: "fake schedule for auto-enroll test",
    connector_id: connectorId,
    connector_instance_id: connectorId,
    created_at: createdAt,
    effective_mode: patch.enabled === false ? "paused" : "automatic",
    enabled: patch.enabled ?? true,
    human_attention_needed: false,
    ineligibility_reason: null,
    interval_seconds: patch.interval_seconds,
    jitter_seconds: patch.jitter_seconds ?? 0,
    last_error_code: null,
    last_finished_at: null,
    last_started_at: null,
    last_successful_at: null,
    minimum_interval_warning: null,
    next_due_at: null,
    notification_posture: "none",
    object: "schedule",
    recommended_policy: null,
    scheduler_backoff: null,
    trigger_kind: "scheduled",
    updated_at: now,
  };
}

interface FakeController extends AutoEnrollControllerLike {
  readonly schedules: Map<string, ScheduleApi>;
}

function createFakeController(): FakeController {
  const schedules = new Map<string, ScheduleApi>();
  return {
    getSchedule: async (connectorId: string) => schedules.get(connectorId) ?? null,
    schedules,
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    upsertSchedule: async (connectorId: string, input: ConnectorSchedulePatch) => {
      const now = new Date().toISOString();
      const createdAt = schedules.get(connectorId)?.created_at ?? now;
      const row = makeFakeSchedule(connectorId, input, createdAt);
      schedules.set(connectorId, row);
      return { policy_warning: null, schedule: row };
    },
  };
}

function singleManifestList(m: TestManifest): () => Promise<readonly AutoEnrollConnectorRow[]> {
  return async () => [{ connector_id: m.connector_id, manifest: m }];
}

test("eligible-with-env enrolls a new schedule at the manifest-recommended interval", async () => {
  const controller = createFakeController();
  const m = manifest();
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.scanned, 1);
  assert.equal(summary.enrolled, 1);
  assert.equal(summary.errors, 0);
  assert.equal(summary.skipped_env, 0);
  assert.equal(summary.skipped_existing, 0);
  assert.equal(summary.skipped_policy, 0);
  const enrolled = controller.schedules.get(m.connector_id);
  assert.ok(enrolled, "a row was inserted");
  assert.equal(enrolled.enabled, true, "enrolled enabled");
  assert.equal(enrolled.interval_seconds, 1800, "recommended interval honored");
  assert.equal(enrolled.jitter_seconds, 0);
});

test("eligible manifest without recommended_interval_seconds falls back to 3600", async () => {
  const controller = createFakeController();
  const m = manifest();
  const { recommended_interval_seconds: _recommendedIntervalSeconds, ...refreshPolicy } = m.capabilities.refresh_policy;
  await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList({ ...m, capabilities: { ...m.capabilities, refresh_policy: refreshPolicy } }),
  });
  const fallbackRow = controller.schedules.get(m.connector_id);
  assert.ok(fallbackRow, "a row was inserted");
  assert.equal(fallbackRow.interval_seconds, 3600);
});

test("missing env keeps the connector honestly unscheduled and counts skipped_env", async () => {
  const controller = createFakeController();
  const m = manifest();
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: {
      /* WIDGET_TOKEN intentionally absent */
    },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.scanned, 1);
  assert.equal(summary.enrolled, 0);
  assert.equal(summary.skipped_env, 1);
  assert.equal(controller.schedules.size, 0);
});

test("blank or whitespace-only env value is treated as missing", async () => {
  const controller = createFakeController();
  const m = manifest();
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "   " },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_env, 1);
  assert.equal(controller.schedules.size, 0);
});

test("alias-array entry is satisfied when the fallback alias is set", async () => {
  const controller = createFakeController();
  const m = manifest({
    capabilities: {
      ...manifest().capabilities,
      auth: { kind: "env", required: [["WIDGET_TOKEN", "WIDGET_PAT"]] },
    },
  });
  // Only the fallback alias is set; the first-listed alias is empty.
  // Runtime first-set-wins says this is enough credential; the enrollment
  // gate must agree.
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_PAT: "alt-set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 1);
  assert.equal(summary.skipped_env, 0);
});

test("alias-array entry is satisfied when the first-listed alias is set", async () => {
  const controller = createFakeController();
  const m = manifest({
    capabilities: {
      ...manifest().capabilities,
      auth: { kind: "env", required: [["WIDGET_TOKEN", "WIDGET_PAT"]] },
    },
  });
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "primary-set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 1);
});

test("alias-array entry is unsatisfied only when EVERY alias is absent or empty", async () => {
  const controller = createFakeController();
  const m = manifest({
    capabilities: {
      ...manifest().capabilities,
      auth: { kind: "env", required: [["WIDGET_TOKEN", "WIDGET_PAT"]] },
    },
  });
  // Both aliases present-but-empty count as unsatisfied (whitespace is
  // treated as missing, same as the runtime).
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_PAT: "   ", WIDGET_TOKEN: "" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 0);
  assert.equal(summary.skipped_env, 1);
});

test("mixed string + alias-array entries each apply their own rule", async () => {
  const controller = createFakeController();
  const m = manifest({
    capabilities: {
      ...manifest().capabilities,
      auth: {
        kind: "env",
        required: ["WIDGET_TOKEN", ["WIDGET_REGION", "WIDGET_DEFAULT_REGION"]],
      },
    },
  });
  // String entry: WIDGET_TOKEN must itself be non-empty.
  // Alias entry: any one of WIDGET_REGION / WIDGET_DEFAULT_REGION suffices.
  const satisfied = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_DEFAULT_REGION: "us-east-1", WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(satisfied.enrolled, 1);

  const controller2 = createFakeController();
  // String entry missing -> whole requirement fails, even though the
  // alias is satisfied.
  const stringMissing = await autoEnrollEligibleSchedules({
    controller: controller2,
    env: { WIDGET_DEFAULT_REGION: "us-east-1" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(stringMissing.skipped_env, 1);
  assert.equal(stringMissing.enrolled, 0);

  const controller3 = createFakeController();
  // Alias entirely absent -> requirement fails, even though the string
  // is satisfied.
  const aliasMissing = await autoEnrollEligibleSchedules({
    controller: controller3,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(aliasMissing.skipped_env, 1);
  assert.equal(aliasMissing.enrolled, 0);
});

test("a connector needing a per-run owner gesture is never auto-enrolled even when env is present", async () => {
  // The safety property this pass must keep: a connector whose declared
  // interaction posture requires the owner at every run never gets an
  // unattended schedule. Mode is derived from that posture, so the posture
  // is what the test states — an interactive-login connector that has NOT
  // declared session persistence, i.e. the Chase/USAA shape.
  const controller = createFakeController();
  const m = manifest();
  m.capabilities.refresh_policy.interaction_posture = "otp_likely";
  m.capabilities.refresh_policy.background_safe = false;
  m.capabilities.refresh_policy.recommended_mode = "manual";
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_policy, 1);
  assert.equal(summary.enrolled, 0);
  assert.equal(controller.schedules.size, 0);
});

test("a file-import connector is never auto-enrolled even when env is present", async () => {
  const controller = createFakeController();
  const m = manifest();
  m.capabilities.refresh_policy.interaction_posture = "manual_action_likely";
  m.capabilities.refresh_policy.background_safe = false;
  m.capabilities.refresh_policy.recommended_mode = "manual";
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_policy, 1);
  assert.equal(summary.enrolled, 0);
});

test("a hand-written manual mode cannot veto the facts the connector declares", async () => {
  // The defect this fixes: Amazon/Reddit/H-E-B each declared
  // background_safe:true (the session persists after first login) and were
  // still refused a schedule because a hand-written string said "manual".
  // Mode is derived, so the declared fact wins.
  const controller = createFakeController();
  const m = manifest();
  m.capabilities.refresh_policy.interaction_posture = "otp_likely";
  m.capabilities.refresh_policy.background_safe = true;
  m.capabilities.refresh_policy.recommended_mode = "manual";
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 1);
  assert.equal(summary.skipped_policy, 0);
});

test("recommended_mode=paused is honored as deliberate operator intent", async () => {
  const controller = createFakeController();
  const m = manifest();
  m.capabilities.refresh_policy.recommended_mode = "paused";
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_policy, 1);
  assert.equal(summary.enrolled, 0);
  assert.equal(controller.schedules.size, 0);
});

test("background_safe=false on a gesture-free connector no longer blocks enrollment", async () => {
  // Notion/Oura/Strava shape: a pure token connector that used
  // background_safe:false to mean "unproven". Maturity is the tier gate's
  // job; with tier=supported there is nothing left to block on.
  const controller = createFakeController();
  const m = manifest();
  m.capabilities.refresh_policy.interaction_posture = "none";
  m.capabilities.refresh_policy.background_safe = false;
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 1);
  assert.equal(summary.skipped_policy, 0);
});

test("assisted_after_owner_auth=true does not by itself block enrollment", async () => {
  // It means "a background run may ask for bounded help", which
  // run-automation-policy.ts projects as automation_mode:"assisted" while
  // still allowing the run to start. Using it as a hard gate here
  // contradicted that engine.
  const controller = createFakeController();
  const m = manifest();
  m.capabilities.refresh_policy.interaction_posture = "otp_likely";
  m.capabilities.refresh_policy.background_safe = true;
  m.capabilities.refresh_policy.assisted_after_owner_auth = true;
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 1);
  assert.equal(summary.skipped_policy, 0);
});

test('public_listing.tier != "supported" is never auto-enrolled', async () => {
  const controller = createFakeController();
  const m = manifest();
  m.capabilities.public_listing.tier = "preview";
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_policy, 1);
  assert.equal(summary.enrolled, 0);
});

test("a Development connector is never auto-enrolled", async () => {
  const controller = createFakeController();
  const m = manifest();
  m.capabilities.public_listing.tier = "development";
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_policy, 1);
  assert.equal(summary.enrolled, 0);
});

test("manifest without capabilities.auth.required cannot be auto-enrolled", async () => {
  const controller = createFakeController();
  const m = manifest();
  const { auth: _auth, ...capabilities } = m.capabilities;
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList({ ...m, capabilities }),
  });
  // Counted apart from skipped_policy: nothing is wrong with this
  // connector's policy — the pass simply has no env requirement to gate on.
  // Conflating the two is what made a no-op boot log read as 25 policy
  // rejections. The connector remains visible in the catalog and the doctor
  // still reports it as NOSCHED.
  assert.equal(summary.skipped_no_auth_requirement, 1);
  assert.equal(summary.skipped_policy, 0);
  assert.equal(summary.enrolled, 0);
});

test("existing schedule row is never overwritten (idempotent re-run)", async () => {
  const controller = createFakeController();
  const m = manifest();
  // Pretend the operator already paused the schedule with a custom interval.
  controller.schedules.set(
    m.connector_id,
    makeFakeSchedule(
      m.connector_id,
      { enabled: false, interval_seconds: 60, jitter_seconds: 15 },
      "2024-01-01T00:00:00.000Z"
    )
  );
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_existing, 1);
  assert.equal(summary.enrolled, 0);
  const row = controller.schedules.get(m.connector_id);
  assert.ok(row, "the pre-seeded row is still present");
  assert.equal(row.enabled, false, "operator-paused row stays paused");
  assert.equal(row.interval_seconds, 60, "operator-set interval is preserved");
  assert.equal(row.jitter_seconds, 15);
});

test("second pass after enrollment is a no-op", async () => {
  const controller = createFakeController();
  const m = manifest();
  await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  const firstRow = { ...controller.schedules.get(m.connector_id) };
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 0);
  assert.equal(summary.skipped_existing, 1);
  // updated_at may differ only because of a write — but no write should
  // have happened. Compare the full row instead.
  assert.deepEqual(controller.schedules.get(m.connector_id), firstRow);
});

test("enabled=false short-circuits the entire pass", async () => {
  const controller = createFakeController();
  const m = manifest();
  const summary = await autoEnrollEligibleSchedules({
    controller,
    enabled: false,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.scanned, 0);
  assert.equal(summary.enrolled, 0);
  assert.equal(controller.schedules.size, 0);
});

test("multiple connectors are evaluated independently in one pass", async () => {
  const controller = createFakeController();
  const eligible = manifest({ connector_id: "eligible" });
  const noEnv = manifest({ connector_id: "no-env" });
  const manual = manifest({ connector_id: "manual" });
  manual.capabilities.refresh_policy.recommended_mode = "manual";
  // Declared facts, not the hand-written string, are what derive manual.
  manual.capabilities.refresh_policy.interaction_posture = "otp_likely";
  manual.capabilities.refresh_policy.background_safe = false;
  const list = async () => [
    { connector_id: eligible.connector_id, manifest: eligible },
    { connector_id: noEnv.connector_id, manifest: noEnv },
    { connector_id: manual.connector_id, manifest: manual },
  ];
  // Same WIDGET_TOKEN env satisfies eligible and manual; manual is still
  // blocked by policy. no-env has its own required env that we leave unset.
  const noEnvManifest = { ...noEnv };
  noEnvManifest.capabilities = {
    ...noEnv.capabilities,
    auth: { kind: "env", required: ["NO_ENV_TOKEN"] },
  };
  const list2 = async () => [
    { connector_id: eligible.connector_id, manifest: eligible },
    { connector_id: noEnvManifest.connector_id, manifest: noEnvManifest },
    { connector_id: manual.connector_id, manifest: manual },
  ];
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: list2,
  });
  assert.equal(summary.scanned, 3);
  assert.equal(summary.enrolled, 1, "only eligible was enrolled");
  assert.equal(summary.skipped_env, 1, "no-env was skipped by env gate");
  assert.equal(summary.skipped_policy, 1, "manual was skipped by policy");
  assert.ok(controller.schedules.has("eligible"));
  assert.ok(!controller.schedules.has("no-env"));
  assert.ok(!controller.schedules.has("manual"));
  // Suppress the unused-var lint without changing test scope: `list` was
  // used to express the alternate shape before the override.
  // biome-ignore lint/complexity/noVoid: expression intentionally discards a test-only value
  void list;
});

test("controller upsertSchedule throwing increments errors and continues", async () => {
  const controller = {
    getSchedule: async () => null,
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    upsertSchedule: async () => {
      throw new Error("boom");
    },
  };
  const m = manifest();
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.errors, 1);
  assert.equal(summary.enrolled, 0);
});

// ─── Store-aware credential gate ────────────────────────────────────────────
//
// Incident regression (2026-06-09): credentials migrated env→store left the
// deployment with NO usable credential env vars (absent or compose-`${VAR:-}`
// empty strings). Eligibility must treat an active per-connection store row
// as equivalent to populated env, or env-free deployments silently never
// enroll their store-backed connectors.

test("a stored credential satisfies eligibility when env vars are absent", async () => {
  const controller = createFakeController();
  const m = manifest();
  const probed: string[] = [];
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: {},
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    hasStoredCredential: async (connectorId: string) => {
      probed.push(connectorId);
      return true;
    },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 1);
  assert.equal(summary.skipped_env, 0);
  assert.deepEqual(probed, [m.connector_id]);
  assert.ok(controller.schedules.get(m.connector_id)?.enabled);
});

test("a stored credential satisfies eligibility when env vars are empty strings", async () => {
  const controller = createFakeController();
  const m = manifest();
  const summary = await autoEnrollEligibleSchedules({
    controller,
    // The recreated-container posture: the var EXISTS but is empty. The env
    // gate already trims, and the store probe must then satisfy eligibility.
    env: { WIDGET_TOKEN: "" },
    hasStoredCredential: async () => true,
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 1);
  assert.equal(summary.skipped_env, 0);
});

test("no env and no stored credential still counts skipped_env", async () => {
  const controller = createFakeController();
  const m = manifest();
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: {},
    hasStoredCredential: async () => false,
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 0);
  assert.equal(summary.skipped_env, 1);
});

test("the store probe is not consulted when env already satisfies the requirement", async () => {
  const controller = createFakeController();
  const m = manifest();
  let probes = 0;
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: { WIDGET_TOKEN: "set" },
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    hasStoredCredential: async () => {
      probes += 1;
      return false;
    },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 1);
  assert.equal(probes, 0, "env presence short-circuits the store probe");
});

test("a throwing store probe counts as an error and does not enroll", async () => {
  const controller = createFakeController();
  const m = manifest();
  const summary = await autoEnrollEligibleSchedules({
    controller,
    env: {},
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    hasStoredCredential: async () => {
      throw new Error("store unavailable");
    },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.enrolled, 0);
  assert.equal(summary.errors, 1);
  assert.equal(summary.skipped_env, 0);
});

test("an ineligible connector is never probed for an existing schedule", async () => {
  // Explains the live boot log {"scanned":25,"enrolled":0,"skipped_policy":25,
  // "skipped_existing":0} on a deployment that HAS existing schedule rows.
  // The manifest gate runs BEFORE the existing-schedule probe, so a connector
  // rejected on policy never reaches getSchedule and never counts toward
  // skipped_existing. That ordering is deliberate and safe — this pass only
  // ever ADDS a row, and the cheap pure-manifest check short-circuits before
  // the per-connector store read — but it does mean skipped_existing counts
  // "eligible AND already scheduled", not "already scheduled".
  const probed: string[] = [];
  const controller = createFakeController();
  const scheduled = makeFakeSchedule(
    "ineligible",
    { enabled: true, interval_seconds: 900 },
    "2024-01-01T00:00:00.000Z"
  );
  controller.schedules.set("ineligible", scheduled);
  const probingController: AutoEnrollControllerLike = {
    getSchedule: (connectorId: string) => {
      probed.push(connectorId);
      return controller.getSchedule(connectorId);
    },
    upsertSchedule: controller.upsertSchedule,
  };
  const m = manifest({ connector_id: "ineligible" });
  m.capabilities.refresh_policy.interaction_posture = "otp_likely";
  m.capabilities.refresh_policy.background_safe = false;
  const summary = await autoEnrollEligibleSchedules({
    controller: probingController,
    env: { WIDGET_TOKEN: "set" },
    listConnectors: singleManifestList(m),
  });
  assert.equal(summary.skipped_policy, 1);
  assert.equal(summary.skipped_existing, 0, "the existing row is not counted because policy rejected first");
  assert.deepEqual(probed, [], "getSchedule must not be called for a policy-rejected connector");
  // The pre-existing row is left exactly as the operator left it.
  assert.equal(controller.schedules.get("ineligible"), scheduled);
});
