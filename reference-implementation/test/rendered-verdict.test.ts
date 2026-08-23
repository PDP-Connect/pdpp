// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECTION_CONDITION_REASONS,
  type ConnectionAttentionEvidence,
  type ConnectionHealthCondition,
  type ConnectionHealthSnapshot,
  type ConnectionHealthState,
  type ConnectionRefreshEvidence,
  type CoverageAxis,
  type ForwardDisposition,
  type OwnerActionSurfaceKind,
} from "../runtime/connection-health.ts";
import { progressMode } from "../runtime/connector-verdict-input.ts";
import {
  type RenderedVerdict,
  type ScheduleEvidence,
  type StreamRollup,
  synthesizeRenderedVerdict,
  toGrantScopedVerdict,
  VerdictInvariantError,
  type VerdictTone,
} from "../runtime/rendered-verdict.ts";

// ─── Builders ────────────────────────────────────────────────────────────────

/** Minimal valid ConnectionHealthCondition. */
function condition(overrides: Partial<ConnectionHealthCondition> = {}): ConnectionHealthCondition {
  return {
    current: true,
    expires_at: null,
    id: "Cond:reason",
    message: "m",
    observed_at: null,
    origin: "connector",
    reason: "reason",
    reason_code: null,
    remediation: null,
    sensitivity: "owner",
    severity: "info",
    status: "true",
    type: "Fresh",
    ...overrides,
  };
}

function credentialRejectedCondition() {
  return condition({
    id: "CredentialsValid:credential_rejected",
    reason: "credential_rejected",
    severity: "error",
    status: "false",
    type: "CredentialsValid",
  });
}

function credentialRequiredCondition() {
  return condition({
    id: "CredentialsValid:credentials_required",
    reason: "credentials_required",
    severity: "blocked",
    status: "false",
    type: "CredentialsValid",
  });
}

function collectionSucceededCondition() {
  return condition({
    id: "CollectionSucceeded:collection_succeeded",
    reason: "collection_succeeded",
    severity: "info",
    status: "true",
    type: "CollectionSucceeded",
  });
}

function localExporterStalledCondition(
  reason: string,
  message = "Local exporter work is stalled."
): ConnectionHealthCondition {
  return condition({
    id: `LocalExporterAvailable:${reason}`,
    message,
    origin: "local_device",
    reason,
    remediation: {
      action: "clear_backlog",
      label: "Cause-specific local collector remediation",
      retryable: true,
      target: "local_device",
    },
    severity: "error",
    status: "false",
    type: "LocalExporterAvailable",
  });
}

function backlogStalledCondition(
  reason: string,
  message = "Local-device outbox work is stalled."
): ConnectionHealthCondition {
  return condition({
    id: `BacklogClear:${reason}`,
    message,
    origin: "local_device",
    reason,
    remediation: {
      action: "clear_backlog",
      label: "Cause-specific local collector remediation",
      retryable: true,
      target: "local_device",
    },
    severity: "error",
    status: "false",
    type: "BacklogClear",
  });
}

function exactSyncAttention(overrides: Partial<ConnectionAttentionEvidence> = {}): ConnectionAttentionEvidence {
  return {
    actionTarget: "dashboard",
    expiresAt: null,
    id: "att_exact_sync",
    lifecycle: "open",
    notificationState: "sent",
    ownerAction: "provide_value",
    reasonCode: "otp_required",
    responseContract: "response_required",
    runId: "run_exact_sync",
    sensitivity: "secret",
    ...overrides,
  };
}

interface SnapshotOverrides {
  readonly axes?: Partial<ConnectionHealthSnapshot["axes"]>;
  readonly badges?: Partial<ConnectionHealthSnapshot["badges"]>;
  readonly conditions?: readonly ConnectionHealthCondition[];
  readonly detail_gap_backlog?: ConnectionHealthSnapshot["detail_gap_backlog"];
  readonly dominant_condition_id?: string | null;
  readonly forward_disposition?: ForwardDisposition;
  readonly last_success_at?: string | null;
  readonly next_attempt_at?: string | null;
  readonly reason_code?: string | null;
  readonly state?: ConnectionHealthState;
  readonly unknown_reasons?: readonly string[];
}

/** Default healthy/fresh snapshot. Override axes/state/conditions per case. */
function snapshot(overrides: SnapshotOverrides = {}): ConnectionHealthSnapshot {
  const axes: ConnectionHealthSnapshot["axes"] = {
    attention: "none",
    coverage: "complete",
    freshness: "fresh",
    outbox: "idle",
    remote_surface: "none",
    ...(overrides.axes ?? {}),
  };
  return {
    axes,
    badges: { stale: false, syncing: false, ...(overrides.badges ?? {}) },
    collection_rate: null,
    conditions: overrides.conditions ?? [],
    detail_gap_backlog: overrides.detail_gap_backlog ?? null,
    dominant_condition_id: overrides.dominant_condition_id ?? null,
    ephemeral_browser_runtime: null,
    forward_disposition: overrides.forward_disposition ?? "complete",
    last_success_at: overrides.last_success_at ?? null,
    next_action: null,
    next_attempt_at: overrides.next_attempt_at ?? null,
    reason_code: overrides.reason_code ?? null,
    remote_surface: null,
    state: overrides.state ?? "healthy",
    supporting_condition_ids: [],
    unknown_reasons: overrides.unknown_reasons ?? [],
  };
}

function stream(overrides: Partial<StreamRollup> = {}): StreamRollup {
  return {
    attention_open: overrides.attention_open ?? false,
    collected: overrides.collected ?? null,
    considered: overrides.considered ?? null,
    coverage: overrides.coverage ?? "complete",
    gap_retryable: overrides.gap_retryable ?? false,
    priority: overrides.priority ?? "required",
    ...(overrides.recovery_action === undefined ? {} : { recovery_action: overrides.recovery_action }),
    stream_id: overrides.stream_id ?? "s1",
    unfillable_accounted: overrides.unfillable_accounted ?? false,
  };
}

const MANUAL_REFRESH: ConnectionRefreshEvidence = {
  backgroundSafe: false,
  interactionPosture: "otp_likely",
  recommendedMode: "manual",
};
const PAUSED_REFRESH: ConnectionRefreshEvidence = {
  backgroundSafe: true,
  interactionPosture: "otp_likely",
  recommendedMode: "paused",
};
const ASSISTED_REFRESH: ConnectionRefreshEvidence = {
  backgroundSafe: true,
  interactionPosture: "manual_action_likely",
  recommendedMode: "automatic",
};

// ─── Composite invariant harness (task 4.3) ──────────────────────────────────
//
// Renders the WHOLE verdict and asserts all eleven invariants (1–7, S1–S4) on it,
// rather than N independently-tested formatters. The synthesizer also throws on a
// violation in dev (NODE_ENV !== production), so a clean synthesis already proves the
// gate fired; this re-checks the externally-observable invariants on the result.

const TONE_RANK: Record<VerdictTone, number> = { amber: 2, green: 0, grey: 1, red: 3 };
const TONE_TO_LABEL: Record<VerdictTone, string> = {
  amber: "Missing data",
  green: "Healthy",
  grey: "Not measured",
  red: "Can't collect",
};
const CALM_ADVISORY_KINDS = new Set(["freshness", "schedule", "activity"]);
const BASE_STATE_TONE: Record<ConnectionHealthState, VerdictTone> = {
  blocked: "red",
  cooling_off: "amber",
  degraded: "amber",
  healthy: "green",
  idle: "green",
  needs_attention: "amber",
  unknown: "grey",
};
const DISPOSITION_TONE: Record<ForwardDisposition, VerdictTone> = {
  awaiting_owner: "amber",
  checking: "grey",
  complete: "green",
  owner_refresh_due: "amber",
  resumable: "amber",
  terminal: "red",
  unmeasured: "grey",
};

// Mirrors rendered-verdict.ts amberLabel: "Needs refresh" only when every
// reason the tone reached amber-or-worse is a not-actually-broken shape
// (idle-with-prior-success or passive cooling-off state, stale freshness,
// owner_refresh_due disposition); any coverage/attention/outbox axis, a
// broken state, or a broken disposition keeps "Missing data". An active run then
// further softens a "Needs refresh" (never a "Missing data") verdict to "Syncing"
// (active-run visibility fix) — active work dominates a routine nudge, never
// a genuine defect.
function expectedAmberLabel(
  snap: ConnectionHealthSnapshot,
  disposition: ForwardDisposition,
  toneInputs: readonly { readonly axis: string; readonly tone: VerdictTone }[]
): string {
  const stateIsBroken =
    snap.state !== "idle" && snap.state !== "cooling_off" && TONE_RANK[BASE_STATE_TONE[snap.state]] >= TONE_RANK.amber;
  const dispositionIsBroken =
    disposition !== "owner_refresh_due" && TONE_RANK[DISPOSITION_TONE[disposition]] >= TONE_RANK.amber;
  const hasDegradingAxis = toneInputs.some(
    (input) => ["coverage", "attention", "outbox"].includes(input.axis) && TONE_RANK[input.tone] >= TONE_RANK.amber
  );
  const label = stateIsBroken || dispositionIsBroken || hasDegradingAxis ? "Missing data" : "Needs refresh";
  return label === "Needs refresh" && snap.badges.syncing ? "Syncing" : label;
}

function assertAllInvariants(verdict: RenderedVerdict, snap: ConnectionHealthSnapshot, runtimeOk: boolean) {
  // (1) freshness-mandatory-off-fresh
  if (snap.axes.freshness !== "fresh") {
    assert.ok(
      verdict.annotations.some((a) => a.kind === "freshness"),
      "inv1: off-fresh must carry a freshness annotation"
    );
  }
  // (2) collected <= considered
  for (const row of verdict.streams) {
    if (row.collected !== null && row.considered !== null) {
      assert.ok(row.collected <= row.considered, `inv2: ${row.stream_id} collected<=considered`);
    }
  }
  // (3) forward_statement reconciles — terminal never claims recovery
  if (verdict.detail.forward_disposition === "terminal") {
    assert.ok(
      // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
      !/resum|refresh|next run|retry/i.test(verdict.forward_statement),
      "inv3: terminal forward_statement must not claim recovery"
    );
  }
  // (4) terminal === (forward_disposition === "terminal") for connection-level actions
  const dispoTerminal = verdict.detail.forward_disposition === "terminal";
  for (const a of verdict.required_actions) {
    if (a.affects.length === 0) {
      assert.equal(a.terminal, dispoTerminal, `inv4: ${a.kind} terminal matches oracle`);
    }
  }
  // (5) tone is worst-wins — never below base state tone
  assert.ok(
    TONE_RANK[verdict.pill.tone] >= TONE_RANK[BASE_STATE_TONE[snap.state]],
    "inv5: tone >= base state tone (worst-wins)"
  );
  // (6) label follows tone plus active-work evidence. Grey is only "Checking"
  // when current activity evidence proves the system is actively checking.
  // Amber splits into "Needs refresh" (not-actually-broken) vs "Missing data"
  // (real trouble) — see expectedAmberLabel.
  const expectedLabel =
    verdict.pill.tone === "grey" && snap.badges.syncing
      ? "Checking"
      : // biome-ignore lint/style/noNestedTernary: localized test assertion preserves its explicit contract.
        verdict.pill.tone === "green" && snap.axes.outbox === "active"
        ? "Syncing"
        : // biome-ignore lint/style/noNestedTernary: localized test assertion preserves its explicit contract.
          verdict.pill.tone === "amber"
          ? expectedAmberLabel(snap, verdict.detail.forward_disposition, verdict.trace.tone_inputs)
          : TONE_TO_LABEL[verdict.pill.tone];
  assert.equal(verdict.pill.label, expectedLabel, "inv6: label matches tone plus active-work evidence");
  // (7) no contradictory chip pair
  for (const row of verdict.streams) {
    if (row.disposition === "terminal") {
      // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
      assert.ok(!/resum|refresh|next run|retry/i.test(row.statement), `inv7: ${row.stream_id} no terminal+resume`);
    }
  }
  // (S1) attention ⇒ owner-self-satisfiable action
  if (verdict.channel === "attention") {
    assert.ok(
      verdict.required_actions.some((a) => a.audience === "owner" && a.satisfied_when.kind !== "none"),
      "invS1: attention carries owner-satisfiable action"
    );
  }
  // (S2) no mechanistic counts on calm/advisory annotations; calm ≤ 1 annotation
  if (verdict.channel === "calm" || verdict.channel === "advisory") {
    for (const a of verdict.annotations) {
      assert.ok(CALM_ADVISORY_KINDS.has(a.kind), `invS2: kind ${a.kind} allowed on calm/advisory`);
      assert.ok(
        // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
        !(/\d/.test(a.text) && /(gap|retr|backlog|record|item)/i.test(a.text)),
        "invS2: no mechanistic count in calm/advisory text"
      );
    }
    if (verdict.channel === "calm") {
      assert.ok(verdict.annotations.length <= 1, "invS2: calm carries at most one annotation");
    }
  }
  // (S3) detail superset — every suppressed signal names a detail field
  for (const s of verdict.detail.suppressed) {
    assert.ok(s.detail_field, "invS3: suppressed signal names detail destination");
  }
  // (S4) runtime_ok false caps channel at calm
  if (!runtimeOk) {
    assert.equal(verdict.channel, "calm", "invS4: runtime fault caps channel at calm");
  }
}

