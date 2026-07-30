// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from "../args.ts";
import { PdppCliError, PdppUsageError } from "../errors.ts";
import { fetchJson, ownerSessionHeaders, resolveReferenceUrl } from "../fetch.ts";
import { validateListEnvelope } from "../list-envelope.ts";
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

/** Reference's own page-size ceiling (`CONNECTOR_SUMMARY_PAGE_LIMIT_MAX`). */
const CONNECTOR_SUMMARY_PAGE_LIMIT_MAX = 100;
/** Hard stop on `--all` page-following so a broken/never-ending cursor can't loop forever. */
const CONNECTOR_SUMMARY_MAX_PAGES = 1000;

interface ConnectorSummaryPageBody {
  data?: ConnectorSummary[];
  has_more?: boolean;
  next_cursor?: string | null;
}

async function fetchConnectorSummaryPage(
  asUrl: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  opts: { cursor?: string; limit: number }
): Promise<{ body: ConnectorSummaryPageBody; rawBody: unknown }> {
  const url = new URL(`${asUrl}/_ref/connectors`);
  url.searchParams.set("limit", String(opts.limit));
  if (opts.cursor) {
    url.searchParams.set("cursor", opts.cursor);
  }
  const { body } = await fetchJson(url, { headers }, fetchImpl);
  return { body: body as ConnectorSummaryPageBody, rawBody: body };
}

interface ListFlags {
  all: boolean;
  cursor: string | undefined;
  limit: number;
  verbose: boolean;
}

function parseListFlags(flags: Record<string, string | boolean>): ListFlags {
  const requestedLimit = typeof flags.limit === "string" ? Number(flags.limit) : Number.NaN;
  const limit =
    Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, CONNECTOR_SUMMARY_PAGE_LIMIT_MAX)
      : CONNECTOR_SUMMARY_PAGE_LIMIT_MAX;
  return {
    all: flags.all === true || flags.all === "true",
    cursor: typeof flags.cursor === "string" ? flags.cursor : undefined,
    limit,
    verbose: flags.verbose === true || flags.verbose === "true",
  };
}

interface CollectedPages {
  cursor: string | undefined;
  envelopes: unknown[];
  hasMore: boolean;
  lastRawBody: unknown;
  pages: number;
  rows: ConnectorSummary[];
}

/**
 * Malformed-continuation error thrown by `collectConnectorSummaryPages` — an
 * envelope that fails the shared `validateListEnvelope` contract (wrong
 * discriminator, non-array `data`, non-boolean `has_more`, or an incoherent
 * continuation — including a blank-after-trim `next_cursor`), or a
 * `next_cursor` that repeats a cursor already consumed in this same
 * page-following run (the self-loop case, and the general repeated-cursor
 * case once more than one prior cursor has been seen). All of these would
 * otherwise either silently stop (looking identical to a genuinely
 * exhausted feed) or loop forever — this surfaces the exact resumable
 * cursor instead.
 */
class MalformedContinuationError extends PdppCliError {
  readonly resumeCursor: string;
  constructor(message: string, resumeCursor: string) {
    super(message, 6, { resumeCursor });
    this.name = "MalformedContinuationError";
    this.resumeCursor = resumeCursor;
  }
}

/**
 * Thrown when `--all` hits `CONNECTOR_SUMMARY_MAX_PAGES` with more
 * connectors remaining. This is a FAILURE, not a partial success: automation
 * consuming `--all` output must never receive success-shaped (exit 0)
 * output that silently omits rows past the cap. The exact resumable cursor
 * is threaded through so a caller can pick up with `--cursor` manually.
 */
class PageCapExceededError extends PdppCliError {
  readonly resumeCursor: string;
  constructor(pages: number, resumeCursor: string) {
    super(
      `--all stopped after ${pages} pages (safety cap of ${CONNECTOR_SUMMARY_MAX_PAGES}) with more connectors remaining; resume with --cursor ${resumeCursor}`,
      7,
      { resumeCursor }
    );
    this.name = "PageCapExceededError";
    this.resumeCursor = resumeCursor;
  }
}

/**
 * Fetch page 1, then (only with `--all`) keep following `next_cursor` until
 * exhaustion or `CONNECTOR_SUMMARY_MAX_PAGES` — a backstop against a broken/
 * never-terminating cursor, never a silent "good enough" completion. Hitting
 * the cap while more remain THROWS `PageCapExceededError` (non-zero exit,
 * nothing printed to stdout) rather than returning a success-shaped partial
 * result.
 *
 * Every envelope is validated by the shared `validateListEnvelope` (the same
 * strict contract the console pager, Explore, and the live-audit script
 * use). A `next_cursor` that repeats any cursor already consumed this run
 * (immediate OR non-adjacent) throws `MalformedContinuationError` rather
 * than silently treating it as "no more pages" or looping forever.
 *
 * `seenCursors` is a full in-memory visited-cursor set (`Set<string |
 * undefined>`, plain function-scoped local — created fresh on every call,
 * never `globalThis`, never keyed by anything a caller supplies) held for
 * the lifetime of ONE `--all` run. That is deliberately NOT the shape the
 * interactive console/Explore pagers use (see
 * `apps/console/.../connector-summary-page.tsx`'s module doc): those reject
 * only an immediate self-loop and keep no cross-request history at all,
 * because an interactive pager's caller-supplied key (a `nav`/session token)
 * would be forgeable and unbounded across many concurrent owners/requests.
 * `--all` has neither problem — it is one unattended, single-process loop
 * with no user interaction between pages and no externally-supplied key to
 * forge, so a full local visited-set here is the correct, minimal tool, not
 * a shortcut.
 */
