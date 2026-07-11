#!/usr/bin/env node
/**
 * PDPP Amazon Connector (v0.1.0) — scaffolded 2026-04-19, BLOCKED on 2FA.
 *
 * Uses the shared Playwright persistent profile. Two-level session probe:
 * (1) nav greeting check, (2) deep check by navigating to /your-orders.
 *
 * Port of selectors from ~/code/data-connectors/amazon/amazon-playwright.js
 * (492 lines), cleaned to PDPP semantics:
 *   - No global `page` coupling
 *   - Emits RECORDs per Collection Profile (orders + order_items streams)
 *   - State per year (year-freezing incremental strategy)
 *   - Sequential, humanlike pacing (2s between navigations)
 *
 * Auth: relies on the bootstrapped profile (the owner logs in once via bootstrap).
 * On session expiry, emits INTERACTION kind=manual_action with sign-in URL.
 */

import pRetry, { AbortError } from "p-retry";
import type { Page } from "playwright";
import { ensureAmazonSession } from "../../src/auto-login/amazon.ts";
import {
  type BrowserCollectContext,
  type DetailGapMessage,
  emitDetailCoverage,
  nowIso,
  politeDelay,
  runConnector,
} from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import {
  buildOrderItemRecord,
  buildOrderRecord,
  mergeOrderItems,
  parseOrderDate,
  parseOrderDetailDom,
  parseOrdersListDom,
} from "./parsers.ts";
import { listPageOrderShape, validateRecord } from "./schemas.ts";
import type { ListPageDiagnostics, ListPageOrder, OrderDetail } from "./types.ts";

interface YearState {
  frozen: boolean;
  last_scraped: string;
  order_count: number;
}

interface YearsCursor {
  [year: string]: YearState | undefined;
}

interface OrdersStateShape {
  /** Per-order fingerprint map (keyed by order id), excluding the
   *  run-clock `fetched_at`. Sibling to `years` in the orders STATE
   *  cursor. */
  fingerprints?: Record<string, string>;
  years?: YearsCursor;
}

/**
 * Parse the prior `orders` STATE cursor's `fingerprints` map. Keyed by the
 * order record `id` (the Amazon order id). The cursor is `{ years,
 * fingerprints }`; `collect()` reads `state.orders.fingerprints`. Legacy
 * cursors (only `{ years }`) decode to an empty map, so the first
 * post-deploy run rebuilds the map and re-emits every re-scraped order
 * exactly once.
 */
