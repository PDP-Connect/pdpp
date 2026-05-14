import type { Viewport } from "next";
import { notFound } from "next/navigation";
import { ServerUnreachable } from "../../../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../../../lib/owner-token.ts";
import {
  getRunTimeline,
  listConnectorSummaries,
  type SpineEvent,
  type TimelineEnvelope,
} from "../../../lib/ref-client.ts";
import { getCurrentBrowserSurfaceAssistance } from "../../../lib/run-assistance.ts";
import { ResolvedSurface, StreamSurface } from "./stream-viewer.tsx";

export const dynamic = "force-dynamic";
export const viewport: Viewport = {
  initialScale: 1,
  interactiveWidget: "overlays-content",
  viewportFit: "cover",
  width: "device-width",
};

interface ConnectorContext {
  connectorId: string;
  displayName: string;
}

function getConnectorIdFromTimeline(events: SpineEvent[]): string | null {
  const fromRuntime = events.find((e) => e.actor_type === "runtime")?.actor_id ?? null;
  if (fromRuntime) {
    return fromRuntime;
  }
  for (const ev of events) {
    const candidate = (ev.data as { connector_id?: unknown } | null)?.connector_id;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

function deriveConnectorSlug(connectorId: string): string {
  try {
    const url = new URL(connectorId);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? url.hostname;
  } catch {
    return connectorId;
  }
}

async function resolveConnectorContext(connectorId: string | null): Promise<ConnectorContext | null> {
  if (!connectorId) {
    return null;
  }
  try {
    const summaries = await listConnectorSummaries();
    const match = summaries.data.find((c) => c.connector_id === connectorId);
    return {
      connectorId,
      displayName: match?.display_name ?? deriveConnectorSlug(connectorId),
    };
  } catch {
    return {
      connectorId,
      displayName: deriveConnectorSlug(connectorId),
    };
  }
}

export default async function RunInteractionStreamPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ _preview?: string; _state?: string }>;
}) {
  const { runId: raw } = await params;
  const runId = decodeURIComponent(raw);
  const sp = await searchParams;

  // Dev preview bypass: render the visual surface without a real run.
  // `?_preview=1`                  → orientation card with synthetic Strava context.
  // `?_preview=1&_state=resolved`  → success state.
  // `?_preview=1&_state=task`      → orientation card with the Stage-2 overlay open on mount,
  //                                  so the modal layout can be reviewed in isolation.
  if (sp._preview === "1" && process.env.NODE_ENV !== "production") {
    const previewConnector: ConnectorContext = {
      connectorId: "https://example.com/connectors/strava",
      displayName: "Strava",
    };
    if (sp._state === "resolved") {
      return <ResolvedSurface connector={previewConnector} />;
    }
    return (
      <StreamSurface
        autoOpen={sp._state === "task"}
        connector={previewConnector}
        interactionId="preview-interaction"
        interactionKind="manual_action"
        interactionMessage="Strava is asking you to confirm a 2FA code from your Authenticator app. Enter the six-digit code in the browser below to let collection continue."
        runId={runId}
      />
    );
  }

  let envelope: TimelineEnvelope | null;
  try {
    envelope = await getRunTimeline(runId, { cursor: null });
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
  if (!envelope) {
    notFound();
    return null;
  }

  const streamableAssistance = getCurrentBrowserSurfaceAssistance(envelope.events);
  const connectorId = getConnectorIdFromTimeline(envelope.events);
  const connector = await resolveConnectorContext(connectorId);

  if (!streamableAssistance) {
    return <ResolvedSurface connector={connector} />;
  }

  return (
    <StreamSurface
      connector={connector}
      interactionId={streamableAssistance.id}
      interactionKind="manual_action"
      interactionMessage={streamableAssistance.message}
      runId={runId}
    />
  );
}
