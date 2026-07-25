// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure machine audit: a required stream without a resolved coverage posture
// SHALL never hide beneath a Healthy connection verdict, and settled/live
// acceptance SHALL inspect every settled connection rather than only Healthy
// pills. "Settled" excludes both revoked connections and `draft`/
// `setup_in_progress` connections — a draft has not completed its first
// enrollment/credential-capture step, so it carries no coverage evidence to
// judge yet (fix-pending-connection-discovery made drafts owner-discoverable
// before that step completes; this audit must not punish that honesty).
//
// Implements openspec/changes/define-stream-coverage-freshness-evidence
// specs/reference-connection-health/spec.md requirement "A reproducible
// machine audit SHALL distinguish settled failures from active or
// unreliable evidence" (tasks.md 9.1).
//
// Input shape (one entry per configured connection), as served by the
// `GET /_ref/connectors` summaries route (`ConnectorSummary` in
// reference-implementation/server/ref-control.ts):
//   {
//     connection_id | connector_instance_id | connector_id: string,
//     display_name?, connector_display_name?: string,
//     rendered_verdict: { pill: { label, tone }, ... },
//     collection_report: CollectionReportEntry[],
//   }
//
// Each `collection_report` entry (CollectionReportEntry, ref-control.ts
// ~2036) carries: stream, coverage_condition, forward_disposition,
// coverage_strategy, freshness_strategy, checkpoint, considered, covered.
//
// `required` is a field the collection-report entry is gaining (a sibling
// change is landing it). Read it when present; when absent, treat the entry
// as required — the audit must not go blind on collection reports that
// predate the field.
//
// Settle/live acceptance is conservative:
//   - required unknown/unmeasured and required+accepted-absence are hard
//     failures on settled connections, regardless of pill label;
//   - active bounded work is reported as inconclusive, but it does not
//     suppress masked failures;
//   - declared-stream count absence fails only when the canonical
//     record-snapshot evidence is current, otherwise it stays inconclusive.

/** Loosely-shaped ConnectorSummary/CollectionReportEntry — read via optional chaining, never assumed complete. */
type Connection = Record<string, unknown>;

const ACTIVE_PILL_LABELS = new Set(["Checking", "Syncing"]);

// Accepted-absence coverage conditions. On a NON-required stream these are
// accepted postures and are not debt. On a REQUIRED stream they are a
// contradictory manifest (load-bearing AND accepted-absent) — the coverage
// projection refuses to project healthy for exactly this combination
// (`pickRequiredAcceptedCoverage` in
// reference-implementation/server/connector-coverage-policy.ts), so a
// Healthy pill over one is a masked failure.
const ACCEPTED_ABSENCE_CONDITIONS = new Set(["deferred", "inventory_only", "unavailable", "unsupported"]);

/**
 * @param entry a CollectionReportEntry-shaped object
 * @returns whether this stream is required (default true when the
 *   `required` field is absent — fail closed rather than silently exempting
 *   older collection reports).
 */
function isRequiredEntry(entry: unknown): boolean {
  if (entry && typeof entry === "object" && "required" in entry) {
    return (entry as Connection).required !== false;
  }
  return true;
}

/**
 * A stream rests at unmeasured coverage when its coverage condition is
 * `unknown` or its forward disposition is `unmeasured`. Both are checked
 * because either axis alone can carry the resting-unmeasured signal
 * depending on which layer normalized the entry.
 */
function restsUnmeasured(entry: Connection): boolean {
  const coverage = entry.coverage_condition;
  const disposition = entry.forward_disposition;
  return coverage === "unknown" || disposition === "unmeasured";
}

// A connection is "settled" only once its first enrollment/credential-capture
// step has completed. A `draft` connection (owner-state resolver
// `setup_in_progress`, per fix-pending-connection-discovery) is intentionally
// discoverable on owner-facing surfaces before it has any coverage evidence
// at all — that is the product contract, not a defect. Judging it against
// the settled-failure bar would fail every fresh connection on the very
// first read after creation. Both signals are checked because either can be
// the more current one depending on which layer served the entry.
function isSettledConnection(connection: Connection): boolean {
  const { status } = connection;
  if (status === "revoked" || connection.revoked_at !== null) {
    return false;
  }
  if (status === "draft") {
    return false;
  }
  if ((connection.owner_state as Connection | undefined)?.resolver === "setup_in_progress") {
    return false;
  }
  return true;
}

