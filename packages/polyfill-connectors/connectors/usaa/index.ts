#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP USAA Connector (v0.2.0)
 *
 * Uses shared Playwright persistent profile. Drives real selectors captured
 * from a live session on 2026-04-19.
 *
 * Streams: accounts, transactions, transfers, bill_payments,
 *          scheduled_transactions, credit_card_billing, statements,
 *          inbox_messages, external_accounts.
 *
 * Transactions path: drive the USAA "Export" button → "Select Date Range"
 * CSV flow. Primary key is a synthetic SHA-256 hash since USAA does not
 * expose transaction IDs (the manifest and parser code document the synthetic key).
 *
 * Session: cookie-based probe on UsaaMbWebMemberLoggedIn + LtpaToken2.
 * On session death, emits INTERACTION manual_action → inbox.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { ensureUsaaSession } from "../../src/auto-login/usaa.ts";
import {
  attachBodyResponseQueue,
  type BodyResponseDiagnostics,
  type BodyResponseQueue,
  waitForOptionalBodyResponse,
} from "../../src/browser-artifact-response.ts";
import {
  type BrowserSurfaceManagedState,
  browserSurfaceManagedState,
  buildBrowserSurfaceDiagnostic,
} from "../../src/browser-surface-diagnostic.ts";
import {
  type BrowserCollectContext,
  type DetailGapMessage,
  type EmittedMessage,
  emitDetailCoverage,
  type InteractionRequest,
  type InteractionResponse,
  nowIso,
  politeDelay,
  runConnector,
  type ValidateRecord,
} from "../../src/connector-runtime.ts";
import { attachDownloadQueue, type DownloadQueue } from "../../src/download-queue.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { readPlaywrightDownloadBufferDetailed } from "../../src/playwright-download.ts";
import { statementFingerprintExcludeKeys } from "../../src/statement-content-fingerprint.ts";
import {
  openStatementHydrationCursor,
  readPriorStatementHydration,
  type StatementHydration,
  type StatementHydrationCursor,
} from "../../src/statement-hydration-carry-forward.ts";
import {
  buildAccountRecord,
  buildAccountStatsRecord,
  buildCandidateStarts,
  buildCreditCardBillingRecord,
  buildCreditCardBillingStatsRecord,
  buildInboxMessageRecord,
  hashId,
  isoDate,
  mmddyyyy,
  BACKFILL_17MO as PARSERS_BACKFILL_17MO,
  INCREMENTAL_OVERLAP_MS as PARSERS_INCREMENTAL_OVERLAP_MS,
  parseCsv,
  resolveAccountIdForRef,
  rowsToTransactions,
} from "./parsers.ts";
import { validateRecord as validateRecordRaw } from "./schemas.ts";
import { computeStatementCoverage, type StatementCoverageRow } from "./statement-coverage.ts";
import { fileUrlForPath, hydrateStatementPdfs, parsePdfStatement } from "./statement-pdfs.ts";
import type {
  BillingKv,
  DashboardAccount,
  DiagnosticCandidate,
  DiagnosticInfo,
  DocRow,
  DownloadDiagnostics,
  DriveExportOptions,
  HydrationResult,
  HydrationResultSuccess,
  InboxRow,
  IndexRow,
  LocatedExportPage,
  NoExportAffordanceObservation,
  PageDiagnostics,
  StatementRecord,
  TransactionsPriorState,
  TransactionsStreamCursor,
  UsaaAccountPageIdentity,
} from "./types.ts";

const validateRecord = validateRecordRaw as ValidateRecord;

// ─── Module-scope regexes ────────────────────────────────────────────────

const ACCOUNT_URL_PREFIXES =
  'a[href^="/my/checking"], a[href^="/my/savings"], a[href^="/my/credit-card"], a[href^="/my/external-account"], a[href^="/my/loan"], a[href^="/my/mortgage"], a[href^="/my/investing"], a[href^="/my/retirement"]';
const DASHBOARD_SELECTOR_WAIT = 'a[href^="/my/checking"], a[href^="/my/credit-card"], a[href^="/my/external-account"]';
const LOGON_REDIRECT_RE = /\/my\/logon|\/access-management\/oauth2\/member\/authorize/;
const TRANSACTION_ACCOUNT_TYPE_RE = /checking|savings|credit-card/;
const CREDIT_CARD_TYPE_RE = /credit-card/;
const TEMP_DIR_PREFIX_RE = /\/[^/]+$/;
const UNSAFE_FILENAME_RE = /[\\/]/g;
const EXPORT_BUTTON_TEXT_RE = /^\s*Export\s*$/i;
const CSV_DOWNLOAD_HINT_RE = /filename|attachment|octet-stream|csv|export/iu;
const CSV_HEAD_RE = /date|description|amount|transaction/iu;
const EXPORT_DIALOG_MESSAGE_SELECTOR =
  '[role="dialog"] [class*="errorMessage"]:not(:empty), [role="dialog"] :text-matches("no transactions|nothing to export", "i")';
const EXPORT_NO_DATA_RE = /no transactions|nothing to export/iu;
const USAA_ACCOUNT_DETAIL_ROUTE_RE = /^\/my\/(?:checking|savings|credit-card)(?:\/|$)/u;
const USAA_INTERSTITIAL_ROUTE_RE =
  /\/(?:my\/logon|access-management\/oauth2\/member\/authorize|security(?:\/|$)|challenge(?:\/|$))/iu;
const USAA_ACCOUNT_DETAIL_MARKER_SELECTOR = ".ent-as-utility-bar, .as_credit__utility-bar";
const USAA_TRANSACTION_MARKER_SELECTOR =
  'table[aria-label*="transaction" i], [data-testid*="transaction" i], [id*="transaction" i]';
const USAA_NAVIGATION_MARKER_SELECTOR = 'a[href*="/my/credit-card"], a[role="tab"], [role="tab"]';
const USAA_EXPORT_AFFORDANCE_SELECTOR =
  "button.ent-as-utility-bar__item.export, button.as_credit__utility-bar-item.as_credit__export";

// ─── Timing + limits ────────────────────────────────────────────────────

const DASHBOARD_NAV_TIMEOUT_MS = 30_000;
const DASHBOARD_SELECTOR_TIMEOUT_MS = 20_000;
const DASHBOARD_SETTLE_DELAY_MS = 4000;
const DOCUMENTS_NAV_TIMEOUT_MS = 25_000;
const DOCUMENTS_SETTLE_DELAY_MS = 5000;
const ACCOUNT_NAV_TIMEOUT_MS = 30_000;
const ACCOUNT_SETTLE_DELAY_MS = 6000;
const INBOX_NAV_TIMEOUT_MS = 25_000;
const CC_SETTLE_DELAY_MS = 6000;
const EXPORT_DIALOG_DELAY_MS = 2500;
const EXPORT_STATE_DELAY_MS = 1500;
const EXPORT_CLICK_TIMEOUT_MS = 5000;
// Same budget as EXPORT_CLICK_TIMEOUT_MS: an explicit isEnabled() check spends
// no extra wall-clock over the old blind click (which internally polled
// actionability for this same duration before timing out) — it just replaces
// an opaque click-timeout error with the exact disabled/aria-disabled facts
// already captured for no_export_affordance.
const EXPORT_ENABLED_CHECK_TIMEOUT_MS = EXPORT_CLICK_TIMEOUT_MS;
const DOWNLOAD_TIMEOUT_MS = 45_000;
const RESPONSE_FALLBACK_GRACE_MS = 3000;
const KEY_TYPE_DELAY_MS = 30;
const BACKFILL_17MO = PARSERS_BACKFILL_17MO;
const INCREMENTAL_OVERLAP_MS = PARSERS_INCREMENTAL_OVERLAP_MS;
const ID_TEXT_SNIP = 160;
const HTML_PREVIEW_MAX = 600;
// Playwright's locator.click() timeout message is a multi-line call log
// (e.g. "waiting for locator(...) - locator resolved to <button disabled...>
// - element is not enabled - retrying click action ..."), routinely 400+
// chars. ID_TEXT_SNIP (160) is sized for short identifiers/filenames and
// was cutting this off before the actionability state (disabled/hidden/
// covered) — the actual cause of the timeout — ever appeared. Sized like
// HTML_PREVIEW_MAX so the full call log survives into diagnostics.
const CLICK_ERROR_SNIP = 600;
export const USAA_FALLBACK_SERIALIZED_BYTES_MAX = 8 * 1024;
const USAA_ORIGIN = "https://www.usaa.com";

// Pure helpers — hashId, currencyToCents, isoDate, mmddyyyy, parseCsv,
// rowsToTransactions — live in ./parsers.ts.

// ─── Emit-path helpers (cross-stream seams) ─────────────────────────────

export type EmitFn = BrowserCollectContext["emit"];
export type EmitRecordFn = BrowserCollectContext["emitRecord"];
export type RequestedScopes = BrowserCollectContext["requested"];

// Module-scope regexes (Biome useTopLevelRegex). CREDIT_CARD_TYPE_RE is
// defined above in the existing regex block; reuse it here rather than
// redeclare to avoid a lint collision.
const STATEMENT_TITLE_RE = /STATEMENT/i;
const NON_STATEMENT_TITLE_RE = /(TERMS\b|AGREEMENT\b|NOTICE\b|DISCLOSURE\b|CONDITION)/i;

/** Per-run dependency bag for the emit-path helpers. */
export interface EmitDeps {
  browserSurface?: BrowserSurfaceManagedState;
  capture?: BrowserCollectContext["capture"];
  emit: EmitFn;
  emitRecord: EmitRecordFn;
  reauthenticate?: (input: {
    context: BrowserContext;
    page: Page;
    sendInteraction: BrowserCollectContext["sendInteraction"];
  }) => Promise<void>;
  /** Pending USAA account transaction gaps served by the runtime this run.
   * A reached account emits recovery for its supplied gap id; this prevents a
   * successful later export from leaving the durable gap pending forever. */
  servedAccountTransactionGaps?: ReadonlyMap<string, string>;
}

/** Aggregate shape from the PDF hydration pass. Exposed so the emit-
 *  path caller can thread successes/attempts into the per-run PROGRESS. */
export interface HydrationSummary {
  attempts: number;
  results: Map<number, HydrationResult>;
  successes: number;
}

/** Streams scaffolded in design-notes but without live selectors. Each
 *  requested-but-deferred stream gets a SKIP_RESULT so the client sees
 *  the intent without data. */
export const DEFERRED_STREAMS: readonly string[] = [
  "transfers",
  "bill_payments",
  "scheduled_transactions",
  "external_accounts",
];

/** True iff we should try to extract transactions from this statement
 *  title. USAA's document index mixes statements with agreements /
 *  disclosures — the parser only understands the former. */
export function shouldParseStatementTitle(title: string): boolean {
  return STATEMENT_TITLE_RE.test(title) && !NON_STATEMENT_TITLE_RE.test(title);
}

/** Narrow a HydrationResult to the success branch. Used by the record-
 *  emit path to decide between a hydrated row and an index-only row. */
export function hydrationSuccess(h: HydrationResult | undefined): HydrationResultSuccess | null {
  if (h && "pdfPath" in h) {
    return h;
  }
  return null;
}

/** Build `statements` IndexRows from scraped DocRows. Rows missing a
 *  `date_delivered` are dropped — we can't reliably key them. Account
 *  resolution accepts only a unique last-four/name match; ambiguous matches
 *  remain unresolved so no account-keyed PDF evidence can be emitted. */
export function buildIndexRows(docs: readonly DocRow[], accounts: readonly DashboardAccount[]): IndexRow[] {
  return docs
    .filter((d) => d.date_delivered)
    .map((d) => {
      const accountReference = d.account_reference.trim() || null;
      return {
        rowIndex: d.rowIndex,
        id: hashId(`${accountReference ?? ""}|${d.date_delivered}|${d.title}`),
        account_id: resolveAccountIdForRef(accountReference ?? "", accounts),
        title: d.title,
        date_delivered: isoDate(d.date_delivered),
        account_reference: accountReference,
      };
    });
}

/** Options controlling which of the two account streams emit. The entity
 *  (`accounts`) and the observation (`account_stats`) are independently
 *  scoped: a client may request the entity, the daily balances, or both.
 *  `observedOn` is the UTC date (`YYYY-MM-DD`) the balances were sampled.
 *  `emitEntity` defaults to `true` so legacy callers (and tests that pass no
 *  options) keep emitting the entity record + STATE unchanged. */
export interface AccountsEmitOptions {
  emitEntity?: boolean;
  emitStats?: boolean;
  observedOn?: string;
}

/** Emit one `accounts` entity record per dashboard account (gated), and
 *  optionally one `account_stats` observation record per account, followed
 *  by per-stream STATE checkpoints. Record `fetched_at` threads the
 *  run-level emittedAt so every record in a run shares one timestamp; STATE
 *  cursors use `nowIso()` at emit time since they're heartbeats, not record
 *  fields.
 *
 *  Entity gate: a per-account fingerprint that excludes the run-clock
 *  `fetched_at`. After the Family-2 split the entity body carries only
 *  identity/settings (id, type, name, last_four, status), so it re-emits
 *  only on a real identity/settings change — a balance-only tick no longer
 *  versions the entity. The point-in-time `balance_cents` /
 *  `available_balance_cents` live on `account_stats`, keyed
 *  `{account_id}:{observed_on}` so same-day re-pulls are idempotent and a
 *  later day appends a new point in the balance time series. When no cursor
 *  is supplied (legacy callers/tests) the entity record always emits and no
 *  entity STATE is written. */
export async function emitAccountsStream(
  deps: EmitDeps,
  accounts: readonly DashboardAccount[],
  emittedAt: string,
  fingerprintCursor?: FingerprintCursor,
  options: AccountsEmitOptions = {}
): Promise<void> {
  const emitEntity = options.emitEntity ?? true;
  const emitStats = options.emitStats ?? false;
  const observedOn = options.observedOn ?? emittedAt.slice(0, 10);
  // `covered` is the in-boundary accounts this entity run accounted for: emitted
  // plus suppressed-because-unchanged. Counted independently at the loop site
  // from objective per-record outcomes, never aliased to the emitted count —
  // `buildAccountRecord` never drops a row, so every enumerated account reaches
  // the gate; a future pre-gate drop would raise `considered` (accounts.length)
  // without raising `covered`, leaving an honest `partial`.
  let entityCovered = 0;
  // Stats-stream coverage: distinct from `entityCovered` above and from the
  // `accounts` self-coverage message below. The append-key/idempotency
  // rationale (no cursor, no suppression — a same-day re-pull collapses via
  // the runtime's byte-equivalence check, not a fingerprint gate) is about
  // *versioning*, not *measurability*: "did this run successfully sample
  // every enumerated account's balance" is a real, honestly-measured
  // denominator (`accounts.length`) and numerator (records actually
  // emitted) — `buildAccountStatsRecord` never drops a row, so a future
  // per-account stats failure would show up as `covered < considered`
  // instead of silently disappearing.
  let statsCovered = 0;
  for (const a of accounts) {
    if (emitEntity) {
      const rec = buildAccountRecord(a, emittedAt);
      if (!fingerprintCursor || fingerprintCursor.shouldEmit(rec)) {
        await deps.emitRecord("accounts", rec);
      }
      // Emitted or suppressed-unchanged: either way the account was accounted
      // for. Only the fingerprint-gated entity path (not the legacy no-cursor
      // path) declares coverage below.
      if (fingerprintCursor) {
        entityCovered += 1;
      }
    }
    // Observation stream: append-keyed daily balance snapshot, emitted
    // unconditionally (the runtime byte-equivalence check collapses an
    // unchanged same-day re-pull). Not fingerprint-gated — the append key
    // already makes same-day re-pulls idempotent.
    if (emitStats) {
      await deps.emitRecord("account_stats", buildAccountStatsRecord(a, observedOn));
      statsCovered += 1;
    }
  }
  if (emitStats) {
    // Own self-coverage message, keyed to the `account_stats` stream itself
    // (not `accounts`) — an account_stats-only request (emitEntity: false)
    // still gets a measured denominator, and a combined request gets two
    // independent coverage reports for the two independently-scoped streams.
    await emitDetailCoverage(deps, {
      stream: "account_stats",
      stateStream: "account_stats",
      requiredKeys: [],
      hydratedKeys: [],
      considered: accounts.length,
      covered: statsCovered,
    });
    await deps.emit({
      type: "STATE",
      stream: "account_stats",
      cursor: { observed_on: observedOn, fetched_at: nowIso() },
    });
  }
  if (!emitEntity) {
    return;
  }
  if (!fingerprintCursor) {
    await deps.emit({
      type: "STATE",
      stream: "accounts",
      cursor: { fetched_at: nowIso() },
    });
    return;
  }
  // The dashboard scan re-enumerates the full account boundary every run and
  // suppresses unchanged accounts via the per-record fingerprint, so on a
  // steady-state run `collected` is a churn-reduced subset (often 0), not a
  // coverage count. Declare `considered = accounts.length` (the enumerated
  // boundary) with the objective `covered` count so the Collection Report reads
  // `complete` instead of a false `partial`
  // (define-connector-progress-evidence-contract task 4.4). This self-coverage
  // message (`stream === state_stream === "accounts"`, empty required/hydrated
  // keys) describes the entity inventory only; `account_stats` is an
  // append-keyed daily observation with no fingerprint suppression to reason
  // about, but it still has its own real per-run denominator (every account
  // this run sampled a stat for) — see its own `emitDetailCoverage` call
  // above, under a distinct `stream: "account_stats"` self-coverage message.
  await emitDetailCoverage(deps, {
    stream: "accounts",
    stateStream: "accounts",
    requiredKeys: [],
    hydratedKeys: [],
    considered: accounts.length,
    covered: entityCovered,
  });
  // Accounts enumeration is a full dashboard scan: prune fingerprints for
  // accounts no longer present so a re-added account re-emits.
  fingerprintCursor.pruneStale();
  const cursor: Record<string, unknown> = { fetched_at: nowIso() };
  if (fingerprintCursor.size() > 0) {
    cursor.fingerprints = fingerprintCursor.toState();
  }
  await deps.emit({
    type: "STATE",
    stream: "accounts",
    cursor,
  });
}