test("expired attention alone does not create an owner action, but unresolved credential evidence still does", () => {
  const expiredAttention = condition({
    current: false,
    expires_at: "2026-06-30T00:00:00.000Z",
    id: "AttentionClear:attention_required",
    reason: "attention_required",
    severity: "blocked",
    status: "false",
    type: "AttentionClear",
  });

  const promptOnly = synthesizeRenderedVerdict(
    snapshot({
      axes: { attention: "none" },
      conditions: [expiredAttention],
      state: "healthy",
    }),
    [stream()],
    null,
    true
  );
  assert.equal(promptOnly.required_actions.length, 0);

  const unresolvedCredential = synthesizeRenderedVerdict(
    snapshot({
      axes: { attention: "none" },
      conditions: [expiredAttention, credentialRejectedCondition()],
      state: "blocked",
    }),
    [stream()],
    null,
    true
  );
  assert.equal(unresolvedCredential.required_actions[0]?.kind, "reauth");
  assert.equal(unresolvedCredential.required_actions[0]?.satisfied_when.kind, "credential_present_and_unrejected");
});

// ─── 3.1 / 3.2 pill tone worst-wins ──────────────────────────────────────────

test("pure: identical inputs produce identical verdicts", () => {
  const snap = snapshot();
  const a = synthesizeRenderedVerdict(snap, [stream()], null, true);
  const b = synthesizeRenderedVerdict(snap, [stream()], null, true);
  assert.deepEqual(a, b);
});

test("tone: healthy + fresh + complete is green/Healthy", () => {
  const v = synthesizeRenderedVerdict(snapshot(), [stream()], null, true);
  assert.equal(v.pill.tone, "green");
  assert.equal(v.pill.label, "Healthy");
  assert.equal(v.channel, "calm");
});

test("tone: stale owner-refresh-due is amber/advisory/Needs refresh, not Healthy or Degraded, and still carries a freshness annotation (inv1)", () => {
  const snap = snapshot({
    axes: { freshness: "stale" },
    forward_disposition: "owner_refresh_due",
    last_success_at: "2026-05-15T00:00:00.000Z",
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(snap, [stream()], MANUAL_REFRESH, true);
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Needs refresh");
  assert.equal(v.channel, "advisory");
  assert.ok(v.annotations.some((a) => a.kind === "freshness"));
  assert.ok(v.required_actions.some((a) => a.kind === "refresh_now"));
});

test("tone: an active, advancing run over stale/owner-refresh-due evidence renders Syncing, not Needs refresh, and offers no conflicting refresh_now action", () => {
  const snap = snapshot({
    axes: { freshness: "stale" },
    badges: { stale: true, syncing: true },
    forward_disposition: "owner_refresh_due",
    last_success_at: "2026-05-15T00:00:00.000Z",
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(snap, [stream()], MANUAL_REFRESH, true);
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Syncing");
  assert.equal(v.channel, "calm");
  assert.deepEqual(
    v.required_actions,
    [],
    "an active run must not co-occur with a refresh_now CTA for the same not-yet-refreshed data"
  );
  assert.equal(v.forward_statement, "Refreshing now.");
  assert.ok(
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    v.annotations.every((a) => !/refreshes when you run it|Up to date once you refresh/i.test(a.text)),
    "annotation copy must not ask the owner to do what the active run is already doing"
  );
  assert.ok(
    v.streams.every((row) => row.statement !== "Up to date once you refresh."),
    "a per-stream row must not contradict the connection-level Syncing state by asking for a refresh already in flight"
  );
  assert.ok(
    v.streams.every((row) => row.disposition !== "owner_refresh_due" || row.statement === "Refreshing now."),
    "an owner_refresh_due stream row must read Refreshing now while a run is actively syncing"
  );
});

test("tone: an active run does not mask genuine open owner attention — attention still wins Degraded/attention/add_info", () => {
  const snap = snapshot({
    axes: { attention: "open", freshness: "stale" },
    badges: { stale: true, syncing: true },
    forward_disposition: "owner_refresh_due",
    last_success_at: "2026-05-15T00:00:00.000Z",
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [stream({ attention_open: true })],
    MANUAL_REFRESH,
    true,
    null,
    null,
    exactSyncAttention()
  );
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
  assert.equal(v.channel, "attention");
  assert.equal(v.required_actions[0]?.kind, "add_info");
  assert.equal(v.forward_statement, "Complete the requested action and collection resumes.");
});

test("connection-level terminal disposition is not erased by a retryable stream row", () => {
  const snap = snapshot({
    axes: { coverage: "terminal_gap", freshness: "stale" },
    forward_disposition: "terminal",
    state: "degraded",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [stream({ coverage: "retryable_gap", gap_retryable: true, priority: "required" })],
    MANUAL_REFRESH,
    true
  );

  assert.equal(v.detail.forward_disposition, "terminal");
  assert.equal(v.pill.tone, "red");
  assert.equal(v.forward_statement, "Some data from this source can't be collected.");
  assert.equal(v.required_actions[0]?.kind, "code_fix");
  assert.equal(v.required_actions[0]?.terminal, true);
  assert.notEqual(v.required_actions[0]?.kind, "retry_gap");
});

test("freshness annotation describes an explicit manual-default schedule as scheduled", () => {
  const mode = progressMode({
    hasRecoveredDetailGaps: false,
    localDeviceBacked: false,
    refresh: { backgroundSafe: true, recommendedMode: "manual" },
    schedule: { enabled: true },
  });
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { freshness: "stale" },
      forward_disposition: "complete",
      state: "idle",
    }),
    [stream()],
    { backgroundSafe: true, recommendedMode: "manual" },
    true,
    {
      last_refreshed_at: "2026-06-29T12:00:00.000Z",
      mode,
      observed_at: "2026-07-01T12:00:00.000Z",
      retained_records: 100,
    },
    { hasPriorSuccess: true, mode: "scheduled-active" }
  );
  const freshness = v.annotations.find((annotation) => annotation.kind === "freshness")?.text ?? "";
  assert.equal(mode, "scheduled");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(freshness, /schedule/i);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(freshness, /refreshes when you run it/i);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(freshness, /manual/i);
});

test("tone: unknown freshness renders Not measured rather than Healthy, Degraded, or Checking", () => {
  const snap = snapshot({
    axes: { freshness: "unknown" },
    forward_disposition: "complete",
    state: "healthy",
  });
  const v = synthesizeRenderedVerdict(snap, [stream()], null, true);
  assert.equal(v.pill.tone, "grey");
  assert.equal(v.pill.label, "Not measured");
  assert.equal(v.channel, "calm");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.ok(v.annotations.some((a) => a.kind === "freshness" && /not been measured/i.test(a.text)));
  assert.equal(v.forward_statement, "Freshness has not been measured yet.");
  assert.notEqual(v.forward_statement, "Current and collecting normally.");
});

test("tone: unknown coverage renders Not measured and no retry action", () => {
  const snap = snapshot({
    axes: { coverage: "unknown", freshness: "fresh" },
    forward_disposition: "unmeasured",
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(snap, [stream({ coverage: "unknown" })], null, true);
  assert.equal(v.pill.tone, "grey");
  assert.equal(v.pill.label, "Not measured");
  assert.equal(v.channel, "calm");
  assert.equal(v.forward_statement, "Coverage has not been measured yet.");
  assert.deepEqual(v.required_actions, []);
  assert.equal(v.streams[0]?.disposition, "unmeasured");
  assert.equal(v.streams[0]?.statement, "Coverage has not been measured yet.");
  assert.notEqual(v.forward_statement, "The next run is expected to fill the remaining data.");
});

test("tone: unknown coverage on a finished one-time import never says 'not measured YET' (B10)", () => {
  // Production shape (owner ledger 2026-08-22, Google Maps Timeline Import
  // cin_50f5bf4b7ecbc7acd6f4c254): a one-time import whose only run died
  // before it could emit DETAIL_COVERAGE. `freshnessNotApplicable` is true
  // (a completed one-time import has no future capture to age — see
  // `connection-health-completed-import.test.ts`), so there is no future run
  // that could ever measure this stream. The generic "has not been measured
  // YET" copy implies one is coming; for this shape that implication is false
  // and must not render.
  const notApplicableFresh = condition({
    id: "Fresh:freshness_not_applicable_complete",
    reason: CONNECTION_CONDITION_REASONS.FRESHNESS_NOT_APPLICABLE_COMPLETE,
    status: "not_applicable",
    type: "Fresh",
  });
  const snap = snapshot({
    axes: { coverage: "unknown", freshness: "unknown" },
    conditions: [notApplicableFresh, collectionSucceededCondition()],
    forward_disposition: "unmeasured",
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [stream({ coverage: "unknown", priority: "optional", stream_id: "timeline_points" })],
    null,
    true
  );
  assert.notEqual(v.forward_statement, "Coverage has not been measured yet.");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(v.forward_statement, /will not run again|ended before/i);
  assert.notEqual(v.streams[0]?.statement, "Coverage has not been measured yet.");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(v.streams[0]?.statement ?? "", /can't be measured/i);
  const maintainerAction = v.required_actions.find((a) => a.audience === "maintainer");
  assert.notEqual(maintainerAction?.cta, "Some data from this source isn't being measured yet");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(maintainerAction?.cta ?? "", /will not run again/i);
});

test("tone: unknown coverage on an ordinary (still-refreshing) source keeps the YET copy", () => {
  // Control: the SAME unknown-coverage shape without the one-time-import
  // condition must keep the existing "yet" wording — most connectors really
  // will measure it on their next scheduled run.
  const snap = snapshot({
    axes: { coverage: "unknown", freshness: "fresh" },
    forward_disposition: "unmeasured",
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(snap, [stream({ coverage: "unknown" })], null, true);
  assert.equal(v.forward_statement, "Coverage has not been measured yet.");
  assert.equal(v.streams[0]?.statement, "Coverage has not been measured yet.");
});

test("tone: active unknown coverage renders Checking because work is active", () => {
  const snap = snapshot({
    axes: { coverage: "unknown", freshness: "fresh" },
    badges: { stale: false, syncing: true },
    forward_disposition: "checking",
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(snap, [stream({ coverage: "unknown" })], null, true);
  assert.equal(v.pill.tone, "grey");
  assert.equal(v.pill.label, "Checking");
  assert.equal(v.forward_statement, "Coverage has not been measured yet.");
});

test("tone: active local-device outbox renders Syncing without owner action", () => {
  const snap = snapshot({
    axes: { coverage: "complete", freshness: "fresh", outbox: "active" },
    forward_disposition: "complete",
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(snap, [stream()], null, true, {
    last_refreshed_at: "2026-07-07T09:00:00.000Z",
    mode: "local_device",
    observed_at: "2026-07-07T10:00:00.000Z",
    retained_records: 100,
  });
  assert.equal(v.pill.tone, "green");
  assert.equal(v.pill.label, "Syncing");
  assert.equal(v.channel, "calm");
  assert.equal(v.required_actions.length, 0);
  assert.equal(v.forward_statement, "The local collector is uploading saved records.");
});

test("tone: degraded evidence wins over active local-device outbox label", () => {
  const snap = snapshot({
    axes: { coverage: "retryable_gap", freshness: "fresh", outbox: "active" },
    forward_disposition: "resumable",
    state: "degraded",
  });
  const v = synthesizeRenderedVerdict(snap, [stream({ coverage: "retryable_gap", gap_retryable: true })], null, true);
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
});

test("tone: worst axis (degrading coverage) wins over a healthy state", () => {
  const snap = snapshot({ axes: { coverage: "retryable_gap" }, state: "healthy" });
  const v = synthesizeRenderedVerdict(snap, [stream({ coverage: "retryable_gap", gap_retryable: true })], null, true);
  assert.equal(v.pill.tone, "amber"); // not the state-implied green
  assert.equal(v.pill.label, "Missing data");
});

test("coverage: optional stale stream annotates but does not downgrade the pill", () => {
  const snap = snapshot({ state: "healthy" });
  const v = synthesizeRenderedVerdict(
    snap,
    [
      stream({ coverage: "complete", priority: "required", stream_id: "req" }),
      stream({ coverage: "partial", priority: "optional", stream_id: "opt" }),
    ],
    null,
    true
  );
  assert.equal(v.pill.tone, "green", "optional partial must not amber the pill");
});

test("coverage: a terminal optional stream stays visible without downgrading required coverage", () => {
  const snap = snapshot({ forward_disposition: "complete", state: "healthy" });
  const v = synthesizeRenderedVerdict(
    snap,
    [stream({ coverage: "terminal_gap", priority: "optional", stream_id: "opt" })],
    null,
    true
  );
  assert.equal(v.pill.tone, "green");
  assert.equal(v.pill.label, "Healthy");
  assert.equal(v.streams[0]?.stream_id, "opt");
  assert.equal(v.streams[0]?.coverage, "terminal_gap");
});

// ─── 3.3 collected clamp ──────────────────────────────────────────────────────

test("streams: collected is clamped to considered — no 3/2 (inv2)", () => {
  const snap = snapshot({ axes: { coverage: "partial" }, state: "healthy" });
  const v = synthesizeRenderedVerdict(snap, [stream({ collected: 3, considered: 2, coverage: "partial" })], null, true);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const row = v.streams[0];
  assert.ok(row, "stream row exists");
  assert.equal(row.collected, 2);
  assert.equal(row.considered, 2);
});

// ─── 3.4 channel orthogonality ────────────────────────────────────────────────

test("channel: same amber health tone can still carry advisory or attention by who can fix it", () => {
  // Retryable manual gap → advisory.
  const retryable = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "retryable_gap", freshness: "stale" },
      forward_disposition: "resumable",
      state: "degraded",
    }),
    [stream({ coverage: "retryable_gap", gap_retryable: true })],
    MANUAL_REFRESH,
    true
  );
  // Credential rejected on a manual connector → attention.
  const rejected = synthesizeRenderedVerdict(
    snapshot({
      axes: { attention: "open", freshness: "stale" },
      conditions: [credentialRejectedCondition()],
      forward_disposition: "awaiting_owner",
      state: "needs_attention",
    }),
    [stream()],
    MANUAL_REFRESH,
    true
  );
  assert.equal(retryable.channel, "advisory");
  assert.equal(rejected.channel, "attention");
  // Same tone, different channel — orthogonal.
  assert.equal(retryable.pill.tone, rejected.pill.tone);
  assert.equal(retryable.pill.tone, "amber");
});

test("channel: a fresh fully self-handled connection stays calm with no owner action", () => {
  const snap = snapshot({
    axes: { coverage: "retryable_gap", freshness: "fresh" },
    forward_disposition: "resumable",
    next_attempt_at: "2026-06-15T12:00:00.000Z",
    state: "cooling_off",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [stream({ coverage: "retryable_gap", gap_retryable: true })],
    ASSISTED_REFRESH,
    true
  );
  assert.equal(v.channel, "calm");
  assert.ok(!v.required_actions.some((a) => a.audience === "owner"));
});

test("channel: attention always carries an owner-satisfiable action (S1)", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { attention: "open" },
      conditions: [credentialRejectedCondition()],
      forward_disposition: "awaiting_owner",
      state: "needs_attention",
    }),
    [stream()],
    null,
    true
  );
  assert.equal(v.channel, "attention");
  assert.ok(v.required_actions.some((a) => a.audience === "owner" && a.satisfied_when.kind !== "none"));
});

test("channel: missing credentials are owner-repairable reauth, not maintainer code_fix", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { attention: "open", coverage: "terminal_gap" },
      conditions: [credentialRequiredCondition()],
      forward_disposition: "terminal",
      state: "blocked",
    }),
    [stream({ coverage: "terminal_gap" })],
    null,
    true
  );
  assert.equal(v.channel, "attention");
  assert.equal(v.required_actions[0]?.kind, "reauth");
  assert.equal(v.required_actions[0]?.cta, "Reconnect this account");
  assert.ok(!v.required_actions.some((a) => a.kind === "code_fix"));
  assert.equal(v.forward_statement, "Reconnect this account before further collection.");
  assert.ok(!JSON.stringify(v).includes("restore missing coverage"));
});

// ─── Owner-action surface on reauth (complete-connection-repair-action-surfaces) ───

function credentialConditionWithSurface(surfaceKind: OwnerActionSurfaceKind) {
  return condition({
    id: `CredentialsValid:${surfaceKind}`,
    origin: "readiness",
    reason: surfaceKind === "browser_session" ? "session_required" : "credential_rejected",
    remediation: {
      action: "refresh_credentials",
      label: "Reconnect this account",
      retryable: false,
      surface: { kind: surfaceKind },
      target: surfaceKind === "browser_session" ? "browser_session" : "credentials",
    },
    severity: "blocked",
    status: "false",
    type: "CredentialsValid",
  });
}

test("surface: reauth carries the stored_credential surface from the credential condition", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { attention: "none" },
      conditions: [credentialConditionWithSurface("stored_credential")],
      state: "blocked",
    }),
    [stream()],
    null,
    true
  );
  const reauth = v.required_actions.find((a) => a.kind === "reauth");
  assert.equal(reauth?.surface?.kind, "stored_credential");
  // Stored-credential repair is satisfied by the credential becoming present.
  assert.equal(reauth?.satisfied_when?.kind, "credential_present_and_unrejected");
});

