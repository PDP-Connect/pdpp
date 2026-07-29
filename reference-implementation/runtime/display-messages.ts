// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reason-code → end-user display-message registry.
 *
 * The Plaid three-layer copy model: every connector reason code carries
 * three messages through the spine —
 *
 *   - machine `reason_code`       (engineers, audit log)
 *   - engineer `reason_message`   (logs, debug surfaces)
 *   - end-user `display_message`  (dashboard pill, toasts)
 *
 * This file is the *single source of truth* for the end-user layer. The
 * UI never synthesizes its own copy from a raw `reason_code`; if a code
 * is not in this registry, `displayMessageFor` returns `null` and the
 * caller is responsible for whatever loud-and-honest fallback copy it
 * wants to show.
 *
 * The discipline is enforced by `test/display-messages.test.js`, which
 * scans every connector's `index.ts` for emitted `reason` literals and
 * asserts the registry has a vetted message for each one. If a connector
 * starts raising a new code, the test fails — and the right fix is to
 * add an entry here, not to weaken the test.
 *
 * Copy guidelines (borrowed from Plaid / Linear naming insight):
 *   - End-user language, never protocol jargon.
 *   - Present tense, action-oriented where possible.
 *   - Never expose the raw code as the value (registry values must not
 *     equal their keys — that just relocates the confusion).
 *   - Empty strings are forbidden.
 */

/**
 * Registry of vetted end-user copy. Keep keys lowercase snake_case
 * matching connector emission literals; values are user-readable English.
 *
 * Day-one entries enumerate every reason code that connectors in
 * `packages/polyfill-connectors/connectors/*` emit today (verified by
 * the registry completeness test), plus the forward-looking codes
 * documented in the design brief §3.4 / Worker E §6.3.
 */