/** Run the `accounts` entity and/or `account_stats` observation streams
 *  based on the requested scope. The entity fingerprint cursor is only
 *  opened when the entity stream is requested; the observation stream is
 *  append-keyed and needs no cursor. Extracted from `collect()` to keep that
 *  orchestrator under the cognitive-complexity budget. */
async function maybeRunAccountsStreams(
  deps: EmitDeps,
  accounts: readonly DashboardAccount[],
  state: Record<string, unknown>,
  requested: RequestedScopes,
  emittedAt: string
): Promise<void> {
  const wantsAccounts = requested.has("accounts");
  const wantsAccountStats = requested.has("account_stats");
  if (!(wantsAccounts || wantsAccountStats)) {
    return;
  }
  const accountsFingerprintCursor = wantsAccounts
    ? openFingerprintCursor(state.accounts, {
        excludeFromFingerprint: ["fetched_at"],
        priorFingerprints: readPriorAccountFingerprints(state),
      })
    : undefined;
  await emitAccountsStream(deps, accounts, emittedAt, accountsFingerprintCursor, {
    emitEntity: wantsAccounts,
    emitStats: wantsAccountStats,
  });
}

/**
 * Parse the prior `accounts` STATE cursor's `fingerprints` map. Keyed by
 * account `id` (the dashboard account id, or a hash of the raw text when
 * USAA does not expose one). Legacy cursors (only `{ fetched_at }`) decode
 * to an empty map, so the first post-deploy run rebuilds the map and
 * re-emits every account exactly once.
 */
export function readPriorAccountFingerprints(state: Record<string, unknown>): Map<string, string> {
  const streamState = (state.accounts ?? {}) as Record<string, unknown>;
  const raw = streamState.fingerprints;
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out.set(id, value);
    }
  }
  return out;
}

/** Emit a SKIP_RESULT for every requested-but-deferred stream. Keeps
 *  the client informed that we understood the request but can't fulfil
 *  it in this revision — rather than silently dropping the scope. */
export async function emitDeferredStreams(emit: EmitFn, requested: RequestedScopes): Promise<void> {
  for (const s of DEFERRED_STREAMS) {
    if (requested.has(s)) {
      const msg: EmittedMessage = {
        type: "SKIP_RESULT",
        stream: s,
        reason: "selectors_pending",
        message: `${s} stream scaffolded in design-notes; click-chain or SPA-component wiring deferred.`,
      };
      await emit(msg);
    }
  }
}

/**
 * Terminal outcome class for an exhausted export ladder. The ladder reaches
 * `emitExportFailure` only when no CSV was produced AND the source never
 * returned an explicit "nothing to export" response (that honest-empty path
 * short-circuits in `processAccountTransactions` and is never a gap). What
 * remains is genuinely ambiguous, so we split it by the last diagnostic phase
 * the ladder recorded:
 *
 *   - `source_structure_changed` — the export affordance or its date-range
 *     dialog was missing/unrecognized (`export_dialog_unexpected_shape`, or
 *     `no_export_affordance` with `no_export_observation.route === "expected"`
 *     — i.e. the page really was the account/transaction detail page and the
 *     export button was genuinely gone). These source-shape phases are fatal
 *     (`isFatalDiagPhase`): they don't get better with a shorter window, so
 *     retrying is pointless until the connector's selectors are revisited.
 *     A matched-but-disabled control is also terminal for ladder control, but
 *     remains `export_pressure` here so its evidence is not mislabeled as a
 *     missing source surface.
 *   - `navigation_drifted` — the page we ended up on was not confirmed to be
 *     the exact requested account/transaction detail page: this includes
 *     `no_export_affordance` with an unknown/interstitial route and any
 *     unexpected dialog shape whose account identity is missing or mismatched
 *     (e.g. a marketing/promo detour, a stale `accountId` query param, or a
 *     logon/security interstitial). This is a navigation/routing failure, not
 *     evidence the source's export UI changed — so unlike
 *     `source_structure_changed` it is NOT ladder-fatal (the ladder keeps
 *     trying remaining candidate windows) and it is NOT reported as
 *     "structure changed". A same-run retry with the same stale URL will
 *     likely drift again, so the account's per-run DETAIL_GAP (below) is
 *     what actually recovers it: the next run re-derives the account URL from
 *     a fresh dashboard scan.
 *   - `export_pressure` — the affordance and dialog were found and the export
 *     was submitted, but the download/body never materialized, the click
 *     failed, or the dialog reported a transient error
 *     (`export_artifact_wait_failed`, `export_dialog_error`,
 *     `export_click_failed`). This is the "temporary export/source pressure"
 *     outcome — a later run may succeed.
 *   - `unknown` — every window failed without leaving a diagnostic phase
 *     (`lastDiag === null`). We don't claim to know which of the above it was.
 *
 * This is a within-protocol refinement: `SKIP_RESULT.reason` is a free-form
 * string and `diagnostics` is open, so the only thing that changes is which
 * vetted reason/copy the dashboard sees and a machine-readable `outcome`
 * discriminator on the diagnostics object. No new protocol field is added.
 */
export type ExportLadderOutcome = "export_pressure" | "navigation_drifted" | "source_structure_changed" | "unknown";

/**
 * A bounded export observation that cannot be improved by another date
 * window. These are terminal for this account until the owner supplies a
 * fresh live surface capture or the connector is updated; they are not a
 * claim that the account has zero activity.
 */
export type TerminalExportFailure = "export_affordance_disabled" | "source_structure_changed";

/**
 * True iff `no_export_affordance`'s route observation confirms the ladder
 * really reached the account/transaction detail page. Only this route value
 * makes a missing export affordance genuinely structural — any other route
 * (a marketing detour, a logon/security interstitial, or any page we can't
 * positively identify) means navigation never reliably reached the page
 * whose UI we'd be judging, so "the button is gone" cannot be concluded.
 */
function noExportRouteConfirmsAccountPage(diag: DiagnosticInfo): boolean {
  return diag.no_export_observation?.route === "expected" && diagnosticAccountPageIdentity(diag) === "exact";
}

function diagnosticAccountPageIdentity(diag: DiagnosticInfo): UsaaAccountPageIdentity | null {
  const identities = [diag.account_page_identity, diag.no_export_observation?.account_page_identity].filter(
    (identity): identity is UsaaAccountPageIdentity => Boolean(identity)
  );
  if (identities.length === 0) {
    return null;
  }
  if (identities.every((identity) => identity === "exact")) {
    return "exact";
  }
  return identities.some((identity) => identity === "mismatch") ? "mismatch" : "unverified";
}

/** Map the ladder's last diagnostic phase to a terminal outcome class. */
export function classifyExportLadderOutcome(lastDiag: DiagnosticInfo | null): ExportLadderOutcome {
  if (!lastDiag) {
    return "unknown";
  }
  const accountPageIdentity = diagnosticAccountPageIdentity(lastDiag);
  if (lastDiag.phase === "no_export_affordance" && !noExportRouteConfirmsAccountPage(lastDiag)) {
    return "navigation_drifted";
  }
  if (lastDiag.phase === "export_dialog_unexpected_shape" && accountPageIdentity !== "exact") {
    return "navigation_drifted";
  }
  if (lastDiag.phase === "no_export_affordance" && lastDiag.no_export_observation?.affordance_disabled) {
    return "export_pressure";
  }
  if (isFatalDiagPhase(lastDiag)) {
    return "source_structure_changed";
  }
  return "export_pressure";
}

/**
 * Classify only evidence that makes another date-window attempt pointless.
 * A matched, disabled control is a control prerequisite: changing the
 * transaction date cannot enable it. A confirmed missing control or an
 * unexpected dialog shape is a source-surface decision, not a transient
 * download failure. Navigation drift and post-submit pressure remain
 * retryable and deliberately return null here.
 */
export function classifyTerminalExportFailure(lastDiag: DiagnosticInfo | null): TerminalExportFailure | null {
  if (
    lastDiag?.phase === "no_export_affordance" &&
    noExportRouteConfirmsAccountPage(lastDiag) &&
    lastDiag.no_export_observation?.affordance_disabled
  ) {
    return "export_affordance_disabled";
  }
  return isFatalDiagPhase(lastDiag) ? "source_structure_changed" : null;
}

/**
 * Emit the transaction-surface result after `tryExportLadder` returns no CSV
 * (either after its bounded retry ladder or at a terminal surface decision)
 * without an explicit "nothing to export" source response.
 *
 * The honest-empty case (the source explicitly said "no transactions") never
 * reaches here — `processAccountTransactions` returns before calling this when
 * `exportEmpty` is true — so this function never turns a genuinely empty
 * account/window into a retryable gap.
 */
export async function emitExportFailure(
  deps: EmitDeps,
  a: DashboardAccount,
  lastDiag: DiagnosticInfo | null,
  terminalFailure: TerminalExportFailure | null = classifyTerminalExportFailure(lastDiag)
): Promise<void> {
  const verifiedTerminalFailure = classifyTerminalExportFailure(lastDiag);
  const effectiveTerminalFailure =
    terminalFailure && terminalFailure === verifiedTerminalFailure ? terminalFailure : verifiedTerminalFailure;
  const outcome = classifyExportLadderOutcome(lastDiag);
  const reason = exportFailureReason(a, lastDiag, outcome, effectiveTerminalFailure);
  await deps.emit({
    type: "SKIP_RESULT",
    stream: "transactions",
    reason,
    message: exportFailureMessage(a, lastDiag, outcome, effectiveTerminalFailure),
    ...(effectiveTerminalFailure ? { recovery_hint: { action: "capture_live_surface", retryable: false } } : {}),
    diagnostics: exportFailureDiagnostics(deps, lastDiag, outcome, effectiveTerminalFailure),
  });
}

function exportFailureMessage(
  a: DashboardAccount,
  lastDiag: DiagnosticInfo | null,
  outcome: ExportLadderOutcome,
  terminalFailure: TerminalExportFailure | null
): string {
  const isCreditCard = CREDIT_CARD_TYPE_RE.test(a.account_type);
  const isNoExportAffordance = lastDiag?.phase === "no_export_affordance";
  const isAffordanceDisabled = Boolean(lastDiag?.no_export_observation?.affordance_disabled);
  let baseMessage = "USAA transaction export affordance was not found on the observed browser surface";
  if (terminalFailure === "export_affordance_disabled") {
    baseMessage =
      "USAA transaction export affordance was found but remained disabled after the bounded actionability wait — no exportable activity was proven and no date-window retry is scheduled";
  } else if (terminalFailure === "source_structure_changed") {
    baseMessage =
      lastDiag?.phase === "export_dialog_unexpected_shape"
        ? "USAA export dialog opened but its date-control shape was not recognized — no exportable activity was proven and a bounded live capture is required before updating the connector"
        : "USAA transaction export affordance was not found on the confirmed account page — no exportable activity was proven and a bounded live capture is required before updating the connector";
  } else if (isAffordanceDisabled) {
    baseMessage =
      "USAA transaction export affordance was found but not actionable (disabled) on the observed browser surface — treating as transient UI-not-ready pressure, not a missing affordance";
  } else if (outcome === "navigation_drifted") {
    baseMessage =
      "USAA navigation did not confirm reaching the account/transaction page before looking for the export affordance (marketing detour or interstitial) — treating as a recoverable navigation drift, not a source UI change";
  } else if (!isNoExportAffordance) {
    baseMessage = lastDiag
      ? `Export ladder exhausted (${outcome}): ${formatDiagnosticInfo(lastDiag)}`
      : "Export dialog didn't produce a download across all ranges and the source never reported an empty account — outcome unknown (transient pressure or shifted selectors)";
  }
  const ccSuffix = isCreditCard && !terminalFailure ? " (credit-card export flow remains live-unverified)" : "";
  return `${baseMessage}${ccSuffix}`;
}

function exportFailureReason(
  a: DashboardAccount,
  lastDiag: DiagnosticInfo | null,
  outcome: ExportLadderOutcome,
  terminalFailure: TerminalExportFailure | null
): string {
  if (terminalFailure === "export_affordance_disabled") {
    return "export_affordance_disabled";
  }
  if (terminalFailure === "source_structure_changed" || outcome === "source_structure_changed") {
    return "export_affordance_missing";
  }
  if (CREDIT_CARD_TYPE_RE.test(a.account_type)) {
    return "credit_card_export_unverified";
  }
  if (lastDiag?.no_export_observation?.affordance_disabled) {
    return "export_affordance_disabled";
  }
  return outcome === "navigation_drifted" ? "navigation_drifted" : "export_no_download";
}

function exportFailureDiagnostics(
  deps: EmitDeps,
  lastDiag: DiagnosticInfo | null,
  outcome: ExportLadderOutcome,
  terminalFailure: TerminalExportFailure | null
): Record<string, unknown> {
  const isNoExportAffordance = lastDiag?.phase === "no_export_affordance";
  const terminal = terminalFailure ? { terminal_failure: terminalFailure } : {};
  if (isNoExportAffordance) {
    const browserSurface = noExportAffordanceDiagnostic(lastDiag, deps.browserSurface ?? "unknown");
    const candidates = sanitizeExportAffordanceCandidates(
      lastDiag?.no_export_observation?.export_affordance_candidates
    );
    const accountPageIdentity = lastDiag ? diagnosticAccountPageIdentity(lastDiag) : null;
    return {
      ...terminal,
      ...(accountPageIdentity ? { account_page_identity: accountPageIdentity } : {}),
      browser_surface: browserSurface,
      ...(candidates.length ? { export_affordance_candidates: candidates } : {}),
    };
  }
  return {
    outcome,
    ...terminal,
    ...(lastDiag ? sanitizeDiagnosticInfo(lastDiag) : {}),
  };
}

function sanitizeDiagnosticInfo(diag: DiagnosticInfo): DiagnosticInfo {
  const sanitized: DiagnosticInfo = {
    ...diag,
    diag: diag.diag
      ? {
          ...diag.diag,
          dialog_html_preview: null,
          export_candidates: diag.diag.export_candidates.map((candidate) => ({
            ...candidate,
            id: null,
            text: "",
          })),
          nav_candidates: diag.diag.nav_candidates.map((candidate) => ({
            ...candidate,
            id: null,
            text: "",
          })),
          title: "",
          url: "",
        }
      : diag.diag,
  };
  if (diag.artifact !== undefined) {
    sanitized.artifact = diag.artifact
      ? {
          ...diag.artifact,
          candidates: diag.artifact.candidates.map((candidate) => ({
            ...candidate,
            contentDisposition: "",
            url: "",
          })),
        }
      : diag.artifact;
  }
  if (diag.download !== undefined) {
    sanitized.download = diag.download
      ? {
          ...diag.download,
          suggestedFilename: null,
          url: null,
        }
      : diag.download;
  }
  return sanitized;
}

/**
 * Redact export-affordance candidates the same way `sanitizeDiagnosticInfo`
 * redacts `export_candidates`/`nav_candidates` — `id` and free-text `text`
 * never reach durable storage, but the bounded actionability facts
 * (tag/role/type/disabled/aria_disabled/visible) survive, since those are
 * the evidence a no-affordance diagnostic exists to carry.
 */
function sanitizeExportAffordanceCandidates(
  candidates: NoExportAffordanceObservation["export_affordance_candidates"] | undefined
): NoExportAffordanceObservation["export_affordance_candidates"] {
  if (!candidates) {
    return [];
  }
  return candidates.map((candidate) => ({
    ...candidate,
    id: null,
    text: "",
  }));
}

function summarizeArtifactDiagnostics(diag: DiagnosticInfo): string | null {
  const { artifact } = diag;
  if (!artifact) {
    return null;
  }
  const matched = artifact.candidates.filter((candidate) => candidate.reason === "matched").length;
  const bodyErrors = artifact.candidates.filter((candidate) => candidate.reason === "body_error").length;
  const inspected = artifact.candidates.length;
  const parts = [
    `artifact cdpReady=${artifact.cdpReady ? "true" : "false"} candidates=${inspected} matched=${matched} bodyErrors=${bodyErrors}`,
  ];
  if (artifact.cdpError) {
    parts.push(`cdpError=${artifact.cdpError.slice(0, ID_TEXT_SNIP)}`);
  }
  const [firstCandidate] = artifact.candidates;
  if (firstCandidate) {
    const firstParts = [
      firstCandidate.source,
      String(firstCandidate.status),
      firstCandidate.reason,
      `${firstCandidate.bodyBytes ?? 0}B`,
      firstCandidate.contentType || "no-content-type",
    ];
    if (firstCandidate.bodyError) {
      firstParts.push(`bodyError=${firstCandidate.bodyError.slice(0, ID_TEXT_SNIP)}`);
    }
    parts.push(`firstCandidate=${firstParts.join(",")}`);
  }
  return parts.join(" ");
}

function summarizeDownloadDiagnostics(diag: DiagnosticInfo): string | null {
  const dl = diag.download;
  if (!dl) {
    return null;
  }
  const parts: string[] = [];
  if (typeof dl.bytes === "number") {
    parts.push(`bytes=${dl.bytes}`);
  }
  if (dl.source) {
    parts.push(`source=${dl.source}`);
  }
  if (dl.saveAsError) {
    parts.push(`saveAsError=${dl.saveAsError.slice(0, ID_TEXT_SNIP)}`);
  }
  if (dl.streamError) {
    parts.push(`streamError=${dl.streamError.slice(0, ID_TEXT_SNIP)}`);
  }
  if (dl.downloadFailure) {
    parts.push(`downloadFailure=${dl.downloadFailure.slice(0, ID_TEXT_SNIP)}`);
  }
  return parts.length ? `download ${parts.join(",")}` : null;
}

