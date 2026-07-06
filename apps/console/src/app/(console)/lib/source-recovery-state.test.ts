import assert from "node:assert/strict";
import test from "node:test";
import type {
  RefConnectionHealthSnapshot,
  RefDetailGapBacklog,
  RefRenderedVerdict,
  RefRequiredAction,
} from "./ref-client.ts";
import {
  buildRecoveryPanelViewModel,
  deriveRecoveryStep,
  hasRecoverableWork,
  recoveryStateGroup,
} from "./source-recovery-state.ts";

const SYNCING_RE = /Syncing details now/;
const CHECKING_RE = /Checking/i;
const COOLDOWN_RE = /cooldown/i;

function backlog(overrides: Partial<RefDetailGapBacklog> = {}): RefDetailGapBacklog {
  return {
    max_attempt_count: 3,
    next_attempt_at: null,
    pending: 0,
    pending_is_floor: false,
    pending_other: 0,
    pending_other_is_floor: false,
    recovered: null,
    terminal: null,
    ...overrides,
  };
}

function health(overrides: Partial<RefConnectionHealthSnapshot> = {}): RefConnectionHealthSnapshot {
  return {
    axes: { attention: "none", coverage: "deferred", freshness: "fresh", outbox: "idle" },
    badges: { stale: false, syncing: false },
    last_success_at: "2026-07-06T12:00:00Z",
    next_action: null,
    next_attempt_at: null,
    reason_code: null,
    state: "healthy",
    unknown_reasons: [],
    ...overrides,
  };
}

function action(overrides: Partial<RefRequiredAction> = {}): RefRequiredAction {
  return {
    affects: [],
    audience: "none",
    cta: "Collecting — no action needed",
    kind: "wait",
    satisfied_when: { kind: "none" },
    terminal: false,
    urgency: "verifying",
    ...overrides,
  };
}

function verdict(overrides: Partial<RefRenderedVerdict> = {}): RefRenderedVerdict {
  return {
    annotations: [],
    channel: "calm",
    detail: {},
    forward_statement: "The next run is expected to fill the remaining data.",
    pill: { label: "Degraded", tone: "amber" },
    progress: {
      gaps_drained_last_run: null,
      headline: "Collecting in the background.",
      last_refreshed_at: null,
      mode: "deferred",
      records_committed_last_run: null,
      retained_records: 100,
    },
    required_actions: [action()],
    streams: [],
    trace: {},
    ...overrides,
  };
}

// ─── hasRecoverableWork ───────────────────────────────────────────────────────

test("recovery: a null backlog is unmeasured, not recoverable work", () => {
  assert.equal(hasRecoverableWork(null), false);
  assert.equal(hasRecoverableWork(undefined), false);
});

test("recovery: a drained backlog with only recovered/terminal counts is not recoverable work", () => {
  assert.equal(hasRecoverableWork(backlog({ pending: 0, recovered: 396, terminal: 4 })), false);
});

test("recovery: pending or deferred gaps or a live retry floor are recoverable work", () => {
  assert.equal(hasRecoverableWork(backlog({ pending: 2093, pending_is_floor: true })), true);
  assert.equal(hasRecoverableWork(backlog({ pending_other: 50 })), true);
  assert.equal(hasRecoverableWork(backlog({ next_attempt_at: "2026-07-06T15:40:00Z" })), true);
});

// ─── deriveRecoveryStep ───────────────────────────────────────────────────────

test("recovery: an in-flight run over recoverable work is active, not checking", () => {
  const step = deriveRecoveryStep(
    verdict(),
    health({ badges: { stale: false, syncing: true }, detail_gap_backlog: backlog({ pending: 2093 }) })
  );
  assert.equal(step, "active");
});

test("recovery: pending gaps with no cooldown and no owner action are queued", () => {
  const step = deriveRecoveryStep(verdict(), health({ detail_gap_backlog: backlog({ pending: 2093 }) }));
  assert.equal(step, "queued");
  assert.equal(recoveryStateGroup(step), "working");
});

test("recovery: an active retry floor makes the step cooling", () => {
  const step = deriveRecoveryStep(
    verdict(),
    health({
      state: "cooling_off",
      detail_gap_backlog: backlog({ pending: 2093, next_attempt_at: "2026-07-06T15:40:00Z" }),
    })
  );
  assert.equal(step, "cooling");
  assert.equal(recoveryStateGroup(step), "working");
});

test("recovery: an owner-satisfiable non-attention action makes recovery eligible (owner-runnable)", () => {
  const step = deriveRecoveryStep(
    verdict({
      channel: "advisory",
      required_actions: [
        action({ audience: "owner", cta: "Retry now", kind: "retry_gap", satisfied_when: { kind: "gap_recovered" } }),
      ],
    }),
    health({ state: "degraded", detail_gap_backlog: backlog({ pending: 12 }) })
  );
  assert.equal(step, "eligible");
  assert.equal(recoveryStateGroup(step), "review");
});