function hasActiveBoundedWork(connection: Connection): boolean {
  const ownerState = connection.owner_state as Connection | undefined;
  const health = connection.connection_health as Connection | undefined;
  const pillLabel = ((connection.rendered_verdict as Connection | undefined)?.pill as Connection | undefined)?.label;
  return (
    ownerState?.resolver === "collecting" ||
    (health?.badges as Connection | undefined)?.syncing === true ||
    pillLabel === "Checking" ||
    pillLabel === "Syncing" ||
    ACTIVE_PILL_LABELS.has(pillLabel as string)
  );
}

function recordSnapshotIsCurrent(connection: Connection): boolean {
  return (connection.record_snapshot as Connection | undefined)?.state === "current";
}

function declaredStreamNames(connection: Connection): string[] {
  const declared = Array.isArray(connection.streams) ? (connection.streams as unknown[]) : [];
  return declared.filter((stream): stream is string => typeof stream === "string" && stream.length > 0);
}

function reportStreamNames(report: readonly Connection[]): string[] {
  const declared = new Set<string>();
  const names: string[] = [];
  for (const entry of Array.isArray(report) ? report : []) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const stream = typeof entry.stream === "string" ? entry.stream : null;
    if (!stream || declared.has(stream)) {
      continue;
    }
    declared.add(stream);
    names.push(stream);
  }
  return names;
}

function streamRecordsByName(connection: Connection): Map<string, Connection> {
  const records = new Map<string, Connection>();
  for (const entry of Array.isArray(connection.stream_records) ? (connection.stream_records as Connection[]) : []) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const stream = typeof entry.stream === "string" ? entry.stream : null;
    if (!stream) {
      continue;
    }
    records.set(stream, entry);
  }
  return records;
}

function connectionLabel(connection: Connection): string {
  return String(
    connection.display_name ||
      connection.connector_display_name ||
      connection.connection_id ||
      connection.connector_instance_id ||
      connection.connector_id ||
      "<unknown connection>"
  );
}

function connectionId(connection: Connection): string | null {
  const id = connection.connection_id ?? connection.connector_instance_id ?? connection.connector_id ?? null;
  return typeof id === "string" ? id : null;
}

/**
 * Evidence class for a masked required stream. These classes state what the
 * served entry shows, not an inferred cause:
 *
 *   - "strategy_declaration_missing": the served collection-report entry has
 *     no `coverage_strategy`. (Suggests investigating whether the STORED
 *     manifest predates the shipped strategy declarations or was never
 *     reconciled — but the oracle only asserts the missing declaration.)
 *   - "runtime_evidence_missing": the strategy is declared, but the entry
 *     rests unmeasured anyway — no committed checkpoint, considered
 *     denominator, or skip fact resolved the stream. (Suggests investigating
 *     the connector's coverage-evidence emission — but the oracle only
 *     asserts the missing runtime evidence.)
 *   - "declared_stream_count_unavailable": canonical record-snapshot
 *     evidence is not current, so the audit cannot prove an exact zero.
 *   - "accepted_absence_on_required": the entry is required AND carries an
 *     accepted-absence coverage condition — the contradictory-manifest
 *     combination the projection refuses to paint green.
 */
type StreamCoverageClass = "accepted_absence_on_required" | "runtime_evidence_missing" | "strategy_declaration_missing";

function evidenceClassForUnmeasured(entry: Connection): StreamCoverageClass {
  if (entry.coverage_strategy === null) {
    return "strategy_declaration_missing";
  }
  return "runtime_evidence_missing";
}

function streamCoverageClass(entry: Connection): StreamCoverageClass | null {
  if (restsUnmeasured(entry)) {
    return evidenceClassForUnmeasured(entry);
  }
  if (ACCEPTED_ABSENCE_CONDITIONS.has(entry.coverage_condition as string)) {
    return "accepted_absence_on_required";
  }
  return null;
}

/**
 * Audit a set of connector summaries for required streams without a
 * resolved coverage posture beneath a settled verdict.
 *
 * A failure = a settled connection with a required collection-report entry
 * that either (a) rests at unknown/unmeasured coverage, or (b) carries an
 * accepted-absence coverage condition (accepted absence is only a resolved
 * posture for non-required streams). Active bounded work and unreliable
 * non-current canonical record-snapshot evidence makes the audit
 * inconclusive rather than passing.
 * Active bounded work is still reported as inconclusive, but it does not
 * hide masked failures.
 *
 * @param connections
 */