function formatDiagnosticInfo(diag: DiagnosticInfo): string {
  const parts = [diag.phase];
  parts.push(`page=${diag.diag ? "captured" : "unavailable"}`);
  const artifact = summarizeArtifactDiagnostics(diag);
  if (artifact) {
    parts.push(artifact);
  }
  const download = summarizeDownloadDiagnostics(diag);
  if (download) {
    parts.push(download);
  }
  if (diag.error) {
    parts.push(`error=${diag.error.slice(0, CLICK_ERROR_SNIP)}`);
  }
  return parts.join("; ");
}

/**
 * Emit one `statements` record per index row. A hydrated row gets a
 * populated `pdf_path` / `pdf_sha256` / `document_url`. A failed hydration
 * falls back to an index-only row so the client never loses the fact that
 * the statement exists — and, if the statement was previously hydrated,
 * carries the prior content-addressed pointers forward (instead of null)
 * so a transient re-download failure does not flap them `value -> null` and
 * re-version an immutable statement. A statement that was never hydrated
 * stays all-null (honest index-only). Emits a final PROGRESS + STATE.
 *
 * Body-honesty: a carried-forward body asserts the artifact's last known
 * content-addressed location (bytes a prior run stored, which never move),
 * not that this run re-verified it; the failed-download SKIP_RESULT emitted
 * by the hydration path remains the authoritative per-run record.
 *
 * Invariants (tested in integration.test.ts + statements-fingerprint.test.ts):
 *   - same number of records emitted as rows in, regardless of
 *     hydration success (carry-forward/null fallback, not drop),
 *   - hydrated rows set pdf_path + pdf_sha256 + document_url; a
 *     never-hydrated failed row leaves all three null; a previously-
 *     hydrated failed row carries the prior pointers forward,
 *   - STATE emits exactly once after all records.
 */
export async function emitStatementRecords(
  deps: EmitDeps,
  indexRows: readonly IndexRow[],
  hydrationResults: Map<number, HydrationResult>,
  summary: HydrationSummary,
  fingerprintCursor?: FingerprintCursor,
  hydrationCursor?: StatementHydrationCursor
): Promise<void> {
  // Per-run detail-coverage evidence. Each statement-document row's resolved
  // hydration outcome (fresh, carried, or all-null) is the numerator input;
  // `shouldParseStatementTitle` is the candidacy (denominator) input. See
  // statement-coverage.ts. Collected here because this loop already resolves
  // both for every row; emitted once after the loop (below).
  const coverageRows: StatementCoverageRow[] = [];
  for (const row of indexRows) {
    const ok = hydrationSuccess(hydrationResults.get(row.rowIndex));
    // On success use this run's fresh pointers; on failure carry the prior
    // hydrated pointers forward if the statement was previously hydrated,
    // else stay all-null.
    let pointers: StatementHydration;
    if (ok) {
      pointers = {
        document_url: fileUrlForPath(ok.pdfPath),
        pdf_path: ok.pdfPath,
        pdf_sha256: ok.pdfSha256,
        pdf_text_sha256: ok.content.pdf_text_sha256,
        pdf_page_count: ok.content.pdf_page_count,
      };
    } else if (hydrationCursor) {
      pointers = hydrationCursor.resolveOnFailure(row.id);
    } else {
      pointers = { document_url: null, pdf_path: null, pdf_sha256: null, pdf_text_sha256: null, pdf_page_count: null };
    }
    coverageRows.push({ id: row.id, isCandidate: shouldParseStatementTitle(row.title), pointers });
    const rec: StatementRecord = {
      id: row.id,
      account_id: row.account_id,
      title: row.title,
      date_delivered: row.date_delivered,
      account_reference: row.account_reference,
      document_url: pointers.document_url,
      pdf_sha256: pointers.pdf_sha256,
      pdf_path: pointers.pdf_path,
      pdf_text_sha256: pointers.pdf_text_sha256 ?? null,
      pdf_page_count: pointers.pdf_page_count ?? null,
      fetched_at: nowIso(),
    };
    // Record the resolved pointers (fresh, carried, or all-null) so the
    // next run's prior map stays complete and the prune step is correct.
    hydrationCursor?.note(row.id, pointers);
    // Gate on a per-statement fingerprint that excludes the run-clock
    // `fetched_at`. A statement's identity fields (id, account_id, title,
    // date_delivered) are immutable, and pdf_path/pdf_sha256/document_url
    // are content-addressed (the path embeds the sha256 prefix), so a
    // re-hydrated identical statement produces a byte-identical body
    // modulo `fetched_at`. With carry-forward, a transient failure also
    // produces a body identical to the prior hydrated one, so the cursor
    // suppresses the re-emit. Without this gate every run appended a fresh
    // version of every statement (~15 versions/record of pure run-clock
    // churn). When no cursor is supplied (legacy callers/tests) the
    // record always emits.
    if (!fingerprintCursor || fingerprintCursor.shouldEmit(rec)) {
      await deps.emitRecord("statements", rec);
    }
  }
  // Statements is a full scan of the documents index: prune fingerprints
  // (and the carried hydration pointers, in lockstep) for statements no
  // longer listed so a re-appearance re-emits and a delisted statement
  // stops being carried forever.
  fingerprintCursor?.pruneStale();
  hydrationCursor?.pruneStale();
  // Honest per-run detail coverage for the statement-PDF detail pass. Emitted
  // only when the run saw at least one statement-document row (a real
  // denominator). Each gap candidate (a statement whose PDF is not present this
  // run) is a pending, retryable DETAIL_GAP — so the run reads "partial, will
  // retry" instead of "complete", and the runtime's coverage-completeness
  // invariant (required === hydrated ∪ pending-gap) holds. Reference-only:
  // these reuse DETAIL_GAP / DETAIL_COVERAGE without promoting them to portable
  // protocol. Strictly additive — no statement RECORD or STATE changes.
  await emitStatementCoverage(deps, coverageRows);
  const progressMsg = {
    type: "PROGRESS",
    stream: "statements",
    message: `Hydrated ${summary.successes}/${summary.attempts || indexRows.length} PDFs`,
    count: summary.successes,
    total: summary.attempts || indexRows.length,
  } as const;
  await deps.emit(progressMsg);
  const cursor: Record<string, unknown> = { fetched_at: nowIso() };
  if (fingerprintCursor && fingerprintCursor.size() > 0) {
    cursor.fingerprints = fingerprintCursor.toState();
  }
  if (hydrationCursor && hydrationCursor.size() > 0) {
    cursor.hydration = hydrationCursor.toState();
  }
  await deps.emit({
    type: "STATE",
    stream: "statements",
    cursor,
  });
}

/**
 * Emit the per-run `statements` detail-coverage evidence: a redacted, pending
 * DETAIL_GAP for each statement-document row whose PDF is not present this run,
 * then one DETAIL_COVERAGE whose `required_keys` is the real denominator (the
 * statement-document rows the run saw on the documents index). The denominator
 * never includes disclosures/agreements (index-only by design) and never
 * carries account/title text — only opaque statement id hashes. See
 * statement-coverage.ts for the contract.
 *
 * Always emits when called — including a steady-state run that enumerated the
 * documents index and found zero statement-document candidates (considered: 0,
 * covered: 0, empty key sets). The caller only invokes this once the index
 * enumeration has actually completed (`runStatementsStream`'s scrape try/catch
 * short-circuits to a SKIP_RESULT and never reaches this function on a failed
 * scrape — see index.ts's `runStatementsStream`), so "zero candidates here"
 * always means "the run measured the denominator and it was zero," never
 * "enumeration never happened." Suppressing on zero would leave the stream
 * permanently unmeasured on an every-run-empty account.
 */
export async function emitStatementCoverage(
  deps: EmitDeps,
  coverageRows: readonly StatementCoverageRow[]
): Promise<void> {
  const result = computeStatementCoverage(coverageRows);
  for (const gap of result.gaps) {
    await deps.emit(gap);
  }
  await emitDetailCoverage(deps, result.coverage);
}

/**
 * Parse the prior `statements` STATE cursor's `fingerprints` map. Keyed
 * by statement `id`. Legacy cursors (only `{ fetched_at }`) decode to an
 * empty map, so the first post-deploy run rebuilds the map and re-emits
 * every statement exactly once.
 */
export function readPriorStatementFingerprints(state: Record<string, unknown>): Map<string, string> {
  const streamState = (state.statements ?? {}) as Record<string, unknown>;
  const raw = streamState.fingerprints;
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out.set(id, value);
    }
  }
  return out;
}

/**
 * Parse the prior `transactions` STATE cursor's `fingerprints` map. Keyed
 * by the transaction record `id` (`hashId(accountId|date|amount|original|
 * #ord)`), shared across the CSV-export and PDF-statement emit paths
 * (both hash the same logical transaction to the same id). The cursor is
 * otherwise a flat `accountKey -> { last_date }` map, so `fingerprints` is
 * a reserved sibling key. Legacy cursors (no `fingerprints`) decode to an
 * empty map, so the first post-deploy run rebuilds the map and re-emits
 * every in-window transaction exactly once.
 */
export function readPriorTransactionFingerprints(state: Record<string, unknown>): Map<string, string> {
  const streamState = (state.transactions ?? {}) as Record<string, unknown>;
  const raw = streamState.fingerprints;
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out.set(id, value);
    }
  }
  return out;
}

/**
 * Parse the prior `inbox_messages` STATE cursor's `fingerprints` map.
 * Keyed by the message record `id` (`hashId(date_short|preview[:120])`).
 * Legacy cursors (only `{ fetched_at }`) decode to an empty map, so the
 * first post-deploy run rebuilds the map and re-emits every still-listed
 * message exactly once.
 */
export function readPriorInboxMessageFingerprints(state: Record<string, unknown>): Map<string, string> {
  const streamState = (state.inbox_messages ?? {}) as Record<string, unknown>;
  const raw = streamState.fingerprints;
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out.set(id, value);
    }
  }
  return out;
}

// ─── Account extraction from the /my/usaa dashboard ───────────────────────

async function extractAccounts(page: Page): Promise<DashboardAccount[]> {
  await page.goto("https://www.usaa.com/my/usaa", {
    waitUntil: "domcontentloaded",
    timeout: DASHBOARD_NAV_TIMEOUT_MS,
  });
  await page
    .waitForSelector(DASHBOARD_SELECTOR_WAIT, {
      timeout: DASHBOARD_SELECTOR_TIMEOUT_MS,
    })
    .catch((): undefined => undefined);
  await politeDelay(DASHBOARD_SETTLE_DELAY_MS);
  return page.evaluate((linkSelector: string): DashboardAccount[] => {
    // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
    const WHITESPACE_RE = /\s+/g;
    const SKIP_TEXT_RE = /^(Get started|Add account|View|Manage|Open|Apply|Browse)/i;
    const TYPE_URL_RE = /^\/my\/([^/?]+)/;
    const ACCOUNT_ID_RE = /(?:accountId|acctId)=([^&]+)/;
    const LAST4_RE = /\*(\d{4})/;
    const ENDING_IN_RE = /\bEnding in\b|\bending in\b/i;
    const DOLLAR_RE = /\$([\d,]+\.\d{2})/g;
    const COMMA_RE_LOCAL = /,/g;
    // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.

    const out: DashboardAccount[] = [];
    const links = [...document.querySelectorAll<HTMLElement>(linkSelector)];
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const text = (a.innerText || "").replace(WHITESPACE_RE, " ").trim();
      // Skip nav/CTA links that happen to match the URL prefix but have generic text.
      if (!text || text.length < 12 || SKIP_TEXT_RE.test(text)) {
        continue;
      }
      const typeMatch = href.match(TYPE_URL_RE);
      const accountType = typeMatch?.[1] ?? "unknown";
      const idMatch = href.match(ACCOUNT_ID_RE);
      const accountId = idMatch?.[1] ? decodeURIComponent(idMatch[1]) : null;
      const last4Match = text.match(LAST4_RE);
      const splitByEnding = text.split(ENDING_IN_RE);
      const namePart = splitByEnding[0] ?? "";
      const name = namePart.trim();
      const amounts = [...text.matchAll(DOLLAR_RE)]
        .map((m) => (m[1] ? m[1] : null))
        .filter((v): v is string => Boolean(v));
      const [firstAmount] = amounts;
      const balanceCents = firstAmount ? Math.round(Number(firstAmount.replace(COMMA_RE_LOCAL, "")) * 100) : null;
      out.push({
        account_id_raw: accountId,
        account_url: href,
        account_type: accountType,
        name: name || null,
        last_four: last4Match?.[1] ?? null,
        balance_cents: balanceCents,
        raw_text: text.slice(0, 200),
      });
    }
    return out;
  }, ACCOUNT_URL_PREFIXES);
}

// ─── CSV export driver for transactions ───────────────────────────────────

async function findExportAffordance(page: Page): Promise<Locator | null> {
  const bankClass = page.locator("button.ent-as-utility-bar__item.export");
  if (await bankClass.count().catch((): number => 0)) {
    return bankClass.first();
  }

  const creditClass = page.locator("button.as_credit__utility-bar-item.as_credit__export");
  if (await creditClass.count().catch((): number => 0)) {
    return creditClass.first();
  }

  const buttonText = page.locator('button, [role="button"]').filter({ hasText: EXPORT_BUTTON_TEXT_RE });
  if (await buttonText.count().catch((): number => 0)) {
    return buttonText.first();
  }

  return null;
}

/** Classify in memory only; no URL or route fragment reaches durable evidence. */
function parseUsaaAccountPageUrl(value: string): URL | null {
  try {
    const url = new URL(value, USAA_ORIGIN);
    return url.origin === USAA_ORIGIN ? url : null;
  } catch {
    return null;
  }
}

function usaaAccountIdFromUrl(url: URL): string | null {
  const ids = [url.searchParams.get("accountId"), url.searchParams.get("acctId")].filter((value): value is string =>
    Boolean(value)
  );
  return new Set(ids).size === 1 ? (ids[0] ?? null) : null;
}

/** Compare the final page to the exact account URL requested by the driver.
 * This returns only a closed enum so neither URL can leak into diagnostics. */
export function classifyUsaaAccountPageIdentity(
  requestedUrl: string | undefined,
  finalUrl: string
): UsaaAccountPageIdentity {
  const actual = parseUsaaAccountPageUrl(finalUrl);
  if (!(actual && USAA_ACCOUNT_DETAIL_ROUTE_RE.test(actual.pathname))) {
    return "mismatch";
  }
  if (!requestedUrl) {
    return "unverified";
  }
  const requested = parseUsaaAccountPageUrl(requestedUrl);
  if (!(requested && USAA_ACCOUNT_DETAIL_ROUTE_RE.test(requested.pathname))) {
    return "unverified";
  }
  const requestedId = usaaAccountIdFromUrl(requested);
  const actualId = usaaAccountIdFromUrl(actual);
  if (!(requestedId && actualId)) {
    return "unverified";
  }
  return requested.pathname === actual.pathname && requestedId === actualId ? "exact" : "mismatch";
}

export function classifyUsaaNoExportRoute(
  value: string,
  hasKnownAccountOrTransactionMarker: boolean,
  requestedUrl?: string
): NoExportAffordanceObservation["route"] {
  try {
    const url = parseUsaaAccountPageUrl(value);
    if (!url) {
      return "unknown";
    }
    if (USAA_INTERSTITIAL_ROUTE_RE.test(url.pathname)) {
      return "interstitial";
    }
    const identity = requestedUrl ? classifyUsaaAccountPageIdentity(requestedUrl, value) : "unverified";
    return USAA_ACCOUNT_DETAIL_ROUTE_RE.test(url.pathname) &&
      hasKnownAccountOrTransactionMarker &&
      (!requestedUrl || identity === "exact")
      ? "expected"
      : "unknown";
  } catch {
    return "unknown";
  }
}

async function captureNoExportAffordanceObservation(
  page: Page,
  requestedUrl?: string
): Promise<NoExportAffordanceObservation> {
  const counts = await page
    .evaluate(
      ({ accountDetail, exportAffordance, navigation, transaction }) => {
        // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
        const WS_RE = /\s+/g;
        // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
        const candidates = [...document.querySelectorAll<HTMLElement>(exportAffordance)].slice(0, 8).map((el) => ({
          aria_disabled: el.getAttribute("aria-disabled") === "true",
          cls: (el.className ? String(el.className) : "").slice(0, 80),
          disabled: "disabled" in el ? Boolean((el as HTMLButtonElement).disabled) : false,
          id: el.id || null,
          role: el.getAttribute("role"),
          tag: el.tagName,
          text: (el.innerText || "").replace(WS_RE, " ").trim().slice(0, 50),
          type: el.getAttribute("type"),
          visible: el.offsetParent !== null,
        }));
        return {
          account_detail_marker_count: document.querySelectorAll(accountDetail).length,
          export_affordance_candidates: candidates,
          navigation_marker_count: document.querySelectorAll(navigation).length,
          target_count: document.querySelectorAll(exportAffordance).length,
          transaction_marker_count: document.querySelectorAll(transaction).length,
        };
      },
      {
        accountDetail: USAA_ACCOUNT_DETAIL_MARKER_SELECTOR,
        exportAffordance: USAA_EXPORT_AFFORDANCE_SELECTOR,
        navigation: USAA_NAVIGATION_MARKER_SELECTOR,
        transaction: USAA_TRANSACTION_MARKER_SELECTOR,
      }
    )
    .catch(() => ({
      account_detail_marker_count: 0,
      export_affordance_candidates: [] as NoExportAffordanceObservation["export_affordance_candidates"],
      navigation_marker_count: 0,
      target_count: 0,
      transaction_marker_count: 0,
    }));
  const hasKnownAccountOrTransactionMarker =
    counts.account_detail_marker_count > 0 || counts.transaction_marker_count > 0;
  const [firstCandidate] = counts.export_affordance_candidates ?? [];
  const affordanceDisabled =
    counts.target_count > 0 && Boolean(firstCandidate?.disabled || firstCandidate?.aria_disabled);
  const finalUrl = page.url();
  return {
    ...counts,
    affordance_disabled: affordanceDisabled,
    account_page_identity: classifyUsaaAccountPageIdentity(requestedUrl, finalUrl),
    route: classifyUsaaNoExportRoute(finalUrl, hasKnownAccountOrTransactionMarker, requestedUrl),
  };
}

