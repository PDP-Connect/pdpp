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

type SpineKind = "trace" | "grant" | "run";
interface BrokenEvent {
  actor_id: string;
  actor_type: string;
  client_id: string | null;
  data: Record<string, unknown>;
  event_id: string;
  event_type: string;
  grant_id: string | null;
  object_type: string;
  occurred_at: string;
  provider_id: string | null;
  recorded_at: string;
  request_id: string | null;
  run_id: string | null;
  status: string;
  trace_id: string | null;
}
interface BrokenAppendInput extends Record<string, unknown> {
  actor_id?: string;
  actor_type?: string;
  client_id?: string | null;
  data?: Record<string, unknown>;
  event_id?: string;
  event_type?: string;
  grant_id?: string | null;
  object_type?: string;
  occurred_at?: string;
  provider_id?: string | null;
  request_id?: string | null;
  run_id?: string | null;
  status?: string;
  trace_id?: string | null;
}
interface BrokenSummary {
  id: string;
  [key: string]: unknown;
}

let nextSeq = 0;

function generateEventId() {
  nextSeq += 1;
  return `evt_broken_${nextSeq.toString(16).padStart(8, "0")}`;
}

function classifyTerminalStatus(events: BrokenEvent[]): string {
  // Walk forward, last non-empty status wins (matches the reference's
  // "last meaningful status" rule closely enough that the rejected-status
  // scenario only detects the *intended* breakage in summary extent, not
  // an unrelated divergence).
  let status = "unknown";
  for (const ev of events) {
    const { status: eventStatus } = ev;
    if (eventStatus && eventStatus !== "unknown") {
      status = eventStatus;
    }
  }
  if (events.some((e) => e.status === "rejected" || e.event_type === "grant.rejected")) {
    return "rejected";
  }
  return status;
}

export function createBrokenInMemoryDisclosureSpineDriver() {
  // correlationKind -> Map<id, EventRecord[]>
  const byKind: Record<SpineKind, Map<string, BrokenEvent[]>> = {
    grant: new Map<string, BrokenEvent[]>(),
    run: new Map<string, BrokenEvent[]>(),
    trace: new Map<string, BrokenEvent[]>(),
  };

  function appendToCorrelation(kind: SpineKind, id: string | null, ev: BrokenEvent): void {
    if (!id) {
      return;
    }
    if (!byKind[kind].has(id)) {
      byKind[kind].set(id, []);
    }
    byKind[kind].get(id)?.push(ev);
  }

  return {
    append(input: BrokenAppendInput): Promise<BrokenEvent> {
      const occurredAt = input.occurred_at || new Date().toISOString();
      const ev: BrokenEvent = {
        actor_id: input.actor_id || "pdpp_reference",
        actor_type: input.actor_type || "system",
        client_id: input.client_id || null,
        data: input.data ?? {},
        event_id: input.event_id || generateEventId(),
        event_type: input.event_type || "",
        grant_id: input.grant_id || null,
        object_type: input.object_type || "event",
        occurred_at: occurredAt,
        provider_id: input.provider_id || null,
        recorded_at: new Date().toISOString(),
        request_id: input.request_id || null,
        run_id: input.run_id || null,
        status: input.status || "succeeded",
        trace_id: input.trace_id || null,
      };
      appendToCorrelation("trace", ev.trace_id, ev);
      appendToCorrelation("grant", ev.grant_id, ev);
      appendToCorrelation("run", ev.run_id, ev);
      return Promise.resolve(ev);
    },

    listPage(
      kind: SpineKind,
      id: string,
      opts: { limit?: number; cursor?: string | null } = {}
    ): Promise<{ events: BrokenEvent[]; next_cursor: string | null; truncated: boolean }> {
      const limit = opts.limit ?? 100;
      const all = byKind[kind].get(id) || [];
      // BROKEN: reverse order. Real driver preserves append order.
      const reversed = [...all].reverse();
      const cursorIdx = opts.cursor ? Number.parseInt(opts.cursor, 10) || 0 : 0;
      const slice = reversed.slice(cursorIdx, cursorIdx + limit);
      const truncated = cursorIdx + slice.length < reversed.length;
      return Promise.resolve({
        events: slice,
        next_cursor: truncated ? String(cursorIdx + slice.length) : null,
        truncated,
      });
    },

    listSummaries(kind: SpineKind /* , filters */): Promise<{ summaries: BrokenSummary[] }> {
      const summaries: BrokenSummary[] = [];
      for (const [id, events] of byKind[kind].entries()) {
        if (events.length === 0) {
          continue;
        }
        // BROKEN: derive extent from a truncated hydration window instead
        // of the full correlation. Mirrors the failure mode where summary
        // aggregates degrade when a correlation overflows the hydration cap.
        const sample = events.slice(0, HYDRATION_CAP);
        const [first] = sample;
        const last = sample.at(-1);
        if (!(first && last)) {
          continue;
        }
        summaries.push({
          actor_id: first.actor_id,
          actor_type: first.actor_type,
          client_id: first.client_id,
          connector_id: null,
          event_count: sample.length,
          failure: null,
          first_at: first.occurred_at,
          grant_id: first.grant_id,
          id,
          kinds: Array.from(new Set(events.map((e) => e.event_type))),
          last_at: last.occurred_at,
          needs_input: false,
          provider_id: first.provider_id,
          request_id: first.request_id,
          run_id: first.run_id,
          status: classifyTerminalStatus(events),
          trace_id: first.trace_id,
        });
      }
      return Promise.resolve({ summaries });
    },
    setup() {
      for (const k of Object.keys(byKind) as SpineKind[]) {
        byKind[k].clear();
      }
      nextSeq = 0;
      return Promise.resolve();
    },

    teardown() {
      for (const k of Object.keys(byKind) as SpineKind[]) {
        byKind[k].clear();
      }
      return Promise.resolve();
    },
  };
}