export interface StreamHealthConnectionResult {
  connection_id: string | null;
  connection_label: string;
  streams: { class: string; stream: string }[];
}

export interface StreamHealthAuditResult {
  failures: StreamHealthConnectionResult[];
  inconclusive: StreamHealthConnectionResult[];
  ok: boolean;
  status: "fail" | "inconclusive" | "pass";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the machine audit's per-connection/per-stream classification logic is deliberately exhaustive (settled/active/masked/unsettled) — carried over unchanged from the .mjs source.
export function auditStreamHealth(connections: readonly unknown[]): StreamHealthAuditResult {
  const failures: StreamHealthConnectionResult[] = [];
  const inconclusive: StreamHealthConnectionResult[] = [];

  for (const connection of (Array.isArray(connections) ? connections : []) as Connection[]) {
    if (!isSettledConnection(connection)) {
      continue;
    }

    const report = (Array.isArray(connection.collection_report) ? connection.collection_report : []) as Connection[];
    const maskedStreams: { class: string; stream: string }[] = [];
    const maskedStreamClasses = new Set<string>();
    const unsettledStreams: { class: string; stream: string }[] = [];
    const unsettledStreamClasses = new Set<string>();

    function pushMasked(stream: string, streamClass: string): void {
      const key = `${stream}\n${streamClass}`;
      if (maskedStreamClasses.has(key)) {
        return;
      }
      maskedStreamClasses.add(key);
      maskedStreams.push({ stream, class: streamClass });
    }

    function pushUnsettled(stream: string, streamClass: string): void {
      const key = `${stream}\n${streamClass}`;
      if (unsettledStreamClasses.has(key)) {
        return;
      }
      unsettledStreamClasses.add(key);
      unsettledStreams.push({ stream, class: streamClass });
    }

    const activeBoundedWork = hasActiveBoundedWork(connection);
    const recordSnapshotCurrent = recordSnapshotIsCurrent(connection);
    const declaredStreams = declaredStreamNames(connection);
    const declaredStreamSet = new Set(declaredStreams);
    const reportOnlyStreams = reportStreamNames(report).filter((stream) => !declaredStreamSet.has(stream));
    const auditedStreams = declaredStreams.concat(reportOnlyStreams);
    const streamRecords = streamRecordsByName(connection);

    for (const stream of auditedStreams) {
      const reportEntry = report.find((entry) => entry?.stream === stream);
      if (!reportEntry) {
        if (recordSnapshotCurrent) {
          pushMasked(stream, "runtime_evidence_missing");
        } else {
          pushUnsettled(stream, "declared_stream_count_unavailable");
        }
        continue;
      }

      if (isRequiredEntry(reportEntry)) {
        const streamClass = streamCoverageClass(reportEntry);
        if (streamClass) {
          pushMasked(stream, streamClass);
        }
      }

      const record = streamRecords.get(stream);
      if (record) {
        continue;
      }
      if (!recordSnapshotCurrent) {
        pushUnsettled(stream, "declared_stream_count_unavailable");
        continue;
      }
      pushMasked(stream, "runtime_evidence_missing");
    }

    if (activeBoundedWork) {
      inconclusive.push({
        connection_id: connectionId(connection),
        connection_label: connectionLabel(connection),
        streams: [{ stream: "<active bounded work>", class: "active_bounded_work" }],
      });
    }

    if (unsettledStreams.length > 0) {
      inconclusive.push({
        connection_id: connectionId(connection),
        connection_label: connectionLabel(connection),
        streams: unsettledStreams,
      });
    }

    if (maskedStreams.length > 0) {
      failures.push({
        connection_id: connectionId(connection),
        connection_label: connectionLabel(connection),
        streams: maskedStreams,
      });
    }
  }

  let status: "fail" | "inconclusive" | "pass";
  if (failures.length > 0) {
    status = "fail";
  } else if (inconclusive.length > 0) {
    status = "inconclusive";
  } else {
    status = "pass";
  }
  return { ok: status === "pass", status, failures, inconclusive };
}