function noExportAffordanceDiagnostic(diag: DiagnosticInfo | null, managedSurface: BrowserSurfaceManagedState) {
  const observation = diag?.no_export_observation;
  const diagnostic = buildBrowserSurfaceDiagnostic({
    accountDetailMarkerCount: observation?.account_detail_marker_count,
    kind: "usaa_transaction_export",
    managedSurface,
    navigationMarkerCount: observation?.navigation_marker_count,
    parserCount: 0,
    readCount: 1,
    route: observation?.route ?? "unknown",
    targetCount: observation?.target_count,
    transactionMarkerCount: observation?.transaction_marker_count,
    verifiedEmptyMarkerCount: 0,
    waitOutcome: "not_needed",
  });
  if (!diagnostic) {
    throw new Error("closed USAA browser-surface diagnostic input was invalid");
  }
  return diagnostic;
}

class SessionDeadRedirectError extends Error {
  readonly observation: NoExportAffordanceObservation;

  constructor(observation: NoExportAffordanceObservation) {
    super("session_dead_redirect_to_logon");
    this.name = "SessionDeadRedirectError";
    this.observation = observation;
  }
}

function capturePageDiagnostics(page: Page): Promise<PageDiagnostics | null> {
  return page
    .evaluate((): PageDiagnostics => {
      // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
      const WS_RE = /\s+/g;
      const EXPORT_OR_DL_RE = /export|download/i;
      // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.

      const take = (sel: string, max = 8): DiagnosticCandidate[] => {
        const els = [...document.querySelectorAll<HTMLElement>(sel)];
        return els.slice(0, max).map((el) => ({
          tag: el.tagName,
          text: (el.innerText || "").replace(WS_RE, " ").trim().slice(0, 50),
          cls: (el.className ? String(el.className) : "").slice(0, 80),
          id: el.id || null,
        }));
      };
      return {
        url: location.href,
        title: document.title,
        has_utility_bar: Boolean(document.querySelector('.ent-as-utility-bar, [class*="utility-bar" i]')),
        export_candidates: take('button, [role="button"]').filter((c) => EXPORT_OR_DL_RE.test(c.text)),
        nav_candidates: take('a[href*="/my/credit-card"], a[role="tab"], [role="tab"]'),
        dialogs_open: document.querySelectorAll('[role="dialog"]').length,
      };
    })
    .catch((): PageDiagnostics | null => null);
}

async function locateExportPage(
  page: Page,
  accountUrl: string,
  settleDelayMs: number
): Promise<LocatedExportPage | null> {
  const candidates = [accountUrl];

  const seen = new Set<string>();
  for (const url of candidates) {
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: ACCOUNT_NAV_TIMEOUT_MS,
      });
    } catch {
      continue;
    }
    await politeDelay(settleDelayMs);
    const finalUrl = page.url();
    if (LOGON_REDIRECT_RE.test(finalUrl)) {
      throw new SessionDeadRedirectError(await captureNoExportAffordanceObservation(page));
    }
    if (classifyUsaaAccountPageIdentity(accountUrl, finalUrl) !== "exact") {
      continue;
    }
    const btn = await findExportAffordance(page);
    if (btn) {
      return { url: finalUrl, export: btn };
    }
  }
  return null;
}

const DIALOG_HTML_WS_RE = /\s+/g;

async function emitExportClickFailedDiagnostic(
  page: Page,
  onDiagnostics: DriveExportOptions["onDiagnostics"],
  err: unknown
): Promise<void> {
  if (!onDiagnostics) {
    return;
  }
  const diag = await capturePageDiagnostics(page);
  const msg = err instanceof Error ? err.message : String(err);
  onDiagnostics({
    phase: "export_click_failed",
    diag,
    error: msg.slice(0, CLICK_ERROR_SNIP),
  });
}

/**
 * Redacted, bounded structural evidence for `export_dialog_unexpected_shape` — the
 * one diagnostic phase this file has no retained live DOM evidence for (the
 * 2026-07-31 gate recorded only the redacted phase). Every OTHER diagnostic
 * capture in this file (the
 * `dialog_html_preview` passed to `onDiagnostics`, and every
 * `captureExportCheckpoint` call) is either bounded to `HTML_PREVIEW_MAX`
 * chars before it reaches durable evidence, or gated behind
 * `options.capture` (the operator-opt-in `PDPP_CAPTURE_FIXTURES` /
 * `PDPP_CAPTURE_ON_FAILURE` fixture-capture session — see
 * ../../src/fixture-capture.ts). On the 2026-07-31 live run neither capture
 * flag was set, so when the dialog took this unexpected shape the ladder's
 * own diagnostics were fully redacted before they reached the DB
 * (`sanitizeDiagnosticInfo` nulls `dialog_html_preview` and every candidate
 * list), and no `dom/*.html` checkpoint existed to fall back on — the
 * failure was real and reproducible in the live DB, but the DOM shape that
 * caused it is unrecoverable after the fact.
 *
 * This function closes that specific gap without turning on general-purpose
 * capture (a shared-runtime, cross-connector policy change, out of scope for
 * a provider-specific fix): it writes ONE bounded, path-fixed, filename-fixed
 * file per process — `<capture root>/usaa/diagnostics/export-dialog-unexpected-shape.json`
 * — that a later run silently overwrites, so disk usage never grows
 * unbounded regardless of how many times this phase recurs. It fires
 * unconditionally at this one boundary (not a general "always capture
 * everything" change), is best-effort (a write failure is swallowed exactly
 * like every other capture call in this file — capture must never fail a
 * run). Titles, HTML, labels, classes, paths, and identifiers are redacted
 * before serialization, and the final UTF-8 JSON is hard-capped. The next
 * live occurrence leaves a retrievable, git-ignored structural receipt even
 * with fixture capture off.
 */
const DEFAULT_FALLBACK_DIAGNOSTIC_ROOT = join(new URL("../../fixtures", import.meta.url).pathname);

/** Read at call time (not module load) so PDPP_CAPTURE_ROOT_DIR set after
 *  import is honored, matching how createCaptureSession reads the same env
 *  var in fixture-capture.ts. `override` lets a test supply an explicit
 *  root instead of mutating global process.env — this file's tests run as
 *  concurrent top-level test() calls by default, so a shared env mutation
 *  would race with unrelated tests in the same process. */
function fallbackDiagnosticRoot(override: string | undefined): string {
  return override ?? process.env.PDPP_CAPTURE_ROOT_DIR?.trim() ?? DEFAULT_FALLBACK_DIAGNOSTIC_ROOT;
}

function serializeFallbackPayload(phase: string, payload: Record<string, unknown>): string {
  const minimal = JSON.stringify({ phase, truncated: true });
  try {
    const serialized = JSON.stringify(payload, null, 2);
    if (serialized && Buffer.byteLength(serialized, "utf8") <= USAA_FALLBACK_SERIALIZED_BYTES_MAX) {
      return serialized;
    }
  } catch {
    // Fall through to the minimal valid receipt.
  }
  return minimal;
}

function redactFallbackObservation(observation: NoExportAffordanceObservation): NoExportAffordanceObservation {
  return {
    account_detail_marker_count: observation.account_detail_marker_count,
    ...(observation.account_page_identity ? { account_page_identity: observation.account_page_identity } : {}),
    affordance_disabled: observation.affordance_disabled,
    export_affordance_candidates: observation.export_affordance_candidates.map((candidate) => ({
      aria_disabled: candidate.aria_disabled,
      cls: "",
      disabled: candidate.disabled,
      id: null,
      role: null,
      tag: "",
      text: "",
      type: null,
      visible: candidate.visible,
    })),
    navigation_marker_count: observation.navigation_marker_count,
    route: observation.route,
    target_count: observation.target_count,
    transaction_marker_count: observation.transaction_marker_count,
  };
}

function redactFallbackSurfaceControls(controls: BoundedSurfaceControl[]): BoundedSurfaceControl[] {
  return controls.map((control) => ({
    aria_disabled: control.aria_disabled,
    class_name: "",
    disabled: control.disabled,
    href_path: null,
    label: "",
    role: null,
    tag: "",
    type: null,
    visible: control.visible,
  }));
}

async function writeExportDialogUnexpectedShapeFallback(rootOverride: string | undefined): Promise<void> {
  try {
    const dir = join(fallbackDiagnosticRoot(rootOverride), "usaa", "diagnostics");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "export-dialog-unexpected-shape.json"),
      serializeFallbackPayload("export_dialog_unexpected_shape", {
        captured_at: nowIso(),
        dialog_html_preview: null,
        page_title: null,
        phase: "export_dialog_unexpected_shape",
        note: "Redacted structural fallback; overwritten on every occurrence.",
      })
    );
  } catch {
    // Best-effort, matching every other capture call in this file: a
    // filesystem error here must never fail the connector run.
  }
}

interface BoundedSurfaceControl {
  aria_disabled: boolean;
  class_name: string;
  disabled: boolean;
  href_path: string | null;
  label: string;
  role: string | null;
  tag: string;
  type: string | null;
  visible: boolean;
}

/** Capture only bounded structural control facts after an export affordance is
 * absent. The in-memory probe is diagnostic-only; its durable fallback is
 * redacted before it is serialized and never drives a selector or click. */
async function captureBoundedSurfaceControls(page: Page): Promise<BoundedSurfaceControl[]> {
  const controls = await page
    .evaluate(() => {
      const visibleControls = [...document.querySelectorAll<HTMLElement>('button, [role="button"], a')]
        .slice(0, 24)
        .map((el): BoundedSurfaceControl => {
          const href = el.getAttribute("href");
          let hrefPath: string | null = null;
          if (href) {
            try {
              hrefPath = new URL(href, location.href).pathname.slice(0, 120);
            } catch {
              hrefPath = null;
            }
          }
          return {
            aria_disabled: el.getAttribute("aria-disabled") === "true",
            class_name: (typeof el.className === "string" ? el.className : "").slice(0, 100),
            disabled: "disabled" in el ? Boolean((el as HTMLButtonElement).disabled) : false,
            href_path: hrefPath,
            label: (el.getAttribute("aria-label") || el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
            role: el.getAttribute("role"),
            tag: el.tagName,
            type: el.getAttribute("type"),
            visible: el.offsetParent !== null,
          };
        });
      return visibleControls;
    })
    .catch((): BoundedSurfaceControl[] => []);
  return Array.isArray(controls) ? controls : [];
}

/**
 * Persist one bounded, path-fixed structural receipt whenever the export
 * affordance is absent or disabled. It is separate from durable SKIP_RESULT
 * diagnostics, local, git-ignored, overwritten on every occurrence, strictly
 * redacted, and byte-capped; the next authenticated UAT run must inspect the
 * live surface directly rather than treating this receipt as selector proof.
 */
async function writeNoExportAffordanceFallback(
  page: Page,
  observation: NoExportAffordanceObservation,
  rootOverride: string | undefined
): Promise<void> {
  try {
    const dir = join(fallbackDiagnosticRoot(rootOverride), "usaa", "diagnostics");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "no-export-affordance.json"),
      serializeFallbackPayload("no_export_affordance", {
        captured_at: nowIso(),
        observation: redactFallbackObservation(observation),
        page_title: null,
        phase: "no_export_affordance",
        surface_controls: redactFallbackSurfaceControls(await captureBoundedSurfaceControls(page)),
        note: "Redacted structural fallback; overwritten on every occurrence.",
      })
    );
  } catch {
    // A diagnostic fallback must never fail the collection run.
  }
}

async function readDialogHtmlPreview(page: Page): Promise<string | null> {
  const dialogHtml = await page
    .locator('[role="dialog"]')
    .first()
    .innerHTML()
    .catch((): string | null => null);
  return dialogHtml ? dialogHtml.replace(DIALOG_HTML_WS_RE, " ").slice(0, HTML_PREVIEW_MAX) : null;
}

function emitDialogUnexpectedShapeDiagnostic(
  base: PageDiagnostics | null,
  preview: string | null,
  onDiagnostics: NonNullable<DriveExportOptions["onDiagnostics"]>,
  accountPageIdentity: UsaaAccountPageIdentity
): void {
  onDiagnostics({
    account_page_identity: accountPageIdentity,
    phase: "export_dialog_unexpected_shape",
    diag: base
      ? { ...base, dialog_html_preview: preview }
      : {
          url: "",
          title: "",
          has_utility_bar: false,
          export_candidates: [],
          nav_candidates: [],
          dialogs_open: 0,
          dialog_html_preview: preview,
        },
  });
}

/** Click Export, then confirm the date-range selector rendered. */
async function openExportDialog(
  page: Page,
  located: LocatedExportPage,
  accountUrl: string,
  options: DriveExportOptions
): Promise<boolean> {
  const { onDiagnostics } = options;
  // Check actionability explicitly before clicking rather than letting a
  // disabled button run out the click's internal actionability poll: the
  // outcome is identical (the click would never succeed), but a blind click
  // timeout only leaves an opaque, best-effort Playwright call-log string as
  // evidence, while the explicit check reuses the same disabled/aria-disabled
  // facts already captured for no_export_affordance/export_affordance_candidates
  // — the button is present (target_count > 0) but not yet actionable, which
  // is categorically different evidence from a genuinely missing affordance.
  const enabled = await located.export
    .isEnabled({ timeout: EXPORT_ENABLED_CHECK_TIMEOUT_MS })
    .catch((): boolean => false);
  if (!enabled) {
    await emitNoExportAffordanceDiagnostic(page, options, "export-affordance-disabled", accountUrl);
    return false;
  }
  try {
    await located.export.click({ timeout: EXPORT_CLICK_TIMEOUT_MS });
  } catch (err) {
    await emitExportClickFailedDiagnostic(page, onDiagnostics, err);
    return false;
  }
  await politeDelay(EXPORT_DIALOG_DELAY_MS);

  const selectCount = await page
    .locator('[role="dialog"] select[name="selectionType"], select[name="selectionType"]')
    .count()
    .catch((): number => 0);
  if (!selectCount) {
    // The dialog HTML preview is retained only for the bounded in-memory
    // diagnostic. The fallback capture fires unconditionally but never
    // receives DOM/title evidence (see writeExportDialogUnexpectedShapeFallback).
    const preview = await readDialogHtmlPreview(page);
    await writeExportDialogUnexpectedShapeFallback(options.fallbackDiagnosticRootOverride);
    if (onDiagnostics) {
      const base = await capturePageDiagnostics(page);
      emitDialogUnexpectedShapeDiagnostic(
        base,
        preview,
        onDiagnostics,
        classifyUsaaAccountPageIdentity(accountUrl, page.url())
      );
    }
    // Capture before Escape: the keypress below can dismiss/mutate the
    // dialog surface, so the checkpoint must run on the still-intact page.
    await captureExportCheckpoint(page, options, "dialog-not-open");
    await page.keyboard.press("Escape").catch((): undefined => undefined);
    return false;
  }
  return true;
}

/** Fill the date-range inputs via select → clear → type. */
async function fillExportDateRange(page: Page, sinceDate: string, untilDate: string): Promise<void> {
  await page.selectOption('select[name="selectionType"]', "date-range").catch((): string[] => []);
  await politeDelay(EXPORT_STATE_DELAY_MS);

  const fromIn = page.locator('input[name="fromDate"], input[name="startDate"]').first();
  const endIn = page.locator('input[name="endDate"]').first();
  await fromIn.click().catch((): undefined => undefined);
  await page.keyboard.press("Control+A").catch((): undefined => undefined);
  await page.keyboard.press("Delete").catch((): undefined => undefined);
  await fromIn.pressSequentially(mmddyyyy(sinceDate), { delay: KEY_TYPE_DELAY_MS }).catch((): undefined => undefined);
  await endIn.click().catch((): undefined => undefined);
  await page.keyboard.press("Control+A").catch((): undefined => undefined);
  await page.keyboard.press("Delete").catch((): undefined => undefined);
  await endIn.pressSequentially(mmddyyyy(untilDate), { delay: KEY_TYPE_DELAY_MS }).catch((): undefined => undefined);
  await politeDelay(EXPORT_STATE_DELAY_MS);
  await politeDelay(EXPORT_STATE_DELAY_MS);
}

async function captureExportCheckpoint(page: Page, options: DriveExportOptions, suffix: string): Promise<void> {
  if (!(options.capture && options.captureLabel)) {
    return;
  }
  await options.capture.captureDom(page, `${options.captureLabel}-${suffix}`).catch((): undefined => undefined);
}

type ExportSubmitOutcome =
  | { buffer: Buffer; kind: "artifact"; suggestedFilename: string | null }
  | {
      kind: "artifact_failed";
      artifact: BodyResponseDiagnostics;
      download: DownloadDiagnostics | null;
      error: string;
    }
  | { kind: "dialog_error"; message: string }
  | { kind: "empty"; message: string };

/**
 * Error subclass used by `waitForCsvArtifact` so failure callers can read
 * the download-side evidence (Playwright Download URL, suggestedFilename,
 * remote `failure()`, byte count, fallback source) without re-deriving it.
 */
class CsvArtifactError extends Error {
  readonly download: DownloadDiagnostics | null;
  constructor(message: string, download: DownloadDiagnostics | null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CsvArtifactError";
    this.download = download;
  }
}

type DriveExportResult = { kind: "artifact"; path: string } | { kind: "empty" } | { kind: "failed" };