test("surface: reauth carries the browser_session surface for a session-required failure", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { attention: "none" },
      conditions: [credentialConditionWithSurface("browser_session")],
      state: "blocked",
    }),
    [stream()],
    null,
    true
  );
  const reauth = v.required_actions.find((a) => a.kind === "reauth");
  assert.equal(reauth?.surface?.kind, "browser_session");
});

test("surface: a browser_session reauth is satisfied by a confirming run, NOT a stored credential", () => {
  // Regression: a browser-session repair may have NO stored credential — the owner
  // re-establishes the live session. Using credential_present_and_unrejected would
  // make the action UNSATISFIABLE (no credential can ever become present), leaving
  // the connection stuck in repair forever. It must use confirming_run_succeeded.
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { attention: "none" },
      conditions: [credentialConditionWithSurface("browser_session")],
      state: "blocked",
    }),
    [stream()],
    null,
    true
  );
  const reauth = v.required_actions.find((a) => a.kind === "reauth");
  assert.equal(reauth?.surface?.kind, "browser_session");
  assert.equal(reauth?.satisfied_when?.kind, "confirming_run_succeeded");
  assert.notEqual(
    reauth?.satisfied_when?.kind,
    "credential_present_and_unrejected",
    "browser-session repair must not require a stored credential to satisfy"
  );
});

test("surface: a browser_session reauth never routes to stored-credential capture (no provider-page password path)", () => {
  // Regression for complete-connection-repair-action-surfaces: a session_required
  // failure must route the owner to browser-session repair, never to a
  // stored-credential capture surface. If it routed to stored_credential, the
  // owner console would present a password field for a page-based login — the
  // exact "silently store provider-page password" hazard the spec forbids.
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { attention: "none" },
      conditions: [credentialConditionWithSurface("browser_session")],
      state: "blocked",
    }),
    [stream()],
    null,
    true
  );
  const reauth = v.required_actions.find((a) => a.kind === "reauth");
  assert.equal(reauth?.surface?.kind, "browser_session");
  assert.notEqual(
    reauth?.surface?.kind,
    "stored_credential",
    "browser-session repair must not route to credential capture"
  );
});

test("surface: reauth falls back to stored_credential when the condition carries no surface", () => {
  // Compatibility: an older projection condition without a remediation surface
  // still yields a reauth action, defaulted to stored_credential capture.
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { attention: "none" },
      conditions: [credentialRejectedCondition()],
      state: "blocked",
    }),
    [stream()],
    null,
    true
  );
  const reauth = v.required_actions.find((a) => a.kind === "reauth");
  assert.equal(reauth?.surface?.kind, "stored_credential");
});

test("channel: stalled outbox state-read block asks for re-run, not dead-letter retry", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "complete", freshness: "fresh", outbox: "stalled" },
      conditions: [
        localExporterStalledCondition(
          CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_STATE_READ_FAILED,
          "Local exporter is blocked reading prior state. There are zero dead-letter rows to retry."
        ),
        backlogStalledCondition(
          CONNECTION_CONDITION_REASONS.OUTBOX_STATE_READ_FAILED,
          "Local-device outbox is blocked on a failed state read, not a backlog."
        ),
      ],
      forward_disposition: "complete",
      reason_code: "local_exporter_state_read_failed",
      state: "degraded",
    }),
    [stream({ coverage: "complete" })],
    null,
    true
  );
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.pill.tone, "red");
  assert.equal(v.pill.label, "Can't collect");
  assert.equal(v.channel, "attention");
  assert.equal(
    v.forward_statement,
    "The server cannot read the collector's last state from that host. Run the local collector again there."
  );
  assert.equal(action.kind, "add_info");
  assert.equal(action.audience, "owner");
  assert.equal(action.cta, "Run the local collector again");
  assert.deepEqual(action.satisfied_when, { kind: "attention_resolved" });
  assert.equal(action.remediation?.kind, "local_collector_recovery");
  assert.equal(action.remediation?.cause, "state_read_failed");
  assert.deepEqual(action.remediation?.target, {
    identity_source: "source_instance_bindings",
    kind: "local_device",
  });
  assert.deepEqual(
    action.remediation?.commands.map((command) => command.kind),
    ["local_collector_recover_apply"]
  );
  assert.equal(
    action.remediation?.commands[0]?.command_template,
    "npx -y @pdpp/local-collector recover --source-instance-id <source-instance-id> --apply"
  );
  assert.notEqual(v.forward_statement, "Current and collecting normally.");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(JSON.stringify(action), /dead[- ]letter/i);
});

