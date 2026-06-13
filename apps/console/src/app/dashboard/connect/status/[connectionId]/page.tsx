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
          ? "Your import was validated and committed. Review the durable coverage receipt below."
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
    return `/dashboard/connect/manual-upload/${encoded}?connection_id=${encodeURIComponent(status.connection_id)}`;
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

function formatWarnings(warnings: readonly string[]): string | null {
  return warnings.length > 0 ? warnings.join(" ") : null;
}

function formatMediaCoverage(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "none reported";
  }
  const media = value as {
    attached_media_files?: unknown;
    referenced_media_files?: unknown;
    status?: unknown;
  };
  const status = typeof media.status === "string" ? media.status : "reported";
  const referenced = typeof media.referenced_media_files === "number" ? media.referenced_media_files : null;
  const attached = typeof media.attached_media_files === "number" ? media.attached_media_files : null;
  if (referenced === null && attached === null) {
    return status;
  }
  return `${status} (${displayValue(attached)} attached of ${displayValue(referenced)} referenced)`;
}

type ImportReceipt = NonNullable<ConnectionSetupStatus["import_receipt"]>;

type ImportPhaseState = "current" | "done" | "failed" | "waiting";

interface ImportPhase {
  readonly detail: string;
  readonly label: string;
  readonly state: ImportPhaseState;
}

interface ImportPhaseFacts {
  readonly active: boolean;
  readonly blockedAfterReceive: boolean;
  readonly committed: boolean;
  readonly deduped: boolean;
  readonly failed: boolean;
  readonly fileReceived: boolean;
  readonly inFlight: boolean;
  readonly parsed: boolean;
}

interface ReceiptRow {
  readonly label: string;
  readonly monospace?: boolean;
  readonly value: string | number | null | undefined;
}

function receiptRows(receipt: ImportReceipt): readonly ReceiptRow[] {
  const baseRows: ReceiptRow[] = [
    { label: "Batch", value: receipt.batch_id, monospace: true },
    { label: "File", value: receipt.uploaded_file_name },
    { label: "Receipt status", value: receipt.status },
    { label: "Detected format", value: receipt.detected_format },
    { label: "Parsed records", value: receipt.parsed_count },
    { label: "Accepted", value: receipt.accepted_count },
    { label: "Duplicates", value: receipt.duplicate_count },
    { label: "Skipped", value: receipt.skipped_count },
    { label: "Failed", value: receipt.failed_count },
  ];
  const timelineRows =
    receipt.estimated_points === null && receipt.estimated_segments === null
      ? []
      : [
          { label: "Estimated points", value: receipt.estimated_points },
          { label: "Estimated segments", value: receipt.estimated_segments },
        ];
  const messageRows =
    receipt.estimated_messages === null
      ? []
      : [
          { label: "Estimated messages", value: receipt.estimated_messages },
          { label: "Participants", value: receipt.estimated_participants },
          { label: "Referenced media", value: receipt.estimated_attachments },
        ];
  return [
    ...baseRows,
    ...timelineRows,
    ...messageRows,
    { label: "Media coverage", value: formatMediaCoverage(receipt.media_coverage) },
    { label: "Coverage window", value: formatDateRange(receipt.date_range) },
    { label: "Acquisition method", value: receipt.acquisition_method },
  ];
}

function phaseTone(state: ImportPhaseState): string {
  switch (state) {
    case "done":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700";
    case "current":
      return "border-blue-500/30 bg-blue-500/10 text-blue-700";
    case "failed":
      return "border-destructive/30 bg-destructive/5 text-destructive";
    default:
      return "border-border bg-muted/30 text-muted-foreground";
  }
}

function phaseWord(state: ImportPhaseState): string {
  switch (state) {
    case "done":
      return "Done";
    case "current":
      return "Now";
    case "failed":
      return "Needs attention";
    default:
      return "Waiting";
  }
}

function parsedPhaseState(facts: ImportPhaseFacts): ImportPhaseState {
  if (facts.parsed) {
    return "done";
  }
  if (facts.blockedAfterReceive) {
    return "failed";
  }
  return facts.fileReceived || facts.inFlight ? "current" : "waiting";
}

function dedupedPhaseState(facts: ImportPhaseFacts): ImportPhaseState {
  if (facts.deduped) {
    return "done";
  }
  if (facts.blockedAfterReceive && facts.parsed) {
    return "failed";
  }
  return facts.inFlight && facts.parsed ? "current" : "waiting";
}

function committedPhaseState(facts: ImportPhaseFacts): ImportPhaseState {
  if (facts.committed) {
    return "done";
  }
  if (facts.blockedAfterReceive && facts.deduped) {
    return "failed";
  }
  return facts.inFlight && facts.deduped ? "current" : "waiting";
}

function indexedPhaseState(facts: ImportPhaseFacts): ImportPhaseState {
  if (facts.active) {
    return "done";
  }
  return facts.inFlight && facts.committed ? "current" : "waiting";
}

function healthProjectedPhaseState(facts: ImportPhaseFacts): ImportPhaseState {
  if (facts.active) {
    return "done";
  }
  return facts.failed ? "failed" : "waiting";
}