export function isNoDataExportMessage(text: string): boolean {
  return EXPORT_NO_DATA_RE.test(text);
}

/**
 * Skip Adobe Analytics / SiteCatalyst beacon hosts when filtering candidate
 * response bodies. USAA tracks the "export" click as a pageName analytics
 * event, so the keyword `export` ends up in the URL query string of every
 * beacon hit — which was matching `CSV_DOWNLOAD_HINT_RE` and crowding the
 * real CSV endpoint out of the diagnostics candidate list when an export
 * actually failed. Beacons return `image/gif` and never carry the CSV body,
 * so excluding them costs us nothing.
 */
const ANALYTICS_HOST_RE = /^https?:\/\/(da|smetrics|tags|tms)\.usaa\.com\//iu;
const ANALYTICS_CONTENT_TYPE_RE = /image\/gif/iu;

function isAnalyticsBeacon(headers: Record<string, string>, url: string): boolean {
  if (ANALYTICS_HOST_RE.test(url)) {
    return true;
  }
  const contentType = headers["content-type"]?.toLowerCase() ?? "";
  return ANALYTICS_CONTENT_TYPE_RE.test(contentType);
}

function attachCsvResponseQueue(page: Page): BodyResponseQueue {
  return attachBodyResponseQueue(page, {
    isExpectedBody(body, headers) {
      if (body.length === 0) {
        return false;
      }
      const contentType = headers["content-type"]?.toLowerCase() ?? "";
      if (contentType.includes("text/html") || contentType.includes("application/json")) {
        return false;
      }
      const head = body.subarray(0, 2048).toString("utf8");
      return CSV_HEAD_RE.test(head) && head.includes(",");
    },
    shouldInspect(headers, url) {
      if (isAnalyticsBeacon(headers, url)) {
        return false;
      }
      const hint = `${headers["content-disposition"] ?? ""} ${headers["content-type"] ?? ""} ${url}`;
      return CSV_DOWNLOAD_HINT_RE.test(hint);
    },
  });
}

async function snapshotDownloadFailure(
  download: Pick<import("playwright").Download, "url" | "suggestedFilename" | "failure">
): Promise<DownloadDiagnostics> {
  const failure = await download.failure().catch((): null => null);
  let url: string | null;
  try {
    url = download.url();
  } catch {
    url = null;
  }
  let suggestedFilename: string | null;
  try {
    suggestedFilename = download.suggestedFilename();
  } catch {
    suggestedFilename = null;
  }
  return { url, suggestedFilename, downloadFailure: failure };
}

async function waitForCsvArtifact(
  downloadQueue: DownloadQueue,
  responseQueue: BodyResponseQueue
): Promise<{ buffer: Buffer; suggestedFilename: string | null }> {
  const responsePromise = responseQueue.waitForNextResponse({ timeoutMs: DOWNLOAD_TIMEOUT_MS });
  const downloadPromise = downloadQueue.waitForNextDownload({ timeoutMs: DOWNLOAD_TIMEOUT_MS });
  const result = await Promise.any([
    responsePromise.then((response) => ({ kind: "response" as const, response })),
    downloadPromise.then((downloadResult) => ({ download: downloadResult, kind: "download" as const })),
  ]);
  if (result.kind === "response") {
    // The download arm lost the race and is never consumed on this path;
    // detach() settles it immediately, so it must have a handler or that
    // rejection is unhandled.
    downloadPromise.catch((): undefined => undefined);
    return { buffer: result.response.body, suggestedFilename: result.response.suggestedFilename };
  }
  const { download } = result;
  try {
    const { buffer, outcome } = await readPlaywrightDownloadBufferDetailed(download);
    if (buffer.length > 0) {
      // The response arm lost the race and is never consumed on this path;
      // neutralize it so detach()'s now-immediate rejection isn't unhandled.
      responsePromise.catch((): undefined => undefined);
      return { buffer, suggestedFilename: download.suggestedFilename() };
    }
    // saveAs + createReadStream both produced zero bytes. Capture the
    // download-side evidence (URL, suggested filename, remote failure)
    // before falling through to the response-queue grace window.
    const baseDiag = await snapshotDownloadFailure(download);
    const downloadDiag: DownloadDiagnostics = {
      ...baseDiag,
      bytes: outcome.bytes,
      source: outcome.source,
      saveAsError: outcome.saveAsError ?? null,
      streamError: outcome.streamError ?? null,
    };
    const response = await waitForOptionalBodyResponse(responsePromise, RESPONSE_FALLBACK_GRACE_MS);
    if (response) {
      return { buffer: response.body, suggestedFilename: response.suggestedFilename };
    }
    throw new CsvArtifactError("download_empty", downloadDiag);
  } catch (err) {
    if (err instanceof CsvArtifactError) {
      throw err;
    }
    const baseDiag = await snapshotDownloadFailure(download).catch((): DownloadDiagnostics => ({}));
    const downloadDiag: DownloadDiagnostics = {
      ...baseDiag,
      bytes: 0,
      saveAsError: err instanceof Error ? err.message : String(err),
    };
    const response = await waitForOptionalBodyResponse(responsePromise, RESPONSE_FALLBACK_GRACE_MS);
    if (response) {
      return { buffer: response.body, suggestedFilename: response.suggestedFilename };
    }
    // biome-ignore lint/style/useErrorCause: CsvArtifactError's 3rd constructor arg forwards to super(message, { cause })
    throw new CsvArtifactError(err instanceof Error ? err.message : String(err), downloadDiag, err);
  }
}

/** Submit the export dialog, race the downloadable artifact against an inline error. */
async function submitExportAndAwait(page: Page): Promise<ExportSubmitOutcome> {
  const downloadQueue = attachDownloadQueue(page);
  const responseQueue = attachCsvResponseQueue(page);
  await responseQueue.ready;

  const submit = page.locator('[role="dialog"] button[type="submit"]').first();
  try {
    await submit.click().catch((): undefined => undefined);

    const dialogMessage = page.locator(EXPORT_DIALOG_MESSAGE_SELECTOR).first();
    const readDialogOutcome = async (): Promise<ExportSubmitOutcome> => {
      const message = ((await dialogMessage.textContent().catch((): string | null => null)) ?? "").trim();
      return isNoDataExportMessage(message) ? { kind: "empty", message } : { kind: "dialog_error", message };
    };
    const errorPromise = page
      .locator(EXPORT_DIALOG_MESSAGE_SELECTOR)
      .first()
      .waitFor({ state: "visible", timeout: DOWNLOAD_TIMEOUT_MS })
      .then(readDialogOutcome)
      .catch((): Promise<never> => new Promise((): void => undefined));

    return await Promise.race<ExportSubmitOutcome>([
      waitForCsvArtifact(downloadQueue, responseQueue).then(
        (artifact): ExportSubmitOutcome => ({
          buffer: artifact.buffer,
          kind: "artifact",
          suggestedFilename: artifact.suggestedFilename,
        })
      ),
      errorPromise,
    ]);
  } catch (err) {
    return {
      artifact: responseQueue.diagnostics(),
      download: err instanceof CsvArtifactError ? err.download : null,
      error: err instanceof Error ? err.message : String(err),
      kind: "artifact_failed",
    };
  } finally {
    downloadQueue.detach();
    responseQueue.detach();
  }
}

async function emitNoExportAffordanceDiagnostic(
  page: Page,
  options: DriveExportOptions,
  checkpointSuffix: string,
  requestedUrl?: string
): Promise<void> {
  await captureExportCheckpoint(page, options, checkpointSuffix);
  const noExportObservation = await captureNoExportAffordanceObservation(page, requestedUrl);
  await writeNoExportAffordanceFallback(page, noExportObservation, options.fallbackDiagnosticRootOverride);
  if (options.onDiagnostics) {
    options.onDiagnostics({
      diag: null,
      no_export_observation: noExportObservation,
      phase: "no_export_affordance",
      ...(noExportObservation.account_page_identity
        ? { account_page_identity: noExportObservation.account_page_identity }
        : {}),
    });
  }
}

async function noExportAffordanceFailure(
  page: Page,
  options: DriveExportOptions,
  requestedUrl: string
): Promise<DriveExportResult> {
  await emitNoExportAffordanceDiagnostic(page, options, "no-export-affordance", requestedUrl);
  return { kind: "failed" };
}

export async function driveExport(
  page: Page,
  accountUrl: string,
  options: DriveExportOptions
): Promise<DriveExportResult> {
  const { sinceDate, untilDate, onDiagnostics } = options;
  const located = await locateExportPage(page, accountUrl, options.settleDelayMs ?? ACCOUNT_SETTLE_DELAY_MS);
  if (!located) {
    return noExportAffordanceFailure(page, options, accountUrl);
  }

  const dialogOpen = await openExportDialog(page, located, accountUrl, options);
  if (!dialogOpen) {
    return { kind: "failed" };
  }

  await fillExportDateRange(page, sinceDate, untilDate);
  await captureExportCheckpoint(page, options, "before-submit");

  const tempDir = mkdtempSync(join(tmpdir(), "usaa-export-"));
  const outcome = await submitExportAndAwait(page);
  if (outcome.kind === "empty" || outcome.kind === "dialog_error") {
    rmSync(tempDir, { recursive: true, force: true });
    await captureExportCheckpoint(page, options, outcome.kind === "empty" ? "source-empty" : "dialog-error");
    let dialogDiag: PageDiagnostics | null = null;
    if (outcome.kind === "dialog_error" && onDiagnostics) {
      dialogDiag = await capturePageDiagnostics(page);
    }
    await page
      .locator('[role="dialog"] #export-cancel-button')
      .click()
      .catch((): undefined => undefined);
    if (outcome.kind === "dialog_error" && onDiagnostics) {
      onDiagnostics({ diag: dialogDiag, error: outcome.message, phase: "export_dialog_error" });
    }
    return outcome.kind === "empty" ? { kind: "empty" } : { kind: "failed" };
  }
  if (outcome.kind === "artifact_failed") {
    rmSync(tempDir, { recursive: true, force: true });
    await captureExportCheckpoint(page, options, "artifact-failed");
    if (onDiagnostics) {
      const diag = await capturePageDiagnostics(page);
      onDiagnostics({
        artifact: outcome.artifact,
        diag,
        download: outcome.download,
        error: outcome.error,
        phase: "export_artifact_wait_failed",
      });
    }
    return { kind: "failed" };
  }
  const suggested = (outcome.suggestedFilename || "usaa-export.csv").replace(UNSAFE_FILENAME_RE, "_");
  const targetPath = join(tempDir, suggested);
  await writeFile(targetPath, outcome.buffer);
  return { kind: "artifact", path: targetPath };
}

// parseCsv + rowsToTransactions live in ./parsers.ts.

// ─── Stream orchestration helpers ────────────────────────────────────────

interface StatementsSubDeps extends EmitDeps {
  page: Page;
}

interface TransactionsStreamState {
  sessionDeadMidRun: boolean;
}

async function reauthAfterSessionLapse(
  deps: EmitDeps,
  context: BrowserContext,
  page: Page,
  sendInteraction: BrowserCollectContext["sendInteraction"],
  _accountName: string | null,
  observation?: NoExportAffordanceObservation
): Promise<boolean> {
  await deps.emit({
    type: "PROGRESS",
    stream: "transactions",
    message: "Session lapsed during transactions; re-authenticating before retry",
  });
  try {
    if (deps.reauthenticate) {
      await deps.reauthenticate({ context, page, sendInteraction });
    } else {
      await ensureUsaaSession({ capture: deps.capture ?? null, context, page, sendInteraction });
    }
    return true;
  } catch {
    const diagnostic = observation
      ? noExportAffordanceDiagnostic(
          { diag: null, no_export_observation: observation, phase: "no_export_affordance" },
          deps.browserSurface ?? "unknown"
        )
      : null;
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "transactions",
      reason: "session_dead_reauth_failed",
      message: "USAA session expired mid-run and re-auth failed. Remaining accounts and statements skipped.",
      ...(diagnostic ? { diagnostics: { browser_surface: diagnostic } } : {}),
    });
    return false;
  }
}

export interface ExportLadderResult {
  csvPath: string | null;
  exportEmpty: boolean;
  lastDiag: DiagnosticInfo | null;
  terminalFailure: TerminalExportFailure | null;
  usedSince: string | null;
}

/** Try each candidate `sinceDate` in the ladder; stop on success or fatal diagnostic. */
interface LadderAttemptArgs {
  a: DashboardAccount;
  accountOrdinal: number;
  accountTotal: number;
  attemptOrdinal: number;
  attemptTotal: number;
  context: BrowserContext;
  deps: EmitDeps;
  onDiagnostics: (info: DiagnosticInfo) => void;
  onSessionDead: () => void;
  page: Page;
  sendInteraction: BrowserCollectContext["sendInteraction"];
  settleDelayMs?: number;
  sinceDate: string;
  todayIso: string;
}

export type AttemptOutcome =
  | { kind: "empty" }
  | { kind: "retry" }
  | { kind: "session_dead" }
  | { kind: "success"; csvPath: string };

function exportCaptureLabel(a: DashboardAccount, sinceDate: string, untilDate: string): string {
  const account = `${a.name ?? a.account_type}-${a.last_four ?? "unknown"}`;
  return `transaction-export-${account}-${sinceDate}-to-${untilDate}`;
}

/** Run one iteration of the backfill ladder: drive export + translate errors. */
export async function runSingleLadderAttempt({
  deps,
  context,
  page,
  sendInteraction,
  a,
  accountOrdinal,
  accountTotal,
  attemptOrdinal,
  attemptTotal,
  sinceDate,
  todayIso,
  onDiagnostics,
  onSessionDead,
  settleDelayMs,
}: LadderAttemptArgs): Promise<AttemptOutcome> {
  await deps.emit({
    type: "PROGRESS",
    stream: "transactions",
    message: `Export wait: account ${accountOrdinal}/${accountTotal}, window ${attemptOrdinal}/${attemptTotal}`,
  });
  try {
    const exportResult = await driveExport(page, `https://www.usaa.com${a.account_url}`, {
      sinceDate,
      untilDate: todayIso,
      accountType: a.account_type,
      capture: deps.capture ?? null,
      captureLabel: exportCaptureLabel(a, sinceDate, todayIso),
      onDiagnostics,
      ...(settleDelayMs === undefined ? {} : { settleDelayMs }),
    });
    if (exportResult.kind === "artifact") {
      return { kind: "success", csvPath: exportResult.path };
    }
    return exportResult.kind === "empty" ? { kind: "empty" } : { kind: "retry" };
  } catch (err) {
    if (err instanceof SessionDeadRedirectError) {
      const ok = await reauthAfterSessionLapse(deps, context, page, sendInteraction, a.name, err.observation);
      if (ok) {
        return { kind: "retry" };
      }
      onSessionDead();
      return { kind: "session_dead" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "transactions",
      reason: "export_error",
      message: `Export error: account ${accountOrdinal}/${accountTotal}, window ${attemptOrdinal}/${attemptTotal}: ${msg.slice(0, ID_TEXT_SNIP)}`,
    });
    return { kind: "retry" };
  }
}

/**
 * A confirmed `no_export_affordance` on the account page is terminal when
 * the source surface is absent OR the matched control stayed disabled after
 * the bounded actionability wait. Neither condition is date-dependent. A
 * drifted route, post-submit pressure, or an unclassified failure remains
 * retryable and continues through the existing bounded ladder.
 */
function isFatalDiagPhase(diag: DiagnosticInfo | null): diag is DiagnosticInfo {
  return classifyTerminalExportFailureWithoutRecursion(diag) !== null;
}

function classifyTerminalExportFailureWithoutRecursion(diag: DiagnosticInfo | null): TerminalExportFailure | null {
  if (!diag) {
    return null;
  }
  if (
    diag.phase === "no_export_affordance" &&
    noExportRouteConfirmsAccountPage(diag) &&
    diag.no_export_observation?.affordance_disabled
  ) {
    return "export_affordance_disabled";
  }
  if (diag.phase === "export_dialog_unexpected_shape" && diagnosticAccountPageIdentity(diag) === "exact") {
    return "source_structure_changed";
  }
  if (diag.phase === "no_export_affordance" && noExportRouteConfirmsAccountPage(diag)) {
    return "source_structure_changed";
  }
  return null;
}

