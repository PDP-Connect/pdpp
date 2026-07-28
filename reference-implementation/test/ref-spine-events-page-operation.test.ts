// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `ref.spine.events.page`.
 *
 * Pins:
 *   - the per-kind envelope `object` discriminator
 *     (`trace` / `grant_timeline` / `run_timeline`);
 *   - the identifying `*_id` key per kind;
 *   - the derived `trace_id` from the first event (or null);
 *   - the `event_count` and pagination fields;
 *   - the live-bearer redaction (token_id stripped, object_id literal
 *     replaced for token / pending_consent / owner_device_auth, and
 *     device_code / user_code / request_uri redacted inside `data`).
 *
 * The runtime end-to-end redaction guarantee is independently enforced
 * by `security-auth-surfaces.test.js` against the mounted route.
 *
 * Spec: openspec/changes/mount-ref-spine-operations
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { RefSpineEventInput } from "../operations/ref-spine-events-page/index.ts";
import { executeRefSpineEventsPage, redactSpineEventForPublic } from "../operations/ref-spine-events-page/index.ts";

function makeEvent(overrides: Partial<RefSpineEventInput> = {}): RefSpineEventInput {
  return {
    actor_id: "pdpp_reference",
    actor_type: "system",
    client_id: null,
    data: {},
    event_id: "evt_1",
    event_type: "test.event",
    grant_id: null,
    interaction_id: null,
    object_id: "obj_1",
    object_type: "event",
    occurred_at: "2026-04-01T00:00:00Z",
    provider_id: null,
    recorded_at: "2026-04-01T00:00:00Z",
    request_id: null,
    run_id: null,
    status: "succeeded",
    stream_id: null,
    token_id: null,
    trace_id: "trc_1",
    version: "1",
    ...overrides,
  };
}

/**
 * Narrow an `unknown` `data` value (the envelope event's `data` field, or
 * `RefSpineEventInput['data']`) to a plain object for property assertions,
 * without casting. Mirrors the runtime guard the operation itself uses
 * before treating `data` as a redactable map.
 */
function isDataRecord(data: unknown): data is Record<string, unknown> {
  return Boolean(data) && typeof data === "object" && !Array.isArray(data);
}

test("ref.spine.events.page emits trace envelope with trace_id key", () => {
  const envelope = executeRefSpineEventsPage({
    cursor: null,
    id: "trc_42",
    kind: "trace",
    page: {
      events: [makeEvent({ trace_id: "trc_42" })],
      limit: 100,
      next_cursor: null,
      truncated: false,
    },
  });
  assert.equal(envelope.object, "trace");
  assert.equal(envelope.trace_id, "trc_42");
  assert.equal(envelope.event_count, 1);
  assert.equal(envelope.limit, 100);
  assert.equal(envelope.truncated, false);
  assert.equal(envelope.next_cursor, null);
  // identifying key matches the kind
  assert.equal(envelope.trace_id, "trc_42");
});

test("ref.spine.events.page emits grant_timeline envelope with grant_id key", () => {
  const envelope = executeRefSpineEventsPage({
    cursor: null,
    id: "grt_42",
    kind: "grant",
    page: { events: [], limit: 50, next_cursor: null, truncated: false },
  });
  assert.equal(envelope.object, "grant_timeline");
  assert.equal(envelope.grant_id, "grt_42");
  assert.equal(envelope.event_count, 0);
  assert.equal(envelope.trace_id, null);
});

test("ref.spine.events.page emits run_timeline envelope with run_id key", () => {
  const envelope = executeRefSpineEventsPage({
    cursor: "cursor_x",
    id: "run_42",
    kind: "run",
    page: {
      events: [makeEvent({ trace_id: "trc_q" })],
      limit: 25,
      next_cursor: "next_cursor_y",
      truncated: true,
    },
  });
  assert.equal(envelope.object, "run_timeline");
  assert.equal(envelope.run_id, "run_42");
  assert.equal(envelope.trace_id, "trc_q");
  assert.equal(envelope.truncated, true);
  assert.equal(envelope.next_cursor, "next_cursor_y");
});

test("ref.spine.events.page strips token_id from every event", () => {
  const envelope = executeRefSpineEventsPage({
    cursor: null,
    id: "t",
    kind: "trace",
    page: {
      events: [makeEvent({ token_id: "opaque-bearer-1234" })],
      limit: 1,
      next_cursor: null,
      truncated: false,
    },
  });
  const [firstEvent] = envelope.data;
  assert.ok(firstEvent);
  assert.equal("token_id" in firstEvent, false);
});

test("ref.spine.events.page replaces token object_id literal", () => {
  const envelope = executeRefSpineEventsPage({
    cursor: null,
    id: "t",
    kind: "trace",
    page: {
      events: [
        makeEvent({
          object_id: "tok_live_bearer_value",
          object_type: "token",
        }),
      ],
      limit: 1,
      next_cursor: null,
      truncated: false,
    },
  });
  const [firstEvent] = envelope.data;
  assert.ok(firstEvent);
  assert.equal(firstEvent.object_id, "<redacted-token-id>");
});

