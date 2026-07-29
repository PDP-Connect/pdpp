// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type CreateAttentionInput,
  canTransition,
  classifyAutoDetect,
  createAttention,
  decideDedupe,
  expireIfDue,
  isExpired,
  isHealthRelevant,
  isNotificationDeliveryFailed,
  isTerminal,
  pushPayload,
  recordNotificationOutcome,
  TERMINAL_LIFECYCLES,
  transition,
} from "../runtime/attention.ts";

const NOW = "2026-05-19T12:00:00.000Z";

function input(overrides: Partial<CreateAttentionInput> = {}): CreateAttentionInput {
  return {
    connection_id: "conn_a",
    dedupe_key: "conn_a:otp",
    id: "att_1",
    now: NOW,
    owner_action: "provide_value",
    progress_posture: "blocked",
    reason_code: "otp",
    response_contract: "response_required",
    run_id: "run_1",
    sensitivity: "secret",
    ...overrides,
  };
}

test("createAttention validates axes — pure progress is not assistance", () => {
  assert.throws(() =>
    createAttention(
      input({
        owner_action: "none",
        progress_posture: "running",
        response_contract: "none",
        sensitivity: "none",
      })
    )
  );
});

test("createAttention validates axes — response_required requires owner_action", () => {
  assert.throws(() =>
    createAttention(
      input({
        owner_action: "none",
        progress_posture: "blocked",
        response_contract: "response_required",
      })
    )
  );
});

test("createAttention accepts nonblocking external approval (act_elsewhere)", () => {
  const rec = createAttention(
    input({
      owner_action: "act_elsewhere",
      progress_posture: "running",
      reason_code: "app_push_approval",
      response_contract: "none",
      sensitivity: "non_secret",
    })
  );
  assert.equal(rec.lifecycle, "open");
  assert.equal(rec.owner_action, "act_elsewhere");
});

test("isHealthRelevant surfaces time-bound external approval", () => {
  const rec = createAttention(
    input({
      expires_at: "2026-05-19T12:05:00.000Z",
      owner_action: "act_elsewhere",
      progress_posture: "running",
      reason_code: "app_push_approval",
      response_contract: "none",
      sensitivity: "non_secret",
    })
  );
  assert.equal(isHealthRelevant(rec, NOW), true);
  assert.equal(isHealthRelevant(rec, "2026-05-19T12:06:00.000Z"), false);
});

test("isHealthRelevant keeps unbounded external progress quiet", () => {
  const rec = createAttention(
    input({
      owner_action: "act_elsewhere",
      progress_posture: "running",
      reason_code: "app_push_pending_auto",
      response_contract: "none",
      sensitivity: "non_secret",
    })
  );
  assert.equal(isHealthRelevant(rec, NOW), false);
});

test("lifecycle transitions are validated", () => {
  const rec = createAttention(input());
  assert.equal(canTransition("open", "in_progress"), true);
  assert.equal(canTransition("resolved", "open"), false);
  assert.throws(() => transition(rec, { now: NOW, to: "open" }));

  const acked = transition(rec, { now: NOW, to: "acknowledged" });
  const inProg = transition(acked, { now: NOW, to: "in_progress" });
  const resolved = transition(inProg, { now: NOW, to: "resolved" });
  assert.equal(resolved.lifecycle, "resolved");
  assert.ok(isTerminal("resolved"));
  assert.deepEqual([...TERMINAL_LIFECYCLES].sort(), ["cancelled", "expired", "resolved", "superseded"]);
});

test("dedupe — suppress active duplicate when axes match", () => {
  const existing = createAttention(input());
  const out = decideDedupe({
    cooldown_seconds: 60,
    existing,
    proposed: input({ id: "att_2", now: "2026-05-19T12:00:10.000Z" }),
  });
  assert.deepEqual(out, { kind: "suppress", reason: "active_duplicate" });
});

