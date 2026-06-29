import { formatConnectorNameForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import type { Viewport } from "next";
import { notFound } from "next/navigation";
import { ServerUnreachable } from "../../../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../../../lib/owner-token.ts";
import {
  getRunStatus,
  getRunTimeline,
  listConnectorSummaries,
  type RunStatusEnvelope,
  type SpineEvent,
  type TimelineEnvelope,
} from "../../../lib/ref-client.ts";
import {
  getCurrentBrowserSurfaceAssistance,
  getCurrentRunAssistance,
  requiresBrowserSurfaceAssistance,
} from "../../../lib/run-assistance.ts";
import { NoAssistanceRunPoller } from "./no-assistance-run-poller.tsx";
import { resolveNoAssistanceEndedTerminalStatus, selectNoAssistanceStreamState } from "./stream-state.ts";
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

async function resolveConnectorContext(connectorId: string | null): Promise<ConnectorContext | null> {
  if (!connectorId) {
    return null;
  }
  try {
    const summaries = await listConnectorSummaries();
    const match = summaries.data.find((c) => c.connector_id === connectorId);
    return {
      connectorId,
      displayName: formatConnectorNameForDisplay({
        connectorId,
        displayName: match?.display_name,
        name: match?.connector_display_name,
      }),
    };
  } catch {
    return {
      connectorId,
      displayName: formatConnectorNameForDisplay({ connectorId }),
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
  let runStatus: RunStatusEnvelope | null;
  try {
    [envelope, runStatus] = await Promise.all([getRunTimeline(runId, { cursor: null }), getRunStatus(runId)]);
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
  const currentAssistance = getCurrentRunAssistance(envelope.events);
  const connectorId = getConnectorIdFromTimeline(envelope.events);
  const connector = await resolveConnectorContext(connectorId);

  if (!streamableAssistance) {
    if (currentAssistance && requiresBrowserSurfaceAssistance(currentAssistance)) {
      return <UnavailableStreamSurface connector={connector} runId={runId} />;
    }
    const noAssistanceState = selectNoAssistanceStreamState({
      runHandleStatus: runStatus?.status ?? null,
      terminalStatus: envelope.terminal_status,
    });
    if (noAssistanceState === "resolved") {
      return <ResolvedSurface connector={connector} />;
    }
    if (noAssistanceState === "ended") {
      return (
        <RunEndedSurface
          connector={connector}
          runId={runId}
          terminalStatus={resolveNoAssistanceEndedTerminalStatus({
            runHandleStatus: runStatus?.status ?? null,
            terminalStatus: envelope.terminal_status,
          })}
        />
      );
    }
    return <RunContinuingSurface connector={connector} runId={runId} />;
  }

  return (
    <StreamSurface
      connector={connector}
      interactionId={streamableAssistance.id}
      interactionKind={streamableAssistance.kind}
      interactionMessage={streamableAssistance.message}
      runId={runId}
    />
  );
}

function RunEndedSurface({
  connector,
  runId,
  terminalStatus,
}: {
  connector: ConnectorContext | null;
  runId: string;
  terminalStatus: TimelineEnvelope["terminal_status"];
}) {
  const subject = connector?.displayName ?? "This run";
  let statusLabel = "failed";
  if (terminalStatus === "cancelled") {
    statusLabel = "cancelled";
  } else if (terminalStatus === "abandoned") {
    statusLabel = "stopped";
  }
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-8">
      <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 shadow-2xl shadow-black/10">
        <p className="pdpp-eyebrow text-muted-foreground">run {statusLabel}</p>
        <h1 className="pdpp-heading mt-3 text-balance text-foreground">{subject} needs a look.</h1>
        <p className="mt-3 text-muted-foreground text-sm leading-6">
          The browser step is no longer waiting, but the run did not complete successfully. Open the run timeline for
          the exact failure and next action.
        </p>
        <a
          className="mt-5 inline-flex rounded-full bg-foreground px-4 py-2 font-medium text-background text-sm"
          href={`/dashboard/runs/${encodeURIComponent(runId)}`}
        >
          Open run timeline
        </a>
      </section>
    </main>
  );
}

function RunContinuingSurface({ connector, runId }: { connector: ConnectorContext | null; runId: string }) {
  const subject = connector?.displayName ?? "This run";
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-8">
      <section className="rounded-3xl border border-border bg-card p-6 shadow-2xl shadow-black/10">
        <NoAssistanceRunPoller />
        <p className="pdpp-eyebrow text-muted-foreground">run continuing</p>
        <h1 className="pdpp-heading mt-3 text-balance text-foreground">No browser action is waiting.</h1>
        <p className="mt-3 text-muted-foreground text-sm leading-6">
          {subject} is still being checked. Open the run timeline to follow the latest status.
        </p>
        <a
          className="mt-5 inline-flex rounded-full bg-foreground px-4 py-2 font-medium text-background text-sm"
          href={`/dashboard/runs/${encodeURIComponent(runId)}`}
        >
          Open run timeline
        </a>
      </section>
    </main>
  );
}

function UnavailableStreamSurface({ connector, runId }: { connector: ConnectorContext | null; runId: string }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-8">
      <section className="rounded-3xl border border-[color:var(--warning)] bg-[color:var(--warning-wash)] p-6 shadow-2xl shadow-black/10">
        <p className="pdpp-eyebrow text-muted-foreground">stream unavailable</p>
        <h1 className="pdpp-heading mt-3 text-balance text-foreground">Waiting for a browser surface</h1>
        <p className="mt-3 text-muted-foreground text-sm leading-6">
          {connector ? `${connector.displayName} needs browser control, but ` : "This run needs browser control, but "}
          no current stream target is registered for this assistance request. Keep the run open while the runtime
          registers a browser surface, then return to the run detail page.
        </p>
        <a
          className="mt-5 inline-flex rounded-full bg-foreground px-4 py-2 font-medium text-background text-sm"
          href={`/dashboard/runs/${encodeURIComponent(runId)}`}
        >
          Back to run detail
        </a>
      </section>
    </main>
  );
}
