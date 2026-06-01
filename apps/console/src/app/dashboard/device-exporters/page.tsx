import Link from "next/link";
import { Button } from "@/components/ui/button.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { DataList, MetaPill, PageHeader, Section, StatusBadge } from "../components/primitives.tsx";
import { DashboardShell, EmptyState, ServerUnreachable } from "../components/shell.tsx";
import { formatSourceOutboxState } from "../lib/connection-evidence.ts";
import { isSupportedLocalCollectorConnector } from "../lib/connection-modality.ts";
import { formatConnectorKeyForDisplay } from "../lib/connector-display.ts";
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
  // `?connector=claude_code` (or `codex`). Validate against the supported
  // local-collector set before prefilling so an arbitrary or unsupported value
  // never lands in the form; an absent/invalid value leaves the field empty.
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const connectorParam = resolvedSearchParams?.connector;
  const requestedConnector = Array.isArray(connectorParam) ? connectorParam[0] : connectorParam;
  const defaultConnectorId = isSupportedLocalCollectorConnector(requestedConnector) ? requestedConnector : undefined;

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
