// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Detail-gap page reader for the connector runtime.
//
// When a connector emits DETAIL_GAPS_PAGE_REQUEST, the runtime serves a
// byte-bounded page of pending detail gaps from the store, marks them
// in_progress (so attempt_count increments before any provider request), and
// adapts its per-entry byte estimate from observed page sizes. These helpers
// hold the paging math (byte budget, candidate-row estimate, serialized-size
// accounting) and request validation.
//
// Extracted from runtime/index.js. The reader closes over the store and run
// identifiers passed by runConnector; the byte accounting and validation are
// pure. No secret handling; grantId is an opaque store parameter (no grant or
// scope enforcement is performed here).

import { resolveRecoveryAdmission } from './recovery-decision.ts';

const DETAIL_GAP_PAGE_MIN_BYTES = 16 * 1024;
const DETAIL_GAP_PAGE_DEFAULT_BYTES = 256 * 1024;
const DETAIL_GAP_PAGE_MAX_BYTES = 1024 * 1024;
const DETAIL_GAP_PAGE_MAX_CANDIDATE_ROWS = 500;
const DETAIL_GAP_PAGE_ASSUMED_AVG_BYTES = 1536;

function boundedPositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function detailGapPageByteBudget(requestedMaxBytes = null, configuredTargetBytes = null) {
  return boundedPositiveInteger(
    requestedMaxBytes ?? configuredTargetBytes,
    DETAIL_GAP_PAGE_DEFAULT_BYTES,
    { min: DETAIL_GAP_PAGE_MIN_BYTES, max: DETAIL_GAP_PAGE_MAX_BYTES },
  );
}

function planDetailGapPageRead({ maxBytes, configuredTargetBytes, observedAverageBytes }) {
  const byteBudget = detailGapPageByteBudget(maxBytes, configuredTargetBytes);
  return {
    byteBudget,
    candidateLimit: Math.max(
      1,
      Math.min(
        DETAIL_GAP_PAGE_MAX_CANDIDATE_ROWS,
        Math.ceil((byteBudget / Math.max(1, observedAverageBytes)) * 1.5),
      ),
    ),
  };
}

function serializedDetailGapBytes(entry) {
  try {
    return Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
  } catch {
    return DETAIL_GAP_PAGE_ASSUMED_AVG_BYTES;
  }
}

function buildStartDetailGap(gap) {
  return {
    gap_id: gap.gap_id,
    stream: gap.stream,
    record_key: gap.record_key ?? null,
    status: gap.status,
    detail_locator: gap.detail_locator ?? null,
    reference_only: true,
  };
}

function trimDetailGapPageToByteBudget(pendingGaps, byteBudget) {
  const detailGaps = [];
  const servedGapIds = [];
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

  return { detailGaps, servedGapIds, serializedBytes, entryBytesTotal };
}

function summarizeDetailGapAdmission(rows) {
  let admitted = 0;
  const deferredByReason = Object.create(null);
  let nextEligibleAt = null;
  for (const row of rows) {
    const admission = resolveRecoveryAdmission(row);
    if (admission.ok) {
      admitted += 1;
      continue;
    }
    deferredByReason[admission.reason] = (deferredByReason[admission.reason] ?? 0) + 1;
    if (typeof admission.nextEligibleAt === 'string' && admission.nextEligibleAt) {
      if (nextEligibleAt === null || admission.nextEligibleAt < nextEligibleAt) {
        nextEligibleAt = admission.nextEligibleAt;
      }
    }
  }
  const deferred = rows.length - admitted;
  return {
    candidates: rows.length,
    admitted,
    deferred,
    ...(deferred > 0 ? { deferred_by_reason: deferredByReason } : {}),
    ...(nextEligibleAt ? { next_eligible_at: nextEligibleAt } : {}),
  };
}

function normalizeDetailGapPageStreams(streams, scopeByStream) {
  if (streams == null) return null;
  if (!Array.isArray(streams)) {
    throw new Error('Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.streams: expected string array');
  }
  const normalized = [];
  const seen = new Set();
  for (const stream of streams) {
    if (typeof stream !== 'string' || !stream.trim()) {
      throw new Error('Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.streams: expected non-empty string array');
    }
    if (!scopeByStream.has(stream)) {
      throw new Error(`Connector emitted DETAIL_GAPS_PAGE_REQUEST for undeclared stream: ${stream}`);
    }
    if (seen.has(stream)) continue;
    seen.add(stream);
    normalized.push(stream);
  }
  return normalized.length ? normalized : null;
}

export function validateDetailGapsPageRequest(msg, scopeByStream) {
  if (msg.reference_only !== true) {
    throw new Error('Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.reference_only: expected true');
  }
  if (typeof msg.request_id !== 'string' || !msg.request_id.trim()) {
    throw new Error('Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.request_id: expected non-empty string');
  }
  if (msg.max_bytes != null && (!Number.isFinite(msg.max_bytes) || msg.max_bytes <= 0)) {
    throw new Error('Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.max_bytes: expected positive number');
  }
  return {
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
  allServedGapIds,
}) {
  let observedAverageBytes = DETAIL_GAP_PAGE_ASSUMED_AVG_BYTES;

  return async function readDetailGapPage({ maxBytes = null, streams = null } = {}) {
    const { byteBudget, candidateLimit } = planDetailGapPageRead({
      maxBytes,
      configuredTargetBytes: process.env.PDPP_DETAIL_GAP_PAGE_TARGET_BYTES,
      observedAverageBytes,
    });
    const pendingGaps = (await detailGapStore.listPendingGaps({
      connectorId,
      connectorInstanceId,
      grantId,
      streams,
      limit: candidateLimit,
    })) ?? [];
    const admission = summarizeDetailGapAdmission(pendingGaps);
    const { detailGaps, servedGapIds, serializedBytes, entryBytesTotal } = trimDetailGapPageToByteBudget(
      pendingGaps,
      byteBudget,
    );

    if (detailGaps.length > 0) {
      const pageAverage = entryBytesTotal / detailGaps.length;
      observedAverageBytes = Math.max(
        1,
        Math.round((observedAverageBytes * 0.65) + (pageAverage * 0.35)),
      );
      // Mark served gaps in_progress so attempt_count increments before the
      // connector makes any provider requests. Re-deferred gaps (connector
      // emits DETAIL_GAP again) revert to pending via upsertPendingGap while
      // keeping the incremented attempt_count. Recovered gaps advance to
      // 'recovered' via DETAIL_GAP_RECOVERED handling.
      await Promise.all(servedGapIds.map((gapId) => detailGapStore.markGapStatus(gapId, 'in_progress', { runId })));
      if (allServedGapIds) {
        for (const gapId of servedGapIds) allServedGapIds.add(gapId);
      }
    }

    return {
      candidateLimit,
      detailGaps,
      servedGapIds,
      maxBytes: byteBudget,
      serializedBytes,
      admission,
    };
  };
}