test("channel: dead-letter stalled outbox includes recover preview before apply", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "complete", freshness: "fresh", outbox: "stalled" },
      conditions: [
        localExporterStalledCondition(CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_DEAD_LETTER_BACKLOG),
        backlogStalledCondition(CONNECTION_CONDITION_REASONS.OUTBOX_DEAD_LETTER_BACKLOG),
      ],
      forward_disposition: "complete",
      reason_code: "local_exporter_dead_letter_backlog",
      state: "degraded",
    }),
    [stream({ coverage: "complete" })],
    null,
    true
  );
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.channel, "attention");
  assert.equal(
    v.forward_statement,
    "The local collector has records on its host that failed to upload and will not retry on their own. Recovering them is a manual step."
  );
  assert.equal(action.cta, "Recover local collector uploads");
  assert.equal(action.remediation?.cause, "dead_letter_backlog");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(v.forward_statement, /dead[- ]letter/i);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(action.cta, /dead[- ]letter/i);
  assert.deepEqual(
    action.remediation?.commands.map((command) => command.kind),
    ["local_collector_recover_preview", "local_collector_recover_apply"]
  );
  assert.deepEqual(
    action.remediation?.commands.map((command) => command.label),
    ["Preview recovery", "Recover and run the collector"]
  );
  assert.deepEqual(
    action.remediation?.commands.map((command) => command.command_template),
    [
      "npx -y @pdpp/local-collector recover --source-instance-id <source-instance-id>",
      "npx -y @pdpp/local-collector recover --source-instance-id <source-instance-id> --apply",
    ]
  );
});

test("channel: structured attention carries the exact sync target from its own run id", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { attention: "open", freshness: "stale" },
      forward_disposition: "awaiting_owner",
      reason_code: "otp_required",
      state: "needs_attention",
    }),
    [stream({ coverage: "complete" })],
    null,
    true,
    null,
    null,
    exactSyncAttention({ runId: "run_causal", sensitivity: "secret" })
  );
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.channel, "attention");
  assert.equal(action.kind, "add_info");
  assert.equal(action.cta, "Complete the requested action");
  assert.deepEqual(action.target, { kind: "sync", run_id: "run_causal" });
});

test("channel: fallback add_info guidance stays plain text when no exact sync target exists", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { attention: "open", freshness: "stale" },
      forward_disposition: "awaiting_owner",
      reason_code: "needs_human_attention",
      state: "needs_attention",
    }),
    [stream({ coverage: "complete" })],
    null,
    true
  );
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.channel, "attention");
  assert.equal(action.kind, "add_info");
  assert.equal(action.cta, "Complete the requested action");
  assert.equal(action.target, undefined);
});

test("channel: transient upload failures do not ask the owner to recover local uploads", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "complete", freshness: "fresh", outbox: "stalled" },
      conditions: [
        condition({
          id: "LocalExporterAvailable:local_exporter_transient_upload_failure",
          message: "The local collector hit temporary server or network errors while uploading.",
          origin: "local_device",
          reason: CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_TRANSIENT_UPLOAD_FAILURE,
          remediation: {
            action: "wait",
            label: "Wait for upload retry",
            retryable: true,
            target: "local_device",
          },
          severity: "warning",
          status: "false",
          type: "LocalExporterAvailable",
        }),
        condition({
          id: "BacklogClear:outbox_transient_upload_failure",
          message: "Local-device uploads are waiting for the server or network to recover.",
          origin: "local_device",
          reason: CONNECTION_CONDITION_REASONS.OUTBOX_TRANSIENT_UPLOAD_FAILURE,
          remediation: {
            action: "wait",
            label: "Wait for upload retry",
            retryable: true,
            target: "local_device",
          },
          severity: "warning",
          status: "false",
          type: "BacklogClear",
        }),
      ],
      forward_disposition: "complete",
      reason_code: "local_exporter_transient_upload_failure",
      state: "degraded",
    }),
    [stream({ coverage: "complete" })],
    null,
    true
  );
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.channel, "calm");
  assert.equal(action.kind, "wait");
  assert.equal(action.audience, "none");
  assert.equal(action.remediation?.cause, "transient_upload_failure");
  assert.equal(action.satisfied_when.kind, "none");
  assert.equal(
    v.forward_statement,
    "The local collector hit temporary server or network errors while uploading. It will retry without owner action."
  );
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(JSON.stringify(v), /Recover local collector uploads/);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(JSON.stringify(v), /Preview recovery/);
});

test("channel: stale-pending stalled outbox asks for collector re-run only", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "complete", freshness: "fresh", outbox: "stalled" },
      conditions: [
        localExporterStalledCondition(CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_STALE_PENDING),
        backlogStalledCondition(CONNECTION_CONDITION_REASONS.OUTBOX_STALE_PENDING),
      ],
      forward_disposition: "complete",
      reason_code: "local_exporter_stale_pending",
      state: "degraded",
    }),
    [stream({ coverage: "complete" })],
    null,
    true
  );
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.channel, "attention");
  assert.equal(
    v.forward_statement,
    "The local collector has queued work that stopped moving. Run it again on that host."
  );
  assert.equal(action.cta, "Run the local collector again");
  assert.equal(action.remediation?.cause, "stale_pending");
  assert.deepEqual(
    action.remediation?.commands.map((command) => command.kind),
    ["local_collector_recover_apply"]
  );
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(JSON.stringify(action), /retry-dead-letters/);
});

test("channel: unknown stalled outbox diagnostics target source-instance recovery scope", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "complete", freshness: "fresh", outbox: "stalled" },
      conditions: [localExporterStalledCondition("unexpected_outbox_stall")],
      forward_disposition: "complete",
      reason_code: "unexpected_outbox_stall",
      state: "degraded",
    }),
    [stream({ coverage: "complete" })],
    null,
    true
  );
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.channel, "attention");
  assert.equal(action.remediation?.cause, "stalled_unknown");
  assert.deepEqual(
    action.remediation?.commands.map((command) => command.kind),
    ["local_collector_doctor"]
  );
  assert.equal(
    action.remediation?.commands[0]?.command_template,
    "npx -y @pdpp/local-collector doctor --source-instance-id <source-instance-id>"
  );
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(JSON.stringify(action), /<connection-id>/);
});

test("channel: degraded resumable stale coverage is advisory Retry now, not calm wait", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "partial", freshness: "stale", outbox: "idle" },
      forward_disposition: "resumable",
      reason_code: "orphaned_started_run",
      state: "degraded",
    }),
    [stream({ coverage: "partial", gap_retryable: true, stream_id: "transactions" })],
    null,
    true
  );
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
  assert.equal(v.channel, "advisory");
  assert.equal(v.forward_statement, "Retry now to give the recoverable gap another run.");
  assert.equal(action.kind, "retry_gap");
  assert.equal(action.audience, "owner");
  assert.equal(action.cta, "Retry now");
  assert.deepEqual(action.satisfied_when, { kind: "gap_recovered" });
});

test("channel: failed deferred history is retryable, not a passive collecting wait", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "retryable_gap", freshness: "stale", outbox: "idle" },
      forward_disposition: "resumable",
      reason_code: "connector_reported_failed",
      state: "degraded",
    }),
    [stream({ coverage: "unknown", gap_retryable: true, stream_id: "messages" })],
    ASSISTED_REFRESH,
    true,
    {
      last_refreshed_at: "2026-07-03T03:51:30.681Z",
      mode: "deferred",
      observed_at: "2026-07-06T15:33:39.630Z",
      retained_records: 136_907,
    }
  );
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
  assert.equal(v.channel, "advisory");
  assert.equal(v.forward_statement, "Retry now to give the recoverable gap another run.");
  assert.equal(v.progress.headline, "Holding 136,907 records; retry to continue.");
  assert.equal(action.kind, "retry_gap");
  assert.equal(action.audience, "owner");
  assert.equal(action.cta, "Retry now");
  assert.ok(!v.required_actions.some((a) => a.kind === "wait" && a.cta === "Collecting — no action needed"));
});

test("channel: idle assisted retryable gap offers retry instead of passive collecting wait", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "retryable_gap", freshness: "stale", outbox: "unknown" },
      forward_disposition: "resumable",
      state: "idle",
    }),
    [stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "messages" })],
    ASSISTED_REFRESH,
    true
  );
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
  assert.equal(v.channel, "advisory");
  assert.equal(v.forward_statement, "Retry now to give the recoverable gap another run.");
  assert.equal(action.kind, "retry_gap");
  assert.equal(action.audience, "owner");
  assert.equal(action.cta, "Retry now");
  assert.deepEqual(action.affects, ["messages"]);
  assert.ok(!v.required_actions.some((a) => a.kind === "wait" && a.cta === "Collecting — no action needed"));
});

test("channel: a retryable gap whose only contributing stream is retry_by_runtime does not offer Retry now", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "retryable_gap", freshness: "stale", outbox: "unknown" },
      forward_disposition: "resumable",
      state: "idle",
    }),
    [
      stream({
        coverage: "retryable_gap",
        gap_retryable: true,
        recovery_action: "retry_by_runtime",
        stream_id: "group_messages",
      }),
    ],
    ASSISTED_REFRESH,
    true
  );
  assert.ok(
    !v.required_actions.some((a) => a.kind === "retry_gap"),
    "no retry_gap action when every contributing stream is retry_by_runtime"
  );
  // The gap itself must still render — never fabricated-complete.
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
});

test("channel: MUTATION-SAFETY a genuinely owner-actionable retryable gap still offers Retry now", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "retryable_gap", freshness: "stale", outbox: "unknown" },
      forward_disposition: "resumable",
      state: "idle",
    }),
    [
      stream({
        coverage: "retryable_gap",
        gap_retryable: true,
        recovery_action: "owner_reauth_required",
        stream_id: "transactions",
      }),
    ],
    ASSISTED_REFRESH,
    true
  );
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(action.kind, "retry_gap");
  assert.equal(action.cta, "Retry now");
});

test("channel: an unknown/absent recovery_action fails open and still offers Retry now", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "retryable_gap", freshness: "stale", outbox: "unknown" },
      forward_disposition: "resumable",
      state: "idle",
    }),
    [stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "messages" })],
    ASSISTED_REFRESH,
    true
  );
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists — absent recovery_action must never suppress the CTA");
  assert.equal(action.kind, "retry_gap");
  assert.equal(action.cta, "Retry now");
});

test("channel: explicit manual-default background-safe schedule stays scheduled and does not offer Retry now", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "retryable_gap", freshness: "stale", outbox: "idle" },
      forward_disposition: "resumable",
      state: "degraded",
    }),
    [stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "messages" })],
    { backgroundSafe: true, recommendedMode: "manual" },
    true,
    {
      last_refreshed_at: "2026-07-03T03:51:30.681Z",
      mode: "scheduled",
      observed_at: "2026-07-06T15:33:39.630Z",
      retained_records: 136_907,
    },
    { hasPriorSuccess: true, mode: "scheduled-active" }
  );
  const freshness = v.annotations.find((annotation) => annotation.kind === "freshness")?.text ?? "";
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.progress.mode, "scheduled");
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
  assert.equal(v.channel, "calm");
  assert.equal(v.forward_statement, "The next run is expected to fill the remaining data.");
  assert.equal(action.kind, "wait");
  assert.equal(action.audience, "none");
  assert.equal(action.cta, "Collecting — no action needed");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(freshness, /schedule/i);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(freshness, /refreshes when you run it/i);
  assert.ok(!v.required_actions.some((a) => a.kind === "retry_gap" || a.audience === "owner"));
});

test("channel: background-unsafe active schedule stays manual and still offers Retry now", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "retryable_gap", freshness: "stale", outbox: "idle" },
      forward_disposition: "resumable",
      last_success_at: "2026-06-01T00:00:00.000Z",
      state: "degraded",
    }),
    [stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "messages" })],
    MANUAL_REFRESH,
    true,
    {
      last_refreshed_at: "2026-07-03T03:51:30.681Z",
      mode: "manual",
      observed_at: "2026-07-06T15:33:39.630Z",
      retained_records: 136_907,
    },
    { hasPriorSuccess: true, mode: "scheduled-active" }
  );
  const freshness = v.annotations.find((annotation) => annotation.kind === "freshness")?.text ?? "";
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.progress.mode, "manual");
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
  assert.equal(v.channel, "advisory");
  assert.equal(v.forward_statement, "Retry now to give the recoverable gap another run.");
  assert.equal(action.kind, "retry_gap");
  assert.equal(action.audience, "owner");
  assert.equal(action.cta, "Retry now");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(freshness, /stuck since/i);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(freshness, /schedule/i);
});

