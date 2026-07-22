// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Conforming in-memory driver for the disclosure-spine conformance harness.
 *
 * Test-only second adapter that mirrors the SQLite reference's append/list
 * ordering, cursor pagination, terminal/latest event lookup, summary extent,
 * rejected-vs-served visibility, and grant-lifecycle summary status — without
 * touching SQLite, the file system, or the production spine helpers. Its
 * purpose is the storage-only proof for `add-second-conformance-adapters`
 * task 3.1: prove the existing disclosure-spine harness can run against
 * SQLite *and* a second conforming adapter, not just the deliberately-broken
 * falsifiability driver.
 *
 * Honesty boundaries:
 *
 *   - Does NOT model `spine_events` rowid pagination; cursors are opaque
 *     numeric sequence offsets scoped to the driver instance. The harness
 *     treats them as opaque tokens, so the only obligation is round-trip
 *     fidelity within a paged walk.
 *   - Does NOT compute a connector_id, search index, or scenario tracing.
 *     Summaries carry only the fields the harness inspects (id, event_count,
 *     first_at, last_at, status, plus a small set of correlation tags so
 *     parallel scenarios see consistent shape).
 *   - Mirrors the SQLite summarizer's status rule: walk backward, last
 *     non-empty/non-"unknown" status wins. For `kind === 'grant'`, the
 *     grant-lifecycle precedence (revoked > denied > failed > issued >
 *     pending) is applied so that a `grant.rejected` event surfaces as a
 *     terminal-failure label in the summary row.
 *   - The driver SHALL NOT be used as a production `DisclosureSpineStore`.
 *     No production code imports it.
 *
 * Spec: openspec/changes/add-second-conformance-adapters/design.md § Lane 3.
 */

const SPINE_VERSION = 'reference.spine.v1';
const DEFAULT_SCENARIO_ID = 'scn_reference_default';

let memoryDriverInstanceCounter = 0;

function nowIso() {
  return new Date().toISOString();
}

const DENIED_EVENT_TYPES = new Set(['grant.denied', 'consent.denied']);
const FAILED_EVENT_TYPES = new Set(['grant.rejected', 'request.rejected']);
const FAILED_STATUSES = new Set(['rejected', 'failed']);

function classifyGrantEvent(ev) {
  const t = ev.event_type;
  if (!t) return null;
  if (t === 'grant.revoked' || ev.status === 'revoked') return 'revoked';
  if (DENIED_EVENT_TYPES.has(t)) return 'denied';
  if (FAILED_EVENT_TYPES.has(t) || FAILED_STATUSES.has(ev.status)) return 'failed';
  if (t === 'grant.issued' || ev.status === 'issued') return 'issued';
  return null;
}

function deriveGrantLifecycleStatus(events) {
  let status = 'pending';
  for (const ev of events) {
    const kind = classifyGrantEvent(ev);
    if (kind === 'revoked') return 'revoked';
    if (kind === 'denied' && status !== 'revoked') {
      status = 'denied';
    } else if (kind === 'failed' && (status === 'pending' || status === 'issued')) {
      status = 'failed';
    } else if (kind === 'issued' && status === 'pending') {
      status = 'issued';
    }
  }
  return status;
}

function deriveTrailingStatus(events) {
  // Walk backward; last non-empty / non-"unknown" status wins. Mirrors the
  // SQLite summarizer's rule so non-grant correlations expose the same
  // terminal status the reference surfaces.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    const s = ev?.status;
    if (s && s !== 'unknown') return s;
  }
  return 'unknown';
}