test("dedupe — supersede when axes shift while existing is still open", () => {
  const existing = createAttention(
    input({
      owner_action: "act_elsewhere",
      progress_posture: "running",
      reason_code: "app_push_approval",
      response_contract: "none",
      sensitivity: "non_secret",
    })
  );
  const out = decideDedupe({
    cooldown_seconds: 60,
    existing,
    proposed: input({
      id: "att_2",
      now: "2026-05-19T12:05:00.000Z",
      owner_action: "provide_value",
      progress_posture: "blocked",
      // Owner ran out of time on the external app, so now we require a code.
      reason_code: "otp",
      response_contract: "response_required",
      sensitivity: "secret",
    }),
  });
  assert.deepEqual(out, { existing_id: existing.id, kind: "supersede" });
});

test("dedupe — cooldown blocks rapid re-fire after terminal close", () => {
  const existing = transition(createAttention(input()), {
    now: "2026-05-19T12:00:30.000Z",
    to: "resolved",
  });
  const out = decideDedupe({
    cooldown_seconds: 60,
    existing,
    proposed: input({ id: "att_3", now: "2026-05-19T12:00:40.000Z" }),
  });
  assert.deepEqual(out, { kind: "suppress", reason: "cooldown" });
});

test("dedupe — creates fresh once cooldown has elapsed", () => {
  const existing = transition(createAttention(input()), {
    now: "2026-05-19T12:00:30.000Z",
    to: "resolved",
  });
  const out = decideDedupe({
    cooldown_seconds: 60,
    existing,
    proposed: input({ id: "att_3", now: "2026-05-19T12:10:00.000Z" }),
  });
  assert.deepEqual(out, { kind: "create" });
});

test("expiry — non-terminal record past expires_at is expired", () => {
  const rec = createAttention(input({ expires_at: "2026-05-19T12:01:00.000Z" }));
  assert.equal(isExpired(rec, "2026-05-19T12:00:30.000Z"), false);
  assert.equal(isExpired(rec, "2026-05-19T12:02:00.000Z"), true);

  const expired = expireIfDue(rec, "2026-05-19T12:02:00.000Z");
  assert.equal(expired.lifecycle, "expired");

  // Idempotent — terminal records never re-expire.
  const again = expireIfDue(expired, "2026-05-19T13:00:00.000Z");
  assert.equal(again, expired);
});

test("push payload — secret records produce no payload (no leak path)", () => {
  const rec = createAttention(input({ owner_copy: "Enter your 6-digit code", sensitivity: "secret" }));
  const payload = pushPayload(rec, {
    connection_display: "Example Bank",
    dashboard_origin: "https://dash.example.com/",
  });
  assert.equal(payload, null);
});

test("push payload — non-secret records produce safe payload, no metadata bleed", () => {
  const rec = createAttention(
    input({
      metadata: {
        // Secret-looking keys must be redacted defensively.
        access_token: "eyJabc.def",
        // Non-secret metadata may pass through, but isn't surfaced in payload.
        attempt: 3,
        cookie: "sessionid=xxx",
        password: "hunter2",
      },
      owner_action: "act_elsewhere",
      owner_copy: "Approve the prompt in your phone",
      progress_posture: "running",
      reason_code: "app_push_approval",
      response_contract: "none",
      sensitivity: "non_secret",
    })
  );

  assert.equal(rec.metadata.access_token, "[redacted]");
  assert.equal(rec.metadata.cookie, "[redacted]");
  assert.equal(rec.metadata.password, "[redacted]");
  assert.equal(rec.metadata.attempt, 3);

  const payload = pushPayload(rec, {
    connection_display: "Example Bank",
    dashboard_origin: "https://dash.example.com/",
  });

  assert.ok(payload);
  assert.equal(payload.title, "Approve in your other app");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(payload.body, /^Example Bank needs/);
  assert.equal(payload.url, "https://dash.example.com/attention/att_1");
  assert.equal(payload.tag, rec.dedupe_key);
  assert.equal(payload.attention_id, rec.id);
  assert.equal(payload.connection_id, "conn_a");
  assert.equal(payload.reason_code, "app_push_approval");

  // Hard guarantees on what's *not* in the payload.
  const serialized = JSON.stringify(payload);
  for (const forbidden of ["eyJabc.def", "sessionid", "hunter2", "Approve the prompt in your phone"]) {
    assert.equal(serialized.includes(forbidden), false, `payload must not contain ${forbidden}`);
  }
});

