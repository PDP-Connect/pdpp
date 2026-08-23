#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP H-E-B Connector (heb.com) — list-then-detail order scraper.
 *
 * Cloned in shape from connectors/amazon (index.ts orchestration / parsers.ts
 * pure DOM->struct / schemas.ts / types.ts). No live H-E-B session has driven
 * this collector — DOM selectors and free-text regexes are derived from
 * docs/research/heb-site-knowledge-2026-07-14.md (mined from a prior
 * open-source H-E-B connector's documented facts), NOT fixture-captured from
 * a real run. design-notes/heb-connector-manifest-design-2026-07-14.md's
 * "Live-verification checklist" lists what must be re-proven in Phase 2
 * before this connector is claimed proven end-to-end.
 *
 * H-E-B is fronted by Imperva Incapsula (confirmed). The session lifecycle
 * probes live first, uses saved sign-in details when the verified login form
 * is present, and otherwise hands the browser to the owner for manual sign-in
 * or challenge completion.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import pRetry from "p-retry";
import type { Page } from "playwright";
import { ensureHebSession, probeHebSession } from "../../src/auto-login/heb.ts";
import { manualAction } from "../../src/browser-handoff.ts";
import {
  type BrowserCollectContext,
  buildDetailGap,
  emitDetailCoverage,
  type ProbeSessionArgs,
  politeDelay,
  runConnector,
} from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { type OrderItemTally, summarizeItemCounts } from "./item-count-anchor.ts";
import {
  buildOrderItemRecord,
  buildOrderRecord,
  diagnoseEmptyListPage,
  isIncapsulaBlocked,
  looksLoggedOut,
  mergeOrdersListPage,
  parseOrderDate,
  parseOrderDetailDom,
  parseOrdersListDom,
  parseOrdersListStructured,
  resolveMaxPage,
} from "./parsers.ts";
import { listPageOrderShape, validateRecord } from "./schemas.ts";
import type { ListPageDiagnostics, ListPageOrder, MaxPageResolution, OrderDetail } from "./types.ts";

const SESSION_COOKIE_RE = /session|hebuser|heb-session/;
const NAV_TIMEOUT_MS = 30_000;
const LIST_PAGE_WAIT_MS = 10_000;
// Site-knowledge doc "Politeness that worked": 1500-2500ms fixed waits after
// every navigation (client-hydrated pages; DOM not ready on `load`).
export const HEB_HYDRATION_WAIT_MIN_MS = 1500;
export const HEB_HYDRATION_WAIT_MAX_MS = 2500;
// 400-500ms between order-history list pages.
const LIST_PAGE_POLITE_DELAY_MS = 450;
const MAX_LIST_PAGES = 50;
// Bounded per-run detail budget (design doc "Collector plan" §3): blast-radius
// stop, not an attempt at exhaustive backfill in one run.
const MAX_DETAIL_ATTEMPTS_PER_RUN = 100;
// ~60 days overlap re-scans recently-seen orders to catch status transitions
// (design doc "Collector plan" §4).
const CHECKPOINT_OVERLAP_DAYS = 60;
const MS_PER_DAY = 86_400_000;
// Bounded polite delay after a successful mid-run repair re-probe, before
// retrying the one affected detail (design.md Decision 4). Reuses the same
// jitter shape as hydrationWait rather than inventing a second constant pair.
export const HEB_REPAIR_RETRY_DELAY_MIN_MS = 1500;
export const HEB_REPAIR_RETRY_DELAY_MAX_MS = 2500;

async function hydrationWait(): Promise<void> {
  const jitter = HEB_HYDRATION_WAIT_MIN_MS + Math.random() * (HEB_HYDRATION_WAIT_MAX_MS - HEB_HYDRATION_WAIT_MIN_MS);
  await politeDelay(jitter);
}

/**
 * Read the run's trigger-kind/automation-mode metadata (the same
 * `PDPP_RUN_TRIGGER_KIND` primitive the ChatGPT connector reads via
 * `chatGptAllowsInteractiveAuthRepair`, src/auto-login/chatgpt.ts:221) to
 * decide whether this run may spend the one shared owner-started manual
 * repair attempt (design.md Decision 4 / spec.md "manual-run-only for
 * owner-started assistance and latch-only for unattended runs"). Absent
 * trigger-kind metadata defaults to allowing repair — mirrors ChatGPT's same
 * default, treating "no metadata" as a manually-invoked/local/test run
 * rather than silently assuming the more restrictive unattended posture,
 * which would make local development impossible to test against.
 */
export function hebAllowsInteractiveAuthRepair(env: NodeJS.ProcessEnv = process.env): boolean {
  const triggerKind = env.PDPP_RUN_TRIGGER_KIND?.trim();
  if (!triggerKind) {
    return true;
  }
  return triggerKind === "manual";
}

type DetailFailureKind =
  | "deferred_budget"
  | "navigation_failed_non_retryable"
  | "navigation_retry_exhausted"
  | "parse_missing"
  | "session_repair_required";

export type HebDetailGapReason = "retry_exhausted" | "temporary_unavailable";

/**
 * Connector-neutral recovery class for one H-E-B detail-attempt outcome.
 * Mirrors connectors/amazon/index.ts's AmazonRecoveryClass shape (design doc:
 * "Copy Amazon's exhaustive DetailFailureKind -> RecoveryClass switch shape").
 */
export type HebRecoveryClass =
  | "run_cap_deferred"
  | "transient_no_progress"
  | "owner_repair_required"
  | "connector_defect";

/** Compile-time-exhaustive guard: a switch that reaches this branch has an
 *  unhandled DetailFailureKind, which is a type error at the call site (the
 *  `never` parameter cannot accept a real value), not a silent runtime
 *  fallback. */
function assertNever(kind: never): never {
  throw new Error(`unhandled DetailFailureKind: ${String(kind)}`);
}

export function reasonForDetailFailure(kind: DetailFailureKind): HebDetailGapReason {
  switch (kind) {
    case "navigation_retry_exhausted":
    case "deferred_budget":
      return "retry_exhausted";
    case "parse_missing":
    case "session_repair_required":
    case "navigation_failed_non_retryable":
      return "temporary_unavailable";
    default:
      return assertNever(kind);
  }
}

export function classifyHebDetailFailure(kind: DetailFailureKind): HebRecoveryClass {
  switch (kind) {
    case "deferred_budget":
      return "run_cap_deferred";
    case "session_repair_required":
      return "owner_repair_required";
    case "navigation_retry_exhausted":
    case "parse_missing":
      return "transient_no_progress";
    case "navigation_failed_non_retryable":
      return "connector_defect";
    default:
      return assertNever(kind);
  }
}

export type DetailFetchResult =
  | { detail: OrderDetail; status: "hydrated" }
  | { failureKind: DetailFailureKind; reason: HebDetailGapReason; status: "deferred" }
  | { failureKind: DetailFailureKind; reason: HebDetailGapReason; status: "failed" };

const SIGNIN_URL_RE = /\/(sign-in|login|challenge|checkpoint)/i;
// Amazon's navigation-retry shape (connectors/amazon/index.ts): retry only
// transient transport failures (timeout, connection reset, 5xx). A
// challenge/session failure (Incapsula block, sign-in redirect, password
// form) is not a transport failure and must not consume the retry budget —
// it is classified as session_repair_required instead, below.
const RETRYABLE_ERROR_RE = /timeout|ECONN|ETIMEDOUT|net::|5\d\d/i;
const DETAIL_RETRY_COUNT = 2;
const DETAIL_RETRY_MIN_TIMEOUT_MS = 1500;
const DETAIL_RETRY_FACTOR = 2;

async function navigateToOrderDetail(page: Page, url: string): Promise<void> {
  await pRetry(
    async (): Promise<void> => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    },
    {
      retries: DETAIL_RETRY_COUNT,
      minTimeout: DETAIL_RETRY_MIN_TIMEOUT_MS,
      factor: DETAIL_RETRY_FACTOR,
      shouldRetry: ({ error }): boolean => RETRYABLE_ERROR_RE.test(error.message),
    }
  );
}

