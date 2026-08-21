// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectionHealthSnapshot } from "../runtime/connection-health.ts";
import {
  type RenderedVerdict,
  type StreamRollup,
  synthesizeRenderedVerdict,
  toGrantScopedVerdict,
  type VerdictStreamRow,
} from "../runtime/rendered-verdict.ts";

// Task 10: grant-scope isolation.
//
// The inspection-layer `detail` (gap backlog, raw disposition, conditions, next-attempt
// floor, collection rate) and the calibration `trace` are owner-only diagnostics —
// identical to the existing `detail_gap_backlog` exposure policy — and SHALL NOT be
// exposed to grant-scoped REST/MCP reads.
//
// `RenderedVerdict` is not yet wired into the RS wire response (that is Dispatch C).
// This is therefore a FORWARD regression at the contract level: it pins the exact
// transform Dispatch C will apply at the wire seam (`toGrantScopedVerdict`) so that a
// grant-scoped projection structurally cannot carry `detail` or `trace`. It will keep
// holding after C wires it IF C routes grant-scoped reads through this projection.

function snapshot(): ConnectionHealthSnapshot {
  return {
    axes: { attention: "open", coverage: "retryable_gap", freshness: "stale", outbox: "idle", remote_surface: "none" },
    badges: { stale: true, syncing: false },
    collection_rate: {
      ceiling_interval_ms: 1000,
      ceiling_rate_per_min: 60,
      current_interval_ms: 2000,
      effective_rate_per_min: 30,
      last_backoff: null,
    },
    conditions: [
      {
        current: true,
        expires_at: null,
        id: "CredentialsValid:credential_rejected",
        message: "rejected",
        observed_at: null,
        origin: "connector",
        reason: "credential_rejected",
        reason_code: null,
        remediation: null,
        sensitivity: "owner",
        severity: "error",
        status: "false",
        type: "CredentialsValid",
      },
    ],
    detail_gap_backlog: {
      max_attempt_count: 3,
      next_attempt_at: "2026-06-15T12:00:00.000Z",
      pending: 7,
      pending_is_floor: false,
      pending_other: 0,
      pending_other_is_floor: false,
      recovered: 2532,
      terminal: null,
    },
    dominant_condition_id: "CredentialsValid:credential_rejected",
    ephemeral_browser_runtime: null,
    forward_disposition: "awaiting_owner",
    last_success_at: null,
    next_action: null,
    next_attempt_at: "2026-06-15T12:00:00.000Z",
    reason_code: "credential_rejected",
    remote_surface: null,
    state: "needs_attention",
    supporting_condition_ids: [],
    unknown_reasons: [],
  };
}

function stream(): StreamRollup {
  return {
    attention_open: true,
    collected: 5,
    considered: 10,
    coverage: "retryable_gap",
    gap_retryable: true,
    priority: "required",
    stream_id: "s1",
  };
}

test("grant-scope: the owner verdict carries detail + trace (owner-only diagnostics)", () => {
  const v = synthesizeRenderedVerdict(
    snapshot(),
    [stream()],
    { backgroundSafe: false, interactionPosture: "otp_likely", recommendedMode: "manual" },
    true
  );
  assert.ok("detail" in v, "owner verdict carries detail");
  assert.ok("trace" in v, "owner verdict carries trace");
  // And the suppressed/backlog evidence really lives there.
  assert.ok(v.detail.detail_gap_backlog, "detail carries a gap backlog rollup");
  assert.equal(v.detail.detail_gap_backlog.recovered, 2532);
});

test("grant-scope: the grant-scoped projection returns NO detail and NO trace", () => {
  const v = synthesizeRenderedVerdict(
    snapshot(),
    [stream()],
    { backgroundSafe: false, interactionPosture: "otp_likely", recommendedMode: "manual" },
    true
  );
  const scoped = toGrantScopedVerdict(v);
  assert.ok(!("detail" in scoped), "grant-scoped read must not expose detail");
  assert.ok(!("trace" in scoped), "grant-scoped read must not expose trace");
});