export const DISPLAY_MESSAGES: Record<string, string> = {
  // ─── Connector SKIP_RESULT reasons (catalog scan) ──────────────────────
  ambiguous_multi_account_overview: "We couldn't tell which account view to use",
  archive_not_found: "We couldn't find an export archive to read",

  // ─── Chase statements-PDF probe diagnostics ────────────────────────────
  // Emitted by `chase` during HTTP-response inspection while scanning the
  // statements page. These three are diagnostic-bucket reasons (matched
  // probe / unmatched probe / probe error), but the completeness test
  // scans every `reason: "<code>"` literal in connector source, so they
  // need vetted end-user copy here too. Reaching the dashboard layer
  // would be unusual but should still read like English, not protocol
  // jargon.
  body_error: "We hit a problem reading a Chase statement page",
  chatgpt_login_unexpected_ui: "ChatGPT needs you to sign in again",
  claude_api_wiring_pending: "Claude API support isn't wired up yet",
  claude_dir_not_found: "We couldn't find your Claude Code data folder",
  cloudflare_challenge: "Cloudflare is checking it's really you",
  consent_expiring_soon: "Your sign-in will expire soon",
  controller_restarted: "We restarted in the middle — we'll try again",
  credit_card_export_unverified: "We couldn't confirm the credit card export",
  // 2026-06-04 baseline repair: these reason literals are emitted by
  // connectors but were missing vetted copy, so the registry completeness
  // test was red and the dashboard would have shown `null` for a real code.
  // Codes that surface through a `reason:` ternary (missing_mapping,
  // csv_no_data_rows, csv_no_usable_transactions) were also invisible to the
  // scan until it was taught to read ternary literals — they are included here
  // so the now-stricter scan stays green. Copy stays operator/end-user voice.
  csv_no_data_rows: "The transactions file had no rows to import",
  csv_no_usable_transactions: "We couldn't find any usable transactions in that file",
  // ─── Amazon order-detail diagnostics ─────────────────────────────────────
  deferred: "We paused this item and will pick it up on the next run",
  deferred_budget: "We saved the current batch and deferred the rest to keep this run bounded",
  doordash_graphql_wiring_pending: "DoorDash support isn't wired up yet",
  empty_detail: "We opened this conversation but found no messages to import",
  // ─── WhatsApp chat export reason codes ────────────────────────────────────
  empty_export: "That WhatsApp export did not contain any messages to import",
  empty_first_page_without_diagnostics: "The first page came back empty and we couldn't tell why",
  empty_first_page_without_terminal_signal: "The first page came back empty with no sign it was really the end",
  empty_page_before_max_page:
    "We hit an empty page of orders before we expected to, so we stopped to check rather than assume we were done",
  export_affordance_missing: "We couldn't find the export controls on this page — the site may have changed",
  export_error: "The export couldn't be downloaded",
  export_no_download: "The export didn't produce a downloadable file",
  export_not_found: "We couldn't find an export to import",
  failed: "We couldn't finish this item on this run",
  heb_dom_wiring_pending: "H-E-B support isn't wired up yet",
  history_not_found: "We couldn't find any history to import",
  http_error: "We hit a network problem talking to the service",
  hydrate_crashed: "Something went wrong while loading the page",
  ics_fetch_failed: "We couldn't download the calendar feed",
  instagram_graphql_wiring_pending: "Instagram support isn't wired up yet",
  linkedin_voyager_wiring_pending: "LinkedIn support isn't wired up yet",
  list_page_navigation_failed:
    "We couldn't load a page of your H-E-B order history and didn't want to assume that meant the end",
  list_page_shape_check_failed: "The page didn't look like we expected",
  login: "H-E-B needs you to sign back in or complete a verification check",
  loom_apollo_wiring_pending: "Loom support isn't wired up yet",
  manual_action_required: "Action needed to continue",
  matched: "We found a Chase statement to import",
  missing_mapping: "We opened this conversation but it had no message data to read",
  navigation_retry_exhausted: "We tried this page several times but it did not finish loading",
  no_calendar_sources: "No calendars are configured to import from",
  no_exports_found: "We couldn't find any exports yet",
  no_orders_text: "This account shows no orders to import",
  not_available: "This data isn't available through the current connection",
  not_expected_body: "A Chase page didn't look like a statement we recognize",
  pagination_exhausted: "We reached the end of the available pages",
  // ─── H-E-B order-history pagination honesty (2026-07-15) ──────────────────
  // Emitted when the source's own page-count signal can't be trusted, so the
  // connector refuses to guess rather than silently under-collecting.
  pagination_metadata_absent:
    "H-E-B didn't tell us how many pages of orders there are, so we stopped to avoid missing any",
  pagination_metadata_contradictory:
    "H-E-B gave us conflicting page-count information, so we stopped to avoid missing any orders",
  parse_missing: "The order detail page loaded, but the expected details were not present",
  pdf_download_failed: "We couldn't download a statement PDF",
  pdf_parse_failed: "We couldn't read one of the statement PDFs",
  pdf_template_unknown: "We don't recognize the format of this statement yet",
  pr_detail_fetch_failed: "We saved these pull requests but couldn't load every detail",
  pr_search_cap_truncated: "There were more results than the service will return, so the oldest couldn't be collected",
  qfx_download_failed: "We couldn't download the transactions file",
  qfx_parse_failed: "We couldn't read the transactions file",
  records_not_found: "We didn't find any records to import",
  // ─── Forward-looking codes from the design brief / Worker E §6.3 ───────
  reddit_login_unexpected_ui: "Reddit is asking for extra verification",
  redirected_non_detail: "Amazon sent us to a different page than the order detail we expected",
  // ─── Resumable retry / bounded-run cap deferrals ───────────────────────
  // Two distinct codes, neither of which means the service was busy (that copy
  // belongs to `upstream_pressure` / `upstream_pressure_deferred`):
  //   - `retry_exhausted` is the GENERIC resumable wire reason — a retry budget
  //     was used up. It covers any retry-exhaustion path, not only a configured
  //     cap, so its copy stays generic and the rest is retried next run.
  //   - `run_cap_deferred` is the SPECIFIC error class for a configured per-run
  //     size/time budget: the run chose to stop and saved what it collected.
  // The two strings must differ (the run-cap class is more specific than the
  // generic reason) and neither may imply source pressure.
  retry_exhausted: "We used up this run's retries here, so we'll pick the rest up on the next run",
  row_exception: "Something went wrong reading one of the rows",
  run_cap_deferred:
    "We collected a batch within this run's budget and saved it; the rest will be collected on the next run",
  schema_validation_failed: "Some data didn't match the expected format and was skipped",
  scrape_failed: "We couldn't read the page contents",
  selector_drift: "The page layout changed and we couldn't find what we needed",
  selectors_pending: "Support for this part of the connector isn't complete yet",
  session_dead_reauth_failed: "Your sign-in expired and we couldn't refresh it",
  session_repair_required: "Reconnect Amazon before collection can continue",
  shape_check_failed: "The data didn't look like we expected",
  shopify_apollo_wiring_pending: "Shopify support isn't wired up yet",
  source_auth_or_challenge: "We need you to sign in or pass a verification check to continue",
  starred_entry_missing_repo: "We skipped a starred entry whose repository was unavailable",
  statements_scrape_failed: "We couldn't read your statements page",
  succeeded_with_gaps: "Some data couldn't be collected",
  temporary_unavailable: "We couldn't finish this item yet, so we'll try it again on the next run",
  // ─── Google Maps Timeline reason codes ────────────────────────────────────
  timeline_points_not_found: "We couldn't find any location points to import",
  timeline_segments_not_found: "We couldn't find any timeline segments to import",
  uber_graphql_wiring_pending: "Uber support isn't wired up yet",
  unparseable_order_date: "We skipped some orders because their dates couldn't be read",
  unsupported_export: "We could not read that WhatsApp export format yet",
  upstream_pressure: "The service is busy right now — we'll back off and try later",
  upstream_pressure_deferred: "The service was busy, so we saved what we could and will finish the rest later",
  wholefoods_filter_pending: "Whole Foods filter support isn't wired up yet",
};

/**
 * Look up the vetted end-user copy for a reason code. Returns `null`
 * when no entry is registered — UI decides the fallback copy (kept out
 * of this layer on purpose; this module stays honest).
 */
export function displayMessageFor(reasonCode: string | null): string | null {
  if (!reasonCode) {
    return null;
  }
  return DISPLAY_MESSAGES[reasonCode] ?? null;
}