function readPriorOrderFingerprints(state: Record<string, unknown>): Map<string, string> {
  const streamState = (state.orders ?? {}) as Record<string, unknown>;
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

type EmptyListPageAction = "abort" | "terminal";

interface EmptyListPageClassification {
  action: EmptyListPageAction;
  reason: string;
}

// Navigation timeouts + pacing knobs
const NAV_TIMEOUT_MS = 30_000;
const DEEP_PROBE_WAIT_MS = 15_000;
const DETAIL_WAIT_MS = 15_000;
const PAGE_CONTENT_TIMEOUT_MS = 10_000;
const LIST_PAGE_WAIT_MS = 10_000;
const PAGE_LIMIT = 50;
const START_INDEX_STEP = 10;
const POLITE_DELAY_MS = 800;
const RETRY_MIN_TIMEOUT_MS = 1500;
const RETRY_FACTOR = 2;
const RETRY_COUNT = 2;
// Keep optional detail enrichment comfortably below the controller watchdog;
// recovery-only runs can drain the durable gaps without re-walking the list.
const MAX_DETAIL_ATTEMPTS_PER_RUN = 200;
const MAX_TEMPORARY_DETAIL_FAILURES_PER_RUN = 3;
// Module-scoped regexes (Biome useTopLevelRegex)
const RETRYABLE_ERROR_RE = /timeout|ECONN|ETIMEDOUT|net::|5\d\d/i;
const SIGNIN_URL_RE = /\/ap\/(signin|challenge|mfa)/;
const ORDERS_URL_RE = /\/your-orders|\/order-history/;
const YEAR_VALUE_RE = /year-(\d{4})/;
const DETAIL_URL_RE = /\/(?:gp\/your-account|fopo|uff\/your-account)\/order-details/;
export const AMAZON_NO_ORDERS_TEXT_PATTERN = String.raw`you have not placed any orders|no orders found|0\s+orders\s+placed\s+in|looks like you didn['’]t place an order in`;

export type AmazonDetailGapReason = "retry_exhausted" | "temporary_unavailable" | "upstream_pressure";

type DetailFailureKind =
  | "deferred_budget"
  | "navigation_retry_exhausted"
  | "parse_missing"
  | "redirected_non_detail"
  | "session_repair_required";

export type DetailFetchResult =
  | { detail: OrderDetail; status: "hydrated" }
  | { failureKind: DetailFailureKind; reason: AmazonDetailGapReason; status: "deferred" }
  | { failureKind: DetailFailureKind; reason: AmazonDetailGapReason; status: "failed" };

/**
 * Connector-neutral recovery class for one Amazon detail-attempt outcome.
 *
 * These are the design-D4 scheduling classes the runtime and owner UI reason
 * about. The connector's job (design D5) is to translate its Amazon-specific
 * failure kinds into this neutral vocabulary so the runtime never sees a local
 * label like `navigation_retry_exhausted` and the owner never sees it as copy.
 * The connector does NOT own the scheduling/quarantine budget that turns a
 * repeated `connector_defect` into a durable terminal gap — that lives in the
 * runtime terminal-gap classifier. This class is the honest signal the runtime
 * consumes; it is emitted on the gap's `detail.class`/`last_error.class`.
 *
 *   - `run_cap_deferred`        — planned blast-radius stop (per-run detail cap
 *                                 or retry budget). Resumable; NOT source
 *                                 pressure.
 *   - `transient_no_progress`   — a transient DOM/parse/navigation failure that
 *                                 made no progress this attempt. Retryable, but
 *                                 the runtime is responsible for escalating
 *                                 repeated no-progress to a connector issue.
 *   - `provider_pressure`       — Amazon rate-limited / throttled the request.
 *                                 Arms the source-pressure cooldown.
 *   - `owner_repair_required`   — the authenticated session is gone (detail
 *                                 request redirected to sign-in/challenge/MFA).
 *                                 The owner must reconnect; retrying is busywork.
 *   - `connector_defect`        — a deterministic parser/navigation defect the
 *                                 connector itself must be fixed for.
 */
export type AmazonRecoveryClass =
  | "run_cap_deferred"
  | "transient_no_progress"
  | "provider_pressure"
  | "owner_repair_required"
  | "connector_defect";

export function reasonForDetailFailure(kind: DetailFailureKind): AmazonDetailGapReason {
  switch (kind) {
    case "navigation_retry_exhausted":
      return "retry_exhausted";
    case "deferred_budget":
      return "retry_exhausted";
    case "parse_missing":
    case "redirected_non_detail":
    case "session_repair_required":
      return "temporary_unavailable";
    default:
      return "temporary_unavailable";
  }
}

/**
 * Map an Amazon detail failure kind to its connector-neutral recovery class.
 * Pure and exhaustive so the classification can be unit-tested without driving
 * the browser and so a newly added failure kind is a compile error until it is
 * classified.
 *
 * NOTE ON `parse_missing`: a single parse-missing attempt is `transient_no_progress`,
 * not `connector_defect`. Whether *repeated* deterministic no-progress becomes a
 * durable connector defect is a runtime decision (per-item attempt budget +
 * terminal-gap classifier), not a per-attempt connector call. See the recovery
 * governor design D4/D10 and the runtime dependency noted in the change report.
 */
export function classifyAmazonDetailFailure(kind: DetailFailureKind): AmazonRecoveryClass {
  switch (kind) {
    case "deferred_budget":
      return "run_cap_deferred";
    case "session_repair_required":
      return "owner_repair_required";
    case "navigation_retry_exhausted":
    case "parse_missing":
    case "redirected_non_detail":
      return "transient_no_progress";
    default:
      return "transient_no_progress";
  }
}

function classForDetailFailure(kind: DetailFailureKind): string {
  return classifyAmazonDetailFailure(kind);
}

export async function readPageContentWithin(
  page: Pick<Page, "content">,
  timeoutMs = PAGE_CONTENT_TIMEOUT_MS
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      page.content(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`page_content_timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

// ─── Session probes ──────────────────────────────────────────────────────

async function deepSessionCheck(page: Page): Promise<boolean> {
  await page.goto("https://www.amazon.com/your-orders/orders", {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });
  // Wait for either the orders page to render or a sign-in form (both are
  // valid post-nav states; we branch on them).
  await page
    .locator('form[name="signIn"], #orderTypeMenuContainer, #yourOrdersHeader, [data-component="orderCardList"]')
    .first()
    .waitFor({ state: "attached", timeout: DEEP_PROBE_WAIT_MS })
    .catch((): undefined => undefined);
  const url = page.url();
  if (SIGNIN_URL_RE.test(url)) {
    return false;
  }
  const loginForm = await page
    .locator('form[name="signIn"]')
    .first()
    .isVisible()
    .catch((): boolean => false);
  if (loginForm) {
    return false;
  }
  return ORDERS_URL_RE.test(url);
}

// ─── Year discovery & pagination ─────────────────────────────────────────

async function discoverYears(page: Page): Promise<number[]> {
  // Try select#time-filter first, then link patterns.
  const fromSelect = await page
    .evaluate((): string[] => {
      const sel =
        document.querySelector<HTMLSelectElement>("select#time-filter") ||
        document.querySelector<HTMLSelectElement>('select[name="timeFilter"]');
      if (!sel) {
        return [];
      }
      return [...sel.options].map((o) => o.value).filter(Boolean);
    })
    .catch((): string[] => []);
  const fromLinks = await page
    .evaluate((): string[] => {
      const links = [...document.querySelectorAll('a[href*="timeFilter=year-"]')];
      return links.map((a) => a.getAttribute("href")).filter((v): v is string => Boolean(v));
    })
    .catch((): string[] => []);
  const years = new Set<number>();
  for (const v of [...fromSelect, ...fromLinks]) {
    const m = YEAR_VALUE_RE.exec(v);
    if (m?.[1]) {
      years.add(Number(m[1]));
    }
  }
  const current = new Date().getFullYear();
  if (years.size === 0) {
    years.add(current);
  }
  return [...years].sort((a, b) => b - a); // newest first
}

// ─── Per-order detail fetch ──────────────────────────────────────────────
// Scrapes /gp/your-account/order-details?orderID=<ID> using Amazon's own
// `data-component` attributes (English-in-code on every locale) rather
// than regexing concatenated innerText. See docs/reference/connector-authoring-guide.md
// §2 for why structure > text.
//
// DOM contract used (stable on Amazon across layouts since ≥2023):
//   [data-component="shippingAddress"]          → recipient + address (clean <ul><li>)
//   [data-component="viewPaymentPlanSummaryWidget"] → payment method
//   [data-component="chargeSummary"]            → Order Summary incl. Grand Total
//   [data-component="purchasedItemsRightGrid"]  → one per item; wraps itemTitle/orderedMerchant/unitPrice
//   [data-component="itemTitle"]                → product name (no cruft)
//   [data-component="orderedMerchant"]          → "Sold by: <seller>"
//   [data-component="unitPrice"]                → "$15.54 $15.54" (accessibility double)
//   [data-component="cancelled"]                → present+non-empty only on cancelled orders
//   .od-item-view-qty span                      → quantity (present only when qty>1)
//   [data-component="itemConnections"]          → cross-sell buttons (EXCLUDED from names)
//
// Fallback path: if no [data-component] attributes exist (hypothetical
// older layouts or post-A/B rollback), return null — the list-page
// record stands alone rather than risking corrupt structural-less parse.
//
// Cancelled orders have [data-component="cancelled"] with "This order has
// been cancelled" text and NO other structural fields. We detect and
// emit status_detail only.
async function fetchOrderDetail(page: Page, orderId: string): Promise<DetailFetchResult> {
  const url = `https://www.amazon.com/gp/your-account/order-details?orderID=${orderId}`;

  // Retry transient navigation failures (network, timeout, 5xx) with
  // exponential backoff. AbortError bypasses retries — we use it for the
  // "Amazon redirected us to a non-detail URL" signal. Valid alternate
  // detail surfaces (for example /uff/... order cards) are handled below.
  try {
    await pRetry(
      async (): Promise<void> => {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: NAV_TIMEOUT_MS,
        });
        // Wait for the known detail page signatures. waitForSelector replaces
        // `await sleep(800)` — real sync primitive instead of a pacing guess.
        await page.waitForSelector(
          [
            "#orderDetails",
            '[data-component="cancelled"]',
            "#f3_food_ItemList",
            "#f3_food_WfmInStoreOrderSummary",
            ".ufpo-item-list-table",
            "#ufpo-order-status-container",
            ".js-order-card",
          ].join(", "),
          {
            timeout: DETAIL_WAIT_MS,
            state: "attached",
          }
        );
      },
      {
        retries: RETRY_COUNT,
        minTimeout: RETRY_MIN_TIMEOUT_MS,
        factor: RETRY_FACTOR,
        shouldRetry: ({ error }): boolean => !(error instanceof AbortError) && RETRYABLE_ERROR_RE.test(error.message),
      }
    );
  } catch {
    return {
      failureKind: "navigation_retry_exhausted",
      reason: reasonForDetailFailure("navigation_retry_exhausted"),
      status: "failed",
    };
  }

  try {
    const landedUrl = page.url();
    if (!DETAIL_URL_RE.test(landedUrl)) {
      // A detail request that lands on Amazon's sign-in/challenge/MFA flow is a
      // dead authenticated session, not a transient page miss: retrying it every
      // run is owner busywork. Route it to owner-repair so the run stops churning
      // retryable gaps and the owner is asked to reconnect. A redirect to any
      // OTHER non-detail URL stays a transient no-progress gap.
      const failureKind: DetailFailureKind = SIGNIN_URL_RE.test(landedUrl)
        ? "session_repair_required"
        : "redirected_non_detail";
      return {
        failureKind,
        reason: reasonForDetailFailure(failureKind),
        status: "failed",
      };
    }
    const html = await readPageContentWithin(page);
    const detail = parseOrderDetailDom(html);
    if (detail) {
      return { detail, status: "hydrated" };
    }
    return {
      failureKind: "parse_missing",
      reason: reasonForDetailFailure("parse_missing"),
      status: "failed",
    };
  } catch {
    return {
      failureKind: "parse_missing",
      reason: reasonForDetailFailure("parse_missing"),
      status: "failed",
    };
  }
}

