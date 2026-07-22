// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator-only stream playground.
 *
 * Asks the reference server to lazy-launch a long-lived patchright headless
 * Chromium pinned to a self-contained data: URL, then renders the real
 * <StreamSurface> against the synthetic (runId, interactionId) the server
 * registered. Lets a developer exercise the full streaming UX (orientation
 * card, modal, frames, mouse / keyboard / wheel / touch / paste dispatch)
 * without spawning a connector run.
 *
 * Production builds 404 the route unless `PDPP_ENABLE_STREAM_PLAYGROUND=1`
 * is set. The Docker n.eko SLVP overlay enables it explicitly; hardened
 * deployments leave it disabled.
 */
import type { Viewport } from "next";
import { notFound } from "next/navigation";
import { ServerUnreachable } from "../components/shell.tsx";
import { getAsInternalUrl, ReferenceServerUnreachableError, withOwnerSessionCookie } from "../lib/owner-token.ts";
import { StreamSurface } from "../syncs/[runId]/stream/stream-viewer.tsx";

export const dynamic = "force-dynamic";
export const viewport: Viewport = {
  initialScale: 1,
  interactiveWidget: "overlays-content",
  viewportFit: "cover",
  width: "device-width",
};

const PLAYGROUND_CONNECTOR = {
  connectorId: "playground:dev",
  displayName: "Stream Playground",
};

const PLAYGROUND_MESSAGE =
  "Click the button below to open the playground browser. " +
  "Inside, click, type, scroll, paste — every input modality is logged on the page so you can see it land.";

type PlaygroundBackend = "cdp" | "neko" | "neko-remote-cdp";

interface PlaygroundSessionResponse {
  backend?: PlaygroundBackend;
  interaction_id: string;
  object: "stream_playground_session";
  run_id: string;
}

function getBackend(searchParams: { backend?: string | string[] }): PlaygroundBackend | null {
  const value = Array.isArray(searchParams.backend) ? searchParams.backend[0] : searchParams.backend;
  if (value === "cdp" || value === "neko" || value === "neko-remote-cdp") {
    return value;
  }
  return null;
}

function getStreamDebug(searchParams: { stream_debug?: string | string[] }): string | null {
  const value = Array.isArray(searchParams.stream_debug) ? searchParams.stream_debug[0] : searchParams.stream_debug;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isStreamPlaygroundEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.PDPP_ENABLE_STREAM_PLAYGROUND === "1";
}

async function getPlaygroundSession(
  backend: PlaygroundBackend | null,
  streamDebug: string | null
): Promise<PlaygroundSessionResponse> {
  const asUrl = getAsInternalUrl();
  const params = new URLSearchParams();
  if (backend) {
    params.set("backend", backend);
  }
  if (streamDebug) {
    params.set("stream_debug", streamDebug);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  let response: Response;
  try {
    response = await fetch(
      `${asUrl}/_ref/dev/playground/session${suffix}`,
      await withOwnerSessionCookie({
        cache: "no-store",
        method: "POST",
        // No body: the endpoint either returns the existing playground
        // session or lazy-launches one. The backend is selected via query so
        // this works through strict JSON body parsers and simple proxies.
      })
    );
  } catch (err) {
    throw new ReferenceServerUnreachableError(`Cannot reach authorization server at ${asUrl}`, err);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`stream playground session failed (${response.status}): ${body}`);
  }
  return (await response.json()) as PlaygroundSessionResponse;
}

export default async function StreamPlaygroundPage({
  searchParams,
}: {
  searchParams: Promise<{ backend?: string | string[]; stream_debug?: string | string[] }>;
}) {
  if (!isStreamPlaygroundEnabled()) {
    notFound();
  }

  const params = await searchParams;
  const backend = getBackend(params);
  const streamDebug = getStreamDebug(params);
  let session: PlaygroundSessionResponse;
  try {
    session = await getPlaygroundSession(backend, streamDebug);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-8">
          <ServerUnreachable />
        </main>
      );
    }
    throw err;
  }

  return (
    <StreamSurface
      connector={PLAYGROUND_CONNECTOR}
      interactionId={session.interaction_id}
      interactionKind="manual_action"
      interactionMessage={PLAYGROUND_MESSAGE}
      pollForResolution={false}
      runId={session.run_id}
    />
  );
}
