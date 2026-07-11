import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCollectionReport } from '../server/ref-control.ts';

// Slack-specific projection proofs for OpenSpec task 4.2
// (`define-connector-progress-evidence-contract`): the Slack connector declares
// an objective `considered` denominator for `canvases` (its one full-sync,
// non-fingerprinted, no-filter list stream).
//
// These tests feed a realistic Slack `collection_facts` block to the REAL
// exported `buildCollectionReport` projection and assert the derived report:
//   - canvases with collected === considered  -> complete  (the new signal)
//   - canvases with collected  <  considered  -> partial   (honest shortfall)
//   - streams that declare NO considered (messages, workspace, users, …) stay
//     `unknown` / `unmeasured` — never inferred `complete` from collected count
//   - a stream that emits SKIP_RESULT(reason: "not_available") reads
//     `unavailable` coverage -> a `terminal` forward disposition with no extra
//     connector code (the second half of task 4.2, true by construction). As
//     of `complete-slack-bundled-connector-coverage`, Slack no longer has any
//     streams in this state (stars/user_groups/reminders/dm_read_states now
//     collect via direct Slack Web API calls); the mechanism below is
//     projection-generic and exercised with synthetic fixture stream names,
//     not a live Slack manifest assertion.
//
// The runtime half (DETAIL_COVERAGE.considered carried onto the terminal facts
// block without blocking commit) is proven connector-agnostically in
// collection-profile.test.js; the Slack connector emitting the right
// DETAIL_COVERAGE shape is proven in
// connectors/slack/canvases-considered.test.ts.

/** A runtime fact-block entry with honest defaults (no considered, no gaps, no skip). */
function fact(overrides = {}) {
  return {
    stream: 'messages',
    collected: 0,
    considered: null,
    checkpoint: 'committed',
    pending_detail_gaps: 0,
    skipped: null,
    ...overrides,
  };
}

/** Build a report from a Slack-shaped fact block. Defaults: fresh, no
 *  attention, schedulable (the projection inputs the connection-health snapshot
 *  supplies). */
function report(facts, overrides = {}) {
  return buildCollectionReport({
    collectionFacts: { streams: facts },
    manifestStreams: [],
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
    ...overrides,
  });
}

function entryFor(entries, stream) {
  const entry = entries.find((e) => e.stream === stream);
  assert.ok(entry, `expected a Collection Report entry for stream "${stream}"`);
  return entry;
}

test('slack canvases: collected === considered -> complete (the populated signal task 4.2 adds)', () => {
  const entries = report([fact({ stream: 'canvases', collected: 4, considered: 4 })]);
  const entry = entryFor(entries, 'canvases');
  assert.equal(entry.considered, 4, 'the declared denominator is carried, not unknown');
  assert.equal(entry.collected, 4);
  assert.equal(entry.coverage_condition, 'complete');
  assert.equal(entry.forward_disposition, 'complete');
});

test('slack canvases: collected < considered -> partial / resumable (honest shortfall, e.g. a dropped canvas)', () => {
  const entries = report([fact({ stream: 'canvases', collected: 3, considered: 4 })]);
  const entry = entryFor(entries, 'canvases');
  assert.equal(entry.considered, 4);
  assert.equal(entry.coverage_condition, 'partial');
  assert.equal(entry.forward_disposition, 'resumable');
});

test('slack canvases: an enumerated empty inventory (considered: 0, collected: 0) reads complete', () => {
  const entries = report([fact({ stream: 'canvases', collected: 0, considered: 0 })]);
  const entry = entryFor(entries, 'canvases');
  assert.equal(entry.considered, 0, 'an enumerated empty inventory is a real 0, not unknown');
  assert.equal(entry.coverage_condition, 'complete');
  assert.equal(entry.forward_disposition, 'complete');
});

test('slack non-canvas streams declare NO considered -> stay unknown / unmeasured (never inferred complete)', () => {
  // messages / workspace / users / files / channels collect records but declare
  // no `considered` (fingerprint-suppressed or incrementally-windowed streams
  // have no honest denominator). They MUST stay `unknown`, never `complete`.
  const entries = report([
    fact({ stream: 'messages', collected: 1903, considered: null }),
    fact({ stream: 'workspace', collected: 1, considered: null }),
    fact({ stream: 'users', collected: 0, considered: null }),
  ]);
  for (const stream of ['messages', 'workspace', 'users']) {
    const entry = entryFor(entries, stream);
    assert.equal(entry.considered, 'unknown', `${stream} considered stays unknown when undeclared`);
    assert.equal(entry.coverage_condition, 'unknown', `${stream} is never inferred complete`);
    assert.equal(entry.forward_disposition, 'unmeasured', `${stream} is unmeasured coverage, not active checking`);
  }
});

test('slack unsupported streams: SKIP_RESULT(reason: "not_available") -> unavailable coverage -> terminal disposition', () => {
  // Projection-generic mechanism proof (synthetic stream names — not a live
  // Slack manifest assertion; see file header). A stream that emits
  // SKIP_RESULT { reason: "not_available" } projects "not_available" ->
  // `unavailable` coverage, and the pure disposition helper maps an
  // `unavailable` coverage with no recovery path -> `terminal`. No extra
  // connector code is needed for the second half of task 4.2 — it holds by
  // construction.
  const unsupported = ['stars', 'user_groups', 'reminders', 'dm_read_states'];
  const entries = report(
    unsupported.map((stream) => fact({ stream, collected: 0, skipped: { reason: 'not_available' } }))
  );
  for (const stream of unsupported) {
    const entry = entryFor(entries, stream);
    assert.equal(entry.coverage_condition, 'unavailable', `${stream} skip reads unavailable, not complete`);
    assert.equal(entry.forward_disposition, 'terminal', `${stream} has no ordinary recovery path -> terminal`);
  }
});

