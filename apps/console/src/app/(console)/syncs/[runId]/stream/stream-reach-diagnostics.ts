// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure classification of a stream-reach give-up.
 *
 * The browser `EventSource` collapses every pre-attach HTTP failure (401
 * invalid_token, 409 session_consumed, 410 session_expired, 410
 * companion_unavailable) and every raw connect failure into a single
 * payload-less `error` event with no status. After the viewer's pre-attach
 * retry loop gives up, the client issues one token-scoped status probe — an
 * ordinary `fetch` that *does* expose the status the `EventSource` hid — and
 * passes the result here to recover the specific failure class.
 *
 * This module has no imports on purpose: it must be safe to load from a
 * `"use client"` component and replayable from a unit test without
 * `node_modules`, mirroring the other pure stream modules
 * (`playground-event-dedupe`, `stream-viewport-classifier`).
 */

/**
 * Closed set of give-up reasons. The classifier never emits a reason outside
 * this set, and the server route clamps any reported reason back into it, so a
 * malformed or hostile client cannot widen the spine's reason vocabulary.
 */
export const STREAM_REACH_REASONS = [
  "invalid_token",
  "session_consumed",
  "session_expired",
  "companion_unavailable",
  "unreachable_origin",
  "unknown",
] as const;

export type StreamReachReason = (typeof STREAM_REACH_REASONS)[number];

const STREAM_REACH_REASON_SET = new Set<string>(STREAM_REACH_REASONS);

/**
 * Operator-facing copy per reason. Operator-console voice: address the operator
 * running their own instance, name the failure class, point at the next action.
 * Never claim the stream connected or recovered. `unknown`'s entry here is the
 * fallback used only when no status was available at all (see
 * {@link unknownTroubleMessage}); when a status IS known it is appended so an
 * unmapped status is visible rather than hidden behind identical generic copy
 * — that silence is exactly what let the 503/streaming_companion_unavailable
 * case go unnoticed before this reason was mapped.
 */
const STREAM_REACH_MESSAGE: Record<StreamReachReason, string> = {
  companion_unavailable: "The browser session is no longer running on the server. Start the browser step again.",
  invalid_token: "The browser stream link is no longer valid. Start the browser step again.",
  session_consumed: "The browser stream was already opened elsewhere. Start the browser step again.",
  session_expired: "The browser stream link expired. Start the browser step again.",
  unknown: "Couldn't reach the browser stream after several tries.",
  unreachable_origin:
    "Couldn't reach the browser stream. Check that the reference server is reachable, then try again.",
};

function unknownTroubleMessage(probeStatus: number | null): string {
  const base = STREAM_REACH_MESSAGE.unknown;
  return probeStatus === null ? base : `${base} (server responded ${probeStatus})`;
}

export interface StreamReachProbeResult {
  /**
   * `error.code` parsed from the probe response body, when present. Used to
   * split the two distinct 410 cases (`session_expired` vs
   * `companion_unavailable`) that share a status code.
   */
  probeCode?: string | null;
  /**
   * True when the probe `fetch` threw (DNS, TLS, connection refused, CORS) —
   * i.e. the request never reached the server to produce a status.
   */
  probeError?: boolean;
  /**
   * HTTP status read from the probe `fetch`, or `null` when the probe request
   * itself failed before any HTTP response was received.
   */
  probeStatus: number | null;
}

export interface StreamReachClassification {
  reason: StreamReachReason;
  troubleMessage: string;
}

/**
 * Clamp an arbitrary reason value to the closed set. Both the client (defensive)
 * and the server route (authoritative) call this so the spine never records a
 * reason outside {@link STREAM_REACH_REASONS}.
 */
export function sanitizeStreamReachReason(value: unknown): StreamReachReason {
  return typeof value === "string" && STREAM_REACH_REASON_SET.has(value) ? (value as StreamReachReason) : "unknown";
}

/**
 * Map a give-up status probe to a typed reason and the operator message. The
 * classification never fabricates a reason more specific than the probe
 * evidence supports: an unrecognized status is `unknown`, and a probe that never
 * reached the server is `unreachable_origin`.
 */
export function classifyStreamReachFailure(probe: StreamReachProbeResult): StreamReachClassification {
  const reason = classifyReason(probe);
  const troubleMessage = reason === "unknown" ? unknownTroubleMessage(probe.probeStatus) : STREAM_REACH_MESSAGE[reason];
  return { reason, troubleMessage };
}

function classifyReason(probe: StreamReachProbeResult): StreamReachReason {
  // The probe request never reached the server → the origin/route/proxy is
  // unreachable. This is distinct from a server that answered with a status.
  if (probe.probeError || probe.probeStatus === null) {
    return "unreachable_origin";
  }
  switch (probe.probeStatus) {
    case 401:
      return "invalid_token";
    case 409:
      return "session_consumed";
    case 410:
      // Two server cases share 410; the body code disambiguates them. An
      // unrecognized/absent code under 410 still means the link is gone, so
      // default to the more common expiry case rather than fabricating
      // companion loss.
      return probe.probeCode === "companion_unavailable" ? "companion_unavailable" : "session_expired";
    case 503:
      // The reference server raises StreamingCompanionUnavailableError as 503
      // ("a browser-control interaction is current, but no ready browser
      // surface is registered for this run") with body code
      // `streaming_companion_unavailable`. That fell through to `unknown`,
      // whose copy read as a network/proxy fault and sent the owner looking
      // in the wrong place while the server had in fact answered with a
      // specific, actionable reason. Verified 2026-08-18: the single
      // STREAMING_COMPANION_UNAVAILABLE occurrence in the production log is
      // recorded with statusCode 503. Other 503 codes (e.g. the managed n.eko
      // window-settle probe's `managed_surface_window_settle_unavailable`)
      // are a different, currently-unclassified condition — only match the
      // companion-unavailable body code here rather than collapsing every
      // 503 into this one reason.
      return probe.probeCode === "streaming_companion_unavailable" ? "companion_unavailable" : "unknown";
    default:
      // 5xx, proxy errors, or any other answered status: real but
      // unclassified. Keep the reason `unknown` (the spine vocabulary stays
      // closed), but the message includes the status code so the next
      // unmapped status is at least visible instead of hiding behind
      // identical generic copy the way this one did.
      return "unknown";
  }
}