// ─── Per-page order extraction ────────────────────────────────────────────
async function extractOrdersOnPage(page: Page): Promise<ListPageOrder[]> {
  try {
    const html = await readPageContentWithin(page);
    return parseOrdersListDom(html);
  } catch {
    return [];
  }
}

// ─── collect() helpers ───────────────────────────────────────────────────

export type EmitFn = BrowserCollectContext["emit"];
export type EmitRecordFn = BrowserCollectContext["emitRecord"];
export type CaptureDep = BrowserCollectContext["capture"];

/** Ephemeral per-run flags that cross year boundaries. */
export interface RunFlags {
  detailAttempts: number;
  detailCaptured: boolean;
  failedDetailCaptured: boolean;
  /** Set once a detail attempt lands on Amazon's sign-in/challenge flow. The
   *  authenticated session is dead for the rest of this run, so remaining
   *  detail attempts are deferred (a connector-local blast-radius stop) rather
   *  than hammering sign-in once per order. This is NOT cross-run scheduling —
   *  the runtime owns whether/when the next run retries. */
  sessionRepairRequired: boolean;
  temporaryDetailFailures: number;
}

/**
 * Per-run, order-item detail coverage accumulator.
 *
 * Amazon enumerates the full order list per scraped year BEFORE hydrating any
 * order-detail page, so the set of list-page order ids it processes is a real
 * "considered" denominator (not a gap-only inference). The `order_items` stream
 * is enriched by the per-order detail page (seller, unit_price, item image,
 * detail-only items). When that detail fetch succeeds the order's items are
 * hydrated; when it returns null the list-page items still emit but the detail
 * enrichment is missing — an honest degraded-coverage signal, not silence.
 *
 * Each set holds order ids (globally unique across years), so the accumulator
 * spans every scraped year and is reported once after the year loop:
 *   - `required`  — every order considered for detail hydration (denominator).
 *   - `hydrated`  — orders whose detail page fetched and parsed (numerator).
 *   - `gap`       — orders whose detail fetch was attempted but degraded (null).
 *   - `optionalSkip` — orders whose detail was skipped by explicit policy
 *                      (`PDPP_AMAZON_SKIP_DETAIL=1`), a scope choice, not a gap.
 */
export interface OrderItemsCoverage {
  gap: string[];
  hydrated: string[];
  optionalSkip: string[];
  required: string[];
}

export function newOrderItemsCoverage(): OrderItemsCoverage {
  return { gap: [], hydrated: [], optionalSkip: [], required: [] };
}

/** The detail-hydration outcome for one considered order. */
export type DetailOutcome = "hydrated" | "gap" | "skipped";

/**
 * Classify one order's detail outcome. Detail skipped by explicit policy is an
 * `optional_skip` (a scope choice); an attempted detail that came back null is
 * a degraded `gap`; a parsed detail is `hydrated`. Pure so the branch is unit
 * testable without driving the browser detail stack.
 */
export function classifyDetailOutcome(skipDetail: boolean, detail: OrderDetail | null): DetailOutcome {
  if (skipDetail) {
    return "skipped";
  }
  return detail ? "hydrated" : "gap";
}

/**
 * Record one order's detail outcome into the run-level coverage accumulator.
 * Pure aside from mutating the passed accumulator; only the order id (an opaque
 * Amazon order number, already carried in SKIP_RESULT diagnostics) crosses in,
 * never recipient/address/payment fields. Every recorded order joins
 * `required` (the denominator); the outcome decides which numerator/skip set it
 * also joins.
 */
export function recordDetailOutcome(coverage: OrderItemsCoverage, orderId: string, outcome: DetailOutcome): void {
  coverage.required.push(orderId);
  if (outcome === "hydrated") {
    coverage.hydrated.push(orderId);
  } else if (outcome === "gap") {
    coverage.gap.push(orderId);
  } else {
    coverage.optionalSkip.push(orderId);
  }
}

