// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side archived-verdict override.
 *
 * An archived source is terminal: records preserved, collection finished,
 * nothing will resume. Its underlying instance is usually `paused`, so the
 * verdict built from its stored evidence still reads like a live-but-stopped
 * connection and still carries "Reconnect this account and collection
 * resumes" — a promise that leads nowhere.
 *
 * These tests pin the two properties that keep that honest, and they pin them
 * against a verdict that WOULD otherwise lie: the fixture deliberately carries
 * a green pill and a real owner action, so an assertion cannot pass vacuously.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { RenderedVerdict } from "../runtime/rendered-verdict.ts";
import {
  archiveRenderedVerdict,
  type ConnectorInstanceRow,
  type ConnectorRunSummary,
  deriveSetupFailedReason,
} from "../server/ref-control.ts";

const RECONNECT_RE = /reconnect/i;
const EXPIRED_WHILE_WAITING_RE = /expired while waiting for you to finish signing in/i;
const NOT_EXPIRED_WHILE_WAITING_RE = /expired while waiting for you/i;
const RESTARTED_ADDENDUM_RE = /we restarted our system while you were signing in/i;
const OWNER_BLAME_RE = /you (did not|didn't|failed to)/i;

// A verdict that reads healthy AND actionable — the shape whose survival into
// an archived row would be the fabricated-green defect.
//
// The green-pill/attention-channel pairing here is DELIBERATELY incoherent: the
// real synthesizer always pairs green with `calm`, and the point of this fixture
// is to construct a verdict that would otherwise lie, so the archival override
// cannot pass vacuously. What is not deliberate is shape drift — hence no
// `as unknown as`. The compiler must still see every field of `RenderedVerdict`,
// so a field the synthesizer later adds (say a `progress` resumption promise
// that archival would spread through untouched) shows up here as a build error
// rather than a silently unstripped promise on a dead source.
function livingVerdict(): RenderedVerdict {
  return {
    annotations: [],
    channel: "attention",
    detail: {
      collection_rate: null,
      conditions: [],
      detail_gap_backlog: null,
      dominant_condition_id: null,
      forward_disposition: "complete",
      next_attempt_at: null,
      reason_code: null,
      state: "healthy",
      suppressed: [],
    },
    forward_statement: "Reconnect this account and collection resumes.",
    pill: { label: "Healthy", tone: "green" },
    progress: {
      gaps_drained_last_run: null,
      headline: "Collecting on schedule.",
      last_refreshed_at: null,
      mode: "scheduled",
      records_committed_last_run: null,
      retained_records: 98_510,
    },
    required_actions: [
      {
        affects: [],
        audience: "owner",
        cta: "Reconnect this account",
        kind: "reauth",
        satisfied_when: { kind: "credential_present_and_unrejected" },
        terminal: false,
        urgency: "soon",
      },
    ],
    streams: [],
    trace: {
      channel_cause: "attention_open",
      detail_destinations: [],
      primary_action_kind: "reauth",
      runtime_capped: false,
      satisfied_when: { kind: "credential_present_and_unrejected" },
      suppressed_evidence: [],
      tone_cause: "green",
      tone_inputs: [{ axis: "state", tone: "green" }],
    },
  };
}

test("an archived source never reports a healthy pill", () => {
  const archived = archiveRenderedVerdict(livingVerdict(), "archived");

  assert.equal(archived.pill.label, "Archived", "the label must state the terminal fact");
  assert.notEqual(archived.pill.tone, "green", "a green tone would say a dead source is healthy");
  assert.equal(archived.channel, "calm", "an archived source never demands owner attention");
});

test("an archived source offers no action — the Reconnect promise is removed, not reworded", () => {
  const before = livingVerdict();
  assert.equal(before.required_actions.length, 1, "control: the source verdict really does carry an action");

  const archived = archiveRenderedVerdict(before, "archived");

  assert.deepEqual(archived.required_actions, [], "no action can resume an archived source");
  assert.doesNotMatch(
    archived.forward_statement,
    RECONNECT_RE,
    "the forward statement must not promise that reconnecting resumes collection"
  );
});

test("an archived source still reports its retained records", () => {
  // Honesty runs both ways: the records are real and the owner must see them.
  const archived = archiveRenderedVerdict(livingVerdict(), "archived");
  assert.equal(archived.progress.retained_records, 98_510, "the preserved record count must survive archival");
});

test("an active source is returned untouched", () => {
  const active = livingVerdict();
  const result = archiveRenderedVerdict(active, "active");

  assert.equal(result, active, "a live source's verdict must pass through by identity, not be rebuilt");
  assert.equal(result.pill.label, "Healthy");
  assert.equal(result.required_actions.length, 1, "a live source keeps its actionable Reconnect prompt");
});

test("a setup-failed source never reports a healthy pill", () => {
  // A revoked browser-enrollment shell's BUILT verdict describes health
  // evidence for a dead popup, not a connection the owner ever had running —
  // the fixture still carries a green pill so the assertion cannot pass
  // vacuously.
  const setupFailed = archiveRenderedVerdict(livingVerdict(), "setup_failed");

  assert.equal(setupFailed.pill.label, "Setup never completed", "the label must state the terminal fact");
  assert.notEqual(setupFailed.pill.tone, "green", "a green tone would say a never-connected source is healthy");
  assert.equal(setupFailed.channel, "calm", "a setup-failed source never demands owner attention");
});

test("a setup-failed source offers no action — there is nothing to reconnect, only a fresh attempt to make", () => {
  const before = livingVerdict();
  assert.equal(before.required_actions.length, 1, "control: the source verdict really does carry an action");

  const setupFailed = archiveRenderedVerdict(before, "setup_failed");

  assert.deepEqual(setupFailed.required_actions, [], "no action on this row can make a failed setup resume");
  assert.doesNotMatch(
    setupFailed.forward_statement,
    RECONNECT_RE,
    "the forward statement must not promise that reconnecting resumes collection"
  );
});

test("a setup-failed source is distinct from archived — both terminal, different honest labels", () => {
  const archived = archiveRenderedVerdict(livingVerdict(), "archived");
  const setupFailed = archiveRenderedVerdict(livingVerdict(), "setup_failed");

  assert.notEqual(
    archived.pill.label,
    setupFailed.pill.label,
    "archived means records were once collected; setup-failed means none ever were — the labels must not collapse into one"
  );
});

// Quiet-expiry defect fix (owner ruling 2026-08-22): a setup that expired
// while the owner was mid-signin must never render as an anonymous, generic
// "Setup never completed" indistinguishable from the owner simply walking
// away. These tests pin the TTL-specific copy against the SAME
// green/actionable fixture as the tests above, so nothing here can pass
// vacuously either.

test("a TTL-expired setup-failed source states plainly that it expired while waiting for the owner", () => {
  const ttlExpired = archiveRenderedVerdict(livingVerdict(), "setup_failed", {
    cause: "ttl_expired",
    interruptedByRestart: false,
  });

  assert.equal(ttlExpired.pill.label, "Expired while waiting for you");
  assert.match(ttlExpired.forward_statement, EXPIRED_WHILE_WAITING_RE);
  assert.equal(ttlExpired.channel, "calm");
  assert.deepEqual(ttlExpired.required_actions, [], "the honest next step is a fresh attempt, not an action here");
});

test("an owner-abandoned setup-failed source keeps the original generic copy, not the TTL-specific sentence", () => {
  const abandoned = archiveRenderedVerdict(livingVerdict(), "setup_failed", {
    cause: "owner_abandoned",
    interruptedByRestart: false,
  });

  assert.equal(abandoned.pill.label, "Setup never completed");
  assert.doesNotMatch(
    abandoned.forward_statement,
    NOT_EXPIRED_WHILE_WAITING_RE,
    "an explicit owner dismissal must not be reworded as a TTL expiry"
  );
});

test("an 'unknown' cause (pre-existing revoked row with no recorded reason) falls back to the original generic copy", () => {
  const unknown = archiveRenderedVerdict(livingVerdict(), "setup_failed", {
    cause: "unknown",
    interruptedByRestart: false,
  });

  assert.equal(
    unknown.pill.label,
    "Setup never completed",
    "an unrecorded cause must fall back to the pre-existing honest label, never guess TTL-expired"
  );
});

test("a null reason (legacy call site) behaves exactly like the pre-fix generic setup_failed copy", () => {
  const legacy = archiveRenderedVerdict(livingVerdict(), "setup_failed");
  assert.equal(legacy.pill.label, "Setup never completed");
  assert.equal(legacy.forward_statement, "Setup never finished for this source. No records were collected.");
});

test("a self-inflicted-restart addendum is appended without being mistaken for owner or provider failure", () => {
  const interrupted = archiveRenderedVerdict(livingVerdict(), "setup_failed", {
    cause: "ttl_expired",
    interruptedByRestart: true,
  });

  assert.match(
    interrupted.forward_statement,
    RESTARTED_ADDENDUM_RE,
    "the restart must be named as OUR action, not folded into silence"
  );
  assert.doesNotMatch(
    interrupted.forward_statement,
    OWNER_BLAME_RE,
    "the addendum must not imply the owner did anything wrong"
  );
});

test("the restart addendum is independent of cause — it can accompany owner_abandoned too", () => {
  const interrupted = archiveRenderedVerdict(livingVerdict(), "setup_failed", {
    cause: "owner_abandoned",
    interruptedByRestart: true,
  });

  assert.match(interrupted.forward_statement, RESTARTED_ADDENDUM_RE);
});

// deriveSetupFailedReason: the server-side reader that trusts the WRITER's
// recorded `revocation_reason` rather than reverse-guessing it. Fixtures
// mirror `connector-instance-store.ts`'s row shape after
// `NEVER_SUCCEEDED_SETUP_SHELL_ESCAPE_*` — every row this function sees is
// already guaranteed revoked + a retired-setup-shell binding kind.

function revokedShellInstance(bindingOverrides: Record<string, unknown> = {}): ConnectorInstanceRow {
  return {
    connectorId: "venmo",
    connectorInstanceId: "cin_test",
    displayName: "Venmo",
    ownerSubjectId: "owner_1",
    revokedAt: "2026-08-21T15:42:00.000Z",
    sourceBinding: {
      connector_id: "venmo",
      enrollment_expires_at: "2026-08-21T15:42:00.000Z",
      kind: "browser_enrollment_shell",
      ...bindingOverrides,
    },
    sourceKind: "browser_collector",
    status: "revoked",
  };
}

function runSummary(overrides: Partial<ConnectorRunSummary> = {}): ConnectorRunSummary {
  return {
    collection_facts: null,
    event_count: 0,
    failure_reason: null,
    finished_at: "2026-08-21T15:42:00.000Z",
    first_at: "2026-08-21T15:41:00.000Z",
    known_gaps: [],
    last_at: "2026-08-21T15:42:00.000Z",
    recovery_only: false,
    run_id: "run_test",
    started_at: "2026-08-21T15:41:00.000Z",
    status: "failed",
    terminal_reason: null,
    ...overrides,
  };
}

test("deriveSetupFailedReason reads the recorded ttl_expired reason rather than guessing it", () => {
  const instance = revokedShellInstance({ revocation_reason: "ttl_expired" });
  const reason = deriveSetupFailedReason(instance, null);

  assert.deepEqual(reason, { cause: "ttl_expired", interruptedByRestart: false });
});

test("deriveSetupFailedReason reads the recorded owner_abandoned reason", () => {
  const instance = revokedShellInstance({ revocation_reason: "owner_abandoned" });
  const reason = deriveSetupFailedReason(instance, null);

  assert.deepEqual(reason, { cause: "owner_abandoned", interruptedByRestart: false });
});

test("deriveSetupFailedReason falls back to 'unknown' for a pre-existing row with no recorded reason — never guesses", () => {
  const instance = revokedShellInstance();
  const reason = deriveSetupFailedReason(instance, null);

  assert.deepEqual(
    reason,
    { cause: "unknown", interruptedByRestart: false },
    "absent revocation_reason must read as unknown, not be reverse-derived from revoked_at timing"
  );
});

test("deriveSetupFailedReason ignores an unrecognized revocation_reason value — treats it as unknown, not a crash", () => {
  const instance = revokedShellInstance({ revocation_reason: "some_future_reason_this_code_predates" });
  const reason = deriveSetupFailedReason(instance, null);

  assert.equal(reason?.cause, "unknown");
});

test("deriveSetupFailedReason returns null for a non-setup-shell revoked row (ordinary revocation)", () => {
  const instance: ConnectorInstanceRow = {
    ...revokedShellInstance(),
    sourceBinding: { kind: "browser_collector" },
  };
  assert.equal(deriveSetupFailedReason(instance, null), null);
});

test("deriveSetupFailedReason returns null for an active (non-revoked) instance", () => {
  const instance: ConnectorInstanceRow = { ...revokedShellInstance(), status: "active" };
  assert.equal(deriveSetupFailedReason(instance, null), null);
});

test("deriveSetupFailedReason detects the self-inflicted restart via the run's terminal_reason", () => {
  const instance = revokedShellInstance({ revocation_reason: "ttl_expired" });
  const lastRun = runSummary({ terminal_reason: "controller_terminated_while_awaiting_owner_interaction" });

  const reason = deriveSetupFailedReason(instance, lastRun);
  assert.deepEqual(reason, { cause: "ttl_expired", interruptedByRestart: true });
});

test("deriveSetupFailedReason does not flag an ordinary connector failure as a self-inflicted restart", () => {
  const instance = revokedShellInstance({ revocation_reason: "ttl_expired" });
  const lastRun = runSummary({ terminal_reason: "connector_reported_failed" });

  const reason = deriveSetupFailedReason(instance, lastRun);
  assert.deepEqual(
    reason,
    { cause: "ttl_expired", interruptedByRestart: false },
    "a genuine connector failure must never be mislabeled as our own restart"
  );
});

test("deriveSetupFailedReason treats a null lastRun as never interrupted by our restart", () => {
  const instance = revokedShellInstance({ revocation_reason: "ttl_expired" });
  const reason = deriveSetupFailedReason(instance, null);
  assert.equal(reason?.interruptedByRestart, false);
});