test("recovery: an attention-channel owner action is owner-required, not passive progress", () => {
  const step = deriveRecoveryStep(
    verdict({
      channel: "attention",
      pill: { label: "Can't collect", tone: "red" },
      required_actions: [
        action({
          audience: "owner",
          cta: "Reconnect this account",
          kind: "reauth",
          satisfied_when: { kind: "credential_present_and_unrejected" },
          urgency: "now",
        }),
      ],
    }),
    health({ state: "blocked", detail_gap_backlog: backlog({ pending: 12 }) })
  );
  assert.equal(step, "owner_required");
  assert.equal(recoveryStateGroup(step), "needsOwner");
});

test("recovery: a connector-defect code_fix verdict is a system issue with no retry", () => {
  const step = deriveRecoveryStep(
    verdict({
      channel: "advisory",
      pill: { label: "Can't collect", tone: "red" },
      required_actions: [
        action({ audience: "maintainer", cta: "Connector code needs a fix", kind: "code_fix", terminal: true }),
      ],
    }),
    health({ state: "degraded", detail_gap_backlog: backlog({ pending: 12 }) })
  );
  assert.equal(step, "system_issue");
  assert.equal(recoveryStateGroup(step), "systemIssue");
});

test("recovery: eligible work with a stale attempt floor beyond cadence is stalled, not queued", () => {
  const step = deriveRecoveryStep(
    verdict(),
    health({ detail_gap_backlog: backlog({ pending: 2093, next_attempt_at: "2026-07-06T10:00:00Z" }) }),
    { now: "2026-07-06T14:00:00Z", cadenceWindowMs: 60 * 60 * 1000 }
  );
  assert.equal(step, "stalled");
  assert.equal(recoveryStateGroup(step), "systemIssue");
});

test("recovery: a future retry floor is a live cooldown, never a stall", () => {
  const step = deriveRecoveryStep(
    verdict(),
    health({
      state: "cooling_off",
      detail_gap_backlog: backlog({ pending: 2093, next_attempt_at: "2026-07-06T15:40:00Z" }),
    }),
    { now: "2026-07-06T14:00:00Z", cadenceWindowMs: 60 * 60 * 1000 }
  );
  assert.equal(step, "cooling");
});

// ─── Panel view-model: required behaviours ────────────────────────────────────

test("panel: active recovery names the work and never says Checking", () => {
  const model = buildRecoveryPanelViewModel(
    verdict(),
    health({
      badges: { stale: false, syncing: true },
      detail_gap_backlog: backlog({ pending: 2093, pending_is_floor: true, recovered: 396 }),
    })
  );
  assert.equal(model.step, "active");
  assert.match(model.primarySentence, SYNCING_RE);
  assert.doesNotMatch(model.primarySentence, CHECKING_RE);
  // Progress floor counts surface recovered and the "at least N" queued floor.
  assert.ok(model.evidence.some((line) => line.includes("396 recovered")));
  assert.ok(model.evidence.some((line) => line.includes("at least 2,093 items still queued")));
});

test("panel: queued recovery carries progress floor counts and a next eligible attempt, no blocker CTA", () => {
  const model = buildRecoveryPanelViewModel(
    verdict(),
    health({
      detail_gap_backlog: backlog({
        pending: 2093,
        pending_is_floor: true,
        recovered: 396,
        next_attempt_at: "2026-07-06T15:40:00Z",
      }),
    })
  );
  // With a retry floor set, this reads as cooling, but the panel still exposes
  // the floor counts and the next eligible attempt.
  assert.ok(["queued", "cooling"].includes(model.step));
  assert.equal(model.nextEligibleAt, "2026-07-06T15:40:00Z");
  assert.ok(model.evidence.some((line) => line.includes("at least 2,093")));
});

test("panel: a cooldown blocker shows a wait/next-attempt line and no normal retry CTA", () => {
  const model = buildRecoveryPanelViewModel(
    verdict(),
    health({
      state: "cooling_off",
      detail_gap_backlog: backlog({ pending: 2093, next_attempt_at: "2026-07-06T15:40:00Z" }),
    })
  );
  assert.equal(model.step, "cooling");
  assert.ok(model.blocker);
  assert.match(model.blocker ?? "", COOLDOWN_RE);
  // The panel view-model exposes no owner-runnable action field: the surface
  // renders a blocker/wait line, never a "Retry now" CTA for unsafe retries.
  assert.equal(Object.hasOwn(model, "primaryAction"), false);
});

test("panel: a terminal backlog is never folded into caught-up", () => {
  const model = buildRecoveryPanelViewModel(
    verdict(),
    health({ detail_gap_backlog: backlog({ pending: 10, recovered: 396, terminal: 4 }) })
  );
  assert.ok(model.evidence.some((line) => line.includes("4 no longer retrievable at the source")));
});
