// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from "../args.ts";
import { PdppUsageError } from "../errors.ts";
import { fetchJson, ownerSessionHeaders, resolveReferenceUrl } from "../fetch.ts";
import { resolveFormat, writeData, writeEnvelopeWarnings } from "../output.ts";
import type { CommandIo } from "./call.ts";

interface ConditionEntry {
  id?: string;
  message?: string;
  origin?: string;
  reason?: string;
  severity?: string;
  type?: string;
}

interface ConnectionHealth {
  axes?: { coverage?: string; freshness?: string; attention?: string; outbox?: string };
  badges?: { syncing?: boolean; stale?: boolean };
  conditions?: ConditionEntry[];
  dominant_condition_id?: string;
  last_success_at?: string;
  next_action?: unknown;
  next_attempt_at?: string;
  reason_code?: string;
  state?: string;
  supporting_condition_ids?: string[];
  unknown_reasons?: string[];
}

interface RenderedVerdict {
  channel?: string;
  forward_statement?: string;
  pill?: { label?: string; tone?: string };
  required_actions?: RequiredAction[];
}

interface RequiredAction {
  audience?: string;
  cta?: string;
  kind?: string;
  satisfied_when?: { kind?: string };
  terminal?: boolean;
}

interface NextAction {
  action_target?: string;
  expires_at?: string;
  owner_action?: string;
  reason_code?: string;
  source?: string;
}

interface AcquisitionBatch {
  accepted_count?: number;
  acquisition_method?: string;
  batch_id?: string;
  date_range?: { start?: string; end?: string };
  detected_format?: string;
  duplicate_count?: number;
  failed_count?: number;
  parsed_count?: number;
  skipped_count?: number;
  status?: string;
  uploaded_file_name?: string;
  warnings?: unknown[];
}

interface ConnectorSummary {
  acquisition_coverage?: { latest_batch?: AcquisitionBatch };
  connection_health?: ConnectionHealth;
  connection_id?: string;
  connector_id?: string;
  display_name?: string;
  last_run?: { last_at?: string; status?: string };
  last_successful_run?: { last_at?: string };
  next_action?: NextAction;
  rendered_verdict?: RenderedVerdict;
  schedule?: { next_due_at?: string };
}

interface ProjectedSummaryRow {
  attention: string;
  connection_id: string | null;
  connector_id: string | null;
  coverage: string;
  display_name: string | null;
  dominant_condition_id: string | null;
  dominant_condition_message: string | null;
  dominant_condition_origin: string | null;
  dominant_condition_reason: string | null;
  dominant_condition_severity: string | null;
  dominant_condition_type: string | null;
  freshness: string;
  last_run_at: string | null;
  last_run_status: string | null;
  last_success_at: string | null;
  latest_acquisition_accepted: number | null;
  latest_acquisition_batch_id: string | null;
  latest_acquisition_duplicates: number | null;
  latest_acquisition_end: string | null;
  latest_acquisition_failed: number | null;
  latest_acquisition_file: string | null;
  latest_acquisition_format: string | null;
  latest_acquisition_method: string | null;
  latest_acquisition_parsed: number | null;
  latest_acquisition_skipped: number | null;
  latest_acquisition_start: string | null;
  latest_acquisition_status: string | null;
  latest_acquisition_warnings: number;
  next_action_expires_at: string | null;
  next_action_owner_action: string | null;
  next_action_reason: string | null;
  next_action_source: string;
  next_action_target: string | null;
  next_attempt_at: string | null;
  outbox: string;
  primary_action_audience: string | null;
  primary_action_cta: string | null;
  primary_action_kind: string | null;
  primary_action_satisfied_when: string | null;
  primary_action_terminal: boolean | null;
  reason_code: string | null;
  rendered_verdict_channel: string | null;
  rendered_verdict_label: string | null;
  rendered_verdict_statement: string | null;
  rendered_verdict_tone: string | null;
  stale: boolean;
  state: string;
  supporting_condition_ids: string[];
  syncing: boolean;
  unknown_reasons: string[];
}