function importPhaseFacts(status: ConnectionSetupStatus): ImportPhaseFacts {
  const receipt = status.import_receipt;
  const failed = status.setup_state === "first_sync_failed";
  const active = status.setup_state === "active";
  const running = status.setup_state === "first_sync_running";
  const pending = status.setup_state === "first_sync_pending";
  const fileReceived = status.setup_material.present;
  const parsed = Boolean(receipt?.detected_format || receipt?.parsed_count !== null || receipt?.status);
  const deduped = Boolean(
    receipt && (receipt.accepted_count !== null || receipt.duplicate_count !== null || receipt.skipped_count !== null)
  );
  const committed = Boolean(active || receipt?.accepted_count !== null || receipt?.duplicate_count !== null);
  const inFlight = running || pending;
  const blockedAfterReceive = failed && fileReceived;
  return { active, blockedAfterReceive, committed, deduped, failed, fileReceived, inFlight, parsed };
}

function importPhaseProgress(status: ConnectionSetupStatus): readonly ImportPhase[] {
  if (status.setup_kind !== "manual_upload") {
    return [];
  }
  const facts = importPhaseFacts(status);
  return [
    {
      label: "Received",
      detail: facts.fileReceived ? "PDPP captured the file for this import." : "Choose a file to start.",
      state: facts.fileReceived ? "done" : "waiting",
    },
    {
      label: "Parsed",
      detail: facts.parsed
        ? "The connector parser produced safe validation facts."
        : "PDPP has not parsed this file yet.",
      state: parsedPhaseState(facts),
    },
    {
      label: "Deduplicated",
      detail: facts.deduped
        ? "Duplicate and skipped counts are available."
        : "Duplicate checks run before records commit.",
      state: dedupedPhaseState(facts),
    },
    {
      label: "Committed",
      detail: facts.committed
        ? "Accepted records or duplicate-only receipt facts are committed."
        : "Records are not committed yet.",
      state: committedPhaseState(facts),
    },
    {
      label: "Indexed",
      detail: facts.active ? "Committed records are available on owner surfaces." : "Indexing follows commit.",
      state: indexedPhaseState(facts),
    },
    {
      label: "Health projected",
      detail: facts.active
        ? "Connection health and acquisition coverage include this batch."
        : "Coverage updates after commit.",
      state: healthProjectedPhaseState(facts),
    },
  ];
}

function ImportProgressCard({ phases }: { phases: readonly ImportPhase[] }) {
  if (!phases.length) {
    return null;
  }
  return (
    <div className="mt-4 max-w-2xl rounded-md border border-border/80 bg-background p-4" data-testid="import-progress">
      <p className="pdpp-eyebrow text-muted-foreground">Import progress</p>
      <ol className="mt-3 grid gap-2">
        {phases.map((phase) => (
          <li className="grid gap-1 rounded-sm border border-border/70 bg-muted/20 px-3 py-2" key={phase.label}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="pdpp-caption font-medium text-foreground">{phase.label}</span>
              <span className={`pdpp-eyebrow rounded border px-1.5 py-0.5 ${phaseTone(phase.state)}`}>
                {phaseWord(phase.state)}
              </span>
            </div>
            <p className="pdpp-caption text-muted-foreground">{phase.detail}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function CoverageReceiptCard({ receipt }: { receipt: ImportReceipt }) {
  const warning = formatWarnings(receipt.warnings);
  return (
    <div className="mt-4 max-w-2xl rounded-md border border-border/80 bg-background p-4">
      <p className="pdpp-eyebrow text-muted-foreground">Coverage preview</p>
      <h2 className="pdpp-section-title mt-1">What PDPP found</h2>
      <p className="pdpp-caption mt-1 text-muted-foreground">
        This receipt combines parser validation with committed acquisition-batch counts. Repeating the same file returns
        this receipt instead of creating another import.
      </p>
      <dl className="mt-4 grid gap-2">
        {receiptRows(receipt).map((row) => (
          <div className="flex justify-between gap-4" key={row.label}>
            <dt className="pdpp-caption text-muted-foreground">{row.label}</dt>
            <dd className={row.monospace ? "pdpp-caption font-mono" : "pdpp-caption"}>{displayValue(row.value)}</dd>
          </div>
        ))}
      </dl>
      {receipt.remediation ? <p className="pdpp-caption mt-3 text-muted-foreground">{receipt.remediation}</p> : null}
      {warning ? <p className="pdpp-caption mt-3 text-muted-foreground">{warning}</p> : null}
    </div>
  );
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
  const importPhases = importPhaseProgress(status);
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

        <ImportProgressCard phases={importPhases} />

        {status.import_receipt ? <CoverageReceiptCard receipt={status.import_receipt} /> : null}

        <div className="mt-4 flex flex-wrap gap-2">
          {described.tone === "active" ? (
            <Link
              className={buttonVariants({ variant: "default", size: "sm" })}
              href={`/dashboard/records/${encodeURIComponent(status.connector_id)}`}
            >
              View records
            </Link>
          ) : null}
          {status.setup_kind === "manual_upload" && described.tone === "active" ? (
            <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={setupHref(status)}>
              Import another file
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