test("ref.spine.events.page replaces pending_consent and owner_device_auth object_id literals", () => {
  const envelope = executeRefSpineEventsPage({
    cursor: null,
    id: "t",
    kind: "trace",
    page: {
      events: [
        makeEvent({ object_id: "device_code_xyz", object_type: "pending_consent" }),
        makeEvent({ object_id: "device_code_abc", object_type: "owner_device_auth" }),
      ],
      limit: 2,
      next_cursor: null,
      truncated: false,
    },
  });
  const [firstEvent, secondEvent] = envelope.data;
  assert.ok(firstEvent);
  assert.ok(secondEvent);
  assert.equal(firstEvent.object_id, "<redacted-device-code>");
  assert.equal(secondEvent.object_id, "<redacted-device-code>");
});

test("ref.spine.events.page redacts device_code / user_code / request_uri inside event data", () => {
  const envelope = executeRefSpineEventsPage({
    cursor: null,
    id: "t",
    kind: "trace",
    page: {
      events: [
        makeEvent({
          data: {
            device_code: "dc_secret",
            other: "kept",
            request_uri: "urn:ietf:params:oauth:request_uri:dc_secret",
            user_code: "WDJB-MJHT",
          },
        }),
      ],
      limit: 1,
      next_cursor: null,
      truncated: false,
    },
  });
  const [firstEvent] = envelope.data;
  assert.ok(firstEvent);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const data = firstEvent.data;
  assert.ok(isDataRecord(data));
  assert.equal(data.device_code, "<redacted-bearer>");
  assert.equal(data.user_code, "<redacted-bearer>");
  assert.equal(data.request_uri, "<redacted-bearer>");
  assert.equal(data.other, "kept");
});

test("ref.spine.events.page does not mutate the input event when redacting data keys", () => {
  const original = makeEvent({
    data: { other: "kept", user_code: "WDJB-MJHT" },
  });
  const before = JSON.stringify(original.data);
  executeRefSpineEventsPage({
    cursor: null,
    id: "t",
    kind: "trace",
    page: { events: [original], limit: 1, next_cursor: null, truncated: false },
  });
  assert.equal(JSON.stringify(original.data), before);
});

test("ref.spine.events.page leaves non-bearer events untouched", () => {
  const envelope = executeRefSpineEventsPage({
    cursor: null,
    id: "t",
    kind: "trace",
    page: {
      events: [makeEvent({ object_id: "plain", object_type: "event" })],
      limit: 1,
      next_cursor: null,
      truncated: false,
    },
  });
  const [firstEvent] = envelope.data;
  assert.ok(firstEvent);
  assert.equal(firstEvent.object_id, "plain");
});

test("ref.spine.events.page threads terminal_status onto the run envelope", () => {
  const envelope = executeRefSpineEventsPage({
    cursor: null,
    id: "run_term",
    kind: "run",
    page: { events: [makeEvent({ run_id: "run_term" })], limit: 10, next_cursor: null, truncated: false },
    terminalStatus: "cancelled",
  });
  assert.equal(envelope.object, "run_timeline");
  assert.equal(envelope.terminal_status, "cancelled");
});

test("ref.spine.events.page run envelope reports terminal_status null when none supplied", () => {
  const envelope = executeRefSpineEventsPage({
    cursor: null,
    id: "run_active",
    kind: "run",
    page: { events: [makeEvent({ run_id: "run_active" })], limit: 10, next_cursor: null, truncated: false },
  });
  assert.equal(envelope.terminal_status, null);
});

test("ref.spine.events.page terminal_status is window-independent of the page contents", () => {
  // The terminal class is whatever the host resolved, regardless of whether
  // the page window contains the terminal event. Here the page carries only
  // non-terminal events yet the envelope reports the run as completed.
  const envelope = executeRefSpineEventsPage({
    cursor: "page_2_cursor",
    id: "run_long",
    kind: "run",
    page: {
      events: [makeEvent({ event_type: "run.detail_gap_recorded", run_id: "run_long" })],
      limit: 1,
      next_cursor: "next",
      truncated: true,
    },
    terminalStatus: "completed",
  });
  assert.equal(envelope.terminal_status, "completed");
});

test("ref.spine.events.page forces terminal_status null for trace/grant kinds", () => {
  const traceEnvelope = executeRefSpineEventsPage({
    cursor: null,
    id: "trc_1",
    kind: "trace",
    page: { events: [makeEvent()], limit: 10, next_cursor: null, truncated: false },
    // A host MUST NOT supply this for non-run kinds; even if it leaks in, the
    // operation forces null (terminal status is a run concept).
    terminalStatus: "failed",
  });
  assert.equal(traceEnvelope.terminal_status, null);

  const grantEnvelope = executeRefSpineEventsPage({
    cursor: null,
    id: "grt_1",
    kind: "grant",
    page: { events: [], limit: 10, next_cursor: null, truncated: false },
  });
  assert.equal(grantEnvelope.terminal_status, null);
});

test("redactSpineEventForPublic is independently testable", () => {
  const redacted = redactSpineEventForPublic({
    data: { user_code: "X" },
    object_id: "live_bearer",
    object_type: "token",
    token_id: "live_bearer",
    trace_id: "t1",
  });
  assert.equal("token_id" in redacted, false);
  assert.equal(redacted.object_id, "<redacted-token-id>");
  assert.ok(isDataRecord(redacted.data));
  assert.equal(redacted.data.user_code, "<redacted-bearer>");
});
