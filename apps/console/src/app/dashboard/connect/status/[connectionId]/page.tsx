import { Callout, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button.tsx";
import { DashboardShell } from "../../../components/shell.tsx";
import { type ConnectionSetupStatus, getConnectionSetupStatus, RefNotFoundError } from "../../../lib/ref-client.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  connectionId: string;
}

interface PageSearchParams {
  identity?: string;
  run_id?: string;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface StatusDescription {
  detail: string;
  headline: string;
  tone: "active" | "failed" | "pending";
}

function describeImportState(status: ConnectionSetupStatus): StatusDescription {
  switch (status.setup_state) {
    case "active":
      return {
        tone: "active",
        headline: "Import complete",
        detail: status.import_receipt
          ? "Your import was validated and committed. Review what PDPP found below; these are parser estimates until durable acquisition-batch receipts land."
          : "Your import was committed. This connector did not provide a validation preview for the setup receipt.",
      };
    case "first_sync_running":
      return {
        tone: "pending",
        headline: "Import running",
        detail: "The import file is captured and the import is in progress. This page updates as it finishes.",
      };
    case "first_sync_pending":
      return {
        tone: "pending",
        headline: "Import starting",
        detail: "The import file is captured and the import is queued. This page updates as it runs.",
      };
    case "awaiting_credential":
      return {
        tone: "pending",
        headline: "File needed",
        detail: "This source is set up but no import file is captured yet.",
      };
    case "first_sync_failed":
      return {
        tone: "failed",
        headline: "Import failed",
        detail: status.last_error?.remediation ?? "Start the import again.",
      };
    case "paused":
      return { tone: "pending", headline: "Connection paused", detail: "This connection is paused." };
    case "revoked":
      return { tone: "failed", headline: "Connection revoked", detail: "This connection has been revoked." };
    default:
      return {
        tone: "pending",
        headline: "Setting up",
        detail: "This connection is being set up. This page updates as the setup progresses.",
      };
  }
}

function describeConnectionState(status: ConnectionSetupStatus): StatusDescription {
  switch (status.setup_state) {
    case "active":
      return {
        tone: "active",
        headline: "Connection active",
        detail: "The first sync accepted records. This account is now a working connection.",
      };
    case "first_sync_running":
      return {
        tone: "pending",
        headline: "First sync running",
        detail:
          "The provider credential is captured and the first sync is in progress. This page updates as it finishes.",
      };
    case "first_sync_pending":
      return {
        tone: "pending",
        headline: "First sync starting",
        detail: "The provider credential is captured and the first sync is queued. This page updates as it runs.",
      };
    case "awaiting_credential":
      return {
        tone: "pending",
        headline: "Setup material needed",
        detail: "This connection is set up but no provider credential is captured yet.",
      };
    case "first_sync_failed":
      return {
        tone: "failed",
        headline: "First sync failed",
        detail: status.last_error?.remediation ?? "Start the first sync again.",
      };
    case "paused":
      return { tone: "pending", headline: "Connection paused", detail: "This connection is paused." };
    case "revoked":
      return { tone: "failed", headline: "Connection revoked", detail: "This connection has been revoked." };
    default:
      return {
        tone: "pending",
        headline: "Setting up",
        detail: "This connection is being set up. This page updates as the setup progresses.",
      };
  }
}

function describeState(status: ConnectionSetupStatus): StatusDescription {
  return status.setup_kind === "manual_upload" ? describeImportState(status) : describeConnectionState(status);
}

function setupHref(status: ConnectionSetupStatus): string {
  const encoded = encodeURIComponent(status.connector_id);
  if (status.setup_kind === "manual_upload") {
    return `/dashboard/connect/manual-upload/${encoded}`;
  }
  return `/dashboard/connect/static-secret/${encoded}`;
}

function retryLabel(status: ConnectionSetupStatus): string {
  return status.setup_kind === "manual_upload" ? "Choose another file and retry" : "Re-enter credential and retry";
}

function displayValue(value: string | number | null | undefined): string {
  if (typeof value === "number") {
    return new Intl.NumberFormat("en-US").format(value);
  }
  return value && value.length > 0 ? value : "unknown";
}

function formatDateRange(range: NonNullable<ConnectionSetupStatus["import_receipt"]>["date_range"]): string {
  if (!range) {
    return "unknown";
  }
  const start = range.start ?? "unknown";
  const end = range.end ?? "unknown";
  if (start === end) {
    return start;
  }
  return `${start} to ${end}`;
}

export default async function ConnectionSetupStatusPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectionId: rawConnectionId } = await params;
  const connectionId = decodeURIComponent(rawConnectionId);
  const resolvedSearchParams = await searchParams;
  const pageParams: PageSearchParams = {
    identity: firstValue(resolvedSearchParams.identity),
    run_id: firstValue(resolvedSearchParams.run_id),
  };

  const status = await getConnectionSetupStatus(connectionId, pageParams.run_id ?? null).catch((err) => {
    if (err instanceof RefNotFoundError) {
      notFound();
    }
    throw err;
  });

  const accountIdentity = status.account_identity ?? pageParams.identity ?? null;
  const described = describeState(status);
  const title = accountIdentity
    ? `${status.display_name ?? status.connector_id} · ${accountIdentity}`
    : (status.display_name ?? status.connector_id);
  const refreshQuery = pageParams.run_id ? `?${new URLSearchParams({ run_id: pageParams.run_id }).toString()}` : "";
  const refreshHref = `/dashboard/connect/status/${encodeURIComponent(connectionId)}${refreshQuery}`;

  return (
    <DashboardShell active="records">
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} href="/dashboard/records">
            Back to Sources
          </Link>
        }
        breadcrumbs={[{ href: "/dashboard/records", label: "Sources" }, { label: "Setup status" }]}
        description="This is the durable status for the account or import you just submitted. Bookmark or revisit it any time."
        title={title}
      />

      <Section description={described.detail} title={described.headline}>
        <dl className="grid max-w-2xl gap-2 rounded-md border border-border/80 bg-muted/20 p-4">
          {accountIdentity ? (
            <div className="flex justify-between gap-4">
              <dt className="pdpp-caption text-muted-foreground">Connected as</dt>
              <dd className="pdpp-caption">{accountIdentity}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4">
            <dt className="pdpp-caption text-muted-foreground">Connection</dt>
            <dd className="pdpp-caption font-mono">{status.connection_id}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="pdpp-caption text-muted-foreground">Status</dt>
            <dd className="pdpp-caption">{status.status}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="pdpp-caption text-muted-foreground">Setup state</dt>
            <dd className="pdpp-caption">{status.setup_state}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="pdpp-caption text-muted-foreground">{status.setup_material.label}</dt>
            <dd className="pdpp-caption">{status.setup_material.present ? "captured" : "not captured"}</dd>
          </div>
          {status.run?.run_id ? (
            <div className="flex justify-between gap-4">
              <dt className="pdpp-caption text-muted-foreground">Run</dt>
              <dd className="pdpp-caption">
                <Link
                  className="font-mono underline underline-offset-2 hover:text-foreground"
                  href={`/dashboard/runs/${encodeURIComponent(status.run.run_id)}`}
                >
                  {status.run.run_id}
                </Link>{" "}
                {status.run.status ? `(${status.run.status})` : null}
              </dd>
            </div>
          ) : null}
        </dl>

        {status.import_receipt ? (
          <div className="mt-4 max-w-2xl rounded-md border border-border/80 bg-background p-4">
            <p className="pdpp-eyebrow text-muted-foreground">Coverage preview</p>
            <h2 className="pdpp-section-title mt-1">What PDPP found</h2>
            <p className="pdpp-caption mt-1 text-muted-foreground">
              These are validation estimates from the import file. The full accepted, duplicate, skipped, and failed
              counts will belong to the acquisition-batch receipt tranche.
            </p>
            <dl className="mt-4 grid gap-2">
              <div className="flex justify-between gap-4">
                <dt className="pdpp-caption text-muted-foreground">File</dt>
                <dd className="pdpp-caption">{displayValue(status.import_receipt.uploaded_file_name)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="pdpp-caption text-muted-foreground">Validation</dt>
                <dd className="pdpp-caption">{displayValue(status.import_receipt.status)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="pdpp-caption text-muted-foreground">Detected format</dt>
                <dd className="pdpp-caption">{displayValue(status.import_receipt.detected_format)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="pdpp-caption text-muted-foreground">Estimated points</dt>
                <dd className="pdpp-caption">{displayValue(status.import_receipt.estimated_points)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="pdpp-caption text-muted-foreground">Estimated segments</dt>
                <dd className="pdpp-caption">{displayValue(status.import_receipt.estimated_segments)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="pdpp-caption text-muted-foreground">Coverage window</dt>
                <dd className="pdpp-caption">{formatDateRange(status.import_receipt.date_range)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="pdpp-caption text-muted-foreground">Acquisition method</dt>
                <dd className="pdpp-caption">{displayValue(status.import_receipt.acquisition_method)}</dd>
              </div>
            </dl>
            {status.import_receipt.remediation ? (
              <p className="pdpp-caption mt-3 text-muted-foreground">{status.import_receipt.remediation}</p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          {described.tone === "active" ? (
            <Link
              className={buttonVariants({ variant: "default", size: "sm" })}
              href={`/dashboard/records/${encodeURIComponent(status.connector_id)}`}
            >
              View records
            </Link>
          ) : null}
          {described.tone === "failed" || status.setup_state === "awaiting_credential" ? (
            <Link className={buttonVariants({ variant: "default", size: "sm" })} href={setupHref(status)}>
              {retryLabel(status)}
            </Link>
          ) : null}
          {described.tone === "pending" && status.setup_state !== "awaiting_credential" ? (
            <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={refreshHref}>
              Refresh status
            </Link>
          ) : null}
        </div>
      </Section>

      {status.last_error ? (
        <Callout className="mt-5" description={status.last_error.remediation} title={described.headline} tone="warning">
          <p className="pdpp-caption text-callout-warning-fg/80">Reason: {status.last_error.reason}</p>
        </Callout>
      ) : null}
    </DashboardShell>
  );
}
