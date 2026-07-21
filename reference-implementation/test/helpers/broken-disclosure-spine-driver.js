// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deliberately broken in-memory driver for disclosure-spine harness
 * falsifiability.
 *
 * This driver exists ONLY for the conformance harness's negative proof. It
 * implements a small in-memory store whose spine reads are intentionally
 * wrong in two specific ways:
 *
 *   1. listPage returns events in *reverse* append order. This is the failure
 *      mode that protects against unstable timeline ordering and would make
 *      terminal/latest event lookups (which rely on the last element of the
 *      timeline being the latest append) point at the *first* event instead.
 *
 *   2. listSummaries derives `event_count`, `first_at`, and `last_at` from a
 *      truncated hydration window (the first 3 events) instead of the full
 *      correlation extent. This is the failure mode that protects against
 *      summary aggregates degrading when a correlation overflows the
 *      summarizer's per-row hydration cap.
 *
 * Other behaviors are kept faithful enough that the rest of the harness's
 * scenarios still execute against a real timeline; the negative proof only
 * needs at least one scenario to detect each broken invariant.
 *
 * This driver SHALL NOT be used as a production adapter or environment
 * profile. It is only imported from the falsifiability test.
 */

const HYDRATION_CAP = 3;

let nextSeq = 0;

function generateEventId() {
  nextSeq += 1;
  return `evt_broken_${nextSeq.toString(16).padStart(8, '0')}`;
}

function classifyTerminalStatus(events) {
  // Walk forward, last non-empty status wins (matches the reference's
  // "last meaningful status" rule closely enough that the rejected-status
  // scenario only detects the *intended* breakage in summary extent, not
  // an unrelated divergence).
  let status = 'unknown';
  for (const ev of events) {
    if (ev.status && ev.status !== 'unknown') status = ev.status;
  }
  if (events.some((e) => e.status === 'rejected' || e.event_type === 'grant.rejected')) {
    return 'rejected';
  }
  return status;
}

export function createBrokenInMemoryDisclosureSpineDriver() {
  // correlationKind -> Map<id, EventRecord[]>
  const byKind = {
    trace: new Map(),
    grant: new Map(),
    run: new Map(),
  };

  function appendToCorrelation(kind, id, ev) {
    if (!id) return;
    if (!byKind[kind].has(id)) byKind[kind].set(id, []);
    byKind[kind].get(id).push(ev);
  }

  return {
    async setup() {
      for (const k of Object.keys(byKind)) byKind[k].clear();
      nextSeq = 0;
    },

    async teardown() {
      for (const k of Object.keys(byKind)) byKind[k].clear();
    },

    async append(input) {
      const occurredAt = input.occurred_at || new Date().toISOString();
      const ev = {
        event_id: input.event_id || generateEventId(),
        event_type: input.event_type || '',
        occurred_at: occurredAt,
        recorded_at: new Date().toISOString(),
        status: input.status || 'succeeded',
        actor_type: input.actor_type || 'system',
        actor_id: input.actor_id || 'pdpp_reference',
        object_type: input.object_type || 'event',
        trace_id: input.trace_id || null,
        grant_id: input.grant_id || null,
        run_id: input.run_id || null,
        client_id: input.client_id || null,
        provider_id: input.provider_id || null,
        request_id: input.request_id || null,
        data: input.data ?? {},
      };
      appendToCorrelation('trace', ev.trace_id, ev);
      appendToCorrelation('grant', ev.grant_id, ev);
      appendToCorrelation('run', ev.run_id, ev);
      return ev;
    },

    async listPage(kind, id, opts = {}) {
      const limit = opts.limit ?? 100;
      const all = byKind[kind].get(id) || [];
      // BROKEN: reverse order. Real driver preserves append order.
      const reversed = [...all].reverse();
      const cursorIdx = opts.cursor ? Number.parseInt(opts.cursor, 10) || 0 : 0;
      const slice = reversed.slice(cursorIdx, cursorIdx + limit);
      const truncated = cursorIdx + slice.length < reversed.length;
      return {
        events: slice,
        next_cursor: truncated ? String(cursorIdx + slice.length) : null,
        truncated,
      };
    },

    async listSummaries(kind /* , filters */) {
      const summaries = [];
      for (const [id, events] of byKind[kind].entries()) {
        if (events.length === 0) continue;
        // BROKEN: derive extent from a truncated hydration window instead
        // of the full correlation. Mirrors the failure mode where summary
        // aggregates degrade when a correlation overflows the hydration cap.
        const sample = events.slice(0, HYDRATION_CAP);
        const first = sample[0];
        const last = sample.at(-1);
        summaries.push({
          id,
          event_count: sample.length,
          first_at: first.occurred_at,
          last_at: last.occurred_at,
          status: classifyTerminalStatus(events),
          kinds: Array.from(new Set(events.map((e) => e.event_type))),
          actor_type: first.actor_type,
          actor_id: first.actor_id,
          trace_id: first.trace_id,
          grant_id: first.grant_id,
          run_id: first.run_id,
          client_id: first.client_id,
          provider_id: first.provider_id,
          connector_id: null,
          request_id: first.request_id,
          needs_input: false,
          failure: null,
        });
      }
      return { summaries };
    },
  };
}