test("push payload — privacy mode hides connection name", () => {
  const rec = createAttention(
    input({
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      reason_code: "manual_action",
      response_contract: "response_required",
      sensitivity: "non_secret",
    })
  );
  const payload = pushPayload(rec, {
    connection_display: "Example Bank",
    dashboard_origin: "https://dash.example.com",
    hide_source: true,
  });
  assert.ok(payload);
  assert.equal(payload.body.includes("Example Bank"), false);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(payload.body, /^A connection needs/);
});

test("push payload — terminal records never notify", () => {
  const rec = transition(createAttention(input({ sensitivity: "non_secret" })), {
    now: NOW,
    to: "resolved",
  });
  assert.equal(pushPayload(rec, { connection_display: null, dashboard_origin: "https://x" }), null);
});

test("health relevance — blocked + response_required is health-relevant", () => {
  const rec = createAttention(input());
  assert.equal(isHealthRelevant(rec, NOW), true);
});

test("health relevance — running + act_elsewhere + no response is NOT health-relevant", () => {
  const rec = createAttention(
    input({
      owner_action: "act_elsewhere",
      progress_posture: "running",
      reason_code: "app_push_approval",
      response_contract: "none",
      sensitivity: "non_secret",
    })
  );
  assert.equal(isHealthRelevant(rec, NOW), false);
});

test("health relevance — expired and terminal records are NOT health-relevant", () => {
  const open = createAttention(input({ expires_at: "2026-05-19T12:00:01.000Z" }));
  assert.equal(isHealthRelevant(open, "2026-05-19T13:00:00.000Z"), false);

  const resolved = transition(open, { now: NOW, to: "resolved" });
  assert.equal(isHealthRelevant(resolved, NOW), false);
});

test("auto-detect — opted-in record with proceeded evidence resolves", () => {
  const rec = createAttention(
    input({
      auto_detect: true,
      owner_action: "act_elsewhere",
      progress_posture: "running",
      reason_code: "app_push_approval",
      response_contract: "none",
      sensitivity: "non_secret",
    })
  );
  const out = classifyAutoDetect({ evidence: "proceeded", now: "2026-05-19T12:05:00.000Z", record: rec });
  assert.equal(out.kind, "resolve");
  assert.equal(out.record.lifecycle, "resolved");
});

test("auto-detect — still_blocked / unknown leaves record untouched", () => {
  const rec = createAttention(
    input({
      auto_detect: true,
      sensitivity: "non_secret",
    })
  );
  assert.deepEqual(classifyAutoDetect({ evidence: "still_blocked", now: NOW, record: rec }), {
    kind: "no_change",
    reason: "still_blocked",
  });
  assert.deepEqual(classifyAutoDetect({ evidence: "unknown", now: NOW, record: rec }), {
    kind: "no_change",
    reason: "no_evidence",
  });
});

test("auto-detect — opt-out record never resolves automatically", () => {
  const rec = createAttention(input({ auto_detect: false, sensitivity: "non_secret" }));
  const out = classifyAutoDetect({ evidence: "proceeded", now: NOW, record: rec });
  assert.deepEqual(out, { kind: "no_change", reason: "auto_detect_disabled" });
});

test("auto-detect — terminal records are not re-resolved", () => {
  const rec = transition(createAttention(input({ auto_detect: true, sensitivity: "non_secret" })), {
    now: NOW,
    to: "resolved",
  });
  const out = classifyAutoDetect({ evidence: "proceeded", now: "2026-05-19T13:00:00.000Z", record: rec });
  assert.deepEqual(out, { kind: "no_change", reason: "terminal" });
});

// ─── 5.6 scenario coverage: re-consent / manual verification ───────────────