export interface HydrationDeps {
  /** Optional deterministic seam for unit tests; production omits it and
   *  therefore keeps the 1500–2500ms polite hydration wait. */
  waitForHydration?: (() => Promise<void>) | undefined;
}

export async function fetchOrderDetail(
  page: Page,
  orderId: string,
  deps: HydrationDeps = {}
): Promise<DetailFetchResult> {
  const url = `https://www.heb.com/my-account/order-history/${orderId}`;
  try {
    await navigateToOrderDetail(page, url);
  } catch (err) {
    // pRetry's shouldRetry gate (RETRYABLE_ERROR_RE) only lets transient
    // transport errors consume the retry budget — a non-retryable error
    // (e.g. "page closed", ERR_ABORTED) reaches here after exactly one
    // attempt. That is a distinct failure from genuinely exhausting the
    // retry budget on a transient error, so it must not be reported as
    // navigation_retry_exhausted (a false reason that also routes it into
    // the retryable pending-gap class).
    const message = err instanceof Error ? err.message : String(err);
    const failureKind: DetailFailureKind = RETRYABLE_ERROR_RE.test(message)
      ? "navigation_retry_exhausted"
      : "navigation_failed_non_retryable";
    return {
      failureKind,
      reason: reasonForDetailFailure(failureKind),
      status: "failed",
    };
  }
  await (deps.waitForHydration ?? hydrationWait)();

  const landedUrl = page.url();
  const html = await page.content().catch((): string => "");
  // Same looksLoggedOut() helper the deep probe uses (URL AND password-form
  // check) — not just the URL pattern — so a login form served at the
  // original order URL (not just a redirect to a sign-in path) is also
  // recognized as a dead session instead of falling through to parse_missing.
  if (SIGNIN_URL_RE.test(landedUrl) || (html && looksLoggedOut(landedUrl, html))) {
    return {
      failureKind: "session_repair_required",
      reason: reasonForDetailFailure("session_repair_required"),
      status: "failed",
    };
  }

  if (!html || isIncapsulaBlocked(html)) {
    return {
      failureKind: "session_repair_required",
      reason: reasonForDetailFailure("session_repair_required"),
      status: "failed",
    };
  }

  const detail = parseOrderDetailDom(html);
  if (!detail) {
    return {
      failureKind: "parse_missing",
      reason: reasonForDetailFailure("parse_missing"),
      status: "failed",
    };
  }
  return { detail, status: "hydrated" };
}

// ─── List-page extraction with shape-check ────────────────────────────────

/**
 * Extract this page's orders, preferring the structured `__NEXT_DATA__`
 * source per row and falling back to DOM extraction for any row absent or
 * untrustworthy in the structured payload (design.md Decision 1). Every
 * merged row — structured or DOM-sourced — is still shape-checked before
 * emission; a structured row that fails shape-check falls through as a
 * SKIP_RESULT, it is never silently substituted with a possibly-stale DOM
 * row without going through the same check.
 */