export async function tryExportLadder(
  deps: EmitDeps,
  context: BrowserContext,
  page: Page,
  sendInteraction: BrowserCollectContext["sendInteraction"],
  a: DashboardAccount,
  accountOrdinal: number,
  accountTotal: number,
  candidateStarts: readonly string[],
  todayIso: string,
  onSessionDead: () => void
): Promise<ExportLadderResult> {
  // Wrap in an object so TS tracks the mutation performed by the onDiagnostics
  // closure; a bare `let lastDiag` would narrow to `null` at read sites.
  const diagBox: { current: DiagnosticInfo | null } = { current: null };
  const onDiagnostics = (info: DiagnosticInfo): void => {
    diagBox.current = info;
  };
  for (let i = 0; i < candidateStarts.length; i += 1) {
    const sinceDate = candidateStarts[i];
    if (!sinceDate) {
      continue;
    }
    const outcome = await runSingleLadderAttempt({
      deps,
      context,
      page,
      sendInteraction,
      a,
      accountOrdinal,
      accountTotal,
      attemptOrdinal: i + 1,
      attemptTotal: candidateStarts.length,
      sinceDate,
      todayIso,
      onDiagnostics,
      onSessionDead,
    });
    if (outcome.kind === "session_dead") {
      return { csvPath: null, exportEmpty: false, lastDiag: diagBox.current, terminalFailure: null, usedSince: null };
    }
    if (outcome.kind === "success") {
      return {
        csvPath: outcome.csvPath,
        exportEmpty: false,
        lastDiag: diagBox.current,
        terminalFailure: null,
        usedSince: sinceDate,
      };
    }
    if (outcome.kind === "empty") {
      await deps.emit({
        type: "PROGRESS",
        stream: "transactions",
        message: `Export complete: no transactions for account ${accountOrdinal}/${accountTotal}, window ${i + 1}/${candidateStarts.length}`,
      });
      return {
        csvPath: null,
        exportEmpty: true,
        lastDiag: diagBox.current,
        terminalFailure: null,
        usedSince: sinceDate,
      };
    }
    const diagNow = diagBox.current;
    if (diagNow) {
      await deps.emit({
        type: "PROGRESS",
        stream: "transactions",
        message: `Export diagnostic: account ${accountOrdinal}/${accountTotal}, window ${i + 1}/${candidateStarts.length}, ${formatDiagnosticInfo(diagNow)}`,
      });
    }
    const terminalFailure = classifyTerminalExportFailureWithoutRecursion(diagNow);
    if (terminalFailure) {
      await deps.emit({
        type: "PROGRESS",
        stream: "transactions",
        message:
          terminalFailure === "export_affordance_disabled"
            ? `Export diagnostic: affordance disabled after bounded actionability wait; no date-window retry for account ${accountOrdinal}/${accountTotal}`
            : `Export diagnostic: ${diagNow?.phase ?? "unknown"}; skipping retries for account ${accountOrdinal}/${accountTotal}`,
      });
      return {
        csvPath: null,
        exportEmpty: false,
        lastDiag: diagBox.current,
        terminalFailure,
        usedSince: null,
      };
    }
    await deps.emit({
      type: "PROGRESS",
      stream: "transactions",
      message: `Retrying export with shorter range for account ${accountOrdinal}/${accountTotal}`,
    });
  }
  return {
    csvPath: null,
    exportEmpty: false,
    lastDiag: diagBox.current,
    terminalFailure: null,
    usedSince: null,
  };
}

interface CsvTransactionEmitResult {
  dataRows: number;
  latest: string | null;
  usableCount: number;
}

/** Parse the downloaded CSV, emit each transaction, and return parse outcome metadata. */
export async function emitCsvTransactions(
  deps: EmitDeps,
  csvPath: string,
  a: DashboardAccount,
  priorLastDate: string | null,
  accountOrdinal: number,
  accountTotal: number,
  fingerprintCursor?: FingerprintCursor
): Promise<CsvTransactionEmitResult> {
  const text = await readFile(csvPath, "utf8");
  const rows = parseCsv(text);
  const txnAccountId = a.account_id_raw || a.last_four || "unknown";
  const txns = rowsToTransactions(rows, {
    accountId: txnAccountId,
    accountName: a.name,
    fetchedAt: nowIso(),
  });
  // A CSV that was downloaded (so not the known-empty export path) but whose
  // data rows produced zero usable transactions is a silent coverage loss:
  // parseCsv returned only a header/garbage, or every data row failed the
  // header/shape checks in rowsToTransactions. Surface a bounded SKIP_RESULT
  // by account ordinal (never the account number / last-four) so the run does
  // not look complete. The caller also refuses to advance this account's
  // transaction cursor on this outcome, so a parser fix can recover the gap.
  // `rows.length` is the raw parsed line count; we report data-row count
  // (rows beyond the header) to keep the number meaningful.
  const dataRows = Math.max(0, rows.length - 1);
  if (txns.length === 0) {
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "transactions",
      reason: dataRows > 0 ? "csv_no_usable_transactions" : "csv_no_data_rows",
      message:
        dataRows > 0
          ? `CSV parsed no usable transactions from ${dataRows} data row(s) for account ${accountOrdinal}/${accountTotal} (header mismatch or unparseable rows)`
          : `CSV had no data rows for account ${accountOrdinal}/${accountTotal}`,
      diagnostics: { account_ordinal: accountOrdinal, account_total: accountTotal, data_rows: dataRows },
    });
  }
  let latest: string | null = priorLastDate;
  for (const t of txns) {
    // Gate on a per-transaction fingerprint that excludes the run-clock
    // `fetched_at`. A posted transaction's identity
    // (id = hashId(accountId|date|amount|original|#ord)) and its fields are
    // immutable, but the incremental export re-downloads an overlapping
    // date window (INCREMENTAL_OVERLAP_MS) every run and re-emits each
    // transaction with a fresh `fetched_at`. With this gate an already-seen
    // transaction whose body is byte-identical modulo `fetched_at` is
    // suppressed; a genuinely-new transaction (new id) or a real field move
    // is a fingerprint boundary and still emits.
    //
    // NOTE: transactions is a PARTIAL scan (per-account overlapping
    // windows + statement-PDF subsets), so this cursor is never
    // `pruneStale()`d — pruning ids the run did not look at would drop
    // their fingerprints and re-churn them on the next overlapping window.
    if (!fingerprintCursor || fingerprintCursor.shouldEmit(t)) {
      await deps.emitRecord("transactions", t);
    }
    if (!latest || t.date > latest) {
      latest = t.date;
    }
  }
  await unlink(csvPath).catch((): undefined => undefined);
  const dir = csvPath.replace(TEMP_DIR_PREFIX_RE, "");
  await readdir(dir)
    .then((f): void => {
      if (!f.length) {
        rmSync(dir, { recursive: true, force: true });
      }
    })
    .catch((): undefined => undefined);
  return { dataRows, latest, usableCount: txns.length };
}

/**
 * Per-account outcome of the transactions detail pass, mirroring chase's
 * `AccountDetailOutcome` in spirit: one entry per transaction-eligible
 * account this run considered, classifying how (or whether) it was
 * covered. `kind` decides both the DETAIL_COVERAGE key classification and
 * whether a retryable DETAIL_GAP is owed:
 *   - `hydrated`: the CSV export downloaded and parsed with usable rows
 *     (fresh coverage of this account's ledger for the window).
 *   - `no_activity`: the source gave a real, source-limited "nothing here"
 *     answer — either the export dialog explicitly reported "no
 *     transactions" (`exportEmpty`) or the export downloaded a headers-only
 *     CSV with zero data rows (a dormant account's steady state). Both
 *     count as covered, never as a failure.
 *   - `gap`: the export ladder was exhausted without a download, or the
 *     downloaded CSV had data rows but none parsed to a usable transaction
 *     (header mismatch / unparseable rows) — genuinely unreached this run,
 *     retryable.
 *   - `unavailable`: the observed account page supplied terminal evidence of
 *     a disabled control or missing export surface. This is an explicit
 *     optional skip, never a zero-activity claim; a bounded statement-PDF
 *     result can still cover it for transaction coverage while the terminal
 *     CSV/control evidence remains emitted separately.
 * Accounts skipped because the session died mid-run are NOT recorded here
 * at all (see `runTransactionsStream`): they were never reached, so
 * `required_keys` only ever lists accounts the run actually attempted,
 * keeping the denominator honest for a partial-run cutoff.
 */
export type AccountTransactionOutcome =
  | { accountId: string; kind: "gap"; reason: DetailGapMessage["reason"]; errorClass: string }
  | {
      accountId: string;
      kind: "unavailable";
      reason: TerminalExportFailure;
      errorClass: string;
    }
  | { accountId: string; kind: "hydrated" | "no_activity" };

/** Build the retryable DETAIL_GAP for a USAA transaction account whose CSV
 *  export failed this run — the ladder produced no download, or the CSV had
 *  data rows but none parsed usable (a headers-only CSV is NOT a gap; see
 *  `classifyCsvTransactionResult`). `record_key` is the account id — the
 *  next run's detail pass retries exactly this account. Mirrors chase's
 *  `buildAccountDetailGap` (reference_only, retryable, pending) so the
 *  runtime persists one resumable gap per failed key and the per-account
 *  coverage stays honest. */
export function buildAccountTransactionDetailGap(outcome: {
  accountId: string;
  errorClass: string;
  reason: DetailGapMessage["reason"];
}): DetailGapMessage {
  return {
    type: "DETAIL_GAP",
    stream: "transactions",
    parent_stream: "accounts",
    record_key: outcome.accountId,
    status: "pending",
    reason: outcome.reason,
    detail_locator: {
      kind: "usaa.account",
      account_id: outcome.accountId,
    },
    retryable: true,
    reference_only: true,
    detail: { class: outcome.errorClass },
    last_error: { class: outcome.errorClass },
  };
}

/**
 * A statement PDF is an alternate transaction surface only when its index row
 * resolved to the exact dashboard account id and the parser yielded at least
 * one transaction. Never infer coverage from a hydrated PDF count, an
 * unresolved account reference, or a statement row with zero parsed rows.
 */
export function applyAlternateSurfaceCoverage(
  outcomes: readonly AccountTransactionOutcome[],
  alternateSurfaceAccountIds: ReadonlySet<string>
): AccountTransactionOutcome[] {
  return outcomes.map((outcome) => {
    if (
      (outcome.kind === "gap" || outcome.kind === "unavailable") &&
      alternateSurfaceAccountIds.has(outcome.accountId)
    ) {
      return { accountId: outcome.accountId, kind: "hydrated" };
    }
    return outcome;
  });
}

/**
 * Keep only USAA account-level transaction gaps the runtime actually served
 * this run. The connector may recover only these supplied ids: synthesizing
 * one, or accepting a foreign/malformed locator, could close unrelated work.
 */
export function buildServedAccountTransactionGapLookup(
  detailGaps: readonly BrowserCollectContext["detailGaps"][number][]
): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const gap of detailGaps) {
    if (gap.stream !== "transactions" || gap.status !== "pending") {
      continue;
    }
    const locator = gap.detail_locator;
    if (locator?.kind !== "usaa.account") {
      continue;
    }
    const accountId = locator.account_id;
    const recordKey = gap.record_key;
    if (
      typeof accountId !== "string" ||
      accountId.length === 0 ||
      typeof recordKey !== "string" ||
      recordKey.length === 0 ||
      recordKey !== accountId ||
      typeof gap.gap_id !== "string" ||
      !gap.gap_id
    ) {
      continue;
    }
    if (!lookup.has(accountId)) {
      lookup.set(accountId, gap.gap_id);
    }
  }
  return lookup;
}

/**
 * A served account gap is recovered only after this run reaches that same
 * account. `hydrated`, source-limited `no_activity`, and an evidence-backed
 * terminal `unavailable` classification all account for the served work;
 * only a fresh retryable `gap` is deliberately re-deferred.
 */
export async function recoverServedAccountTransactionGaps(
  deps: EmitDeps,
  outcomes: readonly AccountTransactionOutcome[]
): Promise<void> {
  const served = deps.servedAccountTransactionGaps;
  if (!served || served.size === 0) {
    return;
  }
  for (const outcome of outcomes) {
    if (outcome.kind === "gap") {
      continue;
    }
    const gapId = served.get(outcome.accountId);
    if (!gapId) {
      continue;
    }
    await deps.emit({
      type: "DETAIL_GAP_RECOVERED",
      reference_only: true,
      gap_id: gapId,
      stream: "transactions",
      record_key: outcome.accountId,
    });
  }
}

/**
 * Emit the per-run DETAIL_COVERAGE for the account -> transactions detail
 * fan-out, mirroring chase's `emitTransactionsDetailCoverage`. `outcomes` is
 * built from the accounts this run actually attempted (session-dead
 * cutoffs are excluded), so it is a real, honest denominator:
 *   - `required_keys`: every transaction-eligible account attempted.
 *   - `hydrated_keys`: accounts reached, including source-limited
 *     no-activity ones (won't-backfill is coverage, never a broken signal).
 *   - `optional_skip_keys`: accounts reached but proven unavailable on the
 *     observed source surface. These keys are accounted for by explicit
 *     terminal policy; no transaction record or zero-activity claim is made.
 *   - `gap_keys`: accounts whose export failed transiently; each also
 *     carries a pending DETAIL_GAP so the runtime's coverage invariant is
 *     satisfied and the next run retries them.
 *
 * `enumerationComplete` disambiguates the two ways `outcomes` can be empty:
 *   - `true`: the account loop ran to completion (never cut short by a
 *     session death) — zero outcomes here means the run genuinely enumerated
 *     zero transaction-eligible accounts, a real measured denominator. Emits
 *     considered: 0 / covered: 0 with empty key sets rather than staying
 *     silent, so an account with no checking/savings/credit-card accounts
 *     stays measured instead of permanently unreported.
 *   - `false`: the session died before any account was attempted (or mid-run,
 *     before this stream's denominator was fully walked) — the denominator is
 *     genuinely unknown this run, so nothing is emitted rather than inventing
 *     a zero.
 * Only emitted when transactions was requested. `state_stream: "accounts"`
 * mirrors chase: the accounts cursor commit is gated on this stream's detail
 * coverage being honestly accounted for (hydrated or a same-run DETAIL_GAP),
 * never silently advanced past an unreached account.
 */
export async function emitTransactionsDetailCoverage(
  deps: EmitDeps,
  outcomes: readonly AccountTransactionOutcome[],
  enumerationComplete: boolean
): Promise<void> {
  // A partial sweep's `outcomes` (whatever accounts were reached before a
  // session death) is never the true denominator, even when non-empty — so
  // suppress unconditionally on `!enumerationComplete`, not only when
  // `outcomes` happens to also be empty.
  if (!enumerationComplete) {
    return;
  }
  const requiredKeys = outcomes.map((o) => o.accountId);
  const hydratedKeys = outcomes
    .filter((o) => o.kind === "hydrated" || o.kind === "no_activity")
    .map((o) => o.accountId);
  const optionalSkipKeys = outcomes.filter((o) => o.kind === "unavailable").map((o) => o.accountId);
  const gapKeys = outcomes.filter((o) => o.kind === "gap").map((o) => o.accountId);
  const coveredKeys = [...hydratedKeys, ...optionalSkipKeys];
  await emitDetailCoverage(deps, {
    stream: "transactions",
    stateStream: "accounts",
    requiredKeys,
    hydratedKeys,
    gapKeys,
    optionalSkipKeys,
    considered: outcomes.length,
    covered: coveredKeys.length,
  });
}

export interface AccountTransactionResult {
  exportFailure?: {
    account: DashboardAccount;
    lastDiag: DiagnosticInfo | null;
    terminalFailure: TerminalExportFailure | null;
  };
  last_date: string | null;
  outcome: AccountTransactionOutcome;
}

/**
 * Classify a downloaded-and-parsed CSV into the account's per-run detail
 * outcome + cursor decision. Pure — exported so the coverage classification
 * is testable without driving the Playwright export flow. The distinction
 * that matters (`csvResult` comes straight from `emitCsvTransactions`):
 *   - `usableCount > 0`: real transactions parsed → `hydrated`; the cursor
 *     advances to the latest parsed date (or the window start).
 *   - `usableCount === 0 && dataRows === 0`: the export produced a
 *     headers-only CSV — the source genuinely had no transactions for the
 *     window. A dormant account exports exactly this every run, so it is
 *     the same source-limited answer as the explicit "nothing to export"
 *     dialog → `no_activity` (covered), NEVER a gap. Classifying it as a
 *     gap would pin a pending retryable DETAIL_GAP on a healthy dormant
 *     account forever (permanent Degraded).
 *   - `usableCount === 0 && dataRows > 0`: data rows were present but none
 *     parsed to a usable transaction (header mismatch / unparseable rows)
 *     → genuine parse trouble, a retryable `gap` so a parser fix can
 *     recover it next run. (`emitCsvTransactions` already emitted the
 *     matching `csv_no_usable_transactions` SKIP_RESULT.)
 * In both zero-usable cases `last_date` stays at the prior watermark
 * (possibly null → the caller writes no cursor entry), preserving the
 * pre-coverage behavior of never advancing the cursor on a run that parsed
 * nothing.
 */
export function classifyCsvTransactionResult(
  accountId: string,
  priorLastDate: string | null,
  usedSince: string | null,
  csvResult: { dataRows: number; latest: string | null; usableCount: number }
): AccountTransactionResult {
  if (csvResult.usableCount > 0) {
    return {
      last_date: csvResult.latest || usedSince || null,
      outcome: { accountId, kind: "hydrated" },
    };
  }
  if (csvResult.dataRows === 0) {
    return {
      last_date: priorLastDate,
      outcome: { accountId, kind: "no_activity" },
    };
  }
  return {
    last_date: priorLastDate,
    outcome: { accountId, kind: "gap", reason: "temporary_unavailable", errorClass: "csv_no_usable_transactions" },
  };
}

async function processAccountTransactions(
  deps: EmitDeps,
  context: BrowserContext,
  page: Page,
  sendInteraction: BrowserCollectContext["sendInteraction"],
  a: DashboardAccount,
  priorLastDate: string | null,
  sinceDateCfg: string | undefined,
  seventeenMonthsAgo: string,
  streamState: TransactionsStreamState,
  accountOrdinal: number,
  accountTotal: number,
  fingerprintCursor?: FingerprintCursor
): Promise<AccountTransactionResult | null> {
  const accountId = a.account_id_raw || a.last_four || "unknown";
  const desiredSince = priorLastDate
    ? new Date(Date.parse(priorLastDate) - INCREMENTAL_OVERLAP_MS).toISOString().slice(0, 10)
    : (sinceDateCfg ?? seventeenMonthsAgo);
  const todayIso = new Date().toISOString().slice(0, 10);
  const candidateStarts = buildCandidateStarts(desiredSince);

  const { csvPath, exportEmpty, usedSince, lastDiag, terminalFailure } = await tryExportLadder(
    deps,
    context,
    page,
    sendInteraction,
    a,
    accountOrdinal,
    accountTotal,
    candidateStarts,
    todayIso,
    () => {
      streamState.sessionDeadMidRun = true;
    }
  );
  if (streamState.sessionDeadMidRun) {
    return null;
  }
  if (!csvPath) {
    if (exportEmpty) {
      return {
        last_date: priorLastDate || usedSince || null,
        outcome: { accountId, kind: "no_activity" },
      };
    }
    // `errorClass` mirrors the observed surface so a terminal disabled or
    // missing affordance stays distinct from navigation drift and ordinary
    // post-submit pressure. The protocol's closed DETAIL_GAP reason vocabulary
    // remains unchanged for the retryable branch.
    let errorClass: string;
    if (terminalFailure === "export_affordance_disabled") {
      errorClass = "export_affordance_disabled";
    } else if (terminalFailure === "source_structure_changed") {
      errorClass = "export_affordance_missing";
    } else if (classifyExportLadderOutcome(lastDiag) === "navigation_drifted") {
      errorClass = "navigation_drifted";
    } else {
      errorClass = "export_no_download";
    }
    return {
      last_date: priorLastDate,
      outcome: terminalFailure
        ? { accountId, kind: "unavailable", reason: terminalFailure, errorClass }
        : { accountId, kind: "gap", reason: "temporary_unavailable", errorClass },
      exportFailure: { account: a, lastDiag, terminalFailure },
    };
  }
  const csvResult = await emitCsvTransactions(
    deps,
    csvPath,
    a,
    priorLastDate,
    accountOrdinal,
    accountTotal,
    fingerprintCursor
  );
  return classifyCsvTransactionResult(accountId, priorLastDate, usedSince, csvResult);
}