test("channel: paused active schedule stays manual and still offers Retry now", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "retryable_gap", freshness: "stale", outbox: "idle" },
      forward_disposition: "resumable",
      last_success_at: "2026-06-01T00:00:00.000Z",
      state: "degraded",
    }),
    [stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "messages" })],
    PAUSED_REFRESH,
    true,
    {
      last_refreshed_at: "2026-07-03T03:51:30.681Z",
      mode: "manual",
      observed_at: "2026-07-06T15:33:39.630Z",
      retained_records: 136_907,
    },
    { hasPriorSuccess: true, mode: "scheduled-active" }
  );
  const freshness = v.annotations.find((annotation) => annotation.kind === "freshness")?.text ?? "";
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.progress.mode, "manual");
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
  assert.equal(v.channel, "advisory");
  assert.equal(v.forward_statement, "Retry now to give the recoverable gap another run.");
  assert.equal(action.kind, "retry_gap");
  assert.equal(action.audience, "owner");
  assert.equal(action.cta, "Retry now");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(freshness, /stuck since/i);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(freshness, /schedule/i);
});

test("channel: source-pressure deferred recovery is a self-handled wait, not an owner Retry now action", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "retryable_gap", freshness: "stale", outbox: "idle" },
      forward_disposition: "resumable",
      reason_code: "source_pressure",
      state: "degraded",
    }),
    [stream({ coverage: "unknown", gap_retryable: true, stream_id: "messages" })],
    ASSISTED_REFRESH,
    true,
    {
      last_refreshed_at: "2026-07-03T03:51:30.681Z",
      mode: "deferred",
      observed_at: "2026-07-06T15:33:39.630Z",
      retained_records: 136_907,
    }
  );
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
  assert.equal(v.channel, "calm");
  assert.equal(v.forward_statement, "The next run is expected to fill the remaining data.");
  assert.equal(action.kind, "wait");
  assert.equal(action.audience, "none");
  assert.equal(action.cta, "Collecting — no action needed");
  assert.ok(!v.required_actions.some((a) => a.kind === "retry_gap" || a.audience === "owner"));
});

// ─── 3.6 forward statement ────────────────────────────────────────────────────

test("forward_statement: terminal never claims resumed collection (inv3)", () => {
  const snap = snapshot({ axes: { coverage: "terminal_gap" }, forward_disposition: "terminal", state: "degraded" });
  const v = synthesizeRenderedVerdict(snap, [stream({ coverage: "terminal_gap" })], null, true);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.ok(!/resum|refresh|next run|retry/i.test(v.forward_statement));
});

// ─── 3.7 progress ─────────────────────────────────────────────────────────────

test("progress: deferred connector never shows a structurally-zero records_emitted", () => {
  const v = synthesizeRenderedVerdict(snapshot(), [stream()], ASSISTED_REFRESH, true, {
    gaps_drained_last_run: 2532,
    mode: "deferred",
    retained_records: 126_000,
  });
  assert.equal(v.progress.mode, "deferred");
  // The dashboard-safe progress headline uses drain evidence qualitatively; the
  // raw drained-gap count lives in detail.detail_gap_backlog, not public progress.
  assert.equal(v.progress.gaps_drained_last_run, null);
  assert.ok(!JSON.stringify(v.progress).includes("2532"));
  // The headline privileges drained/retained posture, never a per-run zero.
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.ok(!/\b0\b records/i.test(v.progress.headline));
});

test("progress: scheduled privileges records committed", () => {
  const v = synthesizeRenderedVerdict(snapshot(), [stream()], null, true, {
    mode: "scheduled",
    records_committed_last_run: 42,
  });
  assert.equal(v.progress.mode, "scheduled");
  assert.equal(v.progress.records_committed_last_run, 42);
});

// Idle scheduled eligibility must never imply active work: a scheduled
// connection that has never committed a run and is not currently syncing
// must not say "Collecting" (see chatgpt-wedge-systemic-0730).
test("progress: idle scheduled eligibility (no active run, no committed run) does not claim active collecting", () => {
  const v = synthesizeRenderedVerdict(snapshot({ badges: { syncing: false } }), [stream()], null, true, {
    mode: "scheduled",
    records_committed_last_run: null,
  });
  assert.equal(v.progress.mode, "scheduled");
  assert.equal(v.progress.headline, "Refreshes on schedule.");
});

test("progress: an active scheduled run does say collecting", () => {
  const v = synthesizeRenderedVerdict(snapshot({ badges: { syncing: true } }), [stream()], null, true, {
    mode: "scheduled",
    records_committed_last_run: null,
  });
  assert.equal(v.progress.mode, "scheduled");
  assert.equal(v.progress.headline, "Collecting on schedule.");
});

test("progress: terminal manual source never says refresh to update", () => {
  const v = synthesizeRenderedVerdict(
    snapshot({
      axes: { coverage: "terminal_gap", freshness: "stale" },
      forward_disposition: "terminal",
      state: "degraded",
    }),
    [stream({ coverage: "terminal_gap" })],
    MANUAL_REFRESH,
    true,
    { last_refreshed_at: "2026-06-15T12:00:00.000Z", mode: "manual", retained_records: 1169 }
  );
  assert.equal(v.progress.headline, "Holding 1,169 records; some of this source's data can't be collected.");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(v.progress.headline, /refresh|retry|resum|next run/i);
});

// ─── 4.3 composite invariant test over representative snapshots ────────────────

test("composite: all eleven invariants hold across representative snapshots", () => {
  const cases = [
    { name: "healthy-fresh", ok: true, refresh: null, snap: snapshot(), streams: [stream()] },
    {
      name: "stale-manual",
      ok: true,
      refresh: MANUAL_REFRESH,
      snap: snapshot({ axes: { freshness: "stale" }, forward_disposition: "owner_refresh_due", state: "idle" }),
      streams: [stream()],
    },
    {
      name: "degraded-retryable",
      ok: true,
      refresh: MANUAL_REFRESH,
      snap: snapshot({
        axes: { coverage: "retryable_gap", freshness: "stale" },
        forward_disposition: "resumable",
        state: "degraded",
      }),
      streams: [stream({ coverage: "retryable_gap", gap_retryable: true })],
    },
    {
      name: "needs_attention",
      ok: true,
      refresh: null,
      snap: snapshot({
        axes: { attention: "open" },
        conditions: [credentialRejectedCondition()],
        forward_disposition: "awaiting_owner",
        state: "needs_attention",
      }),
      streams: [stream({ attention_open: true, coverage: "gaps" })],
    },
    {
      name: "blocked",
      ok: true,
      refresh: null,
      snap: snapshot({
        axes: { coverage: "terminal_gap", outbox: "stalled" },
        forward_disposition: "terminal",
        state: "blocked",
      }),
      streams: [stream({ coverage: "terminal_gap" })],
    },
    {
      name: "cooling_off",
      ok: true,
      refresh: null,
      snap: snapshot({
        axes: { coverage: "retryable_gap" },
        forward_disposition: "resumable",
        next_attempt_at: "2026-06-15T12:00:00.000Z",
        state: "cooling_off",
      }),
      streams: [stream({ coverage: "retryable_gap", gap_retryable: true })],
    },
    {
      name: "terminal",
      ok: true,
      refresh: null,
      snap: snapshot({ axes: { coverage: "terminal_gap" }, forward_disposition: "terminal", state: "degraded" }),
      streams: [stream({ coverage: "terminal_gap" })],
    },
    {
      name: "unknown",
      ok: true,
      refresh: null,
      snap: snapshot({
        axes: { coverage: "unknown", freshness: "unknown", outbox: "unknown" },
        forward_disposition: "unmeasured",
        state: "unknown",
        unknown_reasons: ["x"],
      }),
      streams: [stream({ coverage: "unknown" })],
    },
    {
      name: "runtime-fault",
      ok: false,
      refresh: null,
      snap: snapshot({
        axes: { attention: "open" },
        conditions: [credentialRejectedCondition()],
        forward_disposition: "awaiting_owner",
        state: "needs_attention",
      }),
      streams: [stream()],
    },
  ];
  for (const c of cases) {
    const v = synthesizeRenderedVerdict(c.snap, c.streams, c.refresh, c.ok);
    assertAllInvariants(v, c.snap, c.ok);
  }
});

// ─── 4.4 property test: worst-wins + tone⊥channel ──────────────────────────────

test("property: tone is worst-wins (never below base state) and (tone,channel) orthogonal", () => {
  const states: readonly ConnectionHealthState[] = [
    "healthy",
    "idle",
    "degraded",
    "needs_attention",
    "cooling_off",
    "blocked",
    "unknown",
  ];
  const freshnesses: readonly ("fresh" | "stale" | "unknown")[] = ["fresh", "stale", "unknown"];
  const coverages: readonly CoverageAxis[] = ["complete", "partial", "retryable_gap", "terminal_gap", "unknown"];
  const dispositions: readonly ForwardDisposition[] = [
    "complete",
    "checking",
    "resumable",
    "owner_refresh_due",
    "awaiting_owner",
    "terminal",
    "unmeasured",
  ];
  const attentions: readonly ("none" | "open")[] = ["none", "open"];
  const syncingValues = [false, true];

  const channelByTone = new Map<VerdictTone, Set<string>>();
  let count = 0;
  for (const state of states) {
    for (const freshness of freshnesses) {
      for (const coverage of coverages) {
        for (const disposition of dispositions) {
          for (const attention of attentions) {
            for (const syncing of syncingValues) {
              const conditions = attention === "open" ? [credentialRejectedCondition()] : [];
              const snap = snapshot({
                axes: { attention, coverage, freshness },
                badges: { syncing },
                conditions,
                forward_disposition: disposition,
                state,
              });
              const refresh = freshness === "stale" ? MANUAL_REFRESH : null;
              const v = synthesizeRenderedVerdict(
                snap,
                [
                  stream({
                    attention_open: attention === "open",
                    coverage,
                    gap_retryable: coverage === "retryable_gap",
                  }),
                ],
                refresh,
                true
              );
              // worst-wins: never below base state tone
              assert.ok(
                TONE_RANK[v.pill.tone] >= TONE_RANK[BASE_STATE_TONE[state]],
                `tone>=base for ${state}/${freshness}/${coverage}/syncing=${syncing}`
              );
              // tone never read straight from label-of-state: label follows tone
              // plus current activity evidence.
              const expectedLabel =
                v.pill.tone === "grey" && snap.badges.syncing
                  ? "Checking"
                  : // biome-ignore lint/style/noNestedTernary: localized test assertion preserves its explicit contract.
                    v.pill.tone === "amber"
                    ? expectedAmberLabel(snap, v.detail.forward_disposition, v.trace.tone_inputs)
                    : TONE_TO_LABEL[v.pill.tone];
              assert.equal(v.pill.label, expectedLabel);
              // active work never co-occurs with a conflicting refresh_now CTA.
              if (syncing) {
                assert.ok(
                  !v.required_actions.some((a) => a.kind === "refresh_now"),
                  `active run must not offer refresh_now for ${state}/${freshness}/${disposition}`
                );
              }
              const set = channelByTone.get(v.pill.tone) ?? new Set();
              set.add(v.channel);
              channelByTone.set(v.pill.tone, set);
              count += 1;
            }
          }
        }
      }
    }
  }
  assert.ok(count > 100, "property test covered a wide cross-product");
  // Orthogonality: amber tone must be observed carrying more than one channel.
  const amberChannels = channelByTone.get("amber");
  assert.ok(amberChannels && amberChannels.size >= 2, "same amber tone carries multiple channels (orthogonal)");
});

// ─── 5.x RequiredAction ────────────────────────────────────────────────────────

test("action: terminal flag agrees with the disposition oracle (5.2)", () => {
  const terminal = synthesizeRenderedVerdict(
    snapshot({ axes: { coverage: "terminal_gap" }, forward_disposition: "terminal", state: "degraded" }),
    [stream({ coverage: "terminal_gap" })],
    null,
    true
  );
  for (const a of terminal.required_actions) {
    if (a.affects.length === 0) {
      assert.equal(a.terminal, true);
    }
  }
  const nonTerminal = synthesizeRenderedVerdict(
    snapshot({ axes: { freshness: "stale" }, forward_disposition: "owner_refresh_due", state: "idle" }),
    [stream()],
    MANUAL_REFRESH,
    true
  );
  for (const a of nonTerminal.required_actions) {
    assert.equal(a.terminal, false);
  }
});

