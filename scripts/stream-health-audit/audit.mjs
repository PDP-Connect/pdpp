// Pure machine audit: a required stream without a resolved coverage posture
// SHALL never hide beneath a Healthy connection verdict.
//
// Implements openspec/changes/define-stream-coverage-freshness-evidence
// specs/reference-connection-health/spec.md requirement "A reproducible
// machine audit SHALL fail on unmeasured required streams beneath Healthy"
// (tasks.md 9.1).
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
// The Healthy pill is audited unconditionally — there is NO active-run
// exemption. Under active bounded work the verdict contract renders
// Syncing/Checking, never Healthy, so a Healthy pill coexisting with an
// active run AND a required-unknown stream is an internally impossible
// snapshot; it fails through the normal path rather than being excused.

const HEALTHY_LABEL = "Healthy";

// Accepted-absence coverage conditions. On a NON-required stream these are
// accepted postures and are not debt. On a REQUIRED stream they are a
// contradictory manifest (load-bearing AND accepted-absent) — the coverage
// projection refuses to project healthy for exactly this combination
// (`pickRequiredAcceptedCoverage` in
// reference-implementation/server/connector-coverage-policy.ts), so a
// Healthy pill over one is a masked failure.
const ACCEPTED_ABSENCE_CONDITIONS = new Set(["deferred", "inventory_only", "unavailable", "unsupported"]);

/**
 * @param {unknown} entry a CollectionReportEntry-shaped object
 * @returns {boolean} whether this stream is required (default true when the
 *   `required` field is absent — fail closed rather than silently exempting
 *   older collection reports).
 */
function isRequiredEntry(entry) {
  if (entry && typeof entry === "object" && "required" in entry) {
    return entry.required !== false;
  }
  return true;
}

/**
 * A stream rests at unmeasured coverage when its coverage condition is
 * `unknown` or its forward disposition is `unmeasured`. Both are checked
 * because either axis alone can carry the resting-unmeasured signal
 * depending on which layer normalized the entry.
 */
function restsUnmeasured(entry) {
  const coverage = entry?.coverage_condition;
  const disposition = entry?.forward_disposition;
  return coverage === "unknown" || disposition === "unmeasured";
}

function isHealthyPill(verdict) {
  const pill = verdict?.pill;
  return !!pill && typeof pill === "object" && pill.label === HEALTHY_LABEL;
}

function connectionLabel(connection) {
  return (
    connection?.display_name ||
    connection?.connector_display_name ||
    connection?.connection_id ||
    connection?.connector_instance_id ||
    connection?.connector_id ||
    "<unknown connection>"
  );
}

function connectionId(connection) {
  return connection?.connection_id ?? connection?.connector_instance_id ?? connection?.connector_id ?? null;
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
 *   - "accepted_absence_on_required": the entry is required AND carries an
 *     accepted-absence coverage condition — the contradictory-manifest
 *     combination the projection refuses to paint green.
 */
function evidenceClassForUnmeasured(entry) {
  if (entry?.coverage_strategy == null) {
    return "strategy_declaration_missing";
  }
  return "runtime_evidence_missing";
}

/**
 * Audit a set of connector summaries for required streams without a
 * resolved coverage posture beneath a Healthy verdict.
 *
 * A failure = a Healthy-pill connection with a required collection-report
 * entry that either (a) rests at unknown/unmeasured coverage, or (b)
 * carries an accepted-absence coverage condition (accepted absence is only
 * a resolved posture for non-required streams). There is no active-run
 * exemption; see the module comment.
 *
 * @param {readonly unknown[]} connections
 * @returns {{ ok: boolean, failures: Array<{
 *   connection_id: string|null,
 *   connection_label: string,
 *   streams: Array<{ stream: string,
 *     class: "strategy_declaration_missing"|"runtime_evidence_missing"|"accepted_absence_on_required" }>,
 * }> }}
 */
export function auditStreamHealth(connections) {
  const failures = [];

  for (const connection of Array.isArray(connections) ? connections : []) {
    if (!isHealthyPill(connection?.rendered_verdict)) {
      continue;
    }

    const report = Array.isArray(connection?.collection_report) ? connection.collection_report : [];
    const maskedStreams = [];
    for (const entry of report) {
      if (!isRequiredEntry(entry)) {
        continue;
      }
      if (restsUnmeasured(entry)) {
        maskedStreams.push({
          stream: String(entry?.stream ?? "<unknown stream>"),
          class: evidenceClassForUnmeasured(entry),
        });
        continue;
      }
      if (ACCEPTED_ABSENCE_CONDITIONS.has(entry?.coverage_condition)) {
        maskedStreams.push({
          stream: String(entry?.stream ?? "<unknown stream>"),
          class: "accepted_absence_on_required",
        });
      }
    }

    if (maskedStreams.length > 0) {
      failures.push({
        connection_id: connectionId(connection),
        connection_label: connectionLabel(connection),
        streams: maskedStreams,
      });
    }
  }

  return { ok: failures.length === 0, failures };
}
