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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeRefSpineEventsPage,
  redactSpineEventForPublic,
} from '../operations/ref-spine-events-page/index.ts';

function makeEvent(overrides = {}) {
  return {
    event_id: 'evt_1',
    event_type: 'test.event',
    occurred_at: '2026-04-01T00:00:00Z',
    recorded_at: '2026-04-01T00:00:00Z',
    actor_type: 'system',
    actor_id: 'pdpp_reference',
    object_type: 'event',
    object_id: 'obj_1',
    status: 'succeeded',
    trace_id: 'trc_1',
    request_id: null,
    grant_id: null,
    run_id: null,
    provider_id: null,
    client_id: null,
    stream_id: null,
    token_id: null,
    interaction_id: null,
    data: {},
    version: '1',
    ...overrides,
  };
}

test('ref.spine.events.page emits trace envelope with trace_id key', () => {
  const envelope = executeRefSpineEventsPage({
    kind: 'trace',
    id: 'trc_42',
    cursor: null,
    page: {
      events: [makeEvent({ trace_id: 'trc_42' })],
      truncated: false,
      next_cursor: null,
      limit: 100,
    },
  });
  assert.equal(envelope.object, 'trace');
  assert.equal(envelope.trace_id, 'trc_42');
  assert.equal(envelope.event_count, 1);
  assert.equal(envelope.limit, 100);
  assert.equal(envelope.truncated, false);
  assert.equal(envelope.next_cursor, null);
  // identifying key matches the kind
  assert.equal(envelope.trace_id, 'trc_42');
});

test('ref.spine.events.page emits grant_timeline envelope with grant_id key', () => {
  const envelope = executeRefSpineEventsPage({
    kind: 'grant',
    id: 'grt_42',
    cursor: null,
    page: { events: [], truncated: false, next_cursor: null, limit: 50 },
  });
  assert.equal(envelope.object, 'grant_timeline');
  assert.equal(envelope.grant_id, 'grt_42');
  assert.equal(envelope.event_count, 0);
  assert.equal(envelope.trace_id, null);
});

test('ref.spine.events.page emits run_timeline envelope with run_id key', () => {
  const envelope = executeRefSpineEventsPage({
    kind: 'run',
    id: 'run_42',
    cursor: 'cursor_x',
    page: {
      events: [makeEvent({ trace_id: 'trc_q' })],
      truncated: true,
      next_cursor: 'next_cursor_y',
      limit: 25,
    },
  });
  assert.equal(envelope.object, 'run_timeline');
  assert.equal(envelope.run_id, 'run_42');
  assert.equal(envelope.trace_id, 'trc_q');
  assert.equal(envelope.truncated, true);
  assert.equal(envelope.next_cursor, 'next_cursor_y');
});

test('ref.spine.events.page strips token_id from every event', () => {
  const envelope = executeRefSpineEventsPage({
    kind: 'trace',
    id: 't',
    cursor: null,
    page: {
      events: [makeEvent({ token_id: 'opaque-bearer-1234' })],
      truncated: false,
      next_cursor: null,
      limit: 1,
    },
  });
  assert.equal('token_id' in envelope.data[0], false);
});

test('ref.spine.events.page replaces token object_id literal', () => {
  const envelope = executeRefSpineEventsPage({
    kind: 'trace',
    id: 't',
    cursor: null,
    page: {
      events: [
        makeEvent({
          object_type: 'token',
          object_id: 'tok_live_bearer_value',
        }),
      ],
      truncated: false,
      next_cursor: null,
      limit: 1,
    },
  });
  assert.equal(envelope.data[0].object_id, '<redacted-token-id>');
});

test('ref.spine.events.page replaces pending_consent and owner_device_auth object_id literals', () => {
  const envelope = executeRefSpineEventsPage({
    kind: 'trace',
    id: 't',
    cursor: null,
    page: {
      events: [
        makeEvent({ object_type: 'pending_consent', object_id: 'device_code_xyz' }),
        makeEvent({ object_type: 'owner_device_auth', object_id: 'device_code_abc' }),
      ],
      truncated: false,
      next_cursor: null,
      limit: 2,
    },
  });
  assert.equal(envelope.data[0].object_id, '<redacted-device-code>');
  assert.equal(envelope.data[1].object_id, '<redacted-device-code>');
});