function pickFirstNonNull(events, key) {
  for (const ev of events) {
    const v = ev[key];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

export function createMemoryDisclosureSpineDriver() {
  const instanceTag = (++memoryDriverInstanceCounter).toString(36);
  let appendSeq = 0;

  function nextEventId() {
    appendSeq += 1;
    return `evt_mem_${instanceTag}_${appendSeq.toString(16).padStart(8, '0')}`;
  }

  // Single append-ordered log; per-correlation indices are derived views into
  // it. Storing the canonical sequence in one list (rather than three parallel
  // arrays) makes the "preserve append order even with shared occurred_at"
  // invariant a property of the storage shape itself rather than a sort rule.
  /** @type {Array<{ seq: number; ev: any }>} */
  const log = [];
  /** @type {{ trace: Map<string, number[]>; grant: Map<string, number[]>; run: Map<string, number[]> }} */
  const indexByKind = {
    trace: new Map(),
    grant: new Map(),
    run: new Map(),
  };

  function indexCorrelation(kind, id, seq) {
    if (!id) return;
    let bucket = indexByKind[kind].get(id);
    if (!bucket) {
      bucket = [];
      indexByKind[kind].set(id, bucket);
    }
    bucket.push(seq);
  }

  function reset() {
    log.length = 0;
    for (const k of Object.keys(indexByKind)) indexByKind[k].clear();
    appendSeq = 0;
  }

  return {
    async setup() {
      reset();
    },

    async teardown() {
      reset();
    },

    async append(input = {}) {
      const occurredAt =
        typeof input.occurred_at === 'string' && input.occurred_at
          ? input.occurred_at
          : nowIso();
      const ev = {
        event_id:
          typeof input.event_id === 'string' && input.event_id
            ? input.event_id
            : nextEventId(),
        event_type: typeof input.event_type === 'string' ? input.event_type : '',
        occurred_at: occurredAt,
        recorded_at: nowIso(),
        scenario_id:
          typeof input.scenario_id === 'string' && input.scenario_id
            ? input.scenario_id
            : DEFAULT_SCENARIO_ID,
        trace_id:
          typeof input.trace_id === 'string' && input.trace_id
            ? input.trace_id
            : null,
        actor_type:
          typeof input.actor_type === 'string' && input.actor_type
            ? input.actor_type
            : 'system',
        actor_id:
          typeof input.actor_id === 'string' && input.actor_id
            ? input.actor_id
            : 'pdpp_reference',
        subject_type:
          typeof input.subject_type === 'string' && input.subject_type
            ? input.subject_type
            : null,
        subject_id:
          typeof input.subject_id === 'string' && input.subject_id
            ? input.subject_id
            : null,
        object_type:
          typeof input.object_type === 'string' && input.object_type
            ? input.object_type
            : 'event',
        object_id:
          typeof input.object_id === 'string' && input.object_id
            ? input.object_id
            : `obj_mem_${instanceTag}_${appendSeq.toString(16)}`,
        status:
          typeof input.status === 'string' && input.status ? input.status : 'succeeded',
        request_id:
          typeof input.request_id === 'string' && input.request_id
            ? input.request_id
            : null,
        grant_id:
          typeof input.grant_id === 'string' && input.grant_id
            ? input.grant_id
            : null,
        run_id:
          typeof input.run_id === 'string' && input.run_id ? input.run_id : null,
        provider_id:
          typeof input.provider_id === 'string' && input.provider_id
            ? input.provider_id
            : null,
        client_id:
          typeof input.client_id === 'string' && input.client_id
            ? input.client_id
            : null,
        stream_id:
          typeof input.stream_id === 'string' && input.stream_id
            ? input.stream_id
            : null,
        token_id:
          typeof input.token_id === 'string' && input.token_id
            ? input.token_id
            : null,
        interaction_id:
          typeof input.interaction_id === 'string' && input.interaction_id
            ? input.interaction_id
            : null,
        data: input.data ?? {},
        version:
          typeof input.version === 'string' && input.version
            ? input.version
            : SPINE_VERSION,
      };

      const seq = log.length;
      log.push({ seq, ev });
      indexCorrelation('trace', ev.trace_id, seq);
      indexCorrelation('grant', ev.grant_id, seq);
      indexCorrelation('run', ev.run_id, seq);
      return ev;
    },

    async listPage(kind, id, opts = {}) {
      const limit = opts.limit ?? 100;
      const bucket = indexByKind[kind].get(id) || [];
      // Cursor is an opaque offset within the per-correlation append order.
      // The harness treats cursors as opaque tokens, so any encoding that
      // round-trips identity within a single paged walk is conformant.
      const startOffset = opts.cursor ? Number.parseInt(opts.cursor, 10) || 0 : 0;
      const slice = bucket.slice(startOffset, startOffset + limit);
      const events = slice.map((seq) => log[seq].ev);
      const consumed = startOffset + slice.length;
      const truncated = consumed < bucket.length;
      return {
        events,
        next_cursor: truncated ? String(consumed) : null,
        truncated,
      };
    },

    async listSummaries(kind, filters = {}) {
      const summaries = [];
      for (const [id, seqs] of indexByKind[kind].entries()) {
        if (seqs.length === 0) continue;
        // Pull events in append order from the canonical log so summary
        // extent reflects the *full* correlation, not a truncated hydration
        // window. The SQLite reference computes first_at/last_at/event_count
        // from a SQL aggregate; this driver preserves the same invariant by
        // construction by walking every indexed seq.
        const events = seqs.map((s) => log[s].ev);
        const status =
          kind === 'grant'
            ? deriveGrantLifecycleStatus(events)
            : deriveTrailingStatus(events);

        const terminalFailure = events.find(
          (e) => e.status === 'failed' || e.status === 'rejected',
        );

        const summary = {
          id,
          event_count: events.length,
          first_at: events.reduce(
            (min, event) => (event.occurred_at < min ? event.occurred_at : min),
            events[0].occurred_at,
          ),
          last_at: events.reduce(
            (max, event) => (event.occurred_at > max ? event.occurred_at : max),
            events[0].occurred_at,
          ),
          status,
          kinds: Array.from(new Set(events.map((e) => e.event_type))).slice(0, 16),
          actor_type: events[0].actor_type,
          actor_id: events[0].actor_id,
          trace_id: pickFirstNonNull(events, 'trace_id'),
          grant_id: pickFirstNonNull(events, 'grant_id'),
          run_id: pickFirstNonNull(events, 'run_id'),
          client_id: pickFirstNonNull(events, 'client_id'),
          provider_id: pickFirstNonNull(events, 'provider_id'),
          connector_id: null,
          request_id: pickFirstNonNull(events, 'request_id'),
          needs_input: false,
          failure: terminalFailure
            ? {
                event_type: terminalFailure.event_type,
                reason:
                  terminalFailure.data && typeof terminalFailure.data === 'object'
                    ? (terminalFailure.data.reason ?? null)
                    : null,
              }
            : null,
        };

        if (filters.status && summary.status !== filters.status) continue;
        if (filters.since && summary.last_at < filters.since) continue;
        if (filters.until && summary.first_at > filters.until) continue;

        summaries.push(summary);
      }
      // Stable order: last_at desc, id desc — matches the SQLite reference's
      // ORDER BY so two adapters appear interchangeable from a caller's view.
      summaries.sort((a, b) => {
        if (a.last_at !== b.last_at) return a.last_at < b.last_at ? 1 : -1;
        return a.id < b.id ? 1 : -1;
      });
      return { summaries };
    },
  };
}