// Operator-facing summary projection. Mirrors the evidence the dashboard renders
// in `apps/console/src/app/(console)/lib/ref-client.ts` (RefConnectorSummary +
// RefConnectionHealthSnapshot + RefRenderedVerdict). The reference server has
// already redacted secret-bearing fields; we surface what arrives, with no
// connector-string inference.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a flat field-by-field projection from the wire ConnectorSummary shape to the flat ProjectedSummaryRow table shape (mirrors the console's ref-client.ts projection 1:1); splitting would scatter one summary's fields across helpers for no reduction in real complexity, and risks the console/CLI projections drifting out of sync.
function projectSummaryRow(summary: ConnectorSummary): ProjectedSummaryRow {
  const health = summary.connection_health || {};
  const axes = health.axes || {};
  const badges = health.badges || {};
  const nextAction = summary.next_action || null;
  const verdict = summary.rendered_verdict || null;
  const primaryAction = Array.isArray(verdict?.required_actions) ? (verdict.required_actions[0] ?? null) : null;
  const schedule = summary.schedule || null;
  const lastRun = summary.last_run || null;
  const lastSuccess = summary.last_successful_run || null;
  const latestBatch = summary.acquisition_coverage?.latest_batch || null;
  const dominantCondition = findConditionById(health.conditions, health.dominant_condition_id);
  return {
    connection_id: summary.connection_id ?? null,
    connector_id: summary.connector_id ?? null,
    display_name: summary.display_name ?? null,
    state: health.state ?? "unknown",
    coverage: axes.coverage ?? "unknown",
    freshness: axes.freshness ?? "unknown",
    attention: axes.attention ?? "none",
    outbox: axes.outbox ?? "unknown",
    syncing: badges.syncing === true,
    stale: badges.stale === true,
    reason_code: health.reason_code ?? null,
    dominant_condition_id: health.dominant_condition_id ?? null,
    dominant_condition_type: dominantCondition?.type ?? null,
    dominant_condition_reason: dominantCondition?.reason ?? null,
    dominant_condition_severity: dominantCondition?.severity ?? null,
    dominant_condition_message: dominantCondition?.message ?? null,
    dominant_condition_origin: dominantCondition?.origin ?? null,
    supporting_condition_ids: Array.isArray(health.supporting_condition_ids) ? health.supporting_condition_ids : [],
    unknown_reasons: Array.isArray(health.unknown_reasons) ? health.unknown_reasons : [],
    rendered_verdict_label: verdict?.pill?.label ?? null,
    rendered_verdict_tone: verdict?.pill?.tone ?? null,
    rendered_verdict_channel: verdict?.channel ?? null,
    rendered_verdict_statement: verdict?.forward_statement ?? null,
    primary_action_kind: primaryAction?.kind ?? null,
    primary_action_audience: primaryAction?.audience ?? null,
    primary_action_cta: primaryAction?.cta ?? null,
    primary_action_satisfied_when: primaryAction?.satisfied_when?.kind ?? null,
    primary_action_terminal: primaryAction?.terminal ?? null,
    next_action_source: nextAction?.source ?? "none",
    next_action_reason: nextAction?.reason_code ?? null,
    next_action_owner_action: nextAction?.owner_action ?? null,
    next_action_target: nextAction?.action_target ?? null,
    next_action_expires_at: nextAction?.expires_at ?? null,
    last_run_at: lastRun?.last_at ?? null,
    last_run_status: lastRun?.status ?? null,
    last_success_at: health.last_success_at ?? lastSuccess?.last_at ?? null,
    next_attempt_at: health.next_attempt_at ?? schedule?.next_due_at ?? null,
    latest_acquisition_batch_id: latestBatch?.batch_id ?? null,
    latest_acquisition_status: latestBatch?.status ?? null,
    latest_acquisition_method: latestBatch?.acquisition_method ?? null,
    latest_acquisition_format: latestBatch?.detected_format ?? null,
    latest_acquisition_file: latestBatch?.uploaded_file_name ?? null,
    latest_acquisition_start: latestBatch?.date_range?.start ?? null,
    latest_acquisition_end: latestBatch?.date_range?.end ?? null,
    latest_acquisition_parsed: latestBatch?.parsed_count ?? null,
    latest_acquisition_accepted: latestBatch?.accepted_count ?? null,
    latest_acquisition_duplicates: latestBatch?.duplicate_count ?? null,
    latest_acquisition_skipped: latestBatch?.skipped_count ?? null,
    latest_acquisition_failed: latestBatch?.failed_count ?? null,
    latest_acquisition_warnings: Array.isArray(latestBatch?.warnings) ? latestBatch.warnings.length : 0,
  };
}