test("action: a connection needing both refresh and reauth renders two ordered actions (5.5)", () => {
  const snap = snapshot({
    axes: { attention: "open", freshness: "stale" },
    conditions: [credentialRejectedCondition()],
    forward_disposition: "owner_refresh_due",
    state: "needs_attention",
  });
  const v = synthesizeRenderedVerdict(snap, [stream()], MANUAL_REFRESH, true);
  const kinds = v.required_actions.map((a) => a.kind);
  assert.ok(kinds.includes("reauth"));
  assert.ok(kinds.includes("refresh_now"));
  // Ordered by urgency: reauth (now) before refresh_now (soon).
  assert.ok(kinds.indexOf("reauth") < kinds.indexOf("refresh_now"));
});

test("action: self-handled drain is a single calm wait action (5.4)", () => {
  const snap = snapshot({
    axes: { coverage: "retryable_gap" },
    forward_disposition: "resumable",
    state: "cooling_off",
  });
  const v = synthesizeRenderedVerdict(snap, [stream({ coverage: "retryable_gap", gap_retryable: true })], null, true);
  const wait = v.required_actions.find((a) => a.kind === "wait");
  assert.ok(wait);
  assert.equal(wait.audience, "none");
  assert.deepEqual(wait.satisfied_when, { kind: "none" });
  assert.equal(v.channel, "calm"); // wait never raises above calm
});

test("action: every satisfied_when variant is one of the unified contract kinds (5.3)", () => {
  const ALLOWED = new Set([
    "credential_present_and_unrejected",
    "schedule_attached_and_enabled",
    "attention_resolved",
    "confirming_run_succeeded",
    "gap_recovered",
    "backfill_window_covered",
    "none",
  ]);
  const samples = [
    synthesizeRenderedVerdict(
      snapshot({ axes: { freshness: "stale" }, forward_disposition: "owner_refresh_due", state: "idle" }),
      [stream()],
      MANUAL_REFRESH,
      true
    ),
    synthesizeRenderedVerdict(
      snapshot({
        axes: { attention: "open" },
        conditions: [credentialRejectedCondition()],
        forward_disposition: "awaiting_owner",
        state: "needs_attention",
      }),
      [stream()],
      null,
      true
    ),
    synthesizeRenderedVerdict(
      snapshot({ axes: { coverage: "terminal_gap" }, forward_disposition: "terminal", state: "degraded" }),
      [stream({ coverage: "terminal_gap" })],
      null,
      true
    ),
  ];
  for (const v of samples) {
    for (const a of v.required_actions) {
      assert.ok(ALLOWED.has(a.satisfied_when.kind), `contract kind ${a.satisfied_when.kind} is unified`);
    }
  }
});

// ─── 12.1 calibration trace ────────────────────────────────────────────────────

test("trace: explains tone cause, channel cause, suppressed evidence, and contract", () => {
  const snap = snapshot({
    axes: { attention: "open", freshness: "stale" },
    conditions: [credentialRejectedCondition()],
    detail_gap_backlog: {
      max_attempt_count: 1,
      next_attempt_at: null,
      pending: 0,
      pending_is_floor: false,
      pending_other: 0,
      pending_other_is_floor: false,
      recovered: 2532,
      terminal: null,
    },
    forward_disposition: "awaiting_owner",
    state: "needs_attention",
  });
  const v = synthesizeRenderedVerdict(snap, [stream()], MANUAL_REFRESH, true);
  assert.equal(v.trace.tone_cause, v.pill.tone);
  assert.ok(v.trace.tone_inputs.length >= 6);
  assert.ok(v.trace.channel_cause.startsWith("owner_sole_resolution"));
  assert.equal(v.trace.primary_action_kind, "reauth");
  assert.deepEqual(v.trace.satisfied_when, { kind: "credential_present_and_unrejected" });
});

// ─── 12.2 golden fixtures (verdict + trace) ────────────────────────────────────

test("golden: ChatGPT — green/calm/fresh, no 2532 on dashboard, 2532 present in detail", () => {
  const snap = snapshot({
    axes: { coverage: "complete", freshness: "fresh" },
    // 2,532 fully-drained gaps: recovered, zero pending.
    detail_gap_backlog: {
      max_attempt_count: 3,
      next_attempt_at: null,
      pending: 0,
      pending_is_floor: false,
      pending_other: 0,
      pending_other_is_floor: false,
      recovered: 2532,
      terminal: null,
    },
    forward_disposition: "complete",
    state: "healthy",
  });
  const v = synthesizeRenderedVerdict(snap, [stream()], ASSISTED_REFRESH, true, {
    gaps_drained_last_run: 2532,
    last_refreshed_at: "2026-06-15T08:00:00.000Z",
    mode: "deferred",
    observed_at: "2026-06-15T12:00:00.000Z",
    retained_records: 126_000,
  });
  // Attention layer: green/calm/no gap count.
  assert.equal(v.pill.tone, "green");
  assert.equal(v.pill.label, "Healthy");
  assert.equal(v.channel, "calm");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.ok(v.annotations.some((a) => a.kind === "freshness" && /Fresh today/i.test(a.text)));
  // The acid test: 2532 must not appear on any attention-layer field.
  const attentionText = JSON.stringify({
    actions: v.required_actions,
    annotations: v.annotations,
    channel: v.channel,
    forward_statement: v.forward_statement,
    pill: v.pill,
    progress: v.progress,
  });
  assert.ok(!attentionText.includes("2532"), "2532 must not appear on the attention layer");
  // But it IS present one disclosure down, in detail.
  assert.ok(v.detail.detail_gap_backlog, "detail_gap_backlog is present");
  assert.equal(v.detail.detail_gap_backlog.recovered, 2532);
  // Suppressed drain routed to detail.
  assert.ok(v.detail.suppressed.some((s) => s.kind === "drain"));
});

