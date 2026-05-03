"use server";

import { requireDashboardAccess } from "../../../lib/dashboard-access.ts";
import { mintRunInteractionStream, type StreamingSessionMintResponse } from "../../../lib/operator-runs.ts";
import { getReferencePublicUrl } from "../../../lib/owner-token.ts";

export interface MintStreamSessionInput {
  interactionId: string;
  runId: string;
  viewport?: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean };
}

export interface MintedStreamSession extends StreamingSessionMintResponse {
  close_url: string;
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
  const minted = await mintRunInteractionStream(input.runId, {
    interactionId: input.interactionId,
    viewport: input.viewport,
  });
  const [viewer_url, input_url, viewport_url, close_url] = await Promise.all([
    getReferencePublicUrl(minted.viewer_path),
    getReferencePublicUrl(minted.input_path),
    getReferencePublicUrl(minted.viewport_path),
    getReferencePublicUrl(minted.close_path),
  ]);
  return { ...minted, viewer_url, input_url, viewport_url, close_url };
}