test('slack unsupported-in-mode streams: manifest accepted-absence prevents resting unknown coverage', () => {
  // Projection-generic mechanism proof (synthetic stream names and a
  // synthetic manifest fragment — Slack's real manifest no longer declares
  // any stream this way as of `complete-slack-bundled-connector-coverage`;
  // see file header). A manifest stream declaring coverage_policy=deferred +
  // required=false projects an explicit accepted-absence even when old run
  // facts have no skip, instead of resting `unknown` forever.
  const unsupported = ['stars', 'user_groups', 'reminders', 'dm_read_states'];
  const manifestStreams = unsupported.map((stream) => ({
    name: stream,
    coverage_policy: 'deferred',
    coverage_strategy: stream === 'stars' || stream === 'user_groups' ? 'full_inventory' : 'checkpoint_window',
    freshness_strategy: 'not_trackable',
    required: false,
  }));
  const entries = report(
    unsupported.map((stream) => fact({ stream, collected: 0, considered: null, checkpoint: 'unknown' })),
    { manifestStreams },
  );
  for (const stream of unsupported) {
    const entry = entryFor(entries, stream);
    assert.equal(entry.coverage_condition, 'deferred', `${stream} is accepted-absent, not unknown`);
    assert.equal(entry.forward_disposition, 'complete', `${stream} owes no ordinary collection in slackdump mode`);
  }
});

test('slack co-emitted detail streams: checkpoint_window + committed parent checkpoint -> complete', () => {
  // reactions / message_attachments ride the `messages` cursor and are committed
  // by the parent `messages` STATE. They carry no `considered` denominator, so
  // the ONLY coverage proof is the committed checkpoint under the
  // `checkpoint_window` strategy. A succeeded run whose parent committed must
  // read `complete`, not `unknown`.
  const manifestStreams = [
    { name: 'reactions', coverage_strategy: 'checkpoint_window', state_stream: 'messages' },
    { name: 'message_attachments', coverage_strategy: 'checkpoint_window', state_stream: 'messages' },
  ];
  const entries = report(
    [
      fact({ stream: 'reactions', collected: 42, considered: null, checkpoint: 'committed' }),
      fact({ stream: 'message_attachments', collected: 7, considered: null, checkpoint: 'committed' }),
    ],
    { manifestStreams },
  );
  for (const stream of ['reactions', 'message_attachments']) {
    const entry = entryFor(entries, stream);
    assert.equal(entry.coverage_condition, 'complete', `${stream} committed checkpoint proves coverage`);
    assert.equal(entry.forward_disposition, 'complete', `${stream} is complete, not unmeasured`);
  }
});

test('slack co-emitted detail streams: historical child not_staged inherits committed parent checkpoint', () => {
  // Live repair: historical terminal fact blocks may have stamped a co-emitted
  // child stream as `not_staged` even though the parent `messages` cursor
  // committed. The manifest state_stream declaration is the durable read-side
  // evidence that lets old reports project the same way current runtime facts do.
  const manifestStreams = [
    { name: 'reactions', coverage_strategy: 'checkpoint_window', state_stream: 'messages' },
  ];
  const entries = report(
    [
      fact({ stream: 'messages', collected: 1903, considered: null, checkpoint: 'committed' }),
      fact({ stream: 'reactions', collected: 42, considered: null, checkpoint: 'not_staged' }),
    ],
    { manifestStreams },
  );
  const entry = entryFor(entries, 'reactions');
  assert.equal(entry.checkpoint, 'committed', 'child stream inherits the parent committed checkpoint');
  assert.equal(entry.coverage_condition, 'complete', 'parent checkpoint proves child checkpoint_window coverage');
  assert.equal(entry.forward_disposition, 'complete');
});

test('slack co-emitted detail streams: child not_staged without parent proof stays unknown', () => {
  const manifestStreams = [
    { name: 'reactions', coverage_strategy: 'checkpoint_window', state_stream: 'messages' },
  ];
  const entries = report(
    [fact({ stream: 'reactions', collected: 42, considered: null, checkpoint: 'not_staged' })],
    { manifestStreams },
  );
  const entry = entryFor(entries, 'reactions');
  assert.equal(entry.coverage_condition, 'unknown', 'not_staged alone does not prove checkpoint_window coverage');
  assert.equal(entry.forward_disposition, 'unmeasured');
});

test('slack mixed report: canvases complete alongside unknown messages and a terminal unsupported stream', () => {
  // The whole-connection shape an owner sees after a clean Slack run: canvases
  // carries a real complete, messages stays honestly unknown, and an
  // unsupported stream is terminal — three distinct, non-contradictory verdicts
  // in one report.
  const entries = report([
    fact({ stream: 'canvases', collected: 2, considered: 2 }),
    fact({ stream: 'messages', collected: 1903, considered: null }),
    fact({ stream: 'reminders', collected: 0, skipped: { reason: 'not_available' } }),
  ]);
  assert.equal(entryFor(entries, 'canvases').coverage_condition, 'complete');
  assert.equal(entryFor(entries, 'messages').coverage_condition, 'unknown');
  assert.equal(entryFor(entries, 'reminders').forward_disposition, 'terminal');
});
