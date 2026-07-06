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
  // ─── Forward-looking codes from the design brief / Worker E §6.3 ───────
  reddit_login_unexpected_ui: "Reddit is asking for extra verification",
  chatgpt_login_unexpected_ui: "ChatGPT needs you to sign in again",
  cloudflare_challenge: "Cloudflare is checking it's really you",
  manual_action_required: "Action needed to continue",
  succeeded_with_gaps: "Some data couldn't be collected",
  controller_restarted: "We restarted in the middle — we'll try again",
  consent_expiring_soon: "Your sign-in will expire soon",

  // ─── Chase statements-PDF probe diagnostics ────────────────────────────
  // Emitted by `chase` during HTTP-response inspection while scanning the
  // statements page. These three are diagnostic-bucket reasons (matched
  // probe / unmatched probe / probe error), but the completeness test
  // scans every `reason: "<code>"` literal in connector source, so they
  // need vetted end-user copy here too. Reaching the dashboard layer
  // would be unusual but should still read like English, not protocol
  // jargon.
  body_error: "We hit a problem reading a Chase statement page",
  not_expected_body: "A Chase page didn't look like a statement we recognize",
  matched: "We found a Chase statement to import",

  // ─── Connector SKIP_RESULT reasons (catalog scan) ──────────────────────
  ambiguous_multi_account_overview: "We couldn't tell which account view to use",
  archive_not_found: "We couldn't find an export archive to read",
  claude_api_wiring_pending: "Claude API support isn't wired up yet",
  claude_dir_not_found: "We couldn't find your Claude Code data folder",
  credit_card_export_unverified: "We couldn't confirm the credit card export",
  doordash_graphql_wiring_pending: "DoorDash support isn't wired up yet",
  empty_detail: "We opened this conversation but found no messages to import",
  // 2026-06-04 baseline repair: these reason literals are emitted by
  // connectors but were missing vetted copy, so the registry completeness
  // test was red and the dashboard would have shown `null` for a real code.
  // Codes that surface through a `reason:` ternary (missing_mapping,
  // csv_no_data_rows, csv_no_usable_transactions) were also invisible to the
  // scan until it was taught to read ternary literals — they are included here
  // so the now-stricter scan stays green. Copy stays operator/end-user voice.
  csv_no_data_rows: "The transactions file had no rows to import",
  csv_no_usable_transactions: "We couldn't find any usable transactions in that file",
  empty_first_page_without_diagnostics: "The first page came back empty and we couldn't tell why",
  empty_first_page_without_terminal_signal: "The first page came back empty with no sign it was really the end",
  missing_mapping: "We opened this conversation but it had no message data to read",
  no_orders_text: "This account shows no orders to import",
  pagination_exhausted: "We reached the end of the available pages",
  pr_detail_fetch_failed: "We saved these pull requests but couldn't load every detail",
  pr_search_cap_truncated: "There were more results than the service will return, so the oldest couldn't be collected",
  source_auth_or_challenge: "We need you to sign in or pass a verification check to continue",
  starred_entry_missing_repo: "We skipped a starred entry whose repository was unavailable",
  unparseable_order_date: "We skipped some orders because their dates couldn't be read",
  upstream_pressure_deferred: "The service was busy, so we saved what we could and will finish the rest later",
  temporary_unavailable: "We couldn't finish this item yet, so we'll try it again on the next run",
  // ─── Amazon order-detail diagnostics ─────────────────────────────────────
  deferred: "We paused this item and will pick it up on the next run",
  failed: "We couldn't finish this item on this run",
  navigation_retry_exhausted: "We tried this page several times but it did not finish loading",
  redirected_non_detail: "Amazon sent us to a different page than the order detail we expected",
  parse_missing: "The order detail page loaded, but the expected details were not present",
  session_repair_required: "Reconnect Amazon before collection can continue",
  deferred_budget: "We saved the current batch and deferred the rest to keep this run bounded",
  export_affordance_missing: "We couldn't find the export controls on this page — the site may have changed",
  export_error: "The export couldn't be downloaded",
  export_no_download: "The export didn't produce a downloadable file",
  export_not_found: "We couldn't find an export to import",
  heb_dom_wiring_pending: "H-E-B support isn't wired up yet",
  history_not_found: "We couldn't find any history to import",
  http_error: "We hit a network problem talking to the service",
  hydrate_crashed: "Something went wrong while loading the page",
  ics_fetch_failed: "We couldn't download the calendar feed",
  instagram_graphql_wiring_pending: "Instagram support isn't wired up yet",
  linkedin_voyager_wiring_pending: "LinkedIn support isn't wired up yet",
  list_page_shape_check_failed: "The page didn't look like we expected",
  loom_apollo_wiring_pending: "Loom support isn't wired up yet",
  no_calendar_sources: "No calendars are configured to import from",
  no_exports_found: "We couldn't find any exports yet",
  not_available: "This data isn't available through the current connection",
  pdf_download_failed: "We couldn't download a statement PDF",
  pdf_parse_failed: "We couldn't read one of the statement PDFs",
  pdf_template_unknown: "We don't recognize the format of this statement yet",
  qfx_download_failed: "We couldn't download the transactions file",
  qfx_parse_failed: "We couldn't read the transactions file",
  records_not_found: "We didn't find any records to import",
  // ─── Google Maps Timeline reason codes ────────────────────────────────────
  timeline_points_not_found: "We couldn't find any location points to import",
  timeline_segments_not_found: "We couldn't find any timeline segments to import",
  // ─── WhatsApp chat export reason codes ────────────────────────────────────
  empty_export: "That WhatsApp export did not contain any messages to import",
  unsupported_export: "We could not read that WhatsApp export format yet",
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
  run_cap_deferred:
    "We collected a batch within this run's budget and saved it; the rest will be collected on the next run",
  row_exception: "Something went wrong reading one of the rows",
  schema_validation_failed: "Some data didn't match the expected format and was skipped",
  scrape_failed: "We couldn't read the page contents",
  selector_drift: "The page layout changed and we couldn't find what we needed",
  selectors_pending: "Support for this part of the connector isn't complete yet",
  session_dead_reauth_failed: "Your sign-in expired and we couldn't refresh it",
  shape_check_failed: "The data didn't look like we expected",
  shopify_apollo_wiring_pending: "Shopify support isn't wired up yet",
  statements_scrape_failed: "We couldn't read your statements page",
  uber_graphql_wiring_pending: "Uber support isn't wired up yet",
  upstream_pressure: "The service is busy right now — we'll back off and try later",
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
