import { buttonVariants } from "@pdpp/brand-react";
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
  hasActiveBrowserSurface,
  requiresBrowserSurfaceAssistance,
} from "../../../lib/run-assistance.ts";
import { NoAssistanceRunPoller } from "./no-assistance-run-poller.tsx";
import {
  type NoAssistanceEndedStatus,
  resolveNoAssistanceEndedTerminalStatus,
  selectNoAssistanceStreamState,
} from "./stream-state.ts";
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

function RunDetailLink({ children, runId }: { children: string; runId: string }) {
  return (
    <a className={buttonVariants({ variant: "default", size: "sm", className: "mt-5" })} href={`/syncs/${encodeURIComponent(runId)}`}>
      {children}
    </a>
  );
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

function getConnectorInstanceIdFromTimeline(events: SpineEvent[]): string | null {
  for (const ev of events) {
    const data = ev.data as {
      connection_id?: unknown;
      connector_instance_id?: unknown;
      source?: { connection_id?: unknown } | null;
    } | null;
    const candidates = [data?.connector_instance_id, data?.connection_id, data?.source?.connection_id];
    const match = candidates.find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0
    );
    if (match) {
      return match;
    }
  }
  return null;
}

async function resolveConnectorContext(
  connectorId: string | null,
  connectorInstanceId: string | null
): Promise<ConnectorContext | null> {
  if (!connectorId) {
    return null;
  }
  try {
    const summaries = await listConnectorSummaries();
    const instanceMatch = connectorInstanceId
      ? summaries.data.find(
          (c) =>
            c.connector_id === connectorId &&
            (c.connector_instance_id === connectorInstanceId || c.connection_id === connectorInstanceId)
        )
      : null;
    const match = instanceMatch ?? summaries.data.find((c) => c.connector_id === connectorId);
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

function renderNoAssistanceSurface({
  connector,
  currentAssistance,
  envelope,
  runId,
  runStatus,
}: {
  connector: ConnectorContext | null;
  currentAssistance: ReturnType<typeof getCurrentRunAssistance>;
  envelope: TimelineEnvelope;
  runId: string;
  runStatus: RunStatusEnvelope | null;
}) {
  if (currentAssistance && requiresBrowserSurfaceAssistance(currentAssistance)) {
    return <UnavailableStreamSurface connector={connector} runId={runId} />;
  }
  if (currentAssistance?.ownerAction === "act_elsewhere" && currentAssistance.responseContract === "none") {
    return <ExternalApprovalSurface assistance={currentAssistance} connector={connector} runId={runId} />;
  }
  const noAssistanceState = selectNoAssistanceStreamState({
    runHandleStatus: runStatus?.status ?? null,
    terminalStatus: envelope.terminal_status,
  });
  if (noAssistanceState === "resolved") {
    return <ResolvedSurface connector={connector} runId={runId} />;
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
  if (hasActiveBrowserSurface(envelope.events)) {
    return <PreparingBrowserSurface connector={connector} runId={runId} />;
  }
  return <RunContinuingSurface connector={connector} runId={runId} />;
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
      return <ResolvedSurface connector={previewConnector} runId={runId} />;
    }
    return (
      <StreamSurface
        autoOpen={sp._state === "task"}
        connector={previewConnector}
        interactionId="preview-interaction"
        interactionKind="manual_action"
        interactionMessage="Strava is asking you to confirm a 2FA code from your Authenticator app. Enter the six-digit code in the browser below to let collection continue."
        interactionRequiresResponse
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
  const connectorInstanceId = runStatus?.connector_instance_id ?? getConnectorInstanceIdFromTimeline(envelope.events);
  const connector = await resolveConnectorContext(connectorId, connectorInstanceId);

  if (!streamableAssistance) {
    return renderNoAssistanceSurface({ connector, currentAssistance, envelope, runId, runStatus });
  }

  return (
    <StreamSurface
      connector={connector}
      interactionId={streamableAssistance.id}
      interactionKind="manual_action"
      interactionMessage={streamableAssistance.message}
      interactionRequiresResponse={streamableAssistance.responseContract === "response_required"}
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
  terminalStatus: NoAssistanceEndedStatus;
}) {
  const subject = connector?.displayName ?? "This run";
  let statusLabel = "failed";
  let title = `${subject} needs a look.`;
  let description =
    "The browser step is no longer waiting, but the run did not complete successfully. Open the run timeline for the exact failure and next action.";
  let sectionClass = "rounded-3xl border border-destructive/30 bg-destructive/5 p-6 shadow-2xl shadow-black/10";
  if (terminalStatus === "cancelled") {
    statusLabel = "cancelled";
  } else if (terminalStatus === "abandoned") {
    statusLabel = "stopped";
  } else if (terminalStatus === "deferred") {
    statusLabel = "browser deferred";
    title = "Secure browser slot unavailable.";
    description = `${subject} waited for a secure browser slot, but capacity stayed full. No connector work started. Retry when a browser slot is available.`;
    sectionClass = "rounded-3xl border border-border bg-card p-6 shadow-2xl shadow-black/10";
  }
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-8">
      <section className={sectionClass}>
        <p className="pdpp-eyebrow text-muted-foreground">run {statusLabel}</p>
        <h1 className="pdpp-heading mt-3 text-balance text-foreground">{title}</h1>
        <p className="mt-3 text-muted-foreground text-sm leading-6">{description}</p>
        <RunDetailLink runId={runId}>Open run timeline</RunDetailLink>
      </section>
    </main>
  );
}

function RunContinuingSurface({ connector, runId }: { connector: ConnectorContext | null; runId: string }) {
  const subject = connector?.displayName ?? "This run";
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-8">
      <section className="rounded-3xl border border-border bg-card p-6 shadow-2xl shadow-black/10">
        <NoAssistanceRunPoller runId={runId} />
        <p className="pdpp-eyebrow text-muted-foreground">run continuing</p>
        <h1 className="pdpp-heading mt-3 text-balance text-foreground">No browser action is waiting.</h1>
        <p className="mt-3 text-muted-foreground text-sm leading-6">
          {subject} is still being checked. Open the run timeline to follow the latest status.
        </p>
        <RunDetailLink runId={runId}>Open run timeline</RunDetailLink>
      </section>
    </main>
  );
}

function PreparingBrowserSurface({ connector, runId }: { connector: ConnectorContext | null; runId: string }) {
  const subject = connector?.displayName ?? "This run";
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-8">
      <section className="rounded-3xl border border-border bg-card p-6 shadow-2xl shadow-black/10">
        <NoAssistanceRunPoller runId={runId} />
        <p className="pdpp-eyebrow text-muted-foreground">secure browser starting</p>
        <h1 className="pdpp-heading mt-3 text-balance text-foreground">Preparing the secure browser.</h1>
        <p className="mt-3 text-muted-foreground text-sm leading-6">
          {subject} has started a browser-session repair. This page will open the browser controls as soon as the run
          asks for your input.
        </p>
        <RunDetailLink runId={runId}>Open run timeline</RunDetailLink>
      </section>
    </main>
  );
}

