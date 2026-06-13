import { parseArgs, requirePositional } from '../args.js';
import { PdppUsageError } from '../errors.js';
import { fetchJson, ownerSessionHeaders, resolveReferenceUrl } from '../fetch.js';
import { resolveFormat, writeData, writeEnvelopeWarnings } from '../output.js';

// Operator-facing summary projection. Mirrors the evidence the dashboard renders
// in `apps/console/src/app/dashboard/lib/ref-client.ts` (RefConnectorSummary +
// RefConnectionHealthSnapshot + RefNextAction). The reference server has
// already redacted secret-bearing fields (e.g. `action_target` for
// `sensitivity: "secret"` attention rows); we surface what arrives, with no
// inference.
function projectSummaryRow(summary) {
  const health = summary?.connection_health || {};
  const axes = health.axes || {};
  const badges = health.badges || {};
  const nextAction = summary?.next_action || health.next_action || null;
  const schedule = summary?.schedule || null;
  const lastRun = summary?.last_run || null;
  const lastSuccess = summary?.last_successful_run || null;
  const latestBatch = summary?.acquisition_coverage?.latest_batch || null;
  const dominantCondition = findConditionById(health.conditions, health.dominant_condition_id);
  return {
    connection_id: summary?.connection_id ?? null,
    connector_id: summary?.connector_id ?? null,
    display_name: summary?.display_name ?? null,
    state: health.state ?? 'unknown',
    coverage: axes.coverage ?? 'unknown',
    freshness: axes.freshness ?? 'unknown',
    attention: axes.attention ?? 'none',
    outbox: axes.outbox ?? 'unknown',
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
    next_action_source: nextAction?.source ?? 'none',
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

function findConditionById(conditions, id) {
  if (!id || !Array.isArray(conditions)) {
    return null;
  }
  return conditions.find((condition) => condition?.id === id) || null;
}

export async function runRefConnectors(argv, io = {}, fetchImpl = globalThis.fetch) {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;

  if (subcommand === 'list') {
    const asUrl = resolveReferenceUrl(flags);
    const ownerSession = flags['owner-session'] || '';
    const cacheRoot = flags['cache-root'];
    const { body } = await fetchJson(
      `${asUrl}/_ref/connectors`,
      { headers: { ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }) } },
      fetchImpl
    );
    const format = resolveFormat(flags, 'table', 'json');
    const verbose = flags.verbose === true || flags.verbose === 'true';
    if (verbose) {
      writeData(format === 'table' ? (body.data || []) : body, format, out);
      writeEnvelopeWarnings(body, err);
      return 0;
    }
    const rows = Array.isArray(body?.data) ? body.data.map(projectSummaryRow) : [];
    writeData(format === 'table' ? rows.map(projectSummaryTableRow) : { object: 'list', data: rows }, format, out);
    writeEnvelopeWarnings(body, err);
    return 0;
  }

  if (subcommand === 'show') {
    const connectorId = requirePositional(positionals, 0, 'connector-id');
    const asUrl = resolveReferenceUrl(flags);
    const ownerSession = flags['owner-session'] || '';
    const cacheRoot = flags['cache-root'];
    const { body } = await fetchJson(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`,
      { headers: { ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }) } },
      fetchImpl
    );
    const format = resolveFormat(flags, 'table', 'json');
    const verbose = flags.verbose === true || flags.verbose === 'true';
    if (verbose) {
      writeData(body, format, out);
      writeEnvelopeWarnings(body, err);
      return 0;
    }
    const row = projectSummaryRow(body);
    writeData(format === 'table' ? [projectSummaryTableRow(row)] : row, format, out);
    writeEnvelopeWarnings(body, err);
    return 0;
  }

  throw new PdppUsageError(
    'Usage: pdpp ref connectors <list|show <connector-id>> [--as-url <url>] [--owner-session <cookie>] [--format json|table] [--verbose]'
  );
}

function projectSummaryTableRow(row) {
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
    next_action_reason: row.next_action_reason,
    latest_acquisition_status: row.latest_acquisition_status,
    latest_acquisition_method: row.latest_acquisition_method,
    latest_acquisition_accepted: row.latest_acquisition_accepted,
    latest_acquisition_end: row.latest_acquisition_end,
    last_success_at: row.last_success_at,
    next_attempt_at: row.next_attempt_at,
  };
}