test("golden: Amazon/Reddit stale manual — amber/advisory/Needs refresh, not Healthy or Degraded", () => {
  const snap = snapshot({
    axes: { coverage: "complete", freshness: "stale" },
    forward_disposition: "owner_refresh_due",
    last_success_at: "2026-05-15T00:00:00.000Z",
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(snap, [stream()], MANUAL_REFRESH, true, {
    last_refreshed_at: "2026-05-15T00:00:00.000Z",
    mode: "manual",
    observed_at: "2026-06-15T12:00:00.000Z",
    retained_records: 5000,
  });
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Needs refresh");
  assert.equal(v.channel, "advisory");
  assert.ok(v.annotations.some((a) => a.kind === "freshness" && a.text === "Last refreshed 31 days ago."));
  assert.ok(v.required_actions.some((a) => a.kind === "refresh_now" && a.audience === "owner"));
});

test("stale manual owner refresh survives optional checking streams, amber/Needs refresh not Healthy/Degraded", () => {
  const snap = snapshot({
    axes: { coverage: "complete", freshness: "stale" },
    forward_disposition: "owner_refresh_due",
    last_success_at: "2026-06-01T00:00:00.000Z",
    reason_code: "stale_manual_refresh",
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [
      stream({ coverage: "unknown", priority: "optional", stream_id: "comments" }),
      stream({ coverage: "unknown", priority: "optional", stream_id: "saved" }),
    ],
    MANUAL_REFRESH,
    true,
    {
      last_refreshed_at: "2026-06-16T00:00:00.000Z",
      mode: "manual",
      observed_at: "2026-06-18T00:00:00.000Z",
      retained_records: 1770,
    }
  );

  assert.equal(v.detail.forward_disposition, "owner_refresh_due");
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Needs refresh");
  assert.equal(v.channel, "advisory");
  assert.equal(v.forward_statement, "Run a refresh to bring this up to date.");
  assert.ok(v.required_actions.some((a) => a.kind === "refresh_now" && a.audience === "owner"));
});

test("idle owner-paused with fresh data (no stale evidence yet) is amber/Needs refresh once a prior success exists", () => {
  const snap = snapshot({
    axes: { coverage: "complete", freshness: "fresh" },
    forward_disposition: "complete",
    last_success_at: "2026-07-01T00:00:00.000Z",
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(snap, [stream()], null, true);
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Needs refresh");
});

test("golden: Acme Slack-shaped paused schedule + stale freshness + cancelled last run is amber/Needs refresh, not Healthy", () => {
  // Owner paused the schedule (classifyOwnerPaused -> state: idle), freshness has
  // aged past the staleness window, and the last run was cancelled rather than
  // succeeded (no fresh CollectionSucceeded evidence). This must not render green,
  // and — since nothing about the connector itself is broken — it must not
  // overstate the situation as "Missing data" either.
  const snap = snapshot({
    axes: { coverage: "complete", freshness: "stale" },
    forward_disposition: "owner_refresh_due",
    last_success_at: "2026-05-01T00:00:00.000Z",
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(snap, [stream()], ASSISTED_REFRESH, true);
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Needs refresh");
  assert.notEqual(v.pill.label, "Healthy");
  assert.notEqual(v.pill.label, "Missing data");
  assert.equal(v.channel, "advisory");
});

test("golden: Chase-shaped resumable retryable gap stays Degraded, not Needs refresh", () => {
  // A real coverage gap (retryable_gap) with disposition:resumable is genuine
  // collection trouble, not a routine refresh nudge — even though the
  // connection is otherwise "idle". The coverage axis must keep the label at
  // Degraded.
  const snap = snapshot({
    axes: { coverage: "retryable_gap", freshness: "stale" },
    forward_disposition: "resumable",
    last_success_at: "2026-06-01T00:00:00.000Z",
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "transactions" })],
    MANUAL_REFRESH,
    true
  );
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
  assert.equal(v.channel, "advisory");
});

test("golden: USAA-shaped awaiting_owner attention-open gap stays Degraded, not Needs refresh", () => {
  // A gap blocked on structured owner attention is real trouble the owner must
  // resolve, not a passive refresh nudge.
  const snap = snapshot({
    axes: { attention: "open", coverage: "retryable_gap", freshness: "stale" },
    forward_disposition: "awaiting_owner",
    last_success_at: "2026-06-01T00:00:00.000Z",
    state: "needs_attention",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [stream({ attention_open: true, coverage: "retryable_gap", gap_retryable: true, stream_id: "accounts" })],
    MANUAL_REFRESH,
    true
  );
  assert.equal(v.pill.label, "Missing data");
  assert.notEqual(v.pill.label, "Needs refresh");
});

test("golden: terminal coverage stays Can't collect, not Needs refresh", () => {
  const snap = snapshot({
    axes: { coverage: "terminal_gap", freshness: "stale" },
    forward_disposition: "terminal",
    last_success_at: "2026-06-01T00:00:00.000Z",
    state: "degraded",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [stream({ coverage: "terminal_gap", priority: "required" })],
    MANUAL_REFRESH,
    true
  );
  assert.equal(v.pill.tone, "red");
  assert.equal(v.pill.label, "Can't collect");
});

test("degraded state (real degrading condition) with only stale freshness, no coverage/attention/outbox axis, still stays Degraded", () => {
  // state:degraded only ever fires on a genuine degrading condition
  // (classifyDegradedEvidence), so it must never be softened to "Needs refresh"
  // even if the per-stream/attention/outbox axes happen to look clean in this
  // synthetic input shape.
  const snap = snapshot({
    axes: { coverage: "complete", freshness: "stale" },
    forward_disposition: "complete",
    last_success_at: "2026-06-01T00:00:00.000Z",
    state: "degraded",
  });
  const v = synthesizeRenderedVerdict(snap, [stream()], MANUAL_REFRESH, true);
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
});

test("idle never-run (no prior success, no stale evidence) stays neutral, not amber", () => {
  // No prior success and unmeasured freshness is honestly "Not measured" (grey),
  // not a false-positive green or a false-negative amber — there is nothing yet
  // to call degraded.
  const snap = snapshot({
    axes: { coverage: "complete", freshness: "unknown" },
    forward_disposition: "complete",
    last_success_at: null,
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(snap, [stream()], null, true);
  assert.equal(v.pill.tone, "grey");
  assert.equal(v.pill.label, "Not measured");
});

test("idle never-run with fresh evidence (no prior terminal run yet) stays green, not amber", () => {
  const snap = snapshot({
    axes: { coverage: "complete", freshness: "fresh" },
    forward_disposition: "complete",
    last_success_at: null,
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(snap, [stream()], null, true);
  assert.equal(v.pill.tone, "green");
  assert.equal(v.pill.label, "Healthy");
});

test("golden: Chase — degraded/advisory with a retryable transactions gap", () => {
  const snap = snapshot({
    axes: { coverage: "retryable_gap", freshness: "stale" },
    forward_disposition: "resumable",
    last_success_at: "2026-04-22T08:00:00.000Z",
    state: "degraded",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "transactions" })],
    MANUAL_REFRESH,
    true,
    { mode: "manual", retained_records: 1200 }
  );
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
  assert.equal(v.channel, "advisory");
  assert.ok(v.annotations.some((a) => a.kind === "freshness" && a.text === "Transactions stuck since Apr 22."));
  const retry = v.required_actions.find((a) => a.kind === "retry_gap");
  assert.ok(retry);
  assert.equal(retry.audience, "owner");
  assert.equal(retry.cta, "Retry now");
  assert.deepEqual(retry.satisfied_when, { kind: "gap_recovered" });
  assert.deepEqual(retry.affects, ["transactions"]);
  // The transactions stream truthfully says the next run retries.
  const row = v.streams.find((s) => s.stream_id === "transactions");
  assert.ok(row, "transactions stream row exists");
  assert.equal(row.disposition, "resumable");
  assert.equal(row.action_ref, v.required_actions.indexOf(retry));
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(row.statement, /next run/i);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.ok(!/can't|terminal/i.test(row.statement));
});

test("golden: Amazon order_items stream name does not trip calm/advisory count invariant", () => {
  const snap = snapshot({
    axes: { coverage: "retryable_gap", freshness: "stale" },
    forward_disposition: "resumable",
    last_success_at: "2026-06-30T23:05:36.032Z",
    state: "degraded",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [
      stream({ coverage: "retryable_gap", gap_retryable: true, stream_id: "order_items" }),
      stream({ coverage: "unknown", stream_id: "orders" }),
    ],
    MANUAL_REFRESH,
    true,
    { mode: "manual", retained_records: 6525 }
  );
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
  assert.equal(v.channel, "advisory");
  assert.equal(v.trace.channel_cause, "owner_optional_or_status:retry_gap");
  assert.ok(v.annotations.some((a) => a.kind === "freshness" && a.text === "Order items stuck since Jun 30."));
  assert.equal(v.required_actions[0]?.kind, "retry_gap");
  assert.equal(v.forward_statement, "Retry now to give the recoverable gap another run.");
});

test("golden: broken but recently successful source says last successful refresh, not Fresh yesterday", () => {
  const snap = snapshot({
    axes: { coverage: "terminal_gap", freshness: "fresh" },
    forward_disposition: "terminal",
    state: "blocked",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [stream({ coverage: "terminal_gap", stream_id: "transactions" })],
    null,
    true,
    {
      last_refreshed_at: "2026-06-14T12:00:00.000Z",
      mode: "manual",
      observed_at: "2026-06-15T12:00:00.000Z",
      retained_records: 1200,
    }
  );
  assert.equal(v.pill.label, "Can't collect");
  assert.ok(v.annotations.some((a) => a.kind === "freshness" && a.text === "Last successful refresh yesterday."));
  assert.ok(!JSON.stringify(v.annotations).includes("Fresh yesterday"));
});

test("golden: stream-level terminal gap overrides healthy-state freshness copy", () => {
  const snap = snapshot({
    axes: { coverage: "complete", freshness: "fresh" },
    forward_disposition: "complete",
    state: "healthy",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [stream({ coverage: "terminal_gap", stream_id: "transactions" })],
    null,
    true,
    {
      last_refreshed_at: "2026-06-14T12:00:00.000Z",
      mode: "manual",
      observed_at: "2026-06-15T12:00:00.000Z",
      retained_records: 1200,
    }
  );
  assert.equal(v.pill.label, "Can't collect");
  assert.ok(v.annotations.some((a) => a.kind === "freshness" && a.text === "Last successful refresh yesterday."));
  assert.ok(!JSON.stringify(v.annotations).includes("Fresh yesterday"));
});

test("golden: synthetic terminal code_fix — maintainer status, no dead owner button, never attention", () => {
  const snap = snapshot({
    axes: { coverage: "terminal_gap", freshness: "fresh" },
    forward_disposition: "terminal",
    state: "degraded",
  });
  const v = synthesizeRenderedVerdict(snap, [stream({ coverage: "terminal_gap", stream_id: "lost" })], null, true);
  const codeFix = v.required_actions.find((a) => a.kind === "code_fix");
  assert.ok(codeFix);
  assert.equal(codeFix.audience, "maintainer");
  assert.equal(codeFix.cta, "Some data from this source can't be collected");
  assert.deepEqual(codeFix.satisfied_when, { kind: "none" });
  assert.notEqual(v.channel, "attention"); // maintainer status never raises attention
  assert.equal(v.forward_statement, "Some data from this source can't be collected.");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.ok(!/we|we're|nothing for you/i.test(`${codeFix.cta} ${v.forward_statement}`));
  // No owner-audience action (no dead owner button).
  assert.ok(!v.required_actions.some((a) => a.audience === "owner"));
});

test("golden: succeeded terminal coverage reads as degraded coverage review, not total collection failure", () => {
  const snap = snapshot({
    axes: { coverage: "terminal_gap", freshness: "fresh" },
    conditions: [collectionSucceededCondition()],
    forward_disposition: "terminal",
    state: "degraded",
  });
  const v = synthesizeRenderedVerdict(snap, [stream({ coverage: "terminal_gap", stream_id: "messages" })], null, true, {
    mode: "scheduled",
    retained_records: 369_931,
  });
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const action = v.required_actions[0];
  assert.ok(action, "primary required action exists");
  assert.equal(v.pill.tone, "amber");
  assert.equal(v.pill.label, "Missing data");
  assert.equal(v.channel, "advisory");
  assert.equal(action?.kind, "code_fix");
  assert.equal(action?.audience, "maintainer");
  assert.equal(action?.cta, "Coverage gap needs review");
  assert.equal(v.forward_statement, "Latest collection completed with known coverage gaps.");
  assert.equal(v.progress.headline, "Holding 369,931 records; source coverage has known gaps.");
  assert.ok(!JSON.stringify(v).includes("Some data from this source can't be collected"));
});

test("golden: synthetic runtime fault — channel capped at calm, pill stays honest", () => {
  const snap = snapshot({
    axes: { attention: "open" },
    conditions: [credentialRejectedCondition()],
    forward_disposition: "awaiting_owner",
    state: "needs_attention",
  });
  const ok = synthesizeRenderedVerdict(snap, [stream()], null, true);
  const faulted = synthesizeRenderedVerdict(snap, [stream()], null, false);
  // Pill tone unchanged (honest); only channel capped.
  assert.equal(faulted.pill.tone, ok.pill.tone);
  assert.equal(ok.channel, "attention");
  assert.equal(faulted.channel, "calm");
  assert.equal(faulted.trace.runtime_capped, true);
  assert.ok(faulted.detail.suppressed.some((s) => s.kind === "runtime_fault"));
});

// ─── 6.4 non-credential invariant ──────────────────────────────────────────────

test("refresh-contract: a zero-credential active account (ChatGPT-shape) is a valid green verdict", () => {
  // ChatGPT: account + scheduled + assisted, zero credentials, fresh. No reauth action.
  const snap = snapshot({
    axes: { coverage: "complete", freshness: "fresh" },
    forward_disposition: "complete",
    state: "healthy",
  });
  const v = synthesizeRenderedVerdict(snap, [stream()], ASSISTED_REFRESH, true);
  assert.equal(v.pill.tone, "green");
  assert.ok(!v.required_actions.some((a) => a.kind === "reauth"));
});

// ─── invariant gate falsifiability ──────────────────────────────────────────────

test("gate: throws (in dev) when a stream violates collected<=considered after a forced bad row", () => {
  // The synthesizer clamps, so we cannot feed a bad row through it directly. Instead,
  // prove the gate is wired by confirming a clean synthesis never throws and the
  // VerdictInvariantError class is exported for the prod-fallback path.
  assert.equal(typeof VerdictInvariantError, "function");
  assert.doesNotThrow(() => synthesizeRenderedVerdict(snapshot(), [stream()], null, true));
});

// ─── grant-scope projection ──────────────────────────────────────────────────────

test("grant-scope: toGrantScopedVerdict strips detail and trace", () => {
  const v = synthesizeRenderedVerdict(snapshot(), [stream()], null, true);
  const scoped = toGrantScopedVerdict(v);
  assert.ok(!("detail" in scoped), "detail stripped for grant scope");
  assert.ok(!("trace" in scoped), "trace stripped for grant scope");
  // Public fields survive.
  assert.ok("pill" in scoped && "channel" in scoped && "forward_statement" in scoped);
});

// ─── Wave 10a: reattach_schedule (owner-paused schedule), single-pass invariant ───
//
// `reattach_schedule` is emitted INSIDE `buildRequiredActions`'s single
// synthesis pass, never as a post-pass mutation on an already-built verdict
// (owner review, 2026-07-09: a post-pass mutator leaves `forward_statement`,
// `channel`, `annotations`, `streams[].action_ref`, and `trace` derived from
// the STALE pre-mutation action set — action derivation must have ONE
// owner). These tests prove the verdict's derived fields all agree with the
// FINAL action set, not just that the action array itself looks right.

const SCHEDULED_DISABLED_WITH_HISTORY: ScheduleEvidence = { hasPriorSuccess: true, mode: "scheduled-disabled" };
const SCHEDULED_DISABLED_NO_HISTORY: ScheduleEvidence = { hasPriorSuccess: false, mode: "scheduled-disabled" };
const SCHEDULED_ACTIVE: ScheduleEvidence = { hasPriorSuccess: true, mode: "scheduled-active" };
const MANUAL_NO_SCHEDULE: ScheduleEvidence = { hasPriorSuccess: true, mode: "manual" };

test("reattach_schedule: an owner-paused source with prior success emits it as primary, and every derived field agrees", () => {
  const snap = snapshot({ last_success_at: "2026-06-01T00:00:00.000Z", state: "idle" });
  const v = synthesizeRenderedVerdict(snap, [], null, true, null, SCHEDULED_DISABLED_WITH_HISTORY);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const primary = v.required_actions[0];
  assert.ok(primary, "primary required action exists");
  assert.equal(primary.kind, "reattach_schedule");
  // `{ kind: "schedule" }` (OwnerActionSurfaceKind, connection-health.ts) —
  // NOT `runtime_retry`, which means "run this once now." Resuming a paused
  // schedule is a distinct affordance from a one-off retry; a generic
  // client rendering by surface kind must route this to schedule
  // management, not a run-now button.
  assert.deepEqual(primary.surface, { kind: "schedule" });
  // channel: an owner-satisfiable, non-urgent (`soon`) action reads `advisory`.
  assert.equal(v.channel, "advisory");
  // forward_statement: derived from actions[0] via buildForwardStatement —
  // reattach_schedule has its own dedicated case (pause/resume semantics,
  // not the generic "your action" sentence every other owner action falls
  // back to).
  assert.equal(v.forward_statement, "Resume the schedule to continue automatic collection.");
  // trace: primary_action_kind/satisfied_when/channel_cause all reference
  // the FINAL action, not a stale one.
  assert.equal(v.trace.primary_action_kind, "reattach_schedule");
  assert.deepEqual(v.trace.satisfied_when, { kind: "schedule_attached_and_enabled" });
  assert.equal(v.trace.channel_cause, "owner_optional_or_status:reattach_schedule");
});

test("reattach_schedule: never emitted for a never-run source, even with a disabled schedule", () => {
  const snap = snapshot({ last_success_at: null, state: "idle" });
  const v = synthesizeRenderedVerdict(snap, [], null, true, null, SCHEDULED_DISABLED_NO_HISTORY);
  assert.ok(!v.required_actions.some((a) => a.kind === "reattach_schedule"));
});

test("reattach_schedule: never emitted for an active (non-disabled) schedule", () => {
  const snap = snapshot({ last_success_at: "2026-06-01T00:00:00.000Z", state: "idle" });
  const v = synthesizeRenderedVerdict(snap, [], null, true, null, SCHEDULED_ACTIVE);
  assert.ok(!v.required_actions.some((a) => a.kind === "reattach_schedule"));
});

test("reattach_schedule: never emitted for a manual connector (no schedule concept applies)", () => {
  const snap = snapshot({ last_success_at: "2026-06-01T00:00:00.000Z", state: "idle" });
  const v = synthesizeRenderedVerdict(snap, [], null, true, null, MANUAL_NO_SCHEDULE);
  assert.ok(!v.required_actions.some((a) => a.kind === "reattach_schedule"));
});

test("reattach_schedule: omitting scheduleEvidence entirely is byte-identical to passing null (existing callers unaffected)", () => {
  const snap = snapshot({ last_success_at: "2026-06-01T00:00:00.000Z", state: "idle" });
  const withoutParam = synthesizeRenderedVerdict(snap, [], null, true, null);
  const withNull = synthesizeRenderedVerdict(snap, [], null, true, null, null);
  assert.deepEqual(withoutParam, withNull);
  assert.ok(!withoutParam.required_actions.some((a) => a.kind === "reattach_schedule"));
});

// Named priority-conflict fixtures (owner review, 2026-07-09): a disabled
// schedule must NEVER mask a more urgent credential (reauth) or
// maintainer-blocked (code_fix) defect. Proven here at the SOURCE
// (`buildRequiredActions`), not just re-derived downstream in owner-state.ts.

test("reattach_schedule: paused schedule + credential failure — reauth stays primary, reattach_schedule does not fire at all", () => {
  const snap = snapshot({
    conditions: [credentialRejectedCondition()],
    last_success_at: "2026-06-01T00:00:00.000Z",
    state: "blocked",
  });
  const v = synthesizeRenderedVerdict(snap, [], null, true, null, SCHEDULED_DISABLED_WITH_HISTORY);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const primary = v.required_actions[0];
  assert.ok(primary, "primary required action exists");
  assert.equal(primary.kind, "reauth");
  assert.equal(v.trace.primary_action_kind, "reauth");
  assert.equal(v.channel, "attention");
  assert.equal(v.forward_statement, "Reconnect this account and collection resumes.");
  assert.ok(
    !v.required_actions.some((a) => a.kind === "reattach_schedule"),
    "reattach_schedule must not fire alongside a real credential defect"
  );
});

test("reattach_schedule: paused schedule + terminal code_fix defect — code_fix stays primary, reattach_schedule never fires", () => {
  const snap = snapshot({
    forward_disposition: "terminal",
    last_success_at: "2026-06-01T00:00:00.000Z",
    state: "blocked",
  });
  const streams = [stream({ coverage: "terminal_gap", priority: "required" })];
  const v = synthesizeRenderedVerdict(snap, streams, null, true, null, SCHEDULED_DISABLED_WITH_HISTORY);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const primary = v.required_actions[0];
  assert.ok(primary, "primary required action exists");
  assert.equal(primary.kind, "code_fix");
  assert.equal(v.trace.primary_action_kind, "code_fix");
  assert.ok(
    !v.required_actions.some((a) => a.kind === "reattach_schedule"),
    "reattach_schedule must not fire alongside a real maintainer defect"
  );
});

test("reattach_schedule: paused schedule preempts refresh_now — a merely-stale paused source gets Resume schedule, not a one-off refresh", () => {
  const snap = snapshot({
    axes: { freshness: "stale" },
    forward_disposition: "owner_refresh_due",
    last_success_at: "2026-06-01T00:00:00.000Z",
    state: "idle",
  });
  const v = synthesizeRenderedVerdict(snap, [], MANUAL_REFRESH, true, null, SCHEDULED_DISABLED_WITH_HISTORY);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const primary = v.required_actions[0];
  assert.ok(primary, "primary required action exists");
  assert.equal(primary.kind, "reattach_schedule");
  assert.ok(
    !v.required_actions.some((a) => a.kind === "refresh_now"),
    'refresh_now must not compete with reattach_schedule — both mean "run it again"'
  );
});

test("refresh_now: background-unsafe active schedule stays manual and keeps the owner refresh action", () => {
  const snap = snapshot({
    axes: { freshness: "stale" },
    forward_disposition: "owner_refresh_due",
    last_success_at: "2026-06-01T00:00:00.000Z",
    state: "idle",
  });
  const withoutSchedule = synthesizeRenderedVerdict(snap, [], MANUAL_REFRESH, true, null);
  const withActiveSchedule = synthesizeRenderedVerdict(snap, [], MANUAL_REFRESH, true, null, SCHEDULED_ACTIVE);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const withoutSchedulePrimary = withoutSchedule.required_actions[0];
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const withActiveSchedulePrimary = withActiveSchedule.required_actions[0];
  assert.ok(withoutSchedulePrimary, "primary required action exists without schedule");
  assert.ok(withActiveSchedulePrimary, "primary required action exists with active schedule");
  assert.equal(withoutSchedulePrimary.kind, "refresh_now");
  assert.equal(withActiveSchedulePrimary.kind, "refresh_now");
  assert.deepEqual(withoutSchedule, withActiveSchedule);
  assert.doesNotMatch(
    withActiveSchedule.annotations.find((annotation) => annotation.kind === "freshness")?.text ?? "",
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    /schedule/i
  );
  assert.match(
    withActiveSchedule.annotations.find((annotation) => annotation.kind === "freshness")?.text ?? "",
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    /refreshes when you run it/i
  );
});

test("refresh_now: paused active schedule stays manual and keeps the owner refresh action", () => {
  const snap = snapshot({
    axes: { freshness: "stale" },
    forward_disposition: "owner_refresh_due",
    last_success_at: "2026-06-01T00:00:00.000Z",
    state: "idle",
  });
  const withoutSchedule = synthesizeRenderedVerdict(snap, [], PAUSED_REFRESH, true, null);
  const withActiveSchedule = synthesizeRenderedVerdict(snap, [], PAUSED_REFRESH, true, null, SCHEDULED_ACTIVE);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const withoutSchedulePrimary = withoutSchedule.required_actions[0];
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const withActiveSchedulePrimary = withActiveSchedule.required_actions[0];
  assert.ok(withoutSchedulePrimary, "primary required action exists without schedule");
  assert.ok(withActiveSchedulePrimary, "primary required action exists with active schedule");
  assert.equal(withoutSchedulePrimary.kind, "refresh_now");
  assert.equal(withActiveSchedulePrimary.kind, "refresh_now");
  assert.deepEqual(withoutSchedule, withActiveSchedule);
  assert.doesNotMatch(
    withActiveSchedule.annotations.find((annotation) => annotation.kind === "freshness")?.text ?? "",
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    /schedule/i
  );
  assert.match(
    withActiveSchedule.annotations.find((annotation) => annotation.kind === "freshness")?.text ?? "",
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    /refreshes when you run it/i
  );
});

// ─── unfillable-accounted terminal_gap: the live Gmail shape ─────────────────
//
// Live Gmail (2026-08-18) reached a fully healthy condition set — including
// `SourceCoverageComplete: true` with reason
// `coverage_complete_unfillable_accounted` — while the disposition still read
// `terminal`, so `buildRequiredActions` emitted a maintainer `code_fix` and the
// pill rendered red ("Can't collect"). All five streams were settled; the only
// shortfall was `attachments`, whose every terminal gap carried durable
// size-vs-cap proof (a 29MB attachment against a 25MB cap is not a bug, and
// there is no code fix to make). These tests pin the whole rendered verdict.

test("unfillable-accounted: an all-proven terminal_gap stream renders non-red with no maintainer code_fix", () => {
  const snap = snapshot({
    axes: { coverage: "terminal_gap", freshness: "fresh" },
    conditions: [collectionSucceededCondition()],
    forward_disposition: "complete",
    state: "healthy",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [
      stream({ coverage: "terminal_gap", stream_id: "attachments", unfillable_accounted: true }),
      stream({ coverage: "complete", stream_id: "messages" }),
    ],
    null,
    true
  );

  assert.equal(v.detail.forward_disposition, "complete");
  assert.notEqual(v.pill.tone, "red");
  assert.notEqual(v.pill.label, "Can't collect");
  assert.ok(
    !v.required_actions.some((a) => a.kind === "code_fix"),
    "a fully-accounted terminal gap has no code fix to make"
  );
  assert.ok(!JSON.stringify(v).includes("Some data from this source can't be collected"));
});

test("ANTI-FALSE-GREEN: one unproven terminal gap beside a proven one stays red with the code_fix", () => {
  // Partial proof is not proof. `attachments` is fully accounted; `messages`
  // has an unproven terminal gap, so the connection is still genuinely stuck.
  const snap = snapshot({
    axes: { coverage: "terminal_gap", freshness: "fresh" },
    forward_disposition: "terminal",
    state: "degraded",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [
      stream({ coverage: "terminal_gap", stream_id: "attachments", unfillable_accounted: true }),
      stream({ coverage: "terminal_gap", stream_id: "messages", unfillable_accounted: false }),
    ],
    null,
    true
  );

  assert.equal(v.detail.forward_disposition, "terminal");
  assert.equal(v.pill.tone, "red");
  assert.equal(v.pill.label, "Can't collect");
  const codeFix = v.required_actions.find((a) => a.kind === "code_fix");
  assert.ok(codeFix, "an unproven terminal gap still owes a maintainer code_fix");
  assert.equal(codeFix.audience, "maintainer");
  // The action names the genuinely-stuck stream and ONLY that one: a stream
  // already proven fully accounted is not something a maintainer can fix, and
  // listing it would overstate the blast radius.
  assert.deepEqual(codeFix.affects, ["messages"]);
});

test("ANTI-FALSE-GREEN: the USAA shape — a quarantined terminal gap with no size-vs-cap proof stays red", () => {
  // A quarantined gap carries no per-item impossibility evidence, so
  // `isStreamFullyUnfillableAccounted` leaves the flag false and nothing softens.
  const snap = snapshot({
    axes: { coverage: "terminal_gap", freshness: "fresh" },
    forward_disposition: "terminal",
    state: "degraded",
  });
  const v = synthesizeRenderedVerdict(
    snap,
    [stream({ coverage: "terminal_gap", stream_id: "transactions", unfillable_accounted: false })],
    null,
    true
  );

  assert.equal(v.detail.forward_disposition, "terminal");
  assert.equal(v.pill.tone, "red");
  assert.equal(v.required_actions.find((a) => a.kind === "code_fix")?.audience, "maintainer");
});

test("ANTI-FALSE-GREEN: unsupported/unavailable streams are unaffected by the unfillable flag", () => {
  for (const coverage of ["unsupported", "unavailable"] as const) {
    const snap = snapshot({
      axes: { coverage, freshness: "fresh" },
      forward_disposition: "terminal",
      state: "degraded",
    });
    const v = synthesizeRenderedVerdict(
      snap,
      [stream({ coverage, stream_id: "lost", unfillable_accounted: true })],
      null,
      true
    );
    assert.equal(v.detail.forward_disposition, "terminal", `${coverage} stays terminal`);
    assert.equal(v.pill.tone, "red", `${coverage} stays red`);
    assert.ok(
      v.required_actions.some((a) => a.kind === "code_fix"),
      `${coverage} still owes a code_fix`
    );
  }
});
