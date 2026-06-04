import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { EmptyState } from "@pdpp/operator-ui/components/empty-state";
import { Callout, DataList, MetaPill, PageHeader, Section, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { formatConnectorKeyForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import Link from "next/link";
import { Button } from "@/components/ui/button.tsx";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
import { formatSourceOutboxState } from "../lib/connection-evidence.ts";
import {
  BROWSER_BOUND_RUNBOOK_PATH,
  isBrowserBoundConnector,
  isSupportedBrowserCollectorConnector,
  isSupportedLocalCollectorConnector,
} from "../lib/connection-modality.ts";
import { getReferencePublicOrigin, ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  type DeviceExporter,
  type DeviceSourceInstance,
  listDeviceExporterDiagnostics,
  listDeviceExporterSourceInstances,
} from "../lib/ref-client.ts";
import { revokeDeviceExporterAction } from "./actions.ts";
import { EnrollmentForm } from "./enrollment-form.tsx";
import {
  classifyHeartbeatFreshness,
  formatLastError,
  formatRelativeTime,
  sourceLabel,
  summarizeIngestCounts,
} from "./render.ts";

export const metadata = {
  title: "Local device exporters",
};

const DEVICE_STATUS_VOCABULARY = {
  active: { label: "active", tone: "success" },
  revoked: { label: "revoked", tone: "danger" },
  stale: { label: "stale", tone: "warning" },
  never: { label: "no heartbeat", tone: "warning" },
  fresh: { label: "fresh", tone: "success" },
} as const;

export default async function DeviceExportersPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The records-list "Add a connection" entry point deep-links here with
  // `?connector=claude_code` / `codex` for one-click local collectors, or
  // `?connector=amazon` for the supported manual browser_collector proof path.
  // Validate against those supported sets before prefilling so arbitrary values
  // never land in the form; an absent/invalid value leaves the field empty.
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const connectorParam = resolvedSearchParams?.connector;
  const requestedConnector = Array.isArray(connectorParam) ? connectorParam[0] : connectorParam;
  const defaultConnectorId =
    isSupportedLocalCollectorConnector(requestedConnector) || isSupportedBrowserCollectorConnector(requestedConnector)
      ? requestedConnector
      : undefined;
  const browserCollectorRequest = isSupportedBrowserCollectorConnector(requestedConnector) ? requestedConnector : null;
  // A deep-link to an unsupported *browser-bound* connector is an intentful
  // request this page cannot generate commands for yet. Detect that case via the
  // shared modality classifier (no scattered key checks) and surface an honest
  // notice that names the connector and points at the owner-run runbook — never a
  // faked enroll flow.
  const browserBoundRequest =
    !defaultConnectorId && isBrowserBoundConnector(requestedConnector) ? (requestedConnector as string) : undefined;

  // When the owner arrives here from the "Add connection" picker (a validated
  // `?connector=` deep-link), frame the page as finishing the connector they
  // chose — a "Connections / Add <Connector>" breadcrumb — instead of the bare
  // diagnostics-console header. The breadcrumb is only shown for a connector key
  // already validated against the supported sets, so it never names an arbitrary
  // value. The bare page (no deep-link) keeps its existing diagnostics framing.
  const addConnectionBreadcrumbs = defaultConnectorId
    ? [
        { label: "Connections", href: "/dashboard/records" },
        { label: `Add ${formatConnectorKeyForDisplay(defaultConnectorId)}` },
      ]
    : undefined;

  try {
    const [diagnostics, sourceInstances, referenceBaseUrl] = await Promise.all([
      listDeviceExporterDiagnostics(),
      listDeviceExporterSourceInstances(),
      getReferencePublicOrigin(),
    ]);
    const devices = diagnostics.data;

    return (
      <DashboardShell active="device-exporters">
        <PageHeader
          breadcrumbs={addConnectionBreadcrumbs}
          count={`${devices.length}`}
          description="Reference-experimental diagnostics for local collector agents. The device or host supervisor decides when local collectors run; the server owns enrollment, ingestion, state, health, and advisory freshness/run signals."
          meta={
            <>
              <MetaPill label="surface" tone="protocol" value="reference-experimental" />
              <MetaPill label="source instances" value={sourceInstances.data.length} />
            </>
          }
          title="Local device exporters"
        />

        {browserCollectorRequest ? <BrowserCollectorEnrollmentNotice connectorId={browserCollectorRequest} /> : null}
        {browserBoundRequest ? <BrowserBoundEnrollmentNotice connectorId={browserBoundRequest} /> : null}

        <Section>
          <EnrollmentForm defaultConnectorId={defaultConnectorId} referenceBaseUrl={referenceBaseUrl} />
        </Section>

        <Section
          description="Server-side registration, ingestion, health, diagnostics, and per-connection source identity. Run cadence remains local-supervisor owned."
          title="Enrolled devices"
        >
          {devices.length === 0 ? (
            <EmptyState
              hint="Create an enrollment code, run a local collector from a host supervisor or shell, then refresh this page after its first heartbeat."
              title="No local device exporters enrolled"
            />
          ) : (
            <DataList ariaLabel="Local device exporters">
              {devices.map((device) => (
                <DeviceRow device={device} key={device.device_id} />
              ))}
            </DataList>
          )}
        </Section>
      </DashboardShell>
    );
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="device-exporters">
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }
}

/**
 * Honest notice for a supported manual browser-collector connector deep-link.
 *
 * Amazon can mint a `browser_collector` enrollment code through the same
 * device-exporter route the runbook documents. This is still not a one-click
 * browser-bound flow: after code minting, the owner runs the monorepo browser
 * collector from a host with a real logged-in browser session. The notice names
 * that boundary so the prefilled form is discoverable without over-claiming.
 */
function BrowserCollectorEnrollmentNotice({ connectorId }: { connectorId: string }) {
  return (
    <Callout
      className="mb-4"
      description={`${formatConnectorKeyForDisplay(connectorId)} can mint a browser_collector enrollment code here. Complete the run from a local PDPP monorepo checkout with a real, owner-logged-in browser session.`}
      surface="human"
      title="Manual browser-collector setup"
    >
      <p className="pdpp-caption text-muted-foreground">
        The connector id is prefilled below. After creating the code, use the generated monorepo commands and follow{" "}
        <code className="pdpp-eyebrow font-mono text-foreground" data-testid="browser-bound-runbook-path">
          {BROWSER_BOUND_RUNBOOK_PATH}
        </code>
        . The console still does not advertise a one-click browser flow; provider login and 2FA stay local to the owner.
      </p>
    </Callout>
  );
}

/**
 * Honest notice for a browser-bound connector deep-link that has no generated
 * console setup path yet.
 */
function BrowserBoundEnrollmentNotice({ connectorId }: { connectorId: string }) {
  return (
    <Callout
      className="mb-4"
      description={`${formatConnectorKeyForDisplay(connectorId)} is a browser-bound source, but this console does not have a generated setup path for it yet. It needs a real, owner-logged-in browser session that you run locally with the browser collector.`}
      surface="human"
      title="This connector is not generated here yet"
    >
      <p className="pdpp-caption text-muted-foreground">
        The browser-collector procedure (so far proven against one connector) is documented in{" "}
        <code className="pdpp-eyebrow font-mono text-foreground" data-testid="browser-bound-runbook-path">
          {BROWSER_BOUND_RUNBOOK_PATH}
        </code>
        . The console does not yet offer a generated setup flow for this connector; see the full add-connection guidance
        on the{" "}
        <Link className="underline underline-offset-2 hover:text-foreground" href="/dashboard/records">
          Connections
        </Link>{" "}
        page.
      </p>
    </Callout>
  );
}

function DeviceRow({ device }: { device: DeviceExporter }) {
  const heartbeat = classifyHeartbeatFreshness(device.last_heartbeat_at, device.stale);
  const counts = summarizeIngestCounts(device);
  const visibleStatus = device.status === "revoked" ? "revoked" : heartbeat;

  return (
    <li className="py-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="pdpp-title text-foreground">{device.display_name || device.device_id}</h2>
            <StatusBadge status={device.status} vocabulary={DEVICE_STATUS_VOCABULARY} />
            <StatusBadge status={visibleStatus} vocabulary={DEVICE_STATUS_VOCABULARY} />
          </div>
          <div className="pdpp-caption mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1">
              device
              <code className="max-w-[20rem] truncate font-mono text-foreground/80">{device.device_id}</code>
              <CopyButton ariaLabel={`Copy ${device.device_id}`} value={device.device_id} />
            </span>
            <span>created {formatRelativeTime(device.created_at)}</span>
            <span>heartbeat {formatRelativeTime(device.last_heartbeat_at)}</span>
            <span>last ingest {formatRelativeTime(device.last_ingest_at)}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <MetaPill label="accepted" tone="success" value={counts.accepted} />
            <MetaPill label="rejected" tone={counts.rejected > 0 ? "danger" : "neutral"} value={counts.rejected} />
            <MetaPill label="sources" value={device.source_instances.length} />
            <MetaPill
              label="last error"
              tone={formatLastError(device.last_error) === "none" ? "neutral" : "danger"}
              value={formatLastError(device.last_error)}
            />
          </div>
        </div>

        {device.status === "active" ? (
          <form action={revokeDeviceExporterAction}>
            <input name="device_id" type="hidden" value={device.device_id} />
            <Button size="sm" type="submit" variant="destructive">
              Revoke
            </Button>
          </form>
        ) : (
          <span className="pdpp-caption text-muted-foreground">Revoked {formatRelativeTime(device.revoked_at)}</span>
        )}
      </div>

      {device.source_instances.length > 0 ? (
        <ul className="mt-4 grid gap-2 lg:grid-cols-2">
          {device.source_instances.map((source) => (
            <SourceInstanceCard key={source.source_instance_id} source={source} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SourceInstanceCard({ source }: { source: DeviceSourceInstance }) {
  const lastError = formatLastError(source.last_error);
  const outbox = formatSourceOutboxState(source);
  // `source_instance_id` identifies the device-side binding row; the durable
  // server-side connection identity is `connector_instance_id`. Surface both
  // honestly: the records dashboard, schedules, and ref API key on
  // connector_instance_id, so that is the value worth copying into URLs.
  const recordsHref = source.connector_instance_id
    ? `/dashboard/records/${encodeURIComponent(source.connector_instance_id)}`
    : null;

  return (
    <li className="rounded-md border border-border/70 bg-muted/20 p-3">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h3 className="pdpp-body truncate font-medium text-foreground">{sourceLabel(source)}</h3>
          <p className="pdpp-caption truncate text-muted-foreground">
            {formatConnectorKeyForDisplay(source.connector_id)} / {source.local_binding_name}
          </p>
          {source.connector_instance_id ? (
            <p className="pdpp-caption mt-1 flex min-w-0 items-center gap-1 text-muted-foreground">
              connection
              <code className="truncate font-mono text-foreground/80">{source.connector_instance_id}</code>
              <CopyButton ariaLabel={`Copy ${source.connector_instance_id}`} value={source.connector_instance_id} />
              {recordsHref ? (
                <Link className="ml-1 underline-offset-2 hover:underline" href={recordsHref}>
                  Records →
                </Link>
              ) : null}
            </p>
          ) : (
            <p
              className="pdpp-caption mt-1 flex min-w-0 items-center gap-1 text-muted-foreground"
              data-testid="source-no-connector-instance"
              title="This device source has not yet been bound to a connector instance on the server."
            >
              connection: not bound yet
            </p>
          )}
          <p className="pdpp-caption flex min-w-0 items-center gap-1 text-muted-foreground">
            source
            <code className="truncate font-mono text-foreground/80">{source.source_instance_id}</code>
            <CopyButton ariaLabel={`Copy ${source.source_instance_id}`} value={source.source_instance_id} />
          </p>
        </div>
        <span className="pdpp-caption text-muted-foreground">ingest {formatRelativeTime(source.last_ingest_at)}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <MetaPill label="accepted" tone="success" value={source.accepted_record_count ?? 0} />
        <MetaPill
          label="rejected"
          tone={(source.rejected_record_count ?? 0) > 0 ? "danger" : "neutral"}
          value={source.rejected_record_count ?? 0}
        />
        <MetaPill label="last error" tone={lastError === "none" ? "neutral" : "danger"} value={lastError} />
        <MetaPill label="outbox" tone={outbox.tone} value={outbox.label.replace("Outbox · ", "")} />
      </div>
    </li>
  );
}