/**
 * Build the per-order pending DETAIL_GAP for an order whose detail fetch was
 * attempted but came back null (a degraded gap, not a policy skip). The runtime
 * treats `DETAIL_COVERAGE.gap_keys` as a projection only — a `required` key is
 * satisfied at state-commit solely by a hydration, an optional skip, or a
 * durable pending DETAIL_GAP with a matching `record_key`
 * (`assertDetailCoverageSatisfiedBeforeCommit`). Emitting `gap_keys` without the
 * matching DETAIL_GAP would fail an otherwise-successful run at commit, so every
 * gap order MUST carry exactly one pending DETAIL_GAP on `order_items` (the same
 * stream the coverage report describes, so the runtime's
 * `gap.stream === coverage.stream` match holds).
 *
 * Reference-only and redacted: the opaque Amazon order id is the only datum that
 * crosses (it is already the `record_key`/`detail_locator.order_id`); no
 * recipient, address, payment, item title, or item text is carried. `reason`
 * stays redacted but precise enough to distinguish exhausted navigation retries
 * from parse-missing detail pages and connector-budget deferrals.
 */
export function buildOrderDetailGap(
  orderId: string,
  reason: AmazonDetailGapReason = "temporary_unavailable",
  failureKind?: DetailFailureKind | undefined,
  orderDate?: string | undefined
): DetailGapMessage {
  return {
    type: "DETAIL_GAP",
    stream: "order_items",
    parent_stream: "orders",
    record_key: orderId,
    status: "pending",
    reason,
    retryable: true,
    reference_only: true,
    detail_locator: {
      kind: "amazon.order_detail",
      order_id: orderId,
      ...(orderDate ? { order_date: orderDate } : {}),
    },
    ...(failureKind
      ? {
          detail: { class: classForDetailFailure(failureKind) },
          last_error: { class: classForDetailFailure(failureKind) },
        }
      : {}),
  };
}

function readRecoverableAmazonOrderDetailGap(
  gap: BrowserCollectContext["detailGaps"][number]
): { gapId: string; orderDate: string; orderId: string; recordKey: string | number } | null {
  if (gap.stream !== "order_items" || gap.status !== "pending") {
    return null;
  }
  const locator = gap.detail_locator;
  if (!locator || locator.kind !== "amazon.order_detail") {
    return null;
  }
  const orderId = locator.order_id;
  const orderDate = locator.order_date;
  if (typeof orderId !== "string" || typeof orderDate !== "string" || orderId.length === 0 || orderDate.length === 0) {
    return null;
  }
  return { gapId: gap.gap_id, orderDate, orderId, recordKey: gap.record_key ?? orderId };
}

