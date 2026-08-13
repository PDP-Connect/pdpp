// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Detail-gap page reader for the connector runtime.
//
// When a connector emits DETAIL_GAPS_PAGE_REQUEST, the runtime serves a
// byte-bounded page of pending detail gaps from the store under a run-owned
// CAS lease per gap (so a stale/concurrent page can never serve a row another
// run already owns), and adapts its per-entry byte estimate from observed
// page sizes. Leasing is not an attempt: attempt_count only advances when the
// connector explicitly reports an attempt or outcome for its lease. These
// helpers hold the paging math (byte budget, candidate-row estimate,
// serialized-size accounting) and request validation.
//
// Extracted from runtime/index.js. The reader closes over the store and run
// identifiers passed by runConnector; the byte accounting and validation are
// pure. No secret handling; grantId is an opaque store parameter (no grant or
// scope enforcement is performed here).

import { resolveRecoveryAdmission } from "./recovery-decision.ts";

const DETAIL_GAP_PAGE_MIN_BYTES = 16 * 1024;
const DETAIL_GAP_PAGE_DEFAULT_BYTES = 256 * 1024;
const DETAIL_GAP_PAGE_MAX_BYTES = 1024 * 1024;
const DETAIL_GAP_PAGE_MAX_CANDIDATE_ROWS = 500;
const DETAIL_GAP_PAGE_ASSUMED_AVG_BYTES = 1536;

interface BoundedPositiveIntegerOptions {
  max?: number;
  min?: number;
}

interface DetailGap {
  detail_locator?: string | null;
  gap_id: string;
  parent_stream?: string | null;
  record_key?: string | null;
  status: string;
  stream: string;
  [key: string]: unknown;
}

interface PendingStartDetailGap {
  detail_locator: string | null;
  gap_id: string;
  parent_stream?: string | null;
  record_key: string | null;
  reference_only: boolean;
  status: string;
  stream: string;
}

interface StartDetailGap extends PendingStartDetailGap {
  lease_id: string;
}

interface ServedDetailGapLease {
  attempted: boolean;
  gapId: string;
  leaseId: string;
  parentStream: string | null;
  recordKey: string | null;
  runId: string;
  stream: string | null;
}

interface DetailGapPagePlan {
  byteBudget: number;
  candidateLimit: number;
}

interface DetailGapPageReadResult {
  detailGaps: PendingStartDetailGap[];
  entryBytesTotal: number;
  serializedBytes: number;
  servedGapIds: string[];
}

interface DetailGapAdmissionSummary {
  admitted: number;
  candidates: number;
  deferred: number;
  deferred_by_reason?: Record<string, number>;
  next_eligible_at?: string;
}

interface ValidatedDetailGapsPageRequest {
  maxBytes: number | null;
  requestId: string;
  streams: string[] | null;
}

interface DetailGapPageReaderResult {
  admission: DetailGapAdmissionSummary;
  candidateLimit: number;
  detailGaps: StartDetailGap[];
  maxBytes: number;
  serializedBytes: number;
  servedGapIds: string[];
}

interface DetailGapStore {
  claimPendingGaps: (
    gapIds: readonly (string | null | undefined)[],
    options: { leaseExpiresAt?: string | null; leaseId?: string | null; runId?: string | null }
  ) => Promise<string[]>;
  listPendingGaps: (options: {
    connectorId: string;
    connectorInstanceId: string;
    grantId: string;
    streams?: string[] | null;
    limit: number;
  }) => Promise<DetailGap[] | null>;
  markGapStatus: (gapId: string, status: string, options: { runId: string }) => Promise<void>;
}

interface DetailGapPageReaderOptions {
  allServedGapLeases?: Map<string, ServedDetailGapLease>;
  connectorId: string;
  connectorInstanceId: string;
  detailGapStore: DetailGapStore;
  grantId: string;
  runId: string;
}

interface DetailGapPageReadOptions {
  maxBytes?: number | null;
  streams?: string[] | null;
}

function boundedPositiveInteger(
  value: unknown,
  fallback: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: BoundedPositiveIntegerOptions = {}
): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function detailGapPageByteBudget(
  requestedMaxBytes: number | null | undefined,
  configuredTargetBytes: string | null | undefined
): number {
  return boundedPositiveInteger(requestedMaxBytes ?? configuredTargetBytes, DETAIL_GAP_PAGE_DEFAULT_BYTES, {
    max: DETAIL_GAP_PAGE_MAX_BYTES,
    min: DETAIL_GAP_PAGE_MIN_BYTES,
  });
}

