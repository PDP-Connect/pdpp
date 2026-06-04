"use server";

import { requireDashboardAccess } from "../../../lib/dashboard-access.ts";
import {
  mintRunInteractionStream,
  reportRunInteractionStreamReachFailure,
  StreamingCompanionUnavailableError,
  type StreamingSessionMintResponse,
} from "../../../lib/operator-runs.ts";
import { getReferencePublicUrl } from "../../../lib/owner-token.ts";
import { sanitizeStreamReachReason } from "./stream-reach-diagnostics.ts";
import { STREAMING_UNAVAILABLE_TAG } from "./streaming-protocol.ts";

export interface MintStreamSessionInput {
  /**
   * Optional client-generated idempotency key. Pass a `crypto.randomUUID()`
   * per logical "open browser" click so a doubled call (network retry, an
   * accidental React StrictMode-style double-fire that might creep in via a
   * hook bug, operator double-tap) collapses into the same session record
   * server-side instead of superseding the prior token.
   */
  idempotencyKey?: string;
  interactionId: string;
  runId: string;
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    hasTouch?: boolean;
    mobile?: boolean;
    userAgent?: string;
  };
}

export interface MintedStreamSession extends StreamingSessionMintResponse {
  input_url: string;
  viewer_url: string;
  viewport_url: string;
}

/**
 * Owner-authenticated mint of a run-interaction streaming session. Returns
 * absolute browser-facing URLs the viewer page connects to. The token is
 * embedded in those URLs and is valid for ~5 minutes, single-attach.
 */
export async function mintStreamSessionAction(input: MintStreamSessionInput): Promise<MintedStreamSession> {
  await requireDashboardAccess(`/dashboard/runs/${encodeURIComponent(input.runId)}/stream`);
  let minted: StreamingSessionMintResponse;
  try {
    minted = await mintRunInteractionStream(input.runId, {
      idempotencyKey: input.idempotencyKey,
      interactionId: input.interactionId,
      viewport: input.viewport,
    });
  } catch (err) {
    if (err instanceof StreamingCompanionUnavailableError) {
      throw new Error(`${STREAMING_UNAVAILABLE_TAG}${err.message}`);
    }
    throw err;
  }
  const [viewer_url, input_url, viewport_url] = await Promise.all([
    getReferencePublicUrl(minted.viewer_path),
    getReferencePublicUrl(minted.input_path),
    getReferencePublicUrl(minted.viewport_path),
  ]);
  return { ...minted, viewer_url, input_url, viewport_url };
}

export interface StreamReachFailureInput {
  runId: string;
  interactionId: string;
  /** Typed give-up reason from the client classifier; re-clamped here. */
  reason: string;
  /** HTTP status the give-up probe observed, or null when the probe failed. */
  httpStatus: number | null;
}

/**
 * Record a stream-reach give-up as a `run.stream_reach_failed` spine event. The
 * reason is clamped to the closed set both here and server-side; the payload
 * never carries the stream token, proxy cookie, or raw viewer URL. The viewer
 * calls this best-effort after it has already surfaced the operator message from
 * its own local classification.
 */
export async function reportStreamReachFailureAction(input: StreamReachFailureInput): Promise<void> {
  await requireDashboardAccess(`/dashboard/runs/${encodeURIComponent(input.runId)}/stream`);
  await reportRunInteractionStreamReachFailure(input.runId, {
    interactionId: input.interactionId,
    reason: sanitizeStreamReachReason(input.reason),
    httpStatus: input.httpStatus,
  });
}
