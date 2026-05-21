"use server";

import { requireDashboardAccess } from "../../../lib/dashboard-access.ts";
import {
  mintRunInteractionStream,
  StreamingCompanionUnavailableError,
  type StreamingSessionMintResponse,
} from "../../../lib/operator-runs.ts";
import { getReferencePublicUrl } from "../../../lib/owner-token.ts";
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