test("grant-scope: no inspection-layer figure leaks through the grant-scoped projection", () => {
  const v = synthesizeRenderedVerdict(
    snapshot(),
    [stream()],
    { backgroundSafe: false, interactionPosture: "otp_likely", recommendedMode: "manual" },
    true
  );
  const scoped = toGrantScopedVerdict(v);
  const serialized = JSON.stringify(scoped);
  // The 2,532-gap backlog scale and the raw next-attempt floor must not reach a
  // grant-scoped client through any public field.
  assert.ok(!serialized.includes("2532"), "backlog scale must not leak to grant scope");
  assert.ok(!serialized.includes("detail_gap_backlog"), "no inspection-layer key in grant-scoped output");
  assert.ok(!serialized.includes("collection_rate"), "no rate snapshot in grant-scoped output");
});

test("grant-scope: public attention-layer fields survive the projection", () => {
  const v = synthesizeRenderedVerdict(
    snapshot(),
    [stream()],
    { backgroundSafe: false, interactionPosture: "otp_likely", recommendedMode: "manual" },
    true
  );
  const scoped = toGrantScopedVerdict(v);
  for (const key of [
    "pill",
    "channel",
    "annotations",
    "forward_statement",
    "required_actions",
    "streams",
    "progress",
  ]) {
    assert.ok(key in scoped, `public field ${key} survives grant-scoped projection`);
  }
});

// ─── Dispatch C boundary regression ──────────────────────────────────────────
//
// Now that Dispatch C has wired `rendered_verdict` into `ConnectorSummary` and
// `ConnectorDetail`, the owner types carry a `RenderedVerdict` with `detail` and
// `trace`. This test pins the exact boundary: a verdict that arrives at a
// grant-scoped seam MUST have `detail` and `trace` stripped via `toGrantScopedVerdict`
// before it reaches a grant-scoped client.
//
// This is a structural regression: if anyone removes `toGrantScopedVerdict` from
// the grant-scoped path in the future, these tests catch the exposure.

test("grant-scope: RenderedVerdict.detail is owner-only by type — GrantScopedVerdict structurally cannot carry it", () => {
  const ownerVerdict = synthesizeRenderedVerdict(
    snapshot(),
    [stream()],
    { backgroundSafe: false, interactionPosture: "otp_likely", recommendedMode: "manual" },
    true
  );
  // Owner verdict has detail and trace
  assert.ok("detail" in ownerVerdict, "owner verdict has detail");
  assert.ok("trace" in ownerVerdict, "owner verdict has trace");

  // After grant-scoped projection, both are absent
  const grantScoped = toGrantScopedVerdict(ownerVerdict);
  assert.ok(!("detail" in grantScoped), "GrantScopedVerdict has no detail (structural)");
  assert.ok(!("trace" in grantScoped), "GrantScopedVerdict has no trace (structural)");

  // The type-level guarantee: GrantScopedVerdict = Omit<RenderedVerdict, 'detail' | 'trace'>
  // Confirmed at runtime: the projection does not add them back under any alias.
  const serialized = JSON.stringify(grantScoped);
  const parsed = JSON.parse(serialized);
  assert.ok(!("detail" in parsed), 'no "detail" key in serialized grant-scoped verdict');
  assert.ok(!("trace" in parsed), 'no "trace" key in serialized grant-scoped verdict');
});

test("grant-scope: ConnectorSummary.rendered_verdict detail must go through toGrantScopedVerdict before grant scope", () => {
  // Simulate what the grant-scoped REST path must do when it encounters rendered_verdict:
  // it calls toGrantScopedVerdict, which strips detail and trace.
  // This test proves the transform is idempotent (calling it twice doesn't add fields back)
  // and that the result is safe for a grant-scoped client.
  const ownerVerdict = synthesizeRenderedVerdict(
    snapshot(),
    [stream()],
    { backgroundSafe: false, interactionPosture: "otp_likely", recommendedMode: "manual" },
    true
  );

  const scoped = toGrantScopedVerdict(ownerVerdict);
  // Idempotent: the scoped verdict does not accidentally acquire detail/trace
  // if passed through again (defense-in-depth). This intentionally calls
  // toGrantScopedVerdict on a value that has ALREADY had detail/trace
  // stripped — outside its declared RenderedVerdict input type by design, to
  // prove the destructuring implementation tolerates it at runtime too.
  const scopedAgain = toGrantScopedVerdict(scoped as RenderedVerdict);
  assert.ok(!("detail" in scopedAgain));
  assert.ok(!("trace" in scopedAgain));

  // The 2,532 recovered gap backlog must not be serializable from the scoped verdict.
  const serialized = JSON.stringify(scopedAgain);
  assert.ok(!serialized.includes("2532"), "gap count must not be reachable from grant-scoped verdict");
});