function ExternalApprovalSurface({
  assistance,
  connector,
  runId,
}: {
  assistance: NonNullable<ReturnType<typeof getCurrentRunAssistance>>;
  connector: ConnectorContext | null;
  runId: string;
}) {
  const subject = connector?.displayName ?? "This run";
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-8">
      <section className="rounded-3xl border border-border bg-card p-6 shadow-2xl shadow-black/10">
        <NoAssistanceRunPoller runId={runId} />
        <p className="pdpp-eyebrow text-muted-foreground">approval waiting</p>
        <h1 className="pdpp-heading mt-3 text-balance text-foreground">Approve the prompt outside PDPP.</h1>
        <p className="mt-3 text-muted-foreground text-sm leading-6">{assistance.message}</p>
        <p className="mt-3 text-muted-foreground text-sm leading-6">
          {subject} will continue automatically after the provider confirms the approval. No browser controls are waiting
          on this page.
        </p>
        <RunDetailLink runId={runId}>Open run timeline</RunDetailLink>
      </section>
    </main>
  );
}

function UnavailableStreamSurface({ connector, runId }: { connector: ConnectorContext | null; runId: string }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-8">
      <section className="rounded-3xl border border-[color:var(--warning)] bg-[color:var(--warning-wash)] p-6 shadow-2xl shadow-black/10">
        <NoAssistanceRunPoller runId={runId} />
        <p className="pdpp-eyebrow text-muted-foreground">stream unavailable</p>
        <h1 className="pdpp-heading mt-3 text-balance text-foreground">Waiting for a browser surface</h1>
        <p className="mt-3 text-muted-foreground text-sm leading-6">
          {connector ? `${connector.displayName} needs browser control, but ` : "This run needs browser control, but "}
          no current stream target is registered for this assistance request. Keep the run open while the runtime
          registers a browser surface, then return to the run detail page.
        </p>
        <RunDetailLink runId={runId}>Back to run detail</RunDetailLink>
      </section>
    </main>
  );
}
