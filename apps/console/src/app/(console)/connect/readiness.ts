// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReadinessRow } from "../components/deployment-readiness-rows.ts";
import type { RefConnectorSummary } from "../lib/ref-client.ts";
import { projectSourceActionability } from "../lib/source-actionability.ts";
import { formatTotalRecordsLabel, isTotalRecordsAuthoritative } from "../lib/total-records-label.ts";

export interface SourceReadinessEvidence {
  readonly hasMore: boolean;
  readonly summaries: readonly RefConnectorSummary[] | null;
}

/**
 * Project the existing owner connection summaries into one MCP prerequisite
 * row. This is not a second source-health model: status comes from the
 * server-owned actionability projection, sync success comes from
 * `last_successful_run`, and record presence is accepted only when the
 * summary's count evidence is authoritative.
 */
export function sourceReadinessRow(evidence: SourceReadinessEvidence): ReadinessRow {
  if (evidence.summaries === null) {
    return {
      check: "Usable source data",
      detail: "Source readiness could not be verified from the reference server.",
      hint: "Refresh this page after the reference server responds; do not treat a missing source read as proof that records are available.",
      status: "unknown",
    };
  }

  const usable = evidence.summaries.find(isUsableSource);
  if (usable) {
    const sourceLabel = usable.connector_display_name || usable.display_name || usable.connector_id;
    const successfulAt = usable.last_successful_run?.last_at ?? "an observed time";
    const retainedRecords = formatTotalRecordsLabel(usable.total_records, usable.total_records_state, "records");
    return {
      check: "Usable source data",
      detail: `${sourceLabel} is healthy, completed a successful sync at ${successfulAt}, and retains ${retainedRecords}.`,
      status: "ok",
    };
  }

  if (evidence.hasMore) {
    return {
      check: "Usable source data",
      detail: "The first source page did not prove a usable source, and more source evidence remains unexamined.",
      hint: "Refresh Sources or continue to its next page before treating the deployment as ready.",
      status: "unknown",
    };
  }

  if (evidence.summaries.some(hasUnknownSourceEvidence)) {
    return {
      check: "Usable source data",
      detail:
        "The source projection does not yet provide enough evidence to prove a healthy, synced source with retained records.",
      hint: "Wait for source summary evidence to settle, then refresh. A stale or unobserved count is not retained-record proof.",
      status: "unknown",
    };
  }

  if (evidence.summaries.length === 0) {
    return {
      check: "Usable source data",
      detail: "No source is configured with a successful sync and authoritative retained records.",
      hint: "Add a source, complete its setup, then wait for the first successful sync with at least one retained record.",
      status: "error",
    };
  }

  return {
    check: "Usable source data",
    detail: "Configured sources do not currently project a healthy source with a successful sync and retained records.",
    hint: "Open Sources and follow the server-owned next action; wait for a successful sync and authoritative retained count. Captured credentials or a started sync do not count as readiness.",
    status: "error",
  };
}

function isUsableSource(summary: RefConnectorSummary): boolean {
  const projection = projectSourceActionability(summary);
  return (
    !projection.revoked &&
    projection.renderedStatus.kind === "healthy" &&
    summary.last_successful_run !== null &&
    isTotalRecordsAuthoritative(summary.total_records_state) &&
    Number.isInteger(summary.total_records) &&
    summary.total_records > 0
  );
}

function hasUnknownSourceEvidence(summary: RefConnectorSummary): boolean {
  const projection = projectSourceActionability(summary);
  return projection.renderedStatus.kind === "unknown" || !isTotalRecordsAuthoritative(summary.total_records_state);
}