test('ref.spine.events.page redacts device_code / user_code / request_uri inside event data', () => {
  const envelope = executeRefSpineEventsPage({
    kind: 'trace',
    id: 't',
    cursor: null,
    page: {
      events: [
        makeEvent({
          data: {
            device_code: 'dc_secret',
            user_code: 'WDJB-MJHT',
            request_uri: 'urn:ietf:params:oauth:request_uri:dc_secret',
            other: 'kept',
          },
        }),
      ],
      truncated: false,
      next_cursor: null,
      limit: 1,
    },
  });
  const data = envelope.data[0].data;
  assert.equal(data.device_code, '<redacted-bearer>');
  assert.equal(data.user_code, '<redacted-bearer>');
  assert.equal(data.request_uri, '<redacted-bearer>');
  assert.equal(data.other, 'kept');
});

test('ref.spine.events.page does not mutate the input event when redacting data keys', () => {
  const original = makeEvent({
    data: { user_code: 'WDJB-MJHT', other: 'kept' },
  });
  const before = JSON.stringify(original.data);
  executeRefSpineEventsPage({
    kind: 'trace',
    id: 't',
    cursor: null,
    page: { events: [original], truncated: false, next_cursor: null, limit: 1 },
  });
  assert.equal(JSON.stringify(original.data), before);
});

test('ref.spine.events.page leaves non-bearer events untouched', () => {
  const envelope = executeRefSpineEventsPage({
    kind: 'trace',
    id: 't',
    cursor: null,
    page: {
      events: [makeEvent({ object_type: 'event', object_id: 'plain' })],
      truncated: false,
      next_cursor: null,
      limit: 1,
    },
  });
  assert.equal(envelope.data[0].object_id, 'plain');
});

test('ref.spine.events.page threads terminal_status onto the run envelope', () => {
  const envelope = executeRefSpineEventsPage({
    kind: 'run',
    id: 'run_term',
    cursor: null,
    page: { events: [makeEvent({ run_id: 'run_term' })], truncated: false, next_cursor: null, limit: 10 },
    terminalStatus: 'cancelled',
  });
  assert.equal(envelope.object, 'run_timeline');
  assert.equal(envelope.terminal_status, 'cancelled');
});

test('ref.spine.events.page run envelope reports terminal_status null when none supplied', () => {
  const envelope = executeRefSpineEventsPage({
    kind: 'run',
    id: 'run_active',
    cursor: null,
    page: { events: [makeEvent({ run_id: 'run_active' })], truncated: false, next_cursor: null, limit: 10 },
  });
  assert.equal(envelope.terminal_status, null);
});

test('ref.spine.events.page terminal_status is window-independent of the page contents', () => {
  // The terminal class is whatever the host resolved, regardless of whether
  // the page window contains the terminal event. Here the page carries only
  // non-terminal events yet the envelope reports the run as completed.
  const envelope = executeRefSpineEventsPage({
    kind: 'run',
    id: 'run_long',
    cursor: 'page_2_cursor',
    page: {
      events: [makeEvent({ event_type: 'run.detail_gap_recorded', run_id: 'run_long' })],
      truncated: true,
      next_cursor: 'next',
      limit: 1,
    },
    terminalStatus: 'completed',
  });
  assert.equal(envelope.terminal_status, 'completed');
});

test('ref.spine.events.page forces terminal_status null for trace/grant kinds', () => {
  const traceEnvelope = executeRefSpineEventsPage({
    kind: 'trace',
    id: 'trc_1',
    cursor: null,
    page: { events: [makeEvent()], truncated: false, next_cursor: null, limit: 10 },
    // A host MUST NOT supply this for non-run kinds; even if it leaks in, the
    // operation forces null (terminal status is a run concept).
    terminalStatus: 'failed',
  });
  assert.equal(traceEnvelope.terminal_status, null);

  const grantEnvelope = executeRefSpineEventsPage({
    kind: 'grant',
    id: 'grt_1',
    cursor: null,
    page: { events: [], truncated: false, next_cursor: null, limit: 10 },
  });
  assert.equal(grantEnvelope.terminal_status, null);
});

test('redactSpineEventForPublic is independently testable', () => {
  const redacted = redactSpineEventForPublic({
    object_type: 'token',
    object_id: 'live_bearer',
    token_id: 'live_bearer',
    data: { user_code: 'X' },
    trace_id: 't1',
  });
  assert.equal('token_id' in redacted, false);
  assert.equal(redacted.object_id, '<redacted-token-id>');
  assert.equal(redacted.data.user_code, '<redacted-bearer>');
});