function findConditionById(conditions: ConditionEntry[] | undefined, id: string | undefined): ConditionEntry | null {
  if (!(id && Array.isArray(conditions))) {
    return null;
  }
  return conditions.find((condition) => condition?.id === id) || null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: two subcommands (list/show) each with a verbose/projected branch, dispatched by a flat if-chain; splitting would scatter each subcommand's request/format/output handling across helpers for no reduction in real complexity.
export async function runRefConnectors(
  argv: string[],
  io: CommandIo = {},
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<number> {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;

  if (subcommand === "list") {
    const asUrl = resolveReferenceUrl(flags);
    const ownerSession = typeof flags["owner-session"] === "string" ? flags["owner-session"] : "";
    const cacheRoot = typeof flags["cache-root"] === "string" ? flags["cache-root"] : undefined;
    const { body } = await fetchJson(
      `${asUrl}/_ref/connectors`,
      { headers: { ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }) } },
      fetchImpl
    );
    const format = resolveFormat(flags, "table", "json");
    const verbose = flags.verbose === true || flags.verbose === "true";
    const typedBody = body as { data?: ConnectorSummary[] };
    if (verbose) {
      writeData(format === "table" ? typedBody.data || [] : body, format, out);
      writeEnvelopeWarnings(body, err);
      return 0;
    }
    const rows = Array.isArray(typedBody.data) ? typedBody.data.map(projectSummaryRow) : [];
    writeData(format === "table" ? rows.map(projectSummaryTableRow) : { object: "list", data: rows }, format, out);
    writeEnvelopeWarnings(body, err);
    return 0;
  }

  if (subcommand === "show") {
    const connectorId = requirePositional(positionals, 0, "connector-id");
    const asUrl = resolveReferenceUrl(flags);
    const ownerSession = typeof flags["owner-session"] === "string" ? flags["owner-session"] : "";
    const cacheRoot = typeof flags["cache-root"] === "string" ? flags["cache-root"] : undefined;
    const { body } = await fetchJson(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`,
      { headers: { ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }) } },
      fetchImpl
    );
    const format = resolveFormat(flags, "table", "json");
    const verbose = flags.verbose === true || flags.verbose === "true";
    if (verbose) {
      writeData(body, format, out);
      writeEnvelopeWarnings(body, err);
      return 0;
    }
    const row = projectSummaryRow(body as ConnectorSummary);
    writeData(format === "table" ? [projectSummaryTableRow(row)] : row, format, out);
    writeEnvelopeWarnings(body, err);
    return 0;
  }

  throw new PdppUsageError(
    "Usage: pdpp ref connectors <list|show <connector-id>> [--as-url <url>] [--owner-session <cookie>] [--format json|table] [--verbose]"
  );
}

function projectSummaryTableRow(row: ProjectedSummaryRow) {
  return {
    connection_id: row.connection_id,
    connector_id: row.connector_id,
    display_name: row.display_name,
    state: row.state,
    coverage: row.coverage,
    freshness: row.freshness,
    attention: row.attention,
    outbox: row.outbox,
    syncing: row.syncing,
    stale: row.stale,
    reason_code: row.reason_code,
    dominant_condition_reason: row.dominant_condition_reason,
    rendered_verdict_label: row.rendered_verdict_label,
    rendered_verdict_tone: row.rendered_verdict_tone,
    primary_action_kind: row.primary_action_kind,
    primary_action_cta: row.primary_action_cta,
    latest_acquisition_status: row.latest_acquisition_status,
    latest_acquisition_method: row.latest_acquisition_method,
    latest_acquisition_accepted: row.latest_acquisition_accepted,
    latest_acquisition_end: row.latest_acquisition_end,
    last_success_at: row.last_success_at,
    next_attempt_at: row.next_attempt_at,
  };
}