test("re-consent — non-secret blocked + provide_value emits safe push and is health-relevant", () => {
  const rec = createAttention(
    input({
      attachments: [{ kind: "url", label: "provider re-consent", ref: "opaque-1" }],
      dedupe_key: "conn_a:reconsent",
      owner_action: "operate_attachment",
      owner_copy: "Re-grant access at provider.example.com",
      progress_posture: "blocked",
      reason_code: "re_consent",
      response_contract: "response_required",
      sensitivity: "non_secret",
    })
  );
  assert.equal(isHealthRelevant(rec, NOW), true);

  const payload = pushPayload(rec, {
    connection_display: "ChatGPT",
    dashboard_origin: "https://dash.example.com",
  });
  assert.ok(payload, "re-consent must produce a payload");
  assert.equal(payload.reason_code, "re_consent");
  assert.equal(payload.url, "https://dash.example.com/attention/att_1");
  // Owner-supplied copy and opaque attachment refs must never reach a push payload.
  const serialized = JSON.stringify(payload);
  for (const forbidden of ["Re-grant access", "provider.example.com", "opaque-1"]) {
    assert.equal(serialized.includes(forbidden), false, `payload leaked ${forbidden}`);
  }
});

test("manual browser verification — operate_attachment routes by attention id, not attachment ref", () => {
  const rec = createAttention(
    input({
      attachments: [{ kind: "browser_surface", label: "live browser", ref: "wss://secret-cdp.example/abc?token=xyz" }],
      dedupe_key: "conn_a:manual_verify",
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      reason_code: "manual_verification",
      response_contract: "response_required",
      sensitivity: "non_secret",
    })
  );
  const payload = pushPayload(rec, {
    connection_display: "Example Bank",
    dashboard_origin: "https://dash.example.com",
  });
  assert.ok(payload);
  // The deep-link target is the durable attention surface, never an attachment ref.
  assert.equal(payload.url, "https://dash.example.com/attention/att_1");
  assert.equal(payload.body.includes("wss://"), false);
  assert.equal(payload.body.includes("xyz"), false);
});

test("missing local device — blocked device attention is push-eligible, health-relevant, and auto-detectable", () => {
  const rec = createAttention(
    input({
      action_target: "local_device",
      auto_detect: true,
      dedupe_key: "conn_a:missing_local_device",
      metadata: {
        device_label: "Simon laptop",
        device_token: "devtok_secret",
      },
      owner_action: "act_elsewhere",
      owner_copy: "Start the Claude collector on Simon laptop",
      progress_posture: "blocked",
      reason_code: "missing_local_device",
      response_contract: "none",
      sensitivity: "non_secret",
    })
  );

  assert.equal(rec.metadata.device_token, "[redacted]");
  assert.equal(isHealthRelevant(rec, NOW), true);

  const payload = pushPayload(rec, {
    connection_display: "Claude Code on Simon laptop",
    dashboard_origin: "https://dash.example.com",
  });
  assert.ok(payload, "missing local device should produce a non-secret owner-action push");
  assert.equal(payload.reason_code, "missing_local_device");
  assert.equal(payload.url, "https://dash.example.com/attention/att_1");
  const serialized = JSON.stringify(payload);
  for (const forbidden of ["Start the Claude collector", "devtok_secret"]) {
    assert.equal(serialized.includes(forbidden), false, `payload leaked ${forbidden}`);
  }

  const resolved = classifyAutoDetect({ evidence: "proceeded", now: "2026-05-19T12:10:00.000Z", record: rec });
  assert.equal(resolved.kind, "resolve");
  assert.equal(resolved.record.lifecycle, "resolved");
});

// ─── 5.6 scenario coverage: cancellation ───────────────────────────────────

test("cancellation — cancelled records never notify and never project to health", () => {
  const rec = createAttention(
    input({
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      reason_code: "manual_action",
      response_contract: "response_required",
      sensitivity: "non_secret",
    })
  );
  assert.equal(isHealthRelevant(rec, NOW), true);

  const cancelled = transition(rec, { now: NOW, to: "cancelled" });
  assert.equal(isHealthRelevant(cancelled, NOW), false);
  assert.equal(
    pushPayload(cancelled, { connection_display: "Example Bank", dashboard_origin: "https://dash.example.com" }),
    null
  );
  // Cancellation is terminal; you cannot re-open it.
  assert.throws(() => transition(cancelled, { now: NOW, to: "open" }));
  assert.throws(() => transition(cancelled, { now: NOW, to: "in_progress" }));
});