function resolveOrderDetail(page: Page, flags: RunFlags, orderId: string): Promise<DetailFetchResult> {
  if (flags.sessionRepairRequired) {
    // The session died earlier this run. Do not touch the browser again — the
    // gap re-defers as owner-repair so the owner is asked to reconnect instead
    // of the run hammering sign-in once per remaining order.
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
  if (flags.temporaryDetailFailures >= MAX_TEMPORARY_DETAIL_FAILURES_PER_RUN) {
    return Promise.resolve({
      failureKind: "deferred_budget",
      reason: reasonForDetailFailure("deferred_budget"),
      status: "deferred",
    });
  }
  flags.detailAttempts++;
  return fetchOrderDetail(page, orderId);
}

/**
 * Fold one detail-attempt outcome into the per-run flags. Kept in one place so
 * the forward walk and the recovery loop escalate identically:
 *   - a navigation-retry-exhausted failure ratchets the transient no-progress
 *     count toward the per-run temporary-failure cap;
 *   - a session-repair-required failure latches the run into owner-repair so no
 *     further detail attempt touches the browser (blast-radius stop; the runtime
 *     still owns the cross-run retry decision).
 * `deferred` outcomes (already gated by flags) never re-ratchet.
 */
function recordDetailFailureFlags(flags: RunFlags, result: DetailFetchResult): void {
  if (result.status === "deferred") {
    return;
  }
  if (result.status === "failed" && result.failureKind === "navigation_retry_exhausted") {
    flags.temporaryDetailFailures++;
  }
  if (result.status === "failed" && result.failureKind === "session_repair_required") {
    flags.sessionRepairRequired = true;
  }
}

async function captureFailedDetailOnce(
  capture: CaptureDep,
  page: Page,
  flags: RunFlags,
  result: Extract<DetailFetchResult, { status: "failed" }>
): Promise<void> {
  if (!capture || flags.failedDetailCaptured) {
    return;
  }
  await capture.captureDom(page, `order-detail-failed-${result.failureKind}`);
  flags.failedDetailCaptured = true;
}

export interface AmazonDetailRecoveryDeps {
  capture: CaptureDep;
  detailGaps: readonly BrowserCollectContext["detailGaps"][number][];
  emit: EmitFn;
  emitRecord: EmitRecordFn;
  requestDetailGapPage?: BrowserCollectContext["requestDetailGapPage"] | undefined;
}

async function recoverPendingOrderItemDetailGapPage(
  page: Page,
  deps: AmazonDetailRecoveryDeps,
  flags: RunFlags,
  gaps: readonly BrowserCollectContext["detailGaps"][number][]
): Promise<{ recovered: number; reDeferred: number; skipped: number }> {
  let recovered = 0;
  let reDeferred = 0;
  let skipped = 0;
  for (const gap of gaps) {
    const locator = readRecoverableAmazonOrderDetailGap(gap);
    if (!locator) {
      if (gap.stream === "order_items" && gap.status === "pending") {
        skipped++;
      }
      continue;
    }
    const result = await resolveOrderDetail(page, flags, locator.orderId);
    if (result.status === "hydrated") {
      for (const item of result.detail.items) {
        await deps.emitRecord("order_items", buildOrderItemRecord(locator.orderId, locator.orderDate, item));
      }
      await deps.emit({
        type: "DETAIL_GAP_RECOVERED",
        reference_only: true,
        gap_id: locator.gapId,
        stream: "order_items",
        record_key: locator.recordKey,
      });
      recovered++;
      continue;
    }
    recordDetailFailureFlags(flags, result);
    if (result.status === "failed") {
      await captureFailedDetailOnce(deps.capture, page, flags, result);
    }
    await deps.emit(buildOrderDetailGap(locator.orderId, result.reason, result.failureKind, locator.orderDate));
    reDeferred++;
  }
  return { recovered, reDeferred, skipped };
}

export async function recoverPendingOrderItemDetailGaps(
  page: Page,
  deps: AmazonDetailRecoveryDeps,
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
  deps: AmazonDetailRecoveryDeps,
  flags: RunFlags,
  options: { recoveryOnly?: boolean; wantsItems: boolean }
): Promise<{ recovered: number; stoppedWithPending: boolean; suppressForward: boolean }> {
  if (!options.wantsItems) {
    return { recovered: 0, stoppedWithPending: false, suppressForward: options.recoveryOnly === true };
  }
  const recovery = await recoverPendingOrderItemDetailGaps(page, deps, flags);
  const detailBudgetExhausted =
    flags.detailAttempts >= MAX_DETAIL_ATTEMPTS_PER_RUN ||
    flags.temporaryDetailFailures >= MAX_TEMPORARY_DETAIL_FAILURES_PER_RUN;
  return {
    ...recovery,
    suppressForward: options.recoveryOnly === true || detailBudgetExhausted,
  };
}

/**
 * Emit the run-level `order_items` DETAIL_COVERAGE once after the year loop,
 * using the shared `emitDetailCoverage` helper. The detail stream described is
 * `order_items` (enriched by the per-order detail page); its cursor is anchored
 * by the `orders` list stream (`state_stream`). The caller (`collect()`) only
 * reaches this call site once the `for (const year of years)` sweep has run to
 * completion without throwing — a thrown error aborts the whole collect() call
 * before this line — so `coverage.required.length === 0` here always means
 * "the year sweep completed and considered zero orders across every in-scope
 * year," never "the sweep never ran." Always emits when the caller invokes it
 * (order_items in scope) — including that zero-required steady-state case
 * (considered: 0, covered: 0, empty key sets) — so a run that legitimately
 * swept its denominator to zero stays measured instead of silently
 * unreported. Reuses DETAIL_COVERAGE as a reference-only projection; it is
 * not promoted to portable protocol.
 */
export async function emitOrderItemsCoverage(deps: EmitDeps, coverage: OrderItemsCoverage): Promise<void> {
  await emitDetailCoverage(deps, {
    stream: "order_items",
    stateStream: "orders",
    requiredKeys: coverage.required,
    hydratedKeys: coverage.hydrated,
    gapKeys: coverage.gap,
    optionalSkipKeys: coverage.optionalSkip,
    considered: coverage.required.length,
    covered: coverage.hydrated.length + coverage.optionalSkip.length,
  });
}

/** Per-run dependencies threaded through processListOrder → emitOrderAndItems. */
export interface EmitDeps {
  capture: CaptureDep;
  emit: EmitFn;
  emitRecord: EmitRecordFn;
  emittedAt: string;
  /** Run-level `order_items` detail coverage accumulator. Optional so legacy
   *  callers/tests that only exercise emit ordering can omit it; when present,
   *  processListOrder records each considered order's detail outcome here and
   *  collect() emits one DETAIL_COVERAGE after the year loop. */
  orderItemsCoverage?: OrderItemsCoverage | undefined;
  /** Per-order fingerprint cursor (excludes the run-clock `fetched_at`).
   *  Shared across all years for the whole orders stream because order ids
   *  are globally unique. Optional so legacy callers/tests emit
   *  unconditionally. */
  ordersFingerprintCursor?: FingerprintCursor | undefined;
  progress: BrowserCollectContext["progress"];
  skipDetail: boolean;
  wantsItems: boolean;
  wantsOrders: boolean;
}

/** Emit the order record + per-item records for a single list-page order.
 *
 * The invariants this enforces:
 *   1. The order record emits BEFORE its item records (so downstream
 *      readers see the parent-child relationship in order).
 *   2. Items emit in mergeOrderItems() order — list-page items first,
 *      detail-only items appended — which is the dedup + enrichment
 *      order consumers depend on.
 *   3. Streams disabled via scope (wantsOrders/wantsItems) emit nothing;
 *      the other stream still flows.
 * Regressing any of these is a real bug; integration.test.ts covers them.
 */
export async function emitOrderAndItems(
  deps: EmitDeps,
  listOrder: ListPageOrder,
  detail: OrderDetail | null,
  orderDate: string
): Promise<void> {
  if (deps.wantsOrders) {
    // Gate on a per-order fingerprint that excludes the run-clock
    // `fetched_at`. An order's identity (id = order id) is immutable and its
    // total is fixed once placed, but the current (unfrozen) year is
    // re-scraped every run and re-emitted with a fresh `fetched_at`. With
    // this gate an already-seen order whose body is byte-identical modulo
    // `fetched_at` is suppressed; a real field move (delivery_status /
    // status_detail transitioning while the order ships) is a fingerprint
    // boundary and still emits. `order_items` carries no `fetched_at`, so it
    // does not churn on a no-op re-scrape and is left ungated.
    //
    // NOTE: orders is a PARTIAL scan (year-freezing skips historical years),
    // so this cursor is never `pruneStale()`d — pruning ids in years the run
    // did not scrape would drop their fingerprints and re-churn them when the
    // year is next (re)visited.
    const orderRecord = buildOrderRecord(listOrder, detail, orderDate, deps.emittedAt);
    if (!deps.ordersFingerprintCursor || deps.ordersFingerprintCursor.shouldEmit(orderRecord)) {
      await deps.emitRecord("orders", orderRecord);
    }
  }
  if (deps.wantsItems) {
    for (const merged of mergeOrderItems(listOrder, detail)) {
      await deps.emitRecord("order_items", buildOrderItemRecord(listOrder.orderId, orderDate, merged));
    }
  }
}

/**
 * Run list-page extraction through the zod shape-check. Orders that fail
 * the shape-check become SKIP_RESULT events; the successful subset is
 * returned in source order.
 */
async function extractAndShapeCheckOrders(page: Page, emit: EmitFn): Promise<ListPageOrder[]> {
  const rawOrders = await extractOrdersOnPage(page);
  const orders: ListPageOrder[] = [];
  for (const r of rawOrders) {
    const parsed = listPageOrderShape.safeParse(r);
    if (parsed.success) {
      orders.push(parsed.data as ListPageOrder);
    } else {
      await emit({
        type: "SKIP_RESULT",
        stream: "orders",
        reason: "list_page_shape_check_failed",
        message: `list card ${r.orderId ?? "<no id>"}: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        diagnostics: { card: r, issues: parsed.error.issues },
      });
    }
  }
  return orders;
}

/**
 * Empty-page diagnostic branch: distinguish "no more orders" from
 * "our selectors missed the DOM". Emits SKIP_RESULT with drift details
 * + screenshot when the page clearly has order-like elements but our
 * selectors matched nothing.
 */
async function reportEmptyPageDiagnostics(page: Page, year: number, startIndex: number, emit: EmitFn): Promise<void> {
  const diag = await page
    .evaluate((noOrdersTextPattern): ListPageDiagnostics => {
      // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
      const CAPTCHA_RE = /captcha|robot|unusual traffic/i;
      const NO_ORDERS_RE = new RegExp(noOrdersTextPattern, "i");
      const WS = /\s+/g;
      // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
      return {
        url: location.href,
        title: document.title,
        order_cards: document.querySelectorAll("div.order-card, div.js-order-card").length,
        any_card: document.querySelectorAll('[class*="order" i][class*="card" i]').length,
        any_order_header: document.querySelectorAll('[class*="order" i][class*="header" i]').length,
        sign_in_form: Boolean(document.querySelector('form[name="signIn"]')),
        captcha: CAPTCHA_RE.test(document.body?.innerText || "").toString(),
        no_orders_text: NO_ORDERS_RE.test(document.body?.innerText || "").toString(),
        body_preview: (document.body?.innerText || "").replace(WS, " ").slice(0, 240),
      };
    }, AMAZON_NO_ORDERS_TEXT_PATTERN)
    .catch((): ListPageDiagnostics | null => null);
  const classification = classifyEmptyListPageDiagnostics(diag, startIndex);
  if (classification.action === "terminal") {
    return;
  }
  if (classification.reason === "source_auth_or_challenge") {
    await emit({
      type: "PROGRESS",
      stream: "orders",
      message: `Amazon year ${year}: sign-in or CAPTCHA challenge detected; manual action required to continue`,
    });
  }
  if (diag && classification.reason === "selector_drift") {
    const shotPath = `/tmp/amazon-drift-${year}-${startIndex}.png`;
    await page.screenshot({ path: shotPath, fullPage: true }).catch((): undefined => undefined);
    await emit({
      type: "SKIP_RESULT",
      stream: "orders",
      reason: "selector_drift",
      message: `Year ${year} startIndex=${startIndex}: order containers visible on page but .order-card/.js-order-card selector matched 0. Screenshot=${shotPath}`,
      diagnostics: diag,
    });
  } else {
    await emit({
      type: "SKIP_RESULT",
      stream: "orders",
      reason: classification.reason,
      message: `Year ${year} startIndex=${startIndex}: empty Amazon list page is not a proven terminal page; refusing to advance the cursor.`,
      diagnostics: diag ?? { missing_diagnostics: true },
    });
  }
  throw new Error(`amazon_empty_list_page_${classification.reason}`);
}

export function classifyEmptyListPageDiagnostics(
  diag: ListPageDiagnostics | null,
  startIndex: number
): EmptyListPageClassification {
  if (!diag) {
    return startIndex > 0
      ? { action: "terminal", reason: "pagination_exhausted" }
      : { action: "abort", reason: "empty_first_page_without_diagnostics" };
  }
  const captcha = diag.captcha === "true";
  if (diag.sign_in_form || captcha || SIGNIN_URL_RE.test(diag.url)) {
    return { action: "abort", reason: "source_auth_or_challenge" };
  }
  if ((diag.any_card > 0 || diag.any_order_header > 0) && diag.order_cards === 0) {
    return { action: "abort", reason: "selector_drift" };
  }
  if (diag.no_orders_text === "true") {
    return { action: "terminal", reason: "no_orders_text" };
  }
  if (startIndex > 0) {
    return { action: "terminal", reason: "pagination_exhausted" };
  }
  return { action: "abort", reason: "empty_first_page_without_terminal_signal" };
}

/**
 * Navigate to one list-page URL for `year` at `startIndex`, wait for the
 * list signal, optionally capture a fixture, and return the shape-checked
 * orders. On zero orders, emits drift diagnostics before returning [].
 */
async function scrapeListPage(
  page: Page,
  capture: CaptureDep,
  year: number,
  startIndex: number,
  emit: EmitFn
): Promise<ListPageOrder[]> {
  const url = `https://www.amazon.com/your-orders/orders?timeFilter=year-${year}&startIndex=${startIndex}`;
  await page
    .goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    })
    .catch((): undefined => undefined);
  // Wait for list-page signal. `.order-card` is the standard container
  // in modern layouts; `#ordersContainer` catches legacy. Either appears
  // when the orders list has rendered.
  await page
    .locator(".order-card, .js-order-card, #ordersContainer, #no-orders")
    .first()
    .waitFor({ state: "attached", timeout: LIST_PAGE_WAIT_MS })
    .catch((): undefined => undefined);
  // Fixture capture: one list-page snapshot per year (page 1 only).
  if (capture && startIndex === 0) {
    await capture.captureDom(page, `orders-list-${year}`);
  }
  const orders = await extractAndShapeCheckOrders(page, emit);
  if (orders.length === 0) {
    await reportEmptyPageDiagnostics(page, year, startIndex, emit);
  }
  return orders;
}

/**
 * Fetch the order detail page (if enabled), capture one detail fixture
 * per run, and emit the order + item records.
 */
/**
 * Returns `false` when the order row was dropped because its order date could
 * not be parsed (caller counts these for a per-year summary). Returns `true`
 * when the order was processed. We never emit the raw order id here — only the
 * count crosses into operator-visible evidence.
 */
export async function processListOrder(
  page: Page,
  deps: EmitDeps,
  flags: RunFlags,
  listOrder: ListPageOrder
): Promise<boolean> {
  const orderDate = parseOrderDate(listOrder.orderDateRaw);
  if (!orderDate) {
    // A list row whose date does not parse never reaches the detail lane, so it
    // is not counted toward order-item coverage; runYear already accounts for
    // it via the bounded per-year drop SKIP_RESULT.
    return false;
  }
  let detail: OrderDetail | null = null;
  let detailGapReason: AmazonDetailGapReason = "temporary_unavailable";
  let detailFailureKind: DetailFailureKind | null = null;
  if (!deps.skipDetail) {
    const result = await resolveOrderDetail(page, flags, listOrder.orderId);
    if (result.status === "hydrated") {
      detail = result.detail;
    } else {
      detailGapReason = result.reason;
      detailFailureKind = result.failureKind;
      recordDetailFailureFlags(flags, result);
      if (result.status === "failed") {
        await captureFailedDetailOnce(deps.capture, page, flags, result);
      }
    }
  }
  if (deps.capture && !(flags.detailCaptured || deps.skipDetail) && detail) {
    await deps.capture.captureDom(page, `order-detail-${listOrder.orderId}`);
    flags.detailCaptured = true;
  }
  if (deps.orderItemsCoverage) {
    // The list-page items still emit in every case; this only records whether
    // the order's detail enrichment was hydrated, degraded, or policy-skipped.
    const outcome = classifyDetailOutcome(deps.skipDetail, detail);
    recordDetailOutcome(deps.orderItemsCoverage, listOrder.orderId, outcome);
    // A degraded (attempted-but-null) detail must back its coverage `gap_key`
    // with a durable pending DETAIL_GAP, or the run fails at state-commit (see
    // buildOrderDetailGap). One gap per gap order — processListOrder runs once
    // per order, and these emit during the year loop, strictly before the
    // run-level DETAIL_COVERAGE. A policy skip (`optional_skip`) and a hydration
    // emit no gap.
    if (outcome === "gap") {
      await deps.emit(
        buildOrderDetailGap(listOrder.orderId, detailGapReason, detailFailureKind ?? undefined, orderDate)
      );
    }
  }
  await emitOrderAndItems(deps, listOrder, detail, orderDate);
  return true;
}

interface YearRunResult {
  orderCount: number;
  unparseableDateCount: number;
}

interface YearCompletionArgs {
  newYearsState: YearsCursor;
  prior: YearState | undefined;
  progress: BrowserCollectContext["progress"];
  unparseableDateCount: number;
  year: number;
  yearOrderCount: number;
}

async function applyYearCompletionState({
  newYearsState,
  prior,
  progress,
  unparseableDateCount,
  year,
  yearOrderCount,
}: YearCompletionArgs): Promise<void> {
  // Year completion state with freeze-once-stable policy. If required
  // list rows were dropped, do not advance `last_scraped`: the next run
  // must be allowed to retry the year after a parser fix instead of
  // treating the year as complete forever.
  if (unparseableDateCount === 0) {
    const stableCount = prior !== undefined && prior.order_count === yearOrderCount;
    newYearsState[String(year)] = {
      order_count: yearOrderCount,
      frozen: year < new Date().getFullYear() && stableCount,
      last_scraped: nowIso(),
    };
  } else {
    await progress(
      `Not advancing Amazon year ${year} cursor because ${unparseableDateCount} order row${
        unparseableDateCount === 1 ? "" : "s"
      } could not be emitted`,
      { stream: "orders" }
    );
  }
}

/**
 * Scrape every list page for one year and emit records. Returns both the total
 * order count seen for the year (used for freeze-once-stable policy) and the
 * count of rows we could not emit because their order date was unparseable.
 */
async function runYear(page: Page, deps: EmitDeps, flags: RunFlags, year: number): Promise<YearRunResult> {
  let startIndex = 0;
  let pageCount = 0;
  let yearOrderCount = 0;
  let unparseableDateCount = 0;
  while (pageCount < PAGE_LIMIT) {
    await deps.progress(`Amazon year ${year}: scanning page ${pageCount + 1}`, { stream: "orders" });
    const orders = await scrapeListPage(page, deps.capture, year, startIndex, deps.emit);
    if (orders.length === 0) {
      await deps.progress(`Amazon year ${year}: no more orders after ${yearOrderCount} seen`, { stream: "orders" });
      break;
    }
    yearOrderCount += orders.length;
    await deps.progress(`Amazon year ${year}: page ${pageCount + 1} found ${orders.length} orders`, {
      stream: "orders",
    });
    for (const [index, o] of orders.entries()) {
      await deps.progress(
        `Amazon year ${year}: processing order ${index + 1}/${orders.length} on page ${pageCount + 1}`,
        { stream: "orders" }
      );
      const processed = await processListOrder(page, deps, flags, o);
      if (!processed) {
        unparseableDateCount++;
      }
    }
    pageCount++;
    startIndex += START_INDEX_STEP;
    await politeDelay(POLITE_DELAY_MS);
  }
  // Bounded per-year coverage evidence: a year that silently drops order rows
  // with an unparseable order date must not look complete. One count-only
  // SKIP_RESULT per year (no raw order ids) instead of a per-item flood.
  if (unparseableDateCount > 0) {
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "orders",
      reason: "unparseable_order_date",
      message: `Amazon year ${year}: dropped ${unparseableDateCount} order row${
        unparseableDateCount === 1 ? "" : "s"
      } with unparseable dates (of ${yearOrderCount} seen)`,
      diagnostics: { dropped: unparseableDateCount, total_seen: yearOrderCount, year },
    });
  }
  return { orderCount: yearOrderCount, unparseableDateCount };
}

// ─── Incremental year planning ───────────────────────────────────────────

/**
 * Given the full set of discovered years and prior year state, return the
 * subset that should be scraped on this run.
 *
 * Invariants:
 *   - Current year is always included (orders are ongoing).
 *   - Previous year is always included (returns / late-arriving shipments
 *     can post after year-end).
 *   - Any year ≥2 years ago that already has a `last_scraped` timestamp in
 *     prior state is skipped — it was captured on a previous run and
 *     re-scraping it on every incremental run is unbounded behaviour.
 *   - Any year ≥2 years ago with NO prior `last_scraped` (newly discovered)
 *     is included so first-time discovery still works.
 *   - If there is no prior scraped state at all (first run), all years are
 *     returned so the initial backfill completes normally.
 *
 * This function is exported for unit testing. The `currentYear` parameter
 * is injected to keep the function pure (no `new Date()` at call time).
 */
export function planIncrementalYears(
  years: number[],
  yearsState: YearsCursor,
  currentYear: number
): { planned: number[]; skipped: Array<{ year: number; reason: string }> } {
  // If there is no prior scraped state at all, treat this as a first run —
  // return all discovered years so the initial backfill completes normally.
  const hasAnyScrapeHistory = Object.values(yearsState).some((s) => s?.last_scraped);
  if (!hasAnyScrapeHistory) {
    return { planned: [...years], skipped: [] };
  }

  const planned: number[] = [];
  const skipped: Array<{ year: number; reason: string }> = [];
  const prevYear = currentYear - 1;

  for (const year of years) {
    if (year >= prevYear) {
      // Current and previous year are always eligible.
      planned.push(year);
      continue;
    }
    const prior = yearsState[String(year)];
    if (prior?.last_scraped) {
      // Historical year with prior state: skip to prevent unbounded re-scrape.
      skipped.push({ year, reason: `prior state last_scraped=${prior.last_scraped}` });
    } else {
      // Newly discovered historical year (no prior state): include once.
      planned.push(year);
    }
  }

  return { planned, skipped };
}

// ─── Main ────────────────────────────────────────────────────────────────

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime
// and block the Node event loop on stdin. Only fires when this module
// IS the process entry point (i.e. `tsx connectors/amazon/index.ts`).
if (isMainModule(import.meta.url)) {
  runConnector({
    name: "amazon",
    validateRecord,
    // Amazon's bot detection fingerprints headless Chromium; cold sessions get
    // challenged. Opt into headed mode via PDPP_AMAZON_HEADLESS=0 (first-run,
    // re-auth). Warm sessions can go headless since cookies + TLS fingerprint
    // stay consistent across runs on the persistent profile.
    browser: { profileName: "amazon" },
    async ensureSession({ capture, checkpoint, context, page, sendInteraction }): Promise<void> {
      await ensureAmazonSession({
        ...(capture ? { capture } : {}),
        checkpoint,
        context,
        page,
        sendInteraction,
      });
      await checkpoint("amazon-deep-session-check");
      const deepOk = await deepSessionCheck(page);
      if (!deepOk) {
        throw new Error("amazon_session_required");
      }
    },
    async collect(ctx: BrowserCollectContext): Promise<void> {
      const { scope, state, emitRecord, emit, progress, capture, emittedAt, page } = ctx;
      const requested = new Map((scope?.streams || []).map((s) => [s.name, s]));
      const wantsItems = requested.has("order_items");
      const wantsOrders = requested.has("orders");
      const flags: RunFlags = {
        detailAttempts: 0,
        detailCaptured: false,
        failedDetailCaptured: false,
        sessionRepairRequired: false,
        temporaryDetailFailures: 0,
      };

      const gapRecovery = await recoverPendingOrderItemDetailGapsBeforeForwardRun(
        page,
        {
          capture,
          detailGaps: ctx.detailGaps,
          emit,
          emitRecord,
          requestDetailGapPage: ctx.requestDetailGapPage,
        },
        flags,
        { recoveryOnly: ctx.recoveryOnly === true, wantsItems }
      );
      if (gapRecovery.stoppedWithPending) {
        await progress(
          "Amazon order-item gap recovery stopped with pending gaps still queued; the next run will continue recovery"
        );
      }
      if (gapRecovery.suppressForward) {
        return;
      }

      // STATE is stream-keyed per Collection Profile: `state` is
      // { <stream>: <cursor>, ... }. We write STATE stream='orders'
      // cursor={years:{...}}, so reads must go through state.orders.
      const ordersState = (state.orders ?? {}) as OrdersStateShape;
      const legacyYears = (state as { years?: YearsCursor }).years;
      const yearsState: YearsCursor = ordersState.years ?? legacyYears ?? {};

      // Per-order fingerprint cursor (excludes the run-clock `fetched_at`).
      // One cursor for the whole orders stream — order ids are globally
      // unique across years. Only opened when orders are requested. NOT
      // pruned: orders is a partial scan (year-freezing skips historical
      // years — see emitOrderAndItems).
      const ordersFingerprintCursor = requested.has("orders")
        ? openFingerprintCursor(state.orders, {
            excludeFromFingerprint: ["fetched_at"],
            priorFingerprints: readPriorOrderFingerprints(state),
          })
        : undefined;

      await progress("Amazon session verified; discovering years");
      const discoveredYears = await discoverYears(page);
      let years: number[];
      // Targeted-year override for spot checks and explicit backfills.
      // Bypasses incremental planning entirely.
      if (process.env.PDPP_AMAZON_YEARS) {
        const filter = new Set(process.env.PDPP_AMAZON_YEARS.split(",").map((y) => Number(y.trim())));
        years = discoveredYears.filter((y) => filter.has(y));
      } else {
        // Incremental planning: bound the year set so historical years with
        // prior scraped state are not re-scraped on every run.
        const currentYear = new Date().getFullYear();
        const { planned, skipped } = planIncrementalYears(discoveredYears, yearsState, currentYear);
        for (const { year, reason } of skipped) {
          await progress(`Skipping year ${year} (incremental: ${reason})`);
        }
        years = planned;
      }
      await progress(`Years to scrape: ${years.join(", ")}`);

      // Capture fixtures (gated on PDPP_CAPTURE_FIXTURES=1). One orders-list
      // page per year and one order-detail page overall is enough to drive
      // offline parser tests — more just bloats the fixture tree.
      // Order-item detail coverage is only meaningful when the detail-enriched
      // `order_items` stream is in scope. When it is not requested, the
      // accumulator stays undefined and processListOrder records nothing.
      const orderItemsCoverage = wantsItems ? newOrderItemsCoverage() : undefined;
      const deps: EmitDeps = {
        capture,
        emit,
        emitRecord,
        emittedAt,
        orderItemsCoverage,
        ordersFingerprintCursor,
        progress,
        skipDetail: process.env.PDPP_AMAZON_SKIP_DETAIL === "1",
        wantsItems,
        wantsOrders,
      };

      const newYearsState: YearsCursor = { ...yearsState };

      for (const year of years) {
        const prior = yearsState[String(year)];
        // Year-freezing: skip if already frozen
        if (prior?.frozen) {
          await progress(`Skipping year ${year} (frozen)`);
          continue;
        }

        const { orderCount: yearOrderCount, unparseableDateCount } = await runYear(page, deps, flags, year);

        await applyYearCompletionState({
          newYearsState,
          prior,
          progress,
          unparseableDateCount,
          year,
          yearOrderCount,
        });
        // Carry the per-order fingerprint map forward alongside the year
        // cursors so the next run can suppress re-scraped orders whose body
        // is unchanged modulo the run clock. NOT pruned: orders is a partial
        // scan (frozen years are skipped, so their ids are never re-seen).
        const cursor: OrdersStateShape = { years: newYearsState };
        if (ordersFingerprintCursor && ordersFingerprintCursor.size() > 0) {
          cursor.fingerprints = ordersFingerprintCursor.toState();
        }
        await emit({
          type: "STATE",
          stream: "orders",
          cursor,
        });
      }

      // After every scraped year settles, emit one run-level `order_items`
      // DETAIL_COVERAGE: the order list is a real "considered" denominator, so
      // the console can tell a fully-hydrated run from one that degraded some
      // order-detail fetches without inferring it from gaps alone. No-ops when
      // order_items is out of scope or no order was considered.
      if (orderItemsCoverage) {
        await emitOrderItemsCoverage(deps, orderItemsCoverage);
      }
    },
  });
}
