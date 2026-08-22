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
import { archiveRenderedVerdict } from "../server/ref-control.ts";

const RECONNECT_RE = /reconnect/i;

// A verdict that reads healthy AND actionable — the shape whose survival into
// an archived row would be the fabricated-green defect.
function livingVerdict(): RenderedVerdict {
  return {
    annotations: [],
    channel: "attention",
    detail: {},
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
    trace: {},
  } as unknown as RenderedVerdict;
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