// ─── 5.6 scenario coverage: OTP secrecy ────────────────────────────────────

test("OTP — provider-prompt copy never reaches push, even via metadata bag", () => {
  const rec = createAttention(
    input({
      dedupe_key: "conn_a:otp",
      metadata: {
        bearer: "Bearer eyJabc",
        otp_hint: "482913",
        provider_message: "Your one-time code is 482913",
      },
      owner_action: "provide_value",
      owner_copy: "Enter the 6-digit code we just texted to +1•••5309",
      progress_posture: "blocked",
      reason_code: "otp",
      response_contract: "response_required",
      sensitivity: "secret",
    })
  );
  // Secret sensitivity must short-circuit push entirely.
  assert.equal(
    pushPayload(rec, { connection_display: "Example Bank", dashboard_origin: "https://dash.example.com" }),
    null
  );
  // Even on the durable record, secret-looking keys are redacted defensively.
  assert.equal(rec.metadata.bearer, "[redacted]");
});

// ─── 5.6 scenario coverage: app push approval (act_elsewhere) ─────────────

test("push approval — act_elsewhere is push-eligible but NOT health-relevant on its own", () => {
  const rec = createAttention(
    input({
      dedupe_key: "conn_a:app_push_approval",
      owner_action: "act_elsewhere",
      progress_posture: "running",
      reason_code: "app_push_approval",
      response_contract: "none",
      sensitivity: "non_secret",
    })
  );
  // The runtime distinguishes "owner has work elsewhere" from "the connection
  // is degraded": a running act_elsewhere prompt should ring the PWA but
  // should NOT flip the dashboard pill to needs-attention by itself.
  assert.equal(isHealthRelevant(rec, NOW), false);
  const payload = pushPayload(rec, {
    connection_display: "ChatGPT",
    dashboard_origin: "https://dash.example.com",
  });
  assert.ok(payload, "act_elsewhere should still deliver an attention push");
  assert.equal(payload.title, "Approve in your other app");
});

// ─── 5.6 scenario coverage: supersession deep-check ────────────────────────

test("supersession — superseded records suppress push and stop projecting to health", () => {
  const original = createAttention(
    input({
      owner_action: "act_elsewhere",
      progress_posture: "running",
      reason_code: "app_push_approval",
      response_contract: "none",
      sensitivity: "non_secret",
    })
  );
  const superseded = transition(original, { now: NOW, to: "superseded" });
  assert.equal(isHealthRelevant(superseded, NOW), false);
  assert.equal(
    pushPayload(superseded, {
      connection_display: "ChatGPT",
      dashboard_origin: "https://dash.example.com",
    }),
    null
  );
});

// ─── Policy guardrail: push is a channel, not state ────────────────────────

test("push channel — failed delivery does not change AttentionRecord state", () => {
  const rec = createAttention(
    input({
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      reason_code: "manual_verification",
      response_contract: "response_required",
      sensitivity: "non_secret",
    })
  );
  const beforeSnapshot = JSON.stringify(rec);
  // Simulate a delivery loop: build payload, fail, retry, fail again.
  for (let i = 0; i < 3; i += 1) {
    const payload = pushPayload(rec, {
      connection_display: "Example Bank",
      dashboard_origin: "https://dash.example.com",
    });
    assert.ok(payload);
    // Whatever the transport does, the record is frozen-shape and the runtime
    // never re-routes its lifecycle on the basis of delivery outcome.
  }
  assert.equal(JSON.stringify(rec), beforeSnapshot, "delivery attempts must not mutate the record");
  assert.equal(rec.lifecycle, "open");
  assert.equal(isHealthRelevant(rec, NOW), true);
});