// ─── Audience isolation at the grant boundary ────────────────────────────────
//
// `required_actions` survives the grant-scoped projection (see "public
// attention-layer fields survive the projection" above), so its CONTENTS must be
// filtered rather than the field dropped. A `maintainer`-audience action is
// implementer-facing: its `cta` names a connector defect ("Some data from this
// source can't be collected", `kind: "code_fix"`, `surface: { kind: "maintainer" }`)
// and it is not owner-satisfiable (`satisfied_when: { kind: "none" }`). A
// third-party app holding a scoped grant must only ever see owner-facing material.
//
// `audience: "none"` (the `wait` marker) is likewise internal bookkeeping, not an
// action a grant-scoped client can render or act on.

/** A terminal-coverage snapshot with NO credential failure — the shape that makes
 * `buildRequiredActions` emit the maintainer-audience `code_fix` action. */
function terminalCoverageSnapshot(): ConnectionHealthSnapshot {
  return {
    ...snapshot(),
    axes: { attention: "none", coverage: "terminal_gap", freshness: "fresh", outbox: "idle", remote_surface: "none" },
    badges: { stale: false, syncing: false },
    conditions: [],
    dominant_condition_id: null,
    forward_disposition: "terminal",
    last_success_at: "2026-06-15T10:00:00.000Z",
    next_attempt_at: null,
    reason_code: null,
    state: "degraded",
  };
}

/** A fully-specified stream row pointing at a chosen `required_actions[]` index. */
function row(streamId: string, actionRef: number): VerdictStreamRow {
  return {
    action_ref: actionRef,
    collected: 5,
    considered: 10,
    coverage: "retryable_gap",
    disposition: "resumable",
    statement: "The next run is expected to fill the rest.",
    stream_id: streamId,
  };
}

function terminalStream(): StreamRollup {
  return {
    attention_open: false,
    collected: 2,
    considered: 9,
    coverage: "terminal_gap",
    gap_retryable: false,
    priority: "required",
    stream_id: "s1",
  };
}

test("grant-scope: a maintainer-audience code_fix action does NOT reach a grant-scoped verdict", () => {
  const owner = synthesizeRenderedVerdict(
    terminalCoverageSnapshot(),
    [terminalStream()],
    { backgroundSafe: true, interactionPosture: "none", recommendedMode: "automatic" },
    true
  );

  // Precondition: the owner verdict really does carry the maintainer action.
  const maintainer = owner.required_actions.filter((a) => a.audience === "maintainer");
  assert.equal(maintainer.length, 1, "owner verdict carries the maintainer code_fix action");
  assert.equal(maintainer[0]?.kind, "code_fix");
  assert.equal(maintainer[0]?.cta, "Some data from this source can't be collected");

  const scoped = toGrantScopedVerdict(owner);
  assert.deepEqual(
    scoped.required_actions.filter((a) => a.audience !== "owner"),
    [],
    "grant scope carries no non-owner action"
  );
  // The maintainer-only MARKERS are not reachable through any public field.
  //
  // Deliberately NOT asserted: that the sentence "Some data from this source can't
  // be collected" is absent. `forward_statement` and `progress.headline` are
  // owner-facing narrative DERIVED from the primary action
  // (`terminalForwardStatement`), and they are supposed to reach a grant-scoped
  // client — they state the collection outcome without asking anyone to fix code.
  // What must not cross the boundary is the actionable maintainer entry itself:
  // its `kind`, its `surface`, and the CTA in a slot a client would render as a
  // button. Sharing wording with the CTA is a copy coincidence, not a leak.
  const serialized = JSON.stringify(scoped);
  assert.ok(!serialized.includes("code_fix"), "maintainer action kind must not leak");
  assert.ok(!serialized.includes('"maintainer"'), "maintainer surface/audience must not leak");
  assert.deepEqual(
    scoped.required_actions.map((a) => a.cta),
    [],
    "no CTA is offered to a grant-scoped client for a maintainer-only defect"
  );
});