function planDetailGapPageRead({
  maxBytes,
  configuredTargetBytes,
  observedAverageBytes,
}: {
  maxBytes: number | null | undefined;
  configuredTargetBytes: string | null | undefined;
  observedAverageBytes: number;
}): DetailGapPagePlan {
  const byteBudget = detailGapPageByteBudget(maxBytes, configuredTargetBytes);
  return {
    byteBudget,
    candidateLimit: Math.max(
      1,
      Math.min(DETAIL_GAP_PAGE_MAX_CANDIDATE_ROWS, Math.ceil((byteBudget / Math.max(1, observedAverageBytes)) * 1.5))
    ),
  };
}

function serializedDetailGapBytes(entry: PendingStartDetailGap): number {
  try {
    return Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
  } catch {
    return DETAIL_GAP_PAGE_ASSUMED_AVG_BYTES;
  }
}

function buildStartDetailGap(gap: DetailGap): PendingStartDetailGap {
  return {
    detail_locator: gap.detail_locator ?? null,
    gap_id: gap.gap_id,
    ...(gap.parent_stream ? { parent_stream: gap.parent_stream } : {}),
    record_key: gap.record_key ?? null,
    reference_only: true,
    status: gap.status,
    stream: gap.stream,
  };
}

function trimDetailGapPageToByteBudget(pendingGaps: DetailGap[], byteBudget: number): DetailGapPageReadResult {
  const detailGaps: PendingStartDetailGap[] = [];
  const servedGapIds: string[] = [];
  let serializedBytes = 2; // JSON array brackets; exact enough for page sizing.
  let entryBytesTotal = 0;

  for (const gap of pendingGaps) {
    const entry = buildStartDetailGap(gap);
    const entryBytes = serializedDetailGapBytes(entry);
    if (detailGaps.length > 0 && serializedBytes + entryBytes > byteBudget) {
      break;
    }
    detailGaps.push(entry);
    servedGapIds.push(gap.gap_id);
    serializedBytes += entryBytes;
    entryBytesTotal += entryBytes;
    if (serializedBytes >= byteBudget) {
      break;
    }
  }

  return { detailGaps, entryBytesTotal, serializedBytes, servedGapIds };
}

function summarizeDetailGapAdmission(rows: DetailGap[]): DetailGapAdmissionSummary {
  let admitted = 0;
  const deferredByReason: Record<string, number> = Object.create(null);
  let nextEligibleAt: string | null = null;
  for (const row of rows) {
    const admission = resolveRecoveryAdmission(row);
    if (admission.ok) {
      admitted += 1;
      continue;
    }
    const reason = admission.reason as string;
    deferredByReason[reason] = (deferredByReason[reason] ?? 0) + 1;
    if (
      typeof admission.nextEligibleAt === "string" &&
      admission.nextEligibleAt &&
      (nextEligibleAt === null || admission.nextEligibleAt < nextEligibleAt)
    ) {
      // biome-ignore lint/style/useDestructuring: assignment, not property access
      nextEligibleAt = admission.nextEligibleAt;
    }
  }
  const deferred = rows.length - admitted;
  return {
    admitted,
    candidates: rows.length,
    deferred,
    ...(deferred > 0 ? { deferred_by_reason: deferredByReason } : {}),
    ...(nextEligibleAt ? { next_eligible_at: nextEligibleAt } : {}),
  };
}

function normalizeDetailGapPageStreams(streams: unknown, scopeByStream: Map<string, unknown>): string[] | null {
  // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
  if (streams == null) {
    return null;
  }
  if (!Array.isArray(streams)) {
    throw new Error("Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.streams: expected string array");
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const stream of streams) {
    if (typeof stream !== "string" || !stream.trim()) {
      throw new Error("Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.streams: expected non-empty string array");
    }
    if (!scopeByStream.has(stream)) {
      throw new Error(`Connector emitted DETAIL_GAPS_PAGE_REQUEST for undeclared stream: ${stream}`);
    }
    if (seen.has(stream)) {
      continue;
    }
    seen.add(stream);
    normalized.push(stream);
  }
  return normalized.length ? normalized : null;
}

interface DetailGapsPageRequest {
  max_bytes?: number | null;
  reference_only?: boolean;
  request_id?: string;
  streams?: unknown;
}