interface TransactionsStreamResult {
  cursor: TransactionsStreamCursor;
  enumerationComplete: boolean;
  exportFailures: ReadonlyMap<string, NonNullable<AccountTransactionResult["exportFailure"]>>;
  outcomes: readonly AccountTransactionOutcome[];
}

async function runTransactionsStream(
  deps: EmitDeps,
  context: BrowserContext,
  page: Page,
  sendInteraction: BrowserCollectContext["sendInteraction"],
  accounts: readonly DashboardAccount[],
  state: Record<string, unknown>,
  requested: BrowserCollectContext["requested"],
  streamState: TransactionsStreamState,
  fingerprintCursor?: FingerprintCursor
): Promise<TransactionsStreamResult> {
  const stream = requested.get("transactions");
  const sinceDateCfg = stream?.time_range?.since?.slice(0, 10);
  const seventeenMonthsAgo = new Date(Date.now() - BACKFILL_17MO).toISOString().slice(0, 10);

  const priorStateForTxns = (state.transactions as TransactionsPriorState | undefined) ?? {};
  const transactionsCursor: TransactionsStreamCursor = { ...priorStateForTxns };

  const transactionAccounts = accounts.filter((a) => TRANSACTION_ACCOUNT_TYPE_RE.test(a.account_type));
  const outcomes: AccountTransactionOutcome[] = [];
  const exportFailures = new Map<string, NonNullable<AccountTransactionResult["exportFailure"]>>();
  for (let i = 0; i < transactionAccounts.length; i += 1) {
    const a = transactionAccounts[i];
    if (!a) {
      continue;
    }
    if (streamState.sessionDeadMidRun) {
      await deps.emit({
        type: "PROGRESS",
        stream: "transactions",
        message: `Session died mid-run; skipping remaining ${transactionAccounts.length - i} account(s)`,
      });
      break;
    }
    const accountKey = a.account_id_raw || "";
    const perAccState = priorStateForTxns[accountKey];
    const priorLastDate = perAccState?.last_date ?? null;
    const result = await processAccountTransactions(
      deps,
      context,
      page,
      sendInteraction,
      a,
      priorLastDate,
      sinceDateCfg,
      seventeenMonthsAgo,
      streamState,
      i + 1,
      transactionAccounts.length,
      fingerprintCursor
    );
    if (!result) {
      // Session died mid-attempt: the account was never reached, so it is
      // excluded from `outcomes` entirely (see AccountTransactionOutcome
      // doc) rather than recorded as a gap.
      continue;
    }
    outcomes.push(result.outcome);
    if (result.exportFailure) {
      exportFailures.set(result.outcome.accountId, result.exportFailure);
    }
    if (result.last_date === null) {
      // No cursor advance to record this account (e.g. a gap with no
      // prior watermark) — preserve prior behavior of leaving the cursor
      // untouched rather than writing a null watermark.
      continue;
    }
    transactionsCursor[accountKey || a.last_four || "unknown"] = { last_date: result.last_date };
    await deps.emit({
      type: "STATE",
      stream: "transactions",
      cursor: withTransactionFingerprints(transactionsCursor, fingerprintCursor),
    });
  }
  // The loop above only `break`s on a session death; reaching here without
  // one means every transaction-eligible account was attempted (including
  // the zero-eligible-accounts case, where the loop body never ran at all),
  // so the denominator this run enumerated is genuinely complete. Coverage
  // and DETAIL_GAP emission are deliberately deferred until after the PDF
  // surface runs; a statement PDF can be the already-supported alternate
  // surface for an account whose CSV export failed.
  return {
    cursor: transactionsCursor,
    enumerationComplete: !streamState.sessionDeadMidRun,
    exportFailures,
    outcomes,
  };
}

/** Emit final transaction coverage only after every supported surface has had
 * a chance to account for the same dashboard-account denominator. */
export async function finalizeTransactionsStream(
  deps: EmitDeps,
  result: TransactionsStreamResult,
  alternateSurfaceAccountIds: ReadonlySet<string>
): Promise<void> {
  const outcomes = applyAlternateSurfaceCoverage(result.outcomes, alternateSurfaceAccountIds);
  for (const outcome of outcomes) {
    const failure = result.exportFailures.get(outcome.accountId);
    if (failure && (failure.terminalFailure || (outcome.kind !== "hydrated" && outcome.kind !== "no_activity"))) {
      await emitExportFailure(deps, failure.account, failure.lastDiag, failure.terminalFailure);
    }
    if (outcome.kind === "gap") {
      await deps.emit(buildAccountTransactionDetailGap(outcome));
    }
  }
  await recoverServedAccountTransactionGaps(deps, outcomes);
  await emitTransactionsDetailCoverage(deps, outcomes, result.enumerationComplete);
}

/** Attach the carried-forward per-transaction fingerprint map to the
 *  transactions STATE cursor without mutating the per-account watermark
 *  entries. `fingerprints` is a reserved sibling key (account keys are
 *  USAA account ids / last-four), read back by
 *  `readPriorTransactionFingerprints`. NOT pruned: transactions is a
 *  partial scan (see emitCsvTransactions). */
function withTransactionFingerprints(
  cursor: TransactionsStreamCursor,
  fingerprintCursor?: FingerprintCursor
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cursor };
  if (fingerprintCursor && fingerprintCursor.size() > 0) {
    out.fingerprints = fingerprintCursor.toState();
  }
  return out;
}

// ─── Statements stream helpers ──────────────────────────────────────────

function scrapeStatementsIndex(page: Page): Promise<DocRow[]> {
  return page.evaluate((): DocRow[] => {
    // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
    const WS_RE = /\s+/g;
    // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.

    interface El {
      innerText?: string;
      querySelectorAll: (s: string) => El[];
    }

    const t = document.querySelector("table") as El | null;
    if (!t) {
      return [];
    }
    return [...t.querySelectorAll("tbody tr")].map((tr: El, rowIndex: number) => {
      const cells = [...tr.querySelectorAll("td")] as El[];
      const [c0, c1, c2] = cells;
      return {
        rowIndex,
        title: (c0?.innerText || "").replace(WS_RE, " ").trim(),
        date_delivered: (c1?.innerText || "").trim(),
        account_reference: (c2?.innerText || "").trim(),
      };
    });
  });
}

async function hydratePdfsForIndex(deps: StatementsSubDeps, indexRows: readonly IndexRow[]): Promise<HydrationSummary> {
  const results = new Map<number, HydrationResult>();
  let attempts = 0;
  let successes = 0;

  try {
    const hydrated = await hydrateStatementPdfs({
      page: deps.page,
      statements: indexRows as IndexRow[],
      onProgress: ({ index, total }) => {
        attempts = index + 1;
        // Fire-and-forget: hydrateStatementPdfs signature is sync callback.
        // Swallowing the promise keeps the emit ordering best-effort; a
        // failed write would be caught by the outer try/catch on next await.
        deps
          .emit({
            type: "PROGRESS",
            stream: "statements",
            message: `Downloading statement PDF ${index + 1}/${total}`,
          })
          .catch((): undefined => undefined);
      },
      onSkip: ({ statement, reason, diag }) => {
        results.set(statement.rowIndex, { err: reason, diag });
        deps
          .emit({
            type: "SKIP_RESULT",
            stream: "statements",
            reason: `pdf_download_${reason}`,
            message: `Statement PDF download skipped at row ${statement.rowIndex + 1}: ${reason}`,
            // row_id is statement.rowIndex, a plain ordinal position within
            // this run's /my/documents table scrape — not derived from
            // account reference, date, or title. Unlike a content hash it
            // carries no information about the statement itself and cannot
            // be correlated across runs (row order can shift between
            // scrapes), only within this run's failure set. Always
            // included, even when there are no other diagnostics, so every
            // failure is correlatable back to its row for this run.
            diagnostics: { ...diag, row_id: statement.rowIndex },
          })
          .catch((): undefined => undefined);
      },
    });
    for (const h of hydrated) {
      successes += 1;
      results.set(h.statement.rowIndex, {
        pdfPath: h.pdfPath,
        pdfSha256: h.pdfSha256,
        content: h.content,
        buffer: h.buffer,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "statements",
      reason: "hydrate_crashed",
      message: msg.slice(0, ID_TEXT_SNIP),
    });
  }
  return { attempts, successes, results };
}

interface PdfParseCounters {
  parsedStatements: number;
  pdfTxnCount: number;
  unknownTemplates: number;
}

async function processPdfStatementRow(
  deps: EmitDeps,
  row: IndexRow,
  ok: HydrationResultSuccess,
  accountById: Map<string, DashboardAccount>,
  counters: PdfParseCounters,
  fingerprintCursor?: FingerprintCursor
): Promise<string | null> {
  const title = row.title || "";
  if (!shouldParseStatementTitle(title)) {
    return null;
  }
  if (!(row.account_id && accountById.has(row.account_id))) {
    return null;
  }
  const period = (row.date_delivered || "").slice(0, 7) || null;
  const acct = accountById.get(row.account_id);
  const accountName = acct?.name ?? null;
  try {
    const { txns, parseMeta } = await parsePdfStatement({
      buffer: ok.buffer,
      accountId: row.account_id,
      accountName,
      period,
    });
    if (!txns.length) {
      counters.unknownTemplates += 1;
      await deps.emit({
        type: "SKIP_RESULT",
        stream: "transactions",
        reason: "pdf_template_unknown",
        message: `PDF statement parse skipped at row ${row.rowIndex + 1}: no parser matched (era=${parseMeta.era})`,
        diagnostics: {
          statement_id: row.id,
          year: parseMeta.year,
          raw_text_sample: "rawTextSample" in parseMeta ? parseMeta.rawTextSample : null,
        },
      });
      return null;
    }
    for (const t of txns) {
      // Same per-transaction fingerprint gate as the CSV path (excludes
      // run-clock `fetched_at`). PDF and CSV hash the same logical
      // transaction to the same id, so a transaction already emitted from
      // either source is suppressed on a re-parse whose body is identical
      // modulo `fetched_at`. Re-parsing the same statement PDFs every run
      // was appending a fresh version per transaction.
      if (!fingerprintCursor || fingerprintCursor.shouldEmit({ ...t })) {
        await deps.emitRecord("transactions", { ...t });
      }
      counters.pdfTxnCount += 1;
    }
    counters.parsedStatements += 1;
    return row.account_id && accountById.has(row.account_id) ? row.account_id : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "transactions",
      reason: "pdf_parse_failed",
      message: `PDF statement parse failed at row ${row.rowIndex + 1}: ${msg.slice(0, ID_TEXT_SNIP)}`,
    });
    return null;
  }
}

export async function emitPdfStatementTransactions(
  deps: EmitDeps,
  indexRows: readonly IndexRow[],
  hydrationResults: Map<number, HydrationResult>,
  accounts: readonly DashboardAccount[],
  fingerprintCursor?: FingerprintCursor
): Promise<Set<string>> {
  const accountById = new Map<string, DashboardAccount>(
    accounts
      .filter((a): a is DashboardAccount & { account_id_raw: string } => Boolean(a.account_id_raw))
      .map((a) => [a.account_id_raw, a])
  );
  const transactionAccountIds = new Set(
    accounts
      .filter((a) => a.account_id_raw && TRANSACTION_ACCOUNT_TYPE_RE.test(a.account_type))
      .map((a) => a.account_id_raw as string)
  );
  const coveredAccountIds = new Set<string>();
  const counters: PdfParseCounters = { pdfTxnCount: 0, parsedStatements: 0, unknownTemplates: 0 };
  for (const row of indexRows) {
    const ok = hydrationSuccess(hydrationResults.get(row.rowIndex));
    if (!ok) {
      continue;
    }
    const accountId = await processPdfStatementRow(deps, row, ok, accountById, counters, fingerprintCursor);
    if (accountId && transactionAccountIds.has(accountId)) {
      coveredAccountIds.add(accountId);
    }
  }
  await deps.emit({
    type: "PROGRESS",
    stream: "transactions",
    message: `PDF parse complete: ${counters.pdfTxnCount} transaction(s) across ${counters.parsedStatements} statement(s) (${counters.unknownTemplates} unknown templates)`,
  });
  return coveredAccountIds;
}

async function runStatementsStream(
  deps: StatementsSubDeps,
  accounts: readonly DashboardAccount[],
  requested: BrowserCollectContext["requested"],
  statementsFingerprintCursor?: FingerprintCursor,
  transactionsFingerprintCursor?: FingerprintCursor,
  statementsHydrationCursor?: StatementHydrationCursor
): Promise<Set<string>> {
  const alternateSurfaceAccountIds = new Set<string>();
  try {
    await deps.emit({
      type: "PROGRESS",
      stream: "statements",
      message: "Fetching statements index",
    });
    await deps.page.goto("https://www.usaa.com/my/documents", {
      waitUntil: "domcontentloaded",
      timeout: DOCUMENTS_NAV_TIMEOUT_MS,
    });
    await politeDelay(DOCUMENTS_SETTLE_DELAY_MS);

    const docs = await scrapeStatementsIndex(deps.page);
    const indexRows = buildIndexRows(docs, accounts);
    await deps.emit({
      type: "PROGRESS",
      stream: "statements",
      message: `Found ${indexRows.length} statement index row(s)`,
    });
    const summary = await hydratePdfsForIndex(deps, indexRows);

    if (requested.has("statements")) {
      await emitStatementRecords(
        deps,
        indexRows,
        summary.results,
        summary,
        statementsFingerprintCursor,
        statementsHydrationCursor
      );
    }
    if (requested.has("transactions")) {
      const pdfCoveredAccountIds = await emitPdfStatementTransactions(
        deps,
        indexRows,
        summary.results,
        accounts,
        transactionsFingerprintCursor
      );
      for (const accountId of pdfCoveredAccountIds) {
        alternateSurfaceAccountIds.add(accountId);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "statements",
      reason: "scrape_failed",
      message: msg.slice(0, ID_TEXT_SNIP),
      diagnostics: {
        error_class: err instanceof Error ? err.constructor.name : "unknown",
        message: msg.slice(0, ID_TEXT_SNIP),
      },
    });
  }
  return alternateSurfaceAccountIds;
}

// ─── Inbox stream ───────────────────────────────────────────────────────

function scrapeInboxRows(page: Page): Promise<InboxRow[]> {
  return page.evaluate((): InboxRow[] => {
    // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
    const WS_RE = /\s+/g;
    // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.

    interface El {
      innerText?: string;
      querySelectorAll: (s: string) => El[];
    }

    const t = document.querySelector("table") as El | null;
    if (!t) {
      return [];
    }
    return [...t.querySelectorAll("tbody tr")].map((tr: El) => {
      const cells = [...tr.querySelectorAll("td")] as El[];
      const [c0, c1, c2] = cells;
      return {
        status: (c0?.innerText || "").replace(WS_RE, " ").trim(),
        date_short: (c1?.innerText || "").replace(WS_RE, " ").trim(),
        preview: (c2?.innerText || "").replace(WS_RE, " ").trim(),
      };
    });
  });
}