test("grant-scope: owner-audience actions DO survive the projection", () => {
  // The default snapshot() is a credential failure — an owner-satisfiable reauth.
  const owner = synthesizeRenderedVerdict(
    snapshot(),
    [stream()],
    { backgroundSafe: false, interactionPosture: "otp_likely", recommendedMode: "manual" },
    true
  );
  const ownerActions = owner.required_actions.filter((a) => a.audience === "owner");
  assert.ok(ownerActions.length > 0, "precondition: owner verdict carries an owner action");

  const scoped = toGrantScopedVerdict(owner);
  assert.deepEqual(
    scoped.required_actions,
    ownerActions,
    "every owner-audience action survives the grant-scoped projection unchanged"
  );
  assert.ok(JSON.stringify(scoped).includes("Reconnect this account"), "owner CTA still reaches grant scope");
});

test("grant-scope: dropping a non-owner action renumbers streams[].action_ref", () => {
  // `action_ref` is a POSITIONAL index into `required_actions[]`. If the filter
  // removed entries without remapping, a stream pointing at the owner action at
  // index 1 would, after the maintainer action at index 0 is dropped, silently
  // point at index 1 of a 1-element array (dangling) — or worse, at a different
  // action. Built as a literal so both audiences coexist in a known order.
  const base = synthesizeRenderedVerdict(
    snapshot(),
    [stream()],
    { backgroundSafe: false, interactionPosture: "otp_likely", recommendedMode: "manual" },
    true
  );
  const ownerAction = base.required_actions.find((a) => a.audience === "owner");
  assert.ok(ownerAction, "precondition: an owner action exists to reference");

  const mixed: RenderedVerdict = {
    ...base,
    required_actions: [
      {
        affects: ["s1"],
        audience: "maintainer",
        cta: "Some data from this source can't be collected",
        kind: "code_fix",
        satisfied_when: { kind: "none" },
        surface: { kind: "maintainer" },
        terminal: false,
        urgency: "soon",
      },
      ownerAction,
    ],
    streams: [row("s1", 0), row("s2", 1)],
  };

  const scoped = toGrantScopedVerdict(mixed);
  assert.equal(scoped.required_actions.length, 1, "only the owner action survives");
  assert.equal(scoped.required_actions[0]?.audience, "owner");

  const byId = new Map(scoped.streams.map((r) => [r.stream_id, r.action_ref]));
  assert.equal(byId.get("s1"), null, "a stream whose action was dropped no longer points at one");
  assert.equal(byId.get("s2"), 0, "the surviving owner action is renumbered from index 1 to index 0");
  // The renumbered ref must resolve to the owner action, not run off the end.
  const s2Ref = byId.get("s2");
  assert.equal(typeof s2Ref, "number");
  assert.equal(scoped.required_actions[s2Ref as number]?.cta, ownerAction.cta);
});

test("grant-scope: an audience:none wait action does not reach a grant-scoped verdict", () => {
  const base = synthesizeRenderedVerdict(
    snapshot(),
    [stream()],
    { backgroundSafe: false, interactionPosture: "otp_likely", recommendedMode: "manual" },
    true
  );
  const mixed: RenderedVerdict = {
    ...base,
    required_actions: [
      {
        affects: [],
        audience: "none",
        cta: "Collecting — no action needed",
        kind: "wait",
        satisfied_when: { kind: "none" },
        surface: { kind: "none" },
        terminal: false,
        urgency: "verifying",
      },
    ],
    streams: [row("s1", 0)],
  };

  const scoped = toGrantScopedVerdict(mixed);
  assert.deepEqual(scoped.required_actions, [], "the wait marker is internal, not grant-scoped material");
  assert.equal(scoped.streams[0]?.action_ref, null, "its dangling action_ref is cleared, not left at 0");
});