async function extractAndShapeCheckOrders(html: string, emit: BrowserCollectContext["emit"]): Promise<ListPageOrder[]> {
  if (!html) {
    return [];
  }
  const domOrders = parseOrdersListDom(html);
  const structuredOrders = parseOrdersListStructured(html);
  const rawOrders = mergeOrdersListPage(structuredOrders, domOrders);
  const orders: ListPageOrder[] = [];
  for (const r of rawOrders) {
    const parsed = listPageOrderShape.safeParse(r);
    if (parsed.success) {
      orders.push({ ...(parsed.data as ListPageOrder), source: r.source });
    } else {
      await emit({
        type: "SKIP_RESULT",
        stream: "orders",
        reason: "list_page_shape_check_failed",
        message: `list card ${r.orderId}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        diagnostics: { card: r, issues: parsed.error.issues, source: r.source },
      });
    }
  }
  return orders;
}

type EmptyListPageAction = "abort" | "terminal";
interface EmptyListPageClassification {
  action: EmptyListPageAction;
  reason: string;
}

/**
 * What this connection already knows about its own order history, threaded
 * explicitly into the otherwise-pure empty-page classifier.
 *
 * `hasPriorOrders` is true when a prior run committed an `orders` checkpoint —
 * the in-connector proof that H-E-B once listed orders for this account. It is
 * durable evidence about the CONNECTION, which no single page render can
 * retract.
 */
export interface PriorOrdersEvidence {
  hasPriorOrders: boolean;
}

/** Owner-facing message for the one classification whose whole point is to be
 *  read by a person. Says exactly what was observed and what was NOT concluded:
 *  neither selector drift nor a bot block is established, so neither is named.
 *  Stored records are untouched — this connector never deletes, tombstones, or
 *  overwrites on an empty page; it only declines to advance. */
export const HEB_EMPTY_AFTER_PRIOR_ORDERS_MESSAGE =
  "H-E-B reported no order history, but PDPP previously collected orders for this account. " +
  "Your stored orders are retained and untouched. This run was stopped instead of recording " +
  "an empty history, because a page showing no orders cannot prove the history is gone.";

/**
 * Classify a zero-order list page: distinguish a genuine end-of-list from
 * selector drift, an auth/challenge block, or missing/contradictory
 * pagination metadata. Pure so the branch is unit-testable without driving
 * the browser.
 *
 * design.md Decision 3 / Stop Condition #3: `pageNum > 1` alone is no longer
 * terminal proof. Normal completion is proven by successfully parsing every
 * list page from page 1 through the source-advertised `maxPage`
 * (`resolveMaxPage`) — the caller (`loadListPage`) only reaches this
 * zero-order classification for a page numbered <= maxPage in the first
 * place (a page beyond maxPage is never requested), so ANY zero-order page
 * that reaches here is, by construction, at-or-before maxPage and therefore
 * an error, never a possible terminal signal. A resolved maxPage with a
 * value strictly less than the page actually being loaded (a source-side
 * inconsistency) is also treated as non-terminal via `maxPageResolution`.
 */
export function classifyEmptyListPage(
  diag: ListPageDiagnostics,
  pageNum: number,
  maxPageResolution: MaxPageResolution,
  priorOrdersEvidence: PriorOrdersEvidence = { hasPriorOrders: false }
): EmptyListPageClassification {
  if (diag.incapsula_block || diag.password_form) {
    return { action: "abort", reason: "source_auth_or_challenge" };
  }
  // A connection that has already collected orders can never prove itself
  // empty. `hasPriorOrders` is this connection's own prior `orders` checkpoint
  // — durable evidence that H-E-B previously listed orders for this account —
  // threaded in explicitly by `collect()` rather than read from ambient state,
  // so this branch stays pure and unit-testable.
  //
  // Without this check, a connection holding 41 orders could complete a run as
  // "succeeded, considered:0, covered:0, checkpoint committed", replacing a
  // measured coverage claim with a fabricated proven-zero. The two causes are
  // indistinguishable from the page alone — H-E-B may have purged the history
  // upstream (making our stored copy the only copy), or the page may render
  // empty for a degraded session — so the run fails loudly and lets a human
  // decide, rather than guessing.
  //
  // Ordering: BELOW the block/auth check (an established block is the more
  // specific diagnosis and keeps its own reason), and ABOVE the empty_state
  // branch, so a source-authored empty state cannot short-circuit past it.
  if (diag.empty_state && priorOrdersEvidence.hasPriorOrders) {
    return { action: "abort", reason: "heb_empty_history_after_prior_orders" };
  }
  // H-E-B's own empty-state component, rendered inside the order-results
  // container, is the source asserting the history is empty. Trust it as
  // terminal proof: it is positive evidence, unlike every check below, which
  // can only infer emptiness from things being absent.
  //
  // Ordering is load-bearing in both directions. It must stay BELOW the
  // block/auth check, so a challenge page can never be laundered into a proven
  // empty result. It must stay ABOVE the `selector_drift` check, because a
  // genuinely empty page trips that check: the empty-state component's own
  // CSS-module class names match `[class*="order" i]`, producing
  // `order_cards: 0, any_card: 4` — the drift signature. Before this branch
  // existed, every zero-order run aborted as `selector_drift`, which reads as
  // "H-E-B changed their markup" and sends recovery at a selector rewrite that
  // could never succeed, because the markup is fine and the history is empty.
  //
  // Terminal here means "stop paginating, and count this as proven-empty
  // coverage" — honest because order history is account-wide (verified: a
  // single scrape of one connection returned orders from four different H-E-B
  // stores, so the selected store context does not scope what is listed).
  if (diag.empty_state) {
    return { action: "terminal", reason: "source_reported_empty" };
  }
  if (diag.order_cards === 0 && diag.any_card > 0) {
    return { action: "abort", reason: "selector_drift" };
  }
  if (maxPageResolution.kind === "absent") {
    return { action: "abort", reason: "pagination_metadata_absent" };
  }
  if (maxPageResolution.kind === "contradictory") {
    return { action: "abort", reason: "pagination_metadata_contradictory" };
  }
  if (pageNum <= maxPageResolution.value) {
    return { action: "abort", reason: "empty_page_before_max_page" };
  }
  return { action: "terminal", reason: "pagination_exhausted" };
}

async function reportEmptyPageDiagnostics(
  page: Page,
  pageNum: number,
  emit: BrowserCollectContext["emit"],
  priorOrdersEvidence: PriorOrdersEvidence
): Promise<EmptyListPageClassification> {
  const html = await page.content().catch((): string => "");
  const diag = diagnoseEmptyListPage(html, page.url());
  const maxPageResolution = resolveMaxPage(html);
  const classification = classifyEmptyListPage(diag, pageNum, maxPageResolution, priorOrdersEvidence);
  if (classification.action === "terminal") {
    return classification;
  }
  await emit({
    type: "SKIP_RESULT",
    stream: "orders",
    reason: classification.reason,
    message:
      classification.reason === "heb_empty_history_after_prior_orders"
        ? HEB_EMPTY_AFTER_PRIOR_ORDERS_MESSAGE
        : `H-E-B list page ${pageNum}: empty page is not a proven terminal page (${classification.reason}).`,
    diagnostics: {
      any_card: diag.any_card,
      body_preview: "",
      empty_state: diag.empty_state,
      has_prior_orders: priorOrdersEvidence.hasPriorOrders,
      incapsula_block: diag.incapsula_block,
      max_page_resolution: maxPageResolution,
      order_cards: diag.order_cards,
      password_form: diag.password_form,
      title: "",
      url: "",
    },
  });
  return classification;
}

// ─── Coverage accounting (order_items detail hydration) ───────────────────

export interface OrderItemsCoverage {
  gap: string[];
  hydrated: string[];
  required: string[];
}

export function newOrderItemsCoverage(): OrderItemsCoverage {
  return { gap: [], hydrated: [], required: [] };
}

/**
 * Per-run, `orders` list-stream coverage accumulator — a distinct denominator
 * from `OrderItemsCoverage` (that one tracks the `order_items` detail-page
 * enrichment; this one tracks the `orders` list stream itself, so
 * `orders`/`checkpoint_window` can report honest evidence even on a run that
 * skips order_items entirely — H-E-B usage is genuinely light and orders-only
 * scans are a real steady-state).
 *
 * Every list-page order `runForwardScan` reaches `emitOrderAndItems` for is
 * "considered" (the denominator). An order is "covered" once the connector
 * made a real accounting decision for its `orders` record: either it
 * emitted, or the per-order fingerprint cursor deliberately suppressed a
 * byte-identical re-scrape. An order whose date never parses never reaches
 * `emitOrderAndItems`, so it is recorded separately as `dateDropped` —
 * considered, but not covered.
 */
export interface OrdersCoverage {
  considered: string[];
  covered: string[];
  dateDropped: string[];
}

export function newOrdersCoverage(): OrdersCoverage {
  return { considered: [], covered: [], dateDropped: [] };
}

/**
 * The detail-hydration outcome for one considered order.
 *  - `hydrated` — the detail page fetched and parsed.
 *  - `gap`      — the detail fetch was attempted but degraded, or the order
 *                 never reached the detail lane (e.g., unparseable order date).
 * Both outcomes remain in the required denominator — the order was enumerated
 * by the parent list scan and must not silently vanish from coverage.
 */
export type DetailOutcome = "hydrated" | "gap";

export function recordDetailOutcome(coverage: OrderItemsCoverage, orderId: string, outcome: DetailOutcome): void {
  coverage.required.push(orderId);
  if (outcome === "hydrated") {
    coverage.hydrated.push(orderId);
  } else {
    coverage.gap.push(orderId);
  }
}

function buildHebDetailGap(
  orderId: string,
  reason: HebDetailGapReason,
  failureKind: DetailFailureKind,
  orderDate?: string | undefined
) {
  return buildDetailGap({
    stream: "order_items",
    parentStream: "orders",
    recordKey: orderId,
    reason,
    locator: { kind: "heb.order_detail", order_id: orderId, ...(orderDate ? { order_date: orderDate } : {}) },
    error: { class: classifyHebDetailFailure(failureKind) },
  });
}

/**
 * design.md Decision 4 / spec.md "manual-run-only for owner-started
 * assistance and latch-only for unattended runs": `manualRepairAttempted`
 * tracks whether this run has already spent its ONE shared run-scoped
 * repair attempt — shared across pending-gap recovery and forward scanning
 * so the two paths cannot each spend an independent attempt. `isManualRun`
 * is resolved once at run start from the trigger-kind/automation-mode
 * metadata (`hebAllowsInteractiveAuthRepair`) so every later failure site
 * branches on the same decision.
 */
export interface RunFlags {
  detailAttempts: number;
  isManualRun: boolean;
  manualRepairAttempted: boolean;
  sessionRepairRequired: boolean;
}

export interface EmitDeps extends HydrationDeps {
  capture?: BrowserCollectContext["capture"];
  emit: BrowserCollectContext["emit"];
  emitRecord: BrowserCollectContext["emitRecord"];
  emittedAt: string;
  /** Per-order declared-vs-collected item counts, accumulated across the run
   *  and rolled up into the `order_items` completeness anchor. Optional so
   *  existing callers and tests that do not exercise the anchor need no
   *  change. */
  itemCountTallies?: OrderItemTally[] | undefined;
  orderItemsCoverage: OrderItemsCoverage | undefined;
  ordersCoverage: OrdersCoverage | undefined;
  ordersFingerprintCursor: FingerprintCursor | undefined;
  progress: BrowserCollectContext["progress"];
  sendInteraction: BrowserCollectContext["sendInteraction"];
  wantsItems: boolean;
  wantsOrders: boolean;
}

/** Dependencies for the owner-started manual repair attempt — kept separate
 *  from EmitDeps because repair is browser/session-scoped, not
 *  emit/record-scoped, and tests exercising `resolveOrderDetail` without a
 *  repair scenario should not need to stub these. */
export interface RepairDeps extends HydrationDeps {
  capture?: BrowserCollectContext["capture"];
  sendInteraction: BrowserCollectContext["sendInteraction"];
  /** Optional deterministic seam for tests; production retains the polite
   *  1500–2500ms post-repair delay by omitting this dependency. */
  waitForRepairRetry?: () => Promise<void>;
}

async function waitForRepairRetry(): Promise<void> {
  await politeDelay(
    HEB_REPAIR_RETRY_DELAY_MIN_MS + Math.random() * (HEB_REPAIR_RETRY_DELAY_MAX_MS - HEB_REPAIR_RETRY_DELAY_MIN_MS)
  );
}

/**
 * design.md Decision 4: on an owner-started manual run's first detail
 * failure classified as session loss, Incapsula block, or challenge, spend
 * the one shared `manualAction` attempt, re-probe via `probeHebSession`,
 * wait the bounded polite delay, and report whether the session recovered.
 * Never called on an unattended run (callers gate on `flags.isManualRun`
 * before reaching here) and never called more than once per run (callers
 * gate on `flags.manualRepairAttempted`) — this function itself marks the
 * attempt spent unconditionally on entry, before it knows the outcome, so a
 * thrown/rejected manualAction still consumes the one-shot budget rather
 * than being retried.
 */
async function attemptManualSessionRepair(page: Page, deps: RepairDeps, flags: RunFlags): Promise<boolean> {
  flags.manualRepairAttempted = true;
  try {
    await manualAction(
      {
        ...(deps.capture ? { capture: deps.capture } : {}),
        message:
          "H-E-B needs you to sign back in or complete a challenge so this run can keep collecting your order details.",
        page,
        reason: "login",
      },
      deps.sendInteraction
    );
  } catch {
    return false;
  }
  const recovered = await probeHebSession(page);
  if (!recovered) {
    return false;
  }
  await (deps.waitForRepairRetry ?? waitForRepairRetry)();
  return true;
}

/**
 * design.md Decision 4 / spec.md "manual-run-only for owner-started
 * assistance and latch-only for unattended runs":
 *   - Unattended run: on the first failure classified as session loss,
 *     Incapsula block, or challenge, latch `sessionRepairRequired`
 *     immediately and defer — no browser assistance is ever opened. This is
 *     the ONLY behavior on an unattended run; it never spends the manual
 *     repair budget, because it never has one.
 *   - Owner-started manual run: on that same first failure, if the one
 *     shared repair attempt has not yet been spent, spend it
 *     (`attemptManualSessionRepair`) and retry only the affected detail once
 *     if it recovers. If the attempt is already spent, or this repair
 *     attempt itself fails, latch and defer exactly like the unattended
 *     path — every subsequent failure this run behaves identically to an
 *     unattended run.
 *
 * `resolveOrderDetail` remains the single choke point every detail fetch
 * (forward-scan and old-gap recovery alike) passes through, so the shared
 * budget in `flags` cannot be spent twice by the two call sites.
 */
export async function resolveOrderDetail(
  page: Page,
  flags: RunFlags,
  orderId: string,
  repairDeps?: RepairDeps
): Promise<DetailFetchResult> {
  if (flags.sessionRepairRequired) {
    if (flags.isManualRun && !flags.manualRepairAttempted && repairDeps) {
      const recovered = await attemptManualSessionRepair(page, repairDeps, flags);
      if (recovered) {
        flags.sessionRepairRequired = false;
        flags.detailAttempts += 1;
        const retryResult = await fetchOrderDetail(page, orderId, repairDeps);
        if (retryResult.status === "failed" && retryResult.failureKind === "session_repair_required") {
          // A second challenge right after a successful re-probe — latch for
          // the rest of the run rather than spending a second attempt.
          flags.sessionRepairRequired = true;
        }
        return retryResult;
      }
      // Repair itself failed (manualAction rejected or re-probe still dead):
      // latch permanently and fall through to the deferred response below.
      flags.sessionRepairRequired = true;
    }
    return Promise.resolve({
      failureKind: "session_repair_required",
      reason: reasonForDetailFailure("session_repair_required"),
      status: "deferred",
    });
  }
  if (flags.detailAttempts >= MAX_DETAIL_ATTEMPTS_PER_RUN) {
    return Promise.resolve({
      failureKind: "deferred_budget",
      reason: reasonForDetailFailure("deferred_budget"),
      status: "deferred",
    });
  }
  flags.detailAttempts += 1;
  return fetchOrderDetail(page, orderId, repairDeps);
}

// ─── Old-gap recovery (drains pending order_items detail gaps) ────────────
// Mirrors connectors/amazon/index.ts's recoverPendingOrderItemDetailGaps*
// shape (design doc "Collector plan" §3: "recovery pass drains old gaps
// before new forward scanning").

function readRecoverableHebOrderDetailGap(
  gap: BrowserCollectContext["detailGaps"][number]
): { gapId: string; orderDate: string | undefined; orderId: string; recordKey: string | number } | null {
  if (gap.stream !== "order_items" || gap.status !== "pending") {
    return null;
  }
  const locator = gap.detail_locator;
  if (locator?.kind !== "heb.order_detail") {
    return null;
  }
  const orderId = locator.order_id;
  if (typeof orderId !== "string" || orderId.length === 0) {
    return null;
  }
  const orderDate =
    typeof locator.order_date === "string" && locator.order_date.length > 0 ? locator.order_date : undefined;
  return { gapId: gap.gap_id, orderDate, orderId, recordKey: gap.record_key ?? orderId };
}

export interface HebDetailRecoveryDeps extends HydrationDeps {
  capture?: BrowserCollectContext["capture"];
  detailGaps: readonly BrowserCollectContext["detailGaps"][number][];
  emit: BrowserCollectContext["emit"];
  emitRecord: BrowserCollectContext["emitRecord"];
  emittedAt: string;
  requestDetailGapPage?: BrowserCollectContext["requestDetailGapPage"] | undefined;
  sendInteraction: BrowserCollectContext["sendInteraction"];
}

async function recoverPendingOrderItemDetailGapPage(
  page: Page,
  deps: HebDetailRecoveryDeps,
  flags: RunFlags,
  gaps: readonly BrowserCollectContext["detailGaps"][number][]
): Promise<{ recovered: number; reDeferred: number; skipped: number }> {
  let recovered = 0;
  let reDeferred = 0;
  let skipped = 0;
  for (const gap of gaps) {
    const locator = readRecoverableHebOrderDetailGap(gap);
    if (!locator) {
      if (gap.stream === "order_items" && gap.status === "pending") {
        skipped += 1;
      }
      continue;
    }
    const result = await resolveOrderDetail(page, flags, locator.orderId, {
      ...(deps.capture ? { capture: deps.capture } : {}),
      sendInteraction: deps.sendInteraction,
      waitForHydration: deps.waitForHydration,
    });
    if (result.status === "hydrated") {
      if (!locator.orderDate) {
        // A legacy/pre-fix gap carries no trustworthy order_date in its
        // locator (order_items.order_date is a required, non-null schema
        // field, so we cannot emit an item record here without inventing
        // one). Retain the pending gap unchanged rather than fabricate the
        // current run date as the owner-visible purchase date — a future
        // run whose gap does carry a real date will recover it properly.
        await deps.emit(
          buildHebDetailGap(locator.orderId, "temporary_unavailable", "parse_missing", locator.orderDate)
        );
        reDeferred += 1;
        continue;
      }
      for (const [itemIndex, item] of result.detail.items.entries()) {
        await deps.emitRecord(
          "order_items",
          buildOrderItemRecord(locator.orderId, locator.orderDate, item, itemIndex, deps.emittedAt)
        );
      }
      await deps.emit({
        type: "DETAIL_GAP_RECOVERED",
        reference_only: true,
        gap_id: locator.gapId,
        stream: "order_items",
        record_key: locator.recordKey,
      });
      recovered += 1;
      continue;
    }
    if (result.status === "failed" && result.failureKind === "session_repair_required") {
      flags.sessionRepairRequired = true;
    }
    await deps.emit(buildHebDetailGap(locator.orderId, result.reason, result.failureKind, locator.orderDate));
    reDeferred += 1;
  }
  return { recovered, reDeferred, skipped };
}

export async function recoverPendingOrderItemDetailGaps(
  page: Page,
  deps: HebDetailRecoveryDeps,
  flags: RunFlags
): Promise<{ recovered: number; stoppedWithPending: boolean }> {
  let recovered = 0;
  let gaps = deps.detailGaps;
  while (gaps.length > 0) {
    const result = await recoverPendingOrderItemDetailGapPage(page, deps, flags, gaps);
    recovered += result.recovered;
    if (!deps.requestDetailGapPage) {
      return { recovered, stoppedWithPending: result.reDeferred + result.skipped > 0 };
    }
    if (result.recovered === 0 && result.reDeferred + result.skipped > 0) {
      return { recovered, stoppedWithPending: true };
    }
    gaps = await deps.requestDetailGapPage({ streams: ["order_items"] });
  }
  return { recovered, stoppedWithPending: false };
}

export async function recoverPendingOrderItemDetailGapsBeforeForwardRun(
  page: Page,
  deps: HebDetailRecoveryDeps,
  flags: RunFlags,
  options: { recoveryOnly?: boolean; wantsItems: boolean }
): Promise<{ recovered: number; stoppedWithPending: boolean; suppressForward: boolean }> {
  if (!options.wantsItems) {
    return { recovered: 0, stoppedWithPending: false, suppressForward: options.recoveryOnly === true };
  }
  const recovery = await recoverPendingOrderItemDetailGaps(page, deps, flags);
  const detailBudgetExhausted = flags.detailAttempts >= MAX_DETAIL_ATTEMPTS_PER_RUN;
  return {
    ...recovery,
    suppressForward: options.recoveryOnly === true || detailBudgetExhausted,
  };
}

/** Emit the order record + per-item detail records for a single list-page order. */
async function emitOrderAndItems(
  deps: EmitDeps,
  listOrder: ListPageOrder,
  detail: OrderDetail | null,
  orderDate: string
): Promise<void> {
  if (deps.wantsOrders) {
    const orderRecord = buildOrderRecord(listOrder, orderDate, deps.emittedAt);
    if (!deps.ordersFingerprintCursor || deps.ordersFingerprintCursor.shouldEmit(orderRecord)) {
      await deps.emitRecord("orders", orderRecord);
    }
    // A fingerprint-suppressed re-scrape and a fresh emit are both a real
    // accounting decision for this order's `orders` record, so both count as
    // covered.
    if (deps.ordersCoverage) {
      deps.ordersCoverage.considered.push(listOrder.orderId);
      deps.ordersCoverage.covered.push(listOrder.orderId);
    }
  }
  if (deps.wantsItems && detail) {
    for (const [itemIndex, item] of detail.items.entries()) {
      await deps.emitRecord(
        "order_items",
        buildOrderItemRecord(listOrder.orderId, orderDate, item, itemIndex, deps.emittedAt)
      );
    }
    // Completeness anchor: H-E-B's own list card declared how many items
    // this order has. Recording the pair here — declared (list page) vs
    // collected (detail page) — lets the run compare two independent source
    // surfaces instead of trusting the detail page alone. Only orders whose
    // detail actually hydrated are tallied; a gapped order is already
    // reported as a DETAIL_GAP and must not also be counted as an item
    // shortfall.
    deps.itemCountTallies?.push({
      orderId: listOrder.orderId,
      declaredItemCount: listOrder.itemCount,
      collectedItemCount: detail.items.length,
    });
  }
}

/** Process one list-page order: fetch detail (if in scope), account for
 *  coverage, emit gaps, and emit the order + item records. */
/** The `deps.wantsItems` branch of `processListOrder`: fetch the order
 *  detail (spending the repair budget through `resolveOrderDetail` if
 *  needed), account for coverage, and emit a gap on a non-hydrated outcome.
 *  Split out to keep `processListOrder`'s own cognitive complexity bounded. */
async function fetchDetailAndRecordCoverage(
  page: Page,
  deps: EmitDeps,
  flags: RunFlags,
  listOrder: ListPageOrder,
  orderDate: string
): Promise<OrderDetail | null> {
  const result = await resolveOrderDetail(page, flags, listOrder.orderId, {
    ...(deps.capture ? { capture: deps.capture } : {}),
    sendInteraction: deps.sendInteraction,
    waitForHydration: deps.waitForHydration,
  });
  if (result.status === "failed" && result.failureKind === "session_repair_required") {
    flags.sessionRepairRequired = true;
  }
  if (deps.orderItemsCoverage) {
    const outcome: DetailOutcome = result.status === "hydrated" ? "hydrated" : "gap";
    recordDetailOutcome(deps.orderItemsCoverage, listOrder.orderId, outcome);
    if (result.status !== "hydrated") {
      await deps.emit(buildHebDetailGap(listOrder.orderId, result.reason, result.failureKind, orderDate));
    }
  }
  return result.status === "hydrated" ? result.detail : null;
}

export async function processListOrder(
  page: Page,
  deps: EmitDeps,
  flags: RunFlags,
  listOrder: ListPageOrder
): Promise<void> {
  const orderDate = parseOrderDate(listOrder.orderDateRaw);
  if (!orderDate) {
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "orders",
      reason: "unparseable_order_date",
      message: `Order ${listOrder.orderId}: order date "${listOrder.orderDateRaw ?? ""}" did not parse.`,
      diagnostics: { order_id: listOrder.orderId },
    });
    // Unparseable order dates cannot reach the detail hydration lane. When
    // order_items are in scope, emit a DETAIL_GAP (not a policy skip) backed
    // by actionable evidence; the order was enumerated by the list scan, so
    // it must still join the required denominator.
    if (deps.wantsItems && deps.orderItemsCoverage) {
      recordDetailOutcome(deps.orderItemsCoverage, listOrder.orderId, "gap");
      await deps.emit(buildHebDetailGap(listOrder.orderId, "temporary_unavailable", "parse_missing", undefined));
    }
    // The list scan still enumerated this order, so the `orders` denominator
    // must not silently drop it: considered, but not covered (no accounting
    // decision was made for its `orders` record).
    if (deps.ordersCoverage) {
      deps.ordersCoverage.considered.push(listOrder.orderId);
      deps.ordersCoverage.dateDropped.push(listOrder.orderId);
    }
    return;
  }

  const detail = deps.wantsItems ? await fetchDetailAndRecordCoverage(page, deps, flags, listOrder, orderDate) : null;

  await emitOrderAndItems(deps, listOrder, detail, orderDate);
}

/**
 * Walk the order-history list pages newest-first, processing every order and
 * tracking the newest order_date seen. Stops on a legitimate terminal page,
 * once a full page is entirely older than the resume boundary, or once the
 * source's own pagination max is exhausted. Returns the newest order_date
 * observed this run (or null if none).
 */
export async function runForwardScan(
  page: Page,
  deps: EmitDeps,
  flags: RunFlags,
  boundary: string | null,
  priorOrdersEvidence: PriorOrdersEvidence = { hasPriorOrders: false }
): Promise<string | null> {
  let newestOrderDate: string | null = null;
  let pageNum = 1;
  // Run-scoped dedup: parseOrdersListDom already dedupes within one page, but
  // a pagination-boundary repeat (the last order on page N reappearing as the
  // first order on page N+1) would otherwise be processed twice — double
  // list/item records and two DETAIL_GAPs for one logical order (S5).
  const seenOrderIds = new Set<string>();
  while (pageNum <= MAX_LIST_PAGES) {
    const listPage = await loadListPage(page, pageNum, deps.emit, priorOrdersEvidence, deps.waitForHydration);
    if (listPage === "terminal") {
      break;
    }
    // Pagination max is captured from THIS page's own HTML inside
    // loadListPage(), before the per-order loop below can navigate the
    // shared page to any order-detail URL (fix for the item-enriched scan
    // silently truncating after page 1: detail HTML has no pagination nav).
    const { maxPage, orders } = listPage;

    await deps.progress(`H-E-B list page ${pageNum}: found ${orders.length} orders`, { stream: "orders" });

    const pageOrderDates: (string | null)[] = [];
    for (const listOrder of orders) {
      const orderDate = parseOrderDate(listOrder.orderDateRaw);
      // The boundary/pagination-stop decision considers every order date on
      // the page, repeats included — only the actual processing (which emits
      // records/gaps) is deduped below.
      pageOrderDates.push(orderDate);
      if (orderDate && (!newestOrderDate || orderDate > newestOrderDate)) {
        newestOrderDate = orderDate;
      }
      if (seenOrderIds.has(listOrder.orderId)) {
        continue;
      }
      seenOrderIds.add(listOrder.orderId);
      await processListOrder(page, deps, flags, listOrder);
    }

    if (shouldStopPaginating(pageOrderDates, boundary)) {
      await deps.progress(`H-E-B list page ${pageNum}: full page older than checkpoint boundary; stopping`, {
        stream: "orders",
      });
      break;
    }

    pageNum += 1;
    if (pageNum > maxPage) {
      break;
    }
    await politeDelay(LIST_PAGE_POLITE_DELAY_MS);
  }
  return newestOrderDate;
}

interface LoadedListPage {
  maxPage: number;
  orders: ListPageOrder[];
}

/** Navigate to and extract one order-history list page. Returns "terminal"
 *  when the page is a legitimate end-of-list (caller should stop paginating);
 *  throws on a non-terminal empty page (selector drift / auth challenge), and
 *  also throws — never "terminal" — when the page came up empty AFTER the
 *  list-page `goto()` itself failed (nav timeout/abort/page-closed): a failed
 *  navigation leaves the shared page on whatever HTML it last had (e.g. the
 *  prior order's detail page), which reads as zero order cards and would
 *  otherwise be misclassified as legitimate end-of-history (review3 P1).
 *
 *  `maxPage` is parsed from THIS list page's own HTML before returning — the
 *  caller must not re-read `page.content()` for pagination after this call,
 *  because item-enriched scans (`wantsItems`) navigate the shared Playwright
 *  page to order-detail URLs while processing this page's orders, which
 *  overwrites `page.content()` with detail HTML that has no pagination nav. */
async function loadListPage(
  page: Page,
  pageNum: number,
  emit: BrowserCollectContext["emit"],
  priorOrdersEvidence: PriorOrdersEvidence,
  waitForHydration?: () => Promise<void>
): Promise<LoadedListPage | "terminal"> {
  const url = `https://www.heb.com/my-account/your-orders?page=${pageNum}`;
  const navigation = await page
    .goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
    .then(() => ({ ok: true as const }))
    .catch((error: unknown) => ({ error, ok: false as const }));
  if (!navigation.ok) {
    await emit({
      type: "SKIP_RESULT",
      stream: "orders",
      reason: "list_page_navigation_failed",
      message: `H-E-B list page ${pageNum}: navigation failed; refusing to parse stale page content or advance the cursor.`,
      diagnostics: { error_class: navigation.error instanceof Error ? "Error" : "unknown" },
    });
    throw new Error("heb_empty_list_page_navigation_failed", { cause: navigation.error });
  }
  await (waitForHydration ?? hydrationWait)();
  await page
    .waitForSelector('a[href*="/my-account/order-history/HEB"]', {
      timeout: LIST_PAGE_WAIT_MS,
      state: "attached",
    })
    .catch((): undefined => undefined);

  const html = await page.content().catch((): string => "");
  const orders = await extractAndShapeCheckOrders(html, emit);
  if (orders.length > 0) {
    const maxPageResolution = resolveMaxPage(html);
    if (maxPageResolution.kind !== "resolved") {
      const reason =
        maxPageResolution.kind === "absent" ? "pagination_metadata_absent" : "pagination_metadata_contradictory";
      await emit({
        type: "SKIP_RESULT",
        stream: "orders",
        reason,
        message: `H-E-B list page ${pageNum}: ${orders.length} orders parsed but maxPage could not be resolved (${reason}); refusing to silently assume a single-page result.`,
        diagnostics: { max_page_resolution: maxPageResolution },
      });
      throw new Error(`heb_empty_list_page_${reason}`);
    }
    return { maxPage: maxPageResolution.value, orders };
  }
  const classification = await reportEmptyPageDiagnostics(page, pageNum, emit, priorOrdersEvidence);
  if (classification.action === "terminal") {
    return "terminal";
  }
  throw new Error(`heb_empty_list_page_${classification.reason}`);
}

/** Build the next `orders` STATE cursor from this run's newest order_date
 *  (falling back to the prior checkpoint when no order was seen) and the
 *  fingerprint cursor, if any. */
function buildOrdersStateCursor(
  newestOrderDate: string | null,
  ordersState: OrdersStateShape,
  ordersFingerprintCursor: FingerprintCursor | undefined
): OrdersStateShape {
  const nextCheckpoint = newestOrderDate ?? ordersState.checkpoint;
  const cursor: OrdersStateShape = nextCheckpoint === undefined ? {} : { checkpoint: nextCheckpoint };
  if (ordersFingerprintCursor && ordersFingerprintCursor.size() > 0) {
    cursor.fingerprints = ordersFingerprintCursor.toState();
  }
  return cursor;
}

export async function emitOrderItemsCoverage(deps: EmitDeps, coverage: OrderItemsCoverage): Promise<void> {
  await emitDetailCoverage(deps, {
    stream: "order_items",
    stateStream: "orders",
    requiredKeys: coverage.required,
    hydratedKeys: coverage.hydrated,
    gapKeys: coverage.gap,
    considered: coverage.required.length,
    covered: coverage.hydrated.length,
  });
}

/**
 * Emit the run-level `orders` DETAIL_COVERAGE once after the forward scan,
 * using the shared `emitDetailCoverage` helper self-referentially (`stream`
 * and `stateStream` both `"orders"` — there is no separate detail-hydration
 * phase for the list stream itself, mirroring the pattern used for USAA's
 * `inbox_messages` and GitHub's `declareListConsidered` streams). Always
 * emits when the caller invokes it (orders in scope), including a
 * zero-considered steady-state run, so an account with no orders this run
 * (H-E-B usage is often genuinely light) still reads as measured, not
 * unknown.
 */
export async function emitOrdersCoverage(deps: EmitDeps, coverage: OrdersCoverage): Promise<void> {
  await emitDetailCoverage(deps, {
    stream: "orders",
    stateStream: "orders",
    requiredKeys: [],
    hydratedKeys: [],
    considered: coverage.considered.length,
    covered: coverage.covered.length,
  });
}

// ─── Checkpoint / incremental planning ─────────────────────────────────────

interface OrdersStateShape {
  checkpoint?: string;
  fingerprints?: Record<string, string>;
}

/**
 * Derive the prior-orders evidence from this connection's stored `orders`
 * state. Exported and pure because `collect()` lives inside the
 * `isMainModule` block and cannot be driven from a test — without this seam
 * the checkpoint-to-evidence link would be the one untested link in the
 * chain, and a mutation that hardcodes `false` here (silently disarming the
 * guard for every connection) would go unnoticed.
 *
 * Any committed checkpoint counts, including one recorded by a run that
 * emitted no new records: the checkpoint's existence is the claim that H-E-B
 * once listed orders for this account.
 */
export function priorOrdersEvidenceFromState(ordersState: { checkpoint?: string }): PriorOrdersEvidence {
  return { hasPriorOrders: Boolean(ordersState.checkpoint) };
}

/**
 * H-E-B's order list is globally reverse-chronological (not year-partitioned
 * like Amazon). Given the prior run's checkpoint date, compute the resume
 * boundary: `checkpoint - overlap` so a re-scan crossing the boundary still
 * catches status transitions on recently-seen orders (design doc "Collector
 * plan" §4). Returns null (scan everything) when there is no prior checkpoint.
 */
export function resumeBoundary(priorCheckpoint: string | undefined): string | null {
  if (!priorCheckpoint) {
    return null;
  }
  const d = new Date(priorCheckpoint);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return new Date(d.getTime() - CHECKPOINT_OVERLAP_DAYS * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Given the newest order_date seen so far and a run's per-page order dates,
 * decide whether the forward walk should keep paginating. Stops once every
 * order on a page is older than the resume boundary (a full page past the
 * boundary means the rest of history is already covered).
 */
export function shouldStopPaginating(pageOrderDates: readonly (string | null)[], boundary: string | null): boolean {
  if (!boundary || pageOrderDates.length === 0) {
    return false;
  }
  return pageOrderDates.every((d) => d !== null && d < boundary);
}

// ─── Main ──────────────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "heb",
    validateRecord,
    // See the chase declaration: without this the runtime resolves `{}`, never
    // raises the `credentials` INTERACTION, and H-E-B's hand-off blames the
    // page for what is really an absent stored credential.
    auth: { kind: "env", required: ["HEB_USERNAME", "HEB_PASSWORD"] },
    // H-E-B is fronted by Incapsula, which fingerprints headless Chromium.
    // Persistent profile keeps cookies + TLS fingerprint warm across runs.
    browser: { profileName: "heb" },
    async probeSession({ context }: ProbeSessionArgs): Promise<boolean> {
      const cookies = await context.cookies("https://www.heb.com/");
      const hasSessionCookie = cookies.some((c) => SESSION_COOKIE_RE.test(c.name) && Boolean(c.value));
      if (!hasSessionCookie) {
        return false;
      }
      return true;
    },
    async ensureSession({
      page,
      sendInteraction,
      capture,
      checkpoint,
      credentials,
      onCredentialSubmit,
    }): Promise<void> {
      const ok = await ensureHebSession({
        capture,
        checkpoint,
        credentials,
        onCredentialSubmit,
        page,
        sendInteraction,
      });
      if (!ok) {
        throw new Error("heb_session_required");
      }
    },
    async collect(ctx: BrowserCollectContext): Promise<void> {
      const { scope, state, emitRecord, emit, progress, emittedAt, page, capture, sendInteraction } = ctx;
      const requested = new Map((scope?.streams || []).map((s) => [s.name, s]));
      const wantsOrders = requested.has("orders");
      const wantsItems = requested.has("order_items");

      if (!(wantsOrders || wantsItems)) {
        return;
      }

      const ordersState = (state.orders ?? {}) as OrdersStateShape;
      const boundary = resumeBoundary(ordersState.checkpoint);
      // A committed `orders` checkpoint is this connection's own record that
      // H-E-B has listed orders for this account before. It is what makes a
      // later "no order history" page a contradiction to escalate rather than
      // a result to trust. Read here, next to the checkpoint it derives from,
      // and passed down explicitly.
      const priorOrdersEvidence = priorOrdersEvidenceFromState(ordersState);

      const ordersFingerprintCursor = wantsOrders
        ? openFingerprintCursor(state.orders, { excludeFromFingerprint: ["fetched_at"] })
        : undefined;
      const orderItemsCoverage = wantsItems ? newOrderItemsCoverage() : undefined;
      // `orders` list-stream coverage is only meaningful when `orders` itself
      // is in scope — mirrors the `wantsItems`-gated accumulator above.
      const ordersCoverage = wantsOrders ? newOrdersCoverage() : undefined;
      // Declared-vs-collected item tallies for the `order_items` anchor.
      // Only meaningful when items are in scope.
      const itemCountTallies: OrderItemTally[] | undefined = wantsItems ? [] : undefined;

      const flags: RunFlags = {
        detailAttempts: 0,
        isManualRun: hebAllowsInteractiveAuthRepair(),
        manualRepairAttempted: false,
        sessionRepairRequired: false,
      };
      const deps: EmitDeps = {
        ...(capture ? { capture } : {}),
        emit,
        emitRecord,
        emittedAt,
        itemCountTallies,
        orderItemsCoverage,
        ordersCoverage,
        ordersFingerprintCursor,
        progress,
        sendInteraction,
        wantsItems,
        wantsOrders,
      };

      const gapRecovery = await recoverPendingOrderItemDetailGapsBeforeForwardRun(
        page,
        {
          ...(capture ? { capture } : {}),
          detailGaps: ctx.detailGaps,
          emit,
          emitRecord,
          emittedAt,
          requestDetailGapPage: ctx.requestDetailGapPage,
          sendInteraction,
        },
        flags,
        { recoveryOnly: ctx.recoveryOnly === true, wantsItems }
      );
      if (gapRecovery.stoppedWithPending) {
        await progress(
          "H-E-B order-item gap recovery stopped with pending gaps still queued; the next run will continue recovery"
        );
      }
      if (gapRecovery.suppressForward) {
        return;
      }

      await progress("H-E-B session verified; scanning order history");

      const newestOrderDate = await runForwardScan(page, deps, flags, boundary, priorOrdersEvidence);

      if (wantsOrders) {
        const cursor = buildOrdersStateCursor(newestOrderDate, ordersState, ordersFingerprintCursor);
        await emit({ type: "STATE", stream: "orders", cursor });
      }

      if (orderItemsCoverage) {
        await emitOrderItemsCoverage(deps, orderItemsCoverage);
      }
      // The `order_items` completeness anchor: every hydrated order's item
      // count as H-E-B declared it on the list card, against what the detail
      // page actually yielded. Reported only when the provider's own numbers
      // say something is missing — a run where every order reconciles needs
      // no notice, and an order with no declared count is silently
      // unanchored rather than falsely clean.
      if (itemCountTallies && itemCountTallies.length > 0) {
        const summary = summarizeItemCounts(itemCountTallies);
        if (summary.short > 0) {
          await emit({
            type: "SKIP_RESULT",
            stream: "order_items",
            reason: "item_count_short",
            message: "Some orders hold fewer items than H-E-B says they contain",
            diagnostics: {
              short_orders: summary.short,
              complete_orders: summary.complete,
              unanchored_orders: summary.unavailable,
              declared_items: summary.declaredItems,
              collected_items: summary.collectedItems,
              short_order_ids: summary.shortOrderIds,
            },
          });
        }
      }
      // Same honesty posture as order_items: emit once the forward scan
      // completes, including the zero-considered steady-state case, so the
      // `orders` list stream is never left permanently unmeasured.
      if (ordersCoverage) {
        await emitOrdersCoverage(deps, ordersCoverage);
      }
    },
  });
}