export async function runInboxStream(deps: EmitDeps, page: Page, state: Record<string, unknown>): Promise<void> {
  try {
    await deps.emit({
      type: "PROGRESS",
      stream: "inbox_messages",
      message: "Fetching inbox",
    });
    await page.goto("https://www.usaa.com/my/inbox", {
      waitUntil: "domcontentloaded",
      timeout: INBOX_NAV_TIMEOUT_MS,
    });
    await politeDelay(DOCUMENTS_SETTLE_DELAY_MS);
    const msgs = await scrapeInboxRows(page);
    await deps.emit({
      type: "PROGRESS",
      stream: "inbox_messages",
      message: `Found ${msgs.length} inbox row(s)`,
    });
    // Per-message fingerprint cursor (excludes the run-clock `fetched_at`).
    // The inbox page is re-scraped in full every run, so without this gate
    // each still-listed message appended a fresh version differing only in
    // `fetched_at`. A genuine read → unread / unread → read status flip is
    // a fingerprint boundary and re-emits; only a byte-identical re-scrape
    // modulo `fetched_at` is suppressed.
    const fingerprintCursor = openFingerprintCursor(state.inbox_messages, {
      excludeFromFingerprint: ["fetched_at"],
      priorFingerprints: readPriorInboxMessageFingerprints(state),
    });
    const year = new Date().getFullYear();
    // `covered` counts rows this run actually accounted for: emitted plus
    // suppressed-because-unchanged. A row `buildInboxMessageRecord` drops
    // (missing `date_short` — the row can't be keyed) is neither emitted nor
    // suppressed-unchanged, so it stays out of `covered` and the run reads an
    // honest `partial` rather than a false `complete` — same discipline as
    // `emitAccountsStream`'s `entityCovered`.
    let covered = 0;
    for (const m of msgs) {
      const record = buildInboxMessageRecord(m, year, nowIso());
      if (!record) {
        continue;
      }
      if (fingerprintCursor.shouldEmit(record)) {
        await deps.emitRecord("inbox_messages", record);
      }
      covered += 1;
    }
    // The inbox listing is a full scan of the inbox page, with a real,
    // measurable denominator (rows found on the page): `considered` is the
    // enumerated row count and `covered` is the objective per-row outcome
    // count above — never aliased to the post-suppression emitted count, so a
    // steady-state run (nothing changed → nothing emitted) still reads
    // `complete` (define-connector-progress-evidence-contract task 4.4,
    // mirroring `emitAccountsStream`'s self-coverage message).
    await emitDetailCoverage(deps, {
      stream: "inbox_messages",
      stateStream: "inbox_messages",
      requiredKeys: [],
      hydratedKeys: [],
      considered: msgs.length,
      covered,
    });
    // The inbox listing is a full scan of the inbox page: prune fingerprints
    // for messages no longer listed so a re-appearance re-emits.
    fingerprintCursor.pruneStale();
    const cursor: Record<string, unknown> = { fetched_at: nowIso() };
    if (fingerprintCursor.size() > 0) {
      cursor.fingerprints = fingerprintCursor.toState();
    }
    await deps.emit({
      type: "STATE",
      stream: "inbox_messages",
      cursor,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "inbox_messages",
      reason: "scrape_failed",
      message: msg.slice(0, ID_TEXT_SNIP),
      diagnostics: {
        error_class: err instanceof Error ? err.constructor.name : "unknown",
        message: msg.slice(0, ID_TEXT_SNIP),
      },
    });
  }
}

// ─── Credit-card billing stream ─────────────────────────────────────────

function scrapeCreditCardBilling(page: Page): Promise<BillingKv> {
  return page.evaluate((): BillingKv => {
    interface El {
      innerText?: string;
      nextElementSibling?: El | null;
    }
    const kv: BillingKv = {};
    const labels = [...document.querySelectorAll("dt, .label, .field-label")] as El[];
    for (const el of labels) {
      const label = (el.innerText || "").trim();
      const value = (el.nextElementSibling?.innerText || "").trim();
      if (label && value && !kv[label]) {
        kv[label] = value;
      }
    }
    return kv;
  });
}

/**
 * Parse the prior `credit_card_billing` STATE cursor's `fingerprints`
 * map. Keyed by the billing record `id` (the account id, last-four, or a
 * hash of the raw text). Legacy cursors (only `{ fetched_at }`) decode to
 * an empty map, so the first post-deploy run rebuilds the map and re-emits
 * every card exactly once.
 */
export function readPriorCreditCardBillingFingerprints(state: Record<string, unknown>): Map<string, string> {
  const streamState = (state.credit_card_billing ?? {}) as Record<string, unknown>;
  const raw = streamState.fingerprints;
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out.set(id, value);
    }
  }
  return out;
}

/** Which of the two credit-card streams to emit. The entity
 *  (`credit_card_billing`) and the observation (`credit_card_billing_stats`)
 *  are independently scoped. `observedOn` is the UTC sample date. The entity
 *  cursor is only supplied when the entity is requested. */
export interface CreditCardBillingEmitOptions {
  emitEntity: boolean;
  emitStats: boolean;
  fingerprintCursor: FingerprintCursor | undefined;
  observedOn: string;
}

/** Per-card outcome of one credit-card billing pass: whether the entity was
 *  counted as covered (only meaningful when `emitEntity` + a fingerprint
 *  cursor are active) and whether a stats observation was emitted. Extracted
 *  from `runCreditCardBillingStream`'s loop body to keep that function under
 *  the cognitive-complexity budget. */
interface CreditCardBillingCardOutcome {
  entityCovered: boolean;
  statsEmitted: boolean;
}

/** Navigate to one card's account page, scrape its billing details, and emit
 *  the entity/stats records per `options`. Entity gate: a per-card
 *  fingerprint that excludes the run-clock `fetched_at`. After the Family-2
 *  split the entity body carries only card identity/settings (account_id,
 *  nickname, credit_limit_cents, APRs, card_holders), so it re-emits only on
 *  a real settings change — a balance/rewards/cycle-status tick no longer
 *  versions it. The volatile per-cycle fields go to
 *  `credit_card_billing_stats`, keyed `{card_id}:{observed_on}` so same-day
 *  re-pulls are idempotent and a later day appends a new point in the
 *  series. */
async function processCreditCardBillingAccount(
  deps: EmitDeps,
  page: Page,
  a: DashboardAccount,
  options: CreditCardBillingEmitOptions
): Promise<CreditCardBillingCardOutcome> {
  const { emitEntity, emitStats, fingerprintCursor, observedOn } = options;
  await page
    .goto(`https://www.usaa.com${a.account_url}`, {
      waitUntil: "domcontentloaded",
      timeout: ACCOUNT_NAV_TIMEOUT_MS,
    })
    .catch((): undefined => undefined);
  await politeDelay(CC_SETTLE_DELAY_MS);
  const billing = await scrapeCreditCardBilling(page);
  let entityCovered = false;
  if (emitEntity) {
    const rec = buildCreditCardBillingRecord(a, billing, nowIso());
    if (!fingerprintCursor || fingerprintCursor.shouldEmit(rec)) {
      await deps.emitRecord("credit_card_billing", rec);
    }
    entityCovered = Boolean(fingerprintCursor);
  }
  let statsEmitted = false;
  if (emitStats) {
    await deps.emitRecord("credit_card_billing_stats", buildCreditCardBillingStatsRecord(a, billing, observedOn));
    statsEmitted = true;
  }
  return { entityCovered, statsEmitted };
}

export async function runCreditCardBillingStream(
  deps: EmitDeps,
  page: Page,
  accounts: readonly DashboardAccount[],
  options: CreditCardBillingEmitOptions
): Promise<void> {
  const { emitEntity, emitStats, fingerprintCursor, observedOn } = options;
  try {
    await deps.emit({
      type: "PROGRESS",
      stream: "credit_card_billing",
      message: "Fetching credit card billing details",
    });
    const cards = accounts.filter((a) => CREDIT_CARD_TYPE_RE.test(a.account_type));
    // `entityCovered` is the in-boundary cards this entity pass accounted
    // for: emitted plus suppressed-because-unchanged (mirrors
    // `emitAccountsStream`'s `entityCovered`) — `buildCreditCardBillingRecord`
    // never drops a row, so every scraped card reaches the gate.
    // `statsCovered` is the stats-stream numerator, reported under its own
    // `stream: "credit_card_billing_stats"` self-coverage message (mirrors
    // `account_stats` in `emitAccountsStream`): the append-key idempotency of
    // that observation stream is about versioning, not measurability — "did
    // this run sample every enumerated card's billing stats" is a real
    // denominator (`cards.length`) and a real numerator
    // (`buildCreditCardBillingStatsRecord` never drops a row).
    let entityCovered = 0;
    let statsCovered = 0;
    for (const a of cards) {
      const outcome = await processCreditCardBillingAccount(deps, page, a, options);
      if (outcome.entityCovered) {
        entityCovered += 1;
      }
      if (outcome.statsEmitted) {
        statsCovered += 1;
      }
    }
    if (emitStats) {
      await emitDetailCoverage(deps, {
        stream: "credit_card_billing_stats",
        stateStream: "credit_card_billing_stats",
        requiredKeys: [],
        hydratedKeys: [],
        considered: cards.length,
        covered: statsCovered,
      });
      await deps.emit({
        type: "STATE",
        stream: "credit_card_billing_stats",
        cursor: { observed_on: observedOn, fetched_at: nowIso() },
      });
    }
    if (!emitEntity) {
      return;
    }
    if (!fingerprintCursor) {
      await deps.emit({
        type: "STATE",
        stream: "credit_card_billing",
        cursor: { fetched_at: nowIso() },
      });
      return;
    }
    // Credit-card billing is a full scan of the credit-card accounts, with a
    // real, measurable denominator: `considered = cards.length` (the
    // enumerated boundary) with the objective `covered` count, so a
    // steady-state run (all cards fingerprint-suppressed, `collected` 0)
    // reads `complete` instead of a false `partial`
    // (define-connector-progress-evidence-contract task 4.4, mirroring
    // `emitAccountsStream`'s self-coverage message). Only declared when the
    // fingerprint cursor is present — the legacy no-cursor path emits
    // unconditionally and has no suppressed-vs-emitted distinction to report.
    await emitDetailCoverage(deps, {
      stream: "credit_card_billing",
      stateStream: "credit_card_billing",
      requiredKeys: [],
      hydratedKeys: [],
      considered: cards.length,
      covered: entityCovered,
    });
    // Credit-card billing is a full scan of the credit-card accounts: prune
    // fingerprints for cards no longer present so a re-added card re-emits.
    fingerprintCursor.pruneStale();
    const cursor: Record<string, unknown> = { fetched_at: nowIso() };
    if (fingerprintCursor.size() > 0) {
      cursor.fingerprints = fingerprintCursor.toState();
    }
    await deps.emit({
      type: "STATE",
      stream: "credit_card_billing",
      cursor,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "credit_card_billing",
      reason: "scrape_failed",
      message: msg.slice(0, ID_TEXT_SNIP),
      diagnostics: {
        error_class: err instanceof Error ? err.constructor.name : "unknown",
        message: msg.slice(0, ID_TEXT_SNIP),
      },
    });
  }
}

/** Run the `credit_card_billing` entity and/or `credit_card_billing_stats`
 *  observation streams based on the requested scope. The entity fingerprint
 *  cursor is only opened when the entity stream is requested. Extracted from
 *  `collect()` to keep that orchestrator under the cognitive-complexity
 *  budget. */
async function maybeRunCreditCardBillingStreams(
  deps: EmitDeps,
  page: Page,
  accounts: readonly DashboardAccount[],
  state: Record<string, unknown>,
  requested: RequestedScopes,
  emittedAt: string
): Promise<void> {
  const wantsCardBilling = requested.has("credit_card_billing");
  const wantsCardBillingStats = requested.has("credit_card_billing_stats");
  if (!(wantsCardBilling || wantsCardBillingStats)) {
    return;
  }
  const billingFingerprintCursor = wantsCardBilling
    ? openFingerprintCursor(state.credit_card_billing, {
        excludeFromFingerprint: ["fetched_at"],
        priorFingerprints: readPriorCreditCardBillingFingerprints(state),
      })
    : undefined;
  await runCreditCardBillingStream(deps, page, accounts, {
    emitEntity: wantsCardBilling,
    emitStats: wantsCardBillingStats,
    fingerprintCursor: billingFingerprintCursor,
    observedOn: emittedAt.slice(0, 10),
  });
}

// ─── Connector entry point ────────────────────────────────────────────────

export const USAA_RETRYABLE_PATTERN = /ECONN|ETIMEDOUT|timeout|source_unavailable/i;

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime
// and block the Node event loop on stdin. Only fires when this module
// IS the process entry point (i.e. `tsx connectors/usaa/index.ts`).
if (isMainModule(import.meta.url)) {
  runConnector({
    name: "usaa",
    retryablePattern: USAA_RETRYABLE_PATTERN,
    validateRecord,
    // USAA rejects headless Chromium before the login form loads
    // (`net::ERR_HTTP2_PROTOCOL_ERROR`), while headed Chrome loads it.
    // Allow explicit headless probes with PDPP_USAA_HEADLESS=1.
    browser: { profileName: "usaa", headless: process.env.PDPP_USAA_HEADLESS === "1" },
    async ensureSession({
      capture,
      context,
      page,
      sendInteraction,
    }: {
      capture?: EmitDeps["capture"];
      context: BrowserContext;
      page: Page;
      sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
    }): Promise<void> {
      await ensureUsaaSession({
        capture: capture ?? null,
        context,
        page,
        sendInteraction,
      });
    },
    async collect(ctx: BrowserCollectContext): Promise<void> {
      const {
        state,
        requested,
        context,
        page,
        emit,
        emitRecord,
        progress,
        capture,
        sendInteraction,
        emittedAt,
        browserSurface,
      } = ctx;
      const deps: EmitDeps = {
        browserSurface: browserSurfaceManagedState(browserSurface),
        capture,
        emit,
        emitRecord,
        servedAccountTransactionGaps: buildServedAccountTransactionGapLookup(ctx.detailGaps),
      };

      // ACCOUNTS — extract from dashboard; emit optionally based on requested.
      await progress("Extracting accounts from dashboard");
      if (capture) {
        await capture.captureDom(page, "dashboard-accounts");
      }
      const accounts = await extractAccounts(page);
      await progress(`Found ${accounts.length} account(s)`);

      await maybeRunAccountsStreams(deps, accounts, state, requested, emittedAt);

      // Signal raised by the transactions loop when a page redirects to
      // /my/logon mid-run — meaning USAA's session has lapsed.
      const streamState: TransactionsStreamState = { sessionDeadMidRun: false };

      // Per-transaction fingerprint cursor (excludes the run-clock
      // `fetched_at`). One cursor shared across BOTH transaction emit paths
      // (CSV export + PDF-statement parse) for the whole stream — record
      // ids (`hashId(accountId|date|amount|original|#ord)`) are globally
      // unique and the two paths hash the same logical transaction to the
      // same id. Only opened when transactions are requested. NOT pruned:
      // transactions is a partial scan (see emitCsvTransactions).
      const transactionsFingerprintCursor = requested.has("transactions")
        ? openFingerprintCursor(state.transactions, {
            excludeFromFingerprint: ["fetched_at"],
            priorFingerprints: readPriorTransactionFingerprints(state),
          })
        : undefined;

      // TRANSACTIONS — drive Export per account where applicable. Capture
      // the advanced per-account watermark cursor so the final transactions
      // STATE write below preserves the incremental `last_date` progress
      // (not just the fingerprint map).
      let transactionsCursorAfterCsv: TransactionsStreamCursor =
        (state.transactions as TransactionsPriorState | undefined) ?? {};
      let transactionsRun: TransactionsStreamResult | null = null;
      if (requested.has("transactions")) {
        transactionsRun = await runTransactionsStream(
          deps,
          context,
          page,
          sendInteraction,
          accounts,
          state,
          requested,
          streamState,
          transactionsFingerprintCursor
        );
        transactionsCursorAfterCsv = transactionsRun.cursor;
      }

      // STATEMENTS — scrape /my/documents + hydrate PDFs + (optionally) parse txns.
      // Per-statement fingerprint cursor (excludes the run-clock `fetched_at`)
      // so unchanged statements stop appending a new version every run. Only
      // opened when `statements` is requested; a transactions-only run does
      // not touch the statements STATE. The PDF-statement transaction parse
      // shares the transactions fingerprint cursor.
      if ((requested.has("statements") || requested.has("transactions")) && !streamState.sessionDeadMidRun) {
        const statementsFingerprintCursor = requested.has("statements")
          ? openFingerprintCursor(state.statements, {
              // Content-gated: when the record carries a positive content
              // fingerprint (pdf_text_sha256 + pdf_page_count), the blob/
              // acquisition-identity fields are excluded too, so an RC4-style
              // re-encryption re-download with unchanged content is a no-op;
              // when the content fields are absent (legacy/index-only), only
              // `fetched_at` is excluded (conservative fallback).
              resolveExcludeFromFingerprint: statementFingerprintExcludeKeys,
              priorFingerprints: readPriorStatementFingerprints(state),
            })
          : undefined;
        // Carry-forward of prior hydrated PDF pointers: seeded from the prior
        // statements STATE so a transient re-download failure re-emits the
        // prior content-addressed pointers instead of null.
        const statementsHydrationCursor = requested.has("statements")
          ? openStatementHydrationCursor(readPriorStatementHydration(state.statements))
          : undefined;
        const alternateSurfaceAccountIds = await runStatementsStream(
          { ...deps, page },
          accounts,
          requested,
          statementsFingerprintCursor,
          transactionsFingerprintCursor,
          statementsHydrationCursor
        );
        if (transactionsRun) {
          await finalizeTransactionsStream(deps, transactionsRun, alternateSurfaceAccountIds);
          transactionsRun = null;
        }
      } else if (transactionsRun) {
        await finalizeTransactionsStream(deps, transactionsRun, new Set<string>());
        transactionsRun = null;
      }

      // Persist the merged per-transaction fingerprint map (CSV + PDF paths)
      // once both have run, on top of the advanced per-account watermarks.
      // The per-account STATE writes inside runTransactionsStream only saw
      // the CSV-so-far map; this final write is authoritative and carries
      // the PDF-path fingerprints forward too. NOT pruned (partial scan).
      // Skipped if the session died mid-run so we never narrow a map a
      // partial run could not fully rebuild.
      if (requested.has("transactions") && !streamState.sessionDeadMidRun && transactionsFingerprintCursor) {
        await emit({
          type: "STATE",
          stream: "transactions",
          cursor: withTransactionFingerprints(transactionsCursorAfterCsv, transactionsFingerprintCursor),
        });
      }

      // INBOX_MESSAGES — scrape /my/inbox.
      if (requested.has("inbox_messages") && !streamState.sessionDeadMidRun) {
        await runInboxStream(deps, page, state);
      }

      // CREDIT_CARD_BILLING — entity (identity/settings) + optional
      // `credit_card_billing_stats` observation. See
      // `maybeRunCreditCardBillingStreams`.
      if (!streamState.sessionDeadMidRun) {
        await maybeRunCreditCardBillingStreams(deps, page, accounts, state, requested, emittedAt);
      }

      await emitDeferredStreams(emit, requested);

      if (streamState.sessionDeadMidRun) {
        throw new Error("usaa session expired mid-run; re-run with fresh auth to complete");
      }
    },
  });
}