export function validateDetailGapsPageRequest(
  msg: DetailGapsPageRequest,
  scopeByStream: Map<string, unknown>
): ValidatedDetailGapsPageRequest {
  if (msg.reference_only !== true) {
    throw new Error("Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.reference_only: expected true");
  }
  if (typeof msg.request_id !== "string" || !msg.request_id.trim()) {
    throw new Error("Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.request_id: expected non-empty string");
  }
  // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
  if (msg.max_bytes != null && (!Number.isFinite(msg.max_bytes) || msg.max_bytes <= 0)) {
    throw new Error("Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.max_bytes: expected positive number");
  }
  return {
    // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
    maxBytes: msg.max_bytes == null ? null : Math.floor(msg.max_bytes),
    requestId: msg.request_id,
    streams: normalizeDetailGapPageStreams(msg.streams, scopeByStream),
  };
}

export function createDetailGapPageReader({
  connectorId,
  connectorInstanceId,
  detailGapStore,
  grantId,
  runId,
  allServedGapLeases,
}: DetailGapPageReaderOptions): (options?: DetailGapPageReadOptions) => Promise<DetailGapPageReaderResult> {
  let observedAverageBytes = DETAIL_GAP_PAGE_ASSUMED_AVG_BYTES;
  let pageSequence = 0;

  return async function readDetailGapPage({
    maxBytes = null,
    streams = null,
  }: DetailGapPageReadOptions = {}): Promise<DetailGapPageReaderResult> {
    const { byteBudget, candidateLimit } = planDetailGapPageRead({
      configuredTargetBytes: process.env.PDPP_DETAIL_GAP_PAGE_TARGET_BYTES,
      maxBytes,
      observedAverageBytes,
    });
    const pendingGaps =
      (await detailGapStore.listPendingGaps({
        connectorId,
        connectorInstanceId,
        grantId,
        limit: candidateLimit,
        streams,
      })) ?? [];
    const admission = summarizeDetailGapAdmission(pendingGaps);
    const { detailGaps, serializedBytes, entryBytesTotal } = trimDetailGapPageToByteBudget(pendingGaps, byteBudget);

    if (detailGaps.length === 0) {
      return {
        admission,
        candidateLimit,
        detailGaps: [],
        maxBytes: byteBudget,
        serializedBytes,
        servedGapIds: [],
      };
    }

    const pageAverage = entryBytesTotal / detailGaps.length;
    observedAverageBytes = Math.max(1, Math.round(observedAverageBytes * 0.65 + pageAverage * 0.35));

    // Leasing is not an attempt. Every selected gap receives its own
    // run-owned token; the connector must explicitly report an attempt or
    // outcome before attempt_count changes. CAS claim prevents a stale page
    // from serving a row another run already owns, and a per-gap token makes
    // a swapped same-page gap/token pairing fail closed.
    if (typeof detailGapStore.claimPendingGaps !== "function") {
      throw new Error("detail-gap store must support CAS recovery leases");
    }
    // biome-ignore lint/style/noIncrementDecrement: The explicit counter update preserves this loop’s evaluation order.
    const pageId = ++pageSequence;
    const leaseExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const leasesByGapId = new Map<string, string>();
    await Promise.all(
      detailGaps.map(async (gap) => {
        const leaseId = `${runId}:detail-gap-page:${pageId}:gap:${gap.gap_id}`;
        const claimed = await detailGapStore.claimPendingGaps([gap.gap_id], { leaseExpiresAt, leaseId, runId });
        if (claimed.includes(gap.gap_id)) {
          leasesByGapId.set(gap.gap_id, leaseId);
        }
      })
    );
    const claimedDetailGaps: StartDetailGap[] = detailGaps
      .filter((gap) => leasesByGapId.has(gap.gap_id))
      .map((gap) => ({ ...gap, lease_id: leasesByGapId.get(gap.gap_id) as string }));
    if (allServedGapLeases) {
      for (const gap of claimedDetailGaps) {
        allServedGapLeases.set(gap.gap_id, {
          attempted: false,
          gapId: gap.gap_id,
          leaseId: gap.lease_id,
          parentStream: gap.parent_stream ?? null,
          recordKey: gap.record_key === null ? null : String(gap.record_key),
          runId,
          // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
          stream: gap.stream ?? null,
        });
      }
    }

    return {
      admission,
      candidateLimit,
      detailGaps: claimedDetailGaps,
      maxBytes: byteBudget,
      serializedBytes,
      servedGapIds: claimedDetailGaps.map((gap) => gap.gap_id),
    };
  };
}