async function collectConnectorSummaryPages(
  asUrl: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  listFlags: ListFlags
): Promise<CollectedPages> {
  const rows: ConnectorSummary[] = [];
  const envelopes: unknown[] = [];
  const seenCursors = new Set<string | undefined>([listFlags.cursor]);
  let { cursor } = listFlags;
  let hasMore = false;
  let lastRawBody: unknown;
  let pages = 0;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: each page depends on the previous page's cursor; only reached more than once when --all is passed.
    const { body, rawBody } = await fetchConnectorSummaryPage(
      asUrl,
      headers,
      fetchImpl,
      cursor === undefined ? { limit: listFlags.limit } : { cursor, limit: listFlags.limit }
    );
    lastRawBody = rawBody;
    const validation = validateListEnvelope<ConnectorSummary>(body);
    if (validation.kind === "invalid") {
      throw new MalformedContinuationError(
        `the server returned a malformed connector-summary page after page ${pages + 1} (${validation.reason})`,
        cursor ?? ""
      );
    }
    envelopes.push(rawBody);
    rows.push(...validation.data);
    ({ hasMore } = validation);
    pages += 1;
    if (hasMore) {
      const nextCursor = validation.nextCursor as string;
      if (seenCursors.has(nextCursor)) {
        throw new MalformedContinuationError(
          `the server returned a repeated/self-looping next_cursor ("${nextCursor}") after page ${pages} — resume manually once the reference server's cursor bug is fixed`,
          cursor ?? ""
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (listFlags.all && pages >= CONNECTOR_SUMMARY_MAX_PAGES) {
        throw new PageCapExceededError(pages, cursor);
      }
    } else {
      cursor = undefined;
    }
  } while (listFlags.all && hasMore && cursor);
  return { cursor, envelopes, hasMore, lastRawBody, pages, rows };
}

function writeConnectorSummaryList(
  collected: CollectedPages,
  listFlags: ListFlags,
  format: string,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream
): void {
  if (listFlags.verbose) {
    // Merge EVERY collected page's raw envelope, not just the last one — a
    // multi-page --all run must never silently drop earlier pages from the
    // --verbose/json output the same way `rows` never drops them from the
    // projected view.
    const merged =
      collected.envelopes.length > 1
        ? { data: collected.rows, envelopes: collected.envelopes, object: "list" }
        : collected.lastRawBody;
    writeData(format === "table" ? collected.rows : merged, format, out);
  } else {
    const rows = collected.rows.map(projectSummaryRow);
    writeData(format === "table" ? rows.map(projectSummaryTableRow) : { data: rows, object: "list" }, format, out);
  }
  writeEnvelopeWarnings(collected.lastRawBody, err);

  // Never silently truncate: a caller that did not pass --all and still has
  // more pages gets an explicit, visible notice (not a bare exit) telling it
  // exactly how to continue. (The --all + cap-exceeded case never reaches
  // here — collectConnectorSummaryPages throws PageCapExceededError before
  // returning, so that case never prints success-shaped output at all.)
  if (collected.hasMore && collected.cursor && !listFlags.all) {
    err.write(
      `more results available; pass --cursor ${collected.cursor} for the next page, or --all to fetch every page\n`
    );
  }
}

/**
 * `ref connectors list` — bounded by default (one page, `--limit` capped at
 * the reference's own 100-row max), never the bare unparameterized
 * `/_ref/connectors` call (which selects the reference's deprecated
 * unbounded compatibility branch: a full per-connection fan-out plus a
 * full-fleet-scoped evidence reconcile on every request).
 *
 * `--cursor` continues an explicit prior page. `--all` page-follows to
 * exhaustion (bounded by `CONNECTOR_SUMMARY_MAX_PAGES`) — an explicit,
 * visible opt-in, never the silent default. `has_more`/`next_cursor` are
 * always surfaced (in the envelope for `--verbose`/json, and as an explicit
 * stderr notice otherwise) so a truncated fleet is never mistaken for a
 * complete one. `--verbose --format json` on a multi-page `--all` run prints
 * every collected page's envelope, not just the last (see `envelopes` on
 * `CollectedPages`). Every envelope is validated by the shared
 * `validateListEnvelope` (`../list-envelope.ts`); a malformed page or a
 * `next_cursor` that repeats one already consumed this run throws
 * `MalformedContinuationError` (exit code 6) carrying the last-known-good
 * cursor to resume from. `--all` hitting the `CONNECTOR_SUMMARY_MAX_PAGES`
 * safety cap with more remaining throws `PageCapExceededError` (exit code
 * 7) — NOTHING is printed to stdout in that case; automation must never see
 * success-shaped (exit 0) output for a run that silently omitted rows past
 * the cap.
 */
async function runRefConnectorsList(
  flags: Record<string, string | boolean>,
  io: CommandIo,
  fetchImpl: typeof fetch
): Promise<number> {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const asUrl = resolveReferenceUrl(flags);
  const ownerSession = typeof flags["owner-session"] === "string" ? flags["owner-session"] : "";
  const cacheRoot = typeof flags["cache-root"] === "string" ? flags["cache-root"] : undefined;
  const headers = { ...ownerSessionHeaders({ ownerSession, referenceUrl: asUrl, cacheRoot }) };
  const format = resolveFormat(flags, "table", "json");
  const listFlags = parseListFlags(flags);

  const collected = await collectConnectorSummaryPages(asUrl, headers, fetchImpl, listFlags);
  writeConnectorSummaryList(collected, listFlags, format, out, err);
  return 0;
}
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
    return runRefConnectorsList(flags, io, fetchImpl);
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
    "Usage: pdpp ref connectors <list|show <connector-id>> [--as-url <url>] [--owner-session <cookie>] [--format json|table] [--verbose] [--limit <n>] [--cursor <opaque>] [--all]"
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