test("push channel — owner missing the push still sees the same attention via durable record", () => {
  // The dashboard surface re-derives from the record; this asserts the
  // record itself carries everything the surface needs (id, connection,
  // reason, copy, attachments, lifecycle) regardless of whether any push
  // was ever attempted or delivered.
  const rec = createAttention(
    input({
      attachments: [{ kind: "browser_surface", label: "live browser", ref: "opaque-ref" }],
      owner_action: "operate_attachment",
      owner_copy: "Click Continue in the open tab",
      progress_posture: "blocked",
      reason_code: "manual_action",
      response_contract: "response_required",
      sensitivity: "non_secret",
    })
  );
  assert.equal(rec.lifecycle, "open");
  assert.equal(rec.owner_copy, "Click Continue in the open tab");
  assert.equal(rec.attachments.length, 1);
  const [firstAttachment] = rec.attachments;
  assert.ok(firstAttachment);
  assert.equal(firstAttachment.kind, "browser_surface");
  // Same record is health-relevant whether or not push fired.
  assert.equal(isHealthRelevant(rec, NOW), true);
});

// ─── Notification state ─────────────────────────────────────────────────────

test("notification state defaults to pending on create", () => {
  const rec = createAttention(input({ sensitivity: "non_secret" }));
  assert.equal(rec.notification_state, "pending");
  assert.equal(rec.notification_updated_at, null);
  assert.equal(rec.notification_reason, null);
});

test("recordNotificationOutcome records sent without touching lifecycle", () => {
  const rec = createAttention(input({ sensitivity: "non_secret" }));
  const next = recordNotificationOutcome(rec, { now: "2026-05-19T12:01:00.000Z", outcome: "sent" });
  assert.equal(next.lifecycle, "open");
  assert.equal(next.notification_state, "sent");
  assert.equal(next.notification_updated_at, "2026-05-19T12:01:00.000Z");
  assert.equal(next.notification_reason, null);
});

test("recordNotificationOutcome records failed and preserves lifecycle (no run-storm permission)", () => {
  const rec = createAttention(input({ sensitivity: "non_secret" }));
  const next = recordNotificationOutcome(rec, {
    now: "2026-05-19T12:02:00.000Z",
    outcome: "failed",
    reason: "transport: 410 gone",
  });
  assert.equal(next.lifecycle, "open", "attention remains open after delivery failure");
  assert.equal(isNotificationDeliveryFailed(next), true);
  assert.equal(next.notification_state, "failed");
  assert.equal(next.notification_reason, "transport: 410 gone");
});

test("recordNotificationOutcome accepts suppressed with reason", () => {
  const rec = createAttention(input({ sensitivity: "non_secret" }));
  const next = recordNotificationOutcome(rec, {
    now: "2026-05-19T12:03:00.000Z",
    outcome: "suppressed",
    reason: "quiet_hours",
  });
  assert.equal(next.notification_state, "suppressed");
  assert.equal(next.notification_reason, "quiet_hours");
});

test("recordNotificationOutcome rejects invalid outcomes", () => {
  const rec = createAttention(input({ sensitivity: "non_secret" }));
  assert.throws(() =>
    recordNotificationOutcome(rec, {
      now: NOW,
      // @ts-expect-error — the test's purpose is to prove the runtime rejects
      // an outcome outside the closed NotificationState enum even though the
      // type system already forbids it at the call site.
      outcome: "maybe",
    })
  );
});

test("lifecycle transition to acknowledged promotes notification state to acknowledged", () => {
  const rec = createAttention(input({ sensitivity: "non_secret" }));
  assert.equal(rec.notification_state, "pending");
  const acked = transition(rec, { now: "2026-05-19T12:04:00.000Z", to: "acknowledged" });
  assert.equal(acked.notification_state, "acknowledged");
  assert.equal(acked.notification_reason, "owner_acknowledged");
});

test("lifecycle transition to resolved does NOT touch notification state", () => {
  const rec = createAttention(input({ sensitivity: "non_secret" }));
  const withDelivery = recordNotificationOutcome(rec, {
    now: "2026-05-19T12:05:00.000Z",
    outcome: "sent",
  });
  const resolved = transition(withDelivery, { now: "2026-05-19T12:06:00.000Z", to: "resolved" });
  assert.equal(resolved.notification_state, "sent", "sent state survives resolution for audit");
});
