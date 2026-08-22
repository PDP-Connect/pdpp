// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { deriveSourceDisplayNameFallback } from "@pdpp/display";
import { Callout, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { LivePoller } from "../../../components/live-poller.tsx";
import {
  type ConnectionSetupStatus,
  getConnectionSetupStatus,
  RefNotFoundError,
  type StaticSecretSetupStateValue,
} from "../../../lib/ref-client.ts";
import { setupHref, sourceDetailHref, sourceRecordsHref } from "./connect-status-links.ts";

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

const RUN_FAILURE_STATUSES = new Set(["failed", "errored", "error", "cancelled", "canceled", "aborted"]);
const RUN_SUCCESS_STATUSES = new Set(["completed", "succeeded", "success"]);

function timeMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function runStartedAfterCredentialRotation(status: ConnectionSetupStatus): boolean {
  const rotatedAt = timeMs(status.credential.rotated_at);
  const startedAt = timeMs(status.run?.started_at);
  return rotatedAt !== null && startedAt !== null && startedAt >= rotatedAt;
}

function statusRunIsFailure(status: ConnectionSetupStatus): boolean {
  const runStatus = status.run?.status;
  return typeof runStatus === "string" && RUN_FAILURE_STATUSES.has(runStatus);
}

function statusRunIsSuccess(status: ConnectionSetupStatus): boolean {
  const runStatus = status.run?.status;
  return typeof runStatus === "string" && RUN_SUCCESS_STATUSES.has(runStatus);
}

function describeActiveConnectionState(status: ConnectionSetupStatus): StatusDescription {
  if (status.setup_kind === "static_secret" && runStartedAfterCredentialRotation(status)) {
    if (status.running) {
      return {
        detail:
          "A sync is running now to verify the updated credential. Existing records remain available while it runs.",
        headline: "Credential saved",
        tone: "pending",
      };
    }
    if (statusRunIsFailure(status)) {
      return {
        detail:
          "The updated credential was saved, but the verification sync failed. Re-enter it or open the run timeline for the exact failure.",
        headline: "Credential saved, sync failed",
        tone: "failed",
      };
    }
    if (statusRunIsSuccess(status)) {
      return {
        detail: "The updated credential was verified by a completed sync. Records are available.",
        headline: "Connection active",
        tone: "active",
      };
    }
  }
  return {
    detail: "Records are available for this account.",
    headline: "Connection active",
    tone: "active",
  };
}

function describeZeroYieldState(status: ConnectionSetupStatus): StatusDescription {
  let detail = "The first sync finished without saving records. Retry if you expected data.";
  if (status.setup_kind === "browser_session") {
    detail = "The browser run finished without saving records. Start browser setup again if you expected data.";
  } else if (status.setup_kind === "manual_upload") {
    detail = "The import finished without saving records. Choose another file if you expected data.";
  }
  return { detail, headline: "No records collected", tone: "pending" };
}

function describeTerminalSetupDisposition(status: ConnectionSetupStatus): StatusDescription | null {
  switch (status.terminal_setup_disposition) {
    case "verified_empty":
      return {
        detail: "The first sync verified that this source has no records. Review the setup result before trying again.",
        headline: "First sync verified empty",
        tone: "pending",
      };
    case "unverified_missing_counts":
      return {
        detail: "The first sync completed without durable count evidence. Review the connection before retrying.",
        headline: "First sync incomplete",
        tone: "pending",
      };
    case "unverified_zero":
      return {
        detail:
          "The first sync returned zero records without proving the account was empty. Review the connection and retry if you expected data.",
        headline: "No records confirmed",
        tone: "pending",
      };
    default:
      return null;
  }
}

function describeImportState(status: ConnectionSetupStatus): StatusDescription {
  const terminalDisposition = describeTerminalSetupDisposition(status);
  if (terminalDisposition) {
    return terminalDisposition;
  }
  switch (status.setup_state) {
    case "active":
      return {
        detail: status.import_receipt
          ? "Your import was validated and committed. Review the durable coverage receipt below."
          : "Your import was committed. This connector did not provide a validation preview for the setup receipt.",
        headline: "Import complete",
        tone: "active",
      };
    case "first_sync_running":
      return {
        detail: "The import file is captured and the import is running. It will continue automatically.",
        headline: "Import running",
        tone: "pending",
      };
    case "first_sync_pending":
      return {
        detail: "The import file is captured and the import is queued. It will start automatically.",
        headline: "Import starting",
        tone: "pending",
      };
    case "first_sync_zero_yield":
      return describeZeroYieldState(status);
    case "awaiting_credential":
      return {
        detail: "This source is set up but no import file is captured yet.",
        headline: "File needed",
        tone: "pending",
      };
    case "first_sync_failed":
      return {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: the receiver here is a genuinely optional/nullable type per its declared interface; tsc rejects removing this guard.
        detail: status.last_error?.remediation ?? "Start the import again.",
        headline: "Import failed",
        tone: "failed",
      };
    case "paused":
      return { detail: "This connection is paused.", headline: "Connection paused", tone: "pending" };
    case "revoked":
      return { detail: "This connection has been revoked.", headline: "Connection revoked", tone: "failed" };
    default:
      return {
        detail: "This connection is being set up. Setup will continue automatically.",
        headline: "Setting up",
        tone: "pending",
      };
  }
}

function describeConnectionState(status: ConnectionSetupStatus): StatusDescription {
  const terminalDisposition = describeTerminalSetupDisposition(status);
  if (terminalDisposition) {
    return terminalDisposition;
  }
  switch (status.setup_state) {
    case "active":
      return describeActiveConnectionState(status);
    case "first_sync_running":
      return {
        detail: "The provider credential is captured and the first sync is running. It will continue automatically.",
        headline: "First sync running",
        tone: "pending",
      };
    case "first_sync_pending":
      return {
        detail: "The provider credential is captured and the first sync is queued. It will start automatically.",
        headline: "First sync starting",
        tone: "pending",
      };
    case "first_sync_zero_yield":
      return describeZeroYieldState(status);
    case "awaiting_credential":
      return {
        detail: "This connection is set up but no provider credential is captured yet.",
        headline: "Setup material needed",
        tone: "pending",
      };
    case "first_sync_failed":
      return {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: the receiver here is a genuinely optional/nullable type per its declared interface; tsc rejects removing this guard.
        detail: status.last_error?.remediation ?? "Start the first sync again.",
        headline: "First sync failed",
        tone: "failed",
      };
    case "paused":
      return { detail: "This connection is paused.", headline: "Connection paused", tone: "pending" };
    case "revoked":
      return { detail: "This connection has been revoked.", headline: "Connection revoked", tone: "failed" };
    default:
      return {
        detail: "This connection is being set up. Setup will continue automatically.",
        headline: "Setting up",
        tone: "pending",
      };
  }
}

// Browser/SSO connections (ChatGPT and every other browser-bound connector)
// have no stored credential at all — copy here must never say "credential" or
// imply a secret was expected.
//
// It must also never claim the login SUCCEEDED. `deriveSetupState` reaches
// `first_sync_running`/`first_sync_pending` for a browser session from
// `hasRunEvidence` alone — the mere existence of an active or last run row
// (`static-secret-setup-status.ts` `hasDraftSetupProgress`). For a
// browser_session connection the run IS the login attempt: it starts so the
// owner can sign in inside the streamed browser. So a run row proves a sign-in
// was ATTEMPTED, never that it completed — and `defaultSetupMaterial` pins
// `present: false` for this kind precisely because no material was captured.
//
// Saying "Login is complete" here told the owner a session was live while the
// stream was still sitting on Reddit's sign-in form. Unlike the static-secret
// and manual-upload branches — whose "credential is captured" / "file is
// captured" claims ARE backed by `setup_material.present === true` — this
// branch has no proof to cite, so it describes only what is observed: a sync
// is running. Owner-reported 2026-08-19; see
// design-notes/browser-stream-status-honesty-2026-08-22.md.
function describeBrowserSessionState(status: ConnectionSetupStatus): StatusDescription {
  const terminalDisposition = describeTerminalSetupDisposition(status);
  if (terminalDisposition) {
    return terminalDisposition;
  }
  switch (status.setup_state) {
    case "active":
      return describeActiveConnectionState(status);
    case "first_sync_running":
      return {
        detail:
          "A first sync is running. If the browser is still showing a sign-in page, finish signing in there — this page can't confirm the login by itself.",
        headline: "First sync running",
        tone: "pending",
      };
    case "first_sync_pending":
      return {
        detail:
          "A first sync is queued and will start automatically. If the browser is still showing a sign-in page, finish signing in there — this page can't confirm the login by itself.",
        headline: "First sync starting",
        tone: "pending",
      };
    case "first_sync_zero_yield":
      return describeZeroYieldState(status);
    case "awaiting_browser_login":
      return {
        detail: "Continue in the secure browser to finish signing in. The first sync starts after login.",
        headline: "Sign-in needed",
        tone: "pending",
      };
    case "first_sync_failed":
      return {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: the receiver here is a genuinely optional/nullable type per its declared interface; tsc rejects removing this guard.
        detail: status.last_error?.remediation ?? "Continue in the secure browser and start the first sync again.",
        headline: "First sync failed",
        tone: "failed",
      };
    case "paused":
      return { detail: "This connection is paused.", headline: "Connection paused", tone: "pending" };
    case "revoked":
      return { detail: "This connection has been revoked.", headline: "Connection revoked", tone: "failed" };
    default:
      return {
        detail: "This connection is being set up. Setup will continue automatically.",
        headline: "Setting up",
        tone: "pending",
      };
  }
}

function describeState(status: ConnectionSetupStatus): StatusDescription {
  if (status.setup_kind === "manual_upload") {
    return describeImportState(status);
  }
  if (status.setup_kind === "browser_session") {
    return describeBrowserSessionState(status);
  }
  return describeConnectionState(status);
}

/**
 * Human label for the raw `setup_state` enum, for the "Setup state" technical
 * detail row below the humanized headline/detail above it. Every other line
 * on this page is translated prose; this one used to print the raw
 * snake_case value verbatim.
 */
function describeSetupState(setupState: StaticSecretSetupStateValue): string {
  switch (setupState) {
    case "active":
      return "Active";
    case "awaiting_browser_login":
      return "Awaiting browser login";
    case "awaiting_credential":
      return "Awaiting credential";
    case "first_sync_failed":
      return "First sync failed";
    case "first_sync_pending":
      return "First sync pending";
    case "first_sync_running":
      return "First sync running";
    case "first_sync_unverified_missing_counts":
      return "First sync finished, coverage unverified";
    case "first_sync_unverified_zero":
      return "First sync finished with no records, unverified";
    case "first_sync_verified_empty":
      return "First sync verified empty";
    case "first_sync_zero_yield":
      return "First sync finished with no records";
    case "paused":
      return "Paused";
    case "revoked":
      return "Revoked";
    case "unknown":
      return "Unknown";
    default: {
      const _exhaustive: never = setupState;
      throw new Error(`Unhandled setup state ${_exhaustive}`);
    }
  }
}

function retryLabel(status: ConnectionSetupStatus): string {
  switch (status.terminal_setup_disposition) {
    case "verified_empty":
      return "Review setup result";
    case "unverified_missing_counts":
      return "Review setup";
    case "unverified_zero":
      break;
    default:
      break;
  }
  if (status.setup_kind === "manual_upload") {
    return "Choose another file and retry";
  }
  if (status.setup_kind === "browser_session") {
    return "Start browser setup again";
  }
  return "Re-enter credential and retry";
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
    { label: "Batch", monospace: true, value: receipt.batch_id },
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
      detail: facts.fileReceived ? "PDPP captured the file for this import." : "Choose a file to start.",
      label: "Received",
      state: facts.fileReceived ? "done" : "waiting",
    },
    {
      detail: facts.parsed
        ? "The connector parser produced safe validation facts."
        : "PDPP has not parsed this file yet.",
      label: "Parsed",
      state: parsedPhaseState(facts),
    },
    {
      detail: facts.deduped
        ? "Duplicate and skipped counts are available."
        : "Duplicate checks run before records commit.",
      label: "Deduplicated",
      state: dedupedPhaseState(facts),
    },
    {
      detail: facts.committed
        ? "Accepted records or duplicate-only receipt facts are committed."
        : "Records are not committed yet.",
      label: "Committed",
      state: committedPhaseState(facts),
    },
    {
      detail: facts.active ? "Committed records are available on owner surfaces." : "Indexing follows commit.",
      label: "Indexed",
      state: indexedPhaseState(facts),
    },
    {
      detail: facts.active
        ? "Connection health and acquisition coverage include this batch."
        : "Coverage updates after commit.",
      label: "Health projected",
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

function deriveSetupStatusDisplayName(status: ConnectionSetupStatus): string {
  if (status.display_name) {
    return status.display_name;
  }
  return deriveSourceDisplayNameFallback({
    connectorId: status.connector_id,
    displayName: null,
    name: null,
  });
}

function CoverageReceiptCard({ receipt }: { receipt: ImportReceipt }) {
  const warning = formatWarnings(receipt.warnings);
  return (
    <div className="mt-4 max-w-2xl rounded-md border border-border/80 bg-background p-4">
      <p className="pdpp-eyebrow text-muted-foreground">Coverage preview</p>
      <h2 className="pdpp-section-title mt-1">What PDPP found</h2>
      <p className="pdpp-caption mt-1 text-muted-foreground">
        Repeating the same file returns this receipt instead of creating another import.
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
  const displayName = deriveSetupStatusDisplayName(status);
  const title = accountIdentity ? `${displayName} · ${accountIdentity}` : displayName;
  return (
    <RecordroomShellWithPalette>
      <LivePoller enabled={status.pending} />
      <PageHeader
        actions={
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/sources">
            Back to Sources
          </Link>
        }
        breadcrumbs={[{ href: "/sources", label: "Sources" }, { label: "Setup status" }]}
        description="Durable status for the account or import you just submitted. Bookmark it and come back any time."
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
            <dt className="pdpp-caption text-muted-foreground">Setup state</dt>
            <dd className="pdpp-caption">{describeSetupState(status.setup_state)}</dd>
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
                  href={`/syncs/${encodeURIComponent(status.run.run_id)}`}
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
            <>
              <Link className={buttonVariants({ size: "sm", variant: "default" })} href={sourceRecordsHref(status)}>
                Open in Explore
              </Link>
              <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={sourceDetailHref(status)}>
                Source details
              </Link>
              {status.setup_kind === "manual_upload" ? (
                <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={setupHref(status)}>
                  Import another file
                </Link>
              ) : null}
            </>
          ) : null}
          {described.tone === "failed" ||
          status.setup_state === "awaiting_credential" ||
          status.setup_state === "awaiting_browser_login" ||
          status.setup_state === "first_sync_zero_yield" ||
          status.setup_state === "first_sync_verified_empty" ||
          status.setup_state === "first_sync_unverified_zero" ||
          status.setup_state === "first_sync_unverified_missing_counts" ? (
            <Link className={buttonVariants({ size: "sm", variant: "default" })} href={setupHref(status)}>
              {retryLabel(status)}
            </Link>
          ) : null}
        </div>
      </Section>

      {status.last_error ? (
        <Callout className="mt-5" description={status.last_error.remediation} title={described.headline} tone="warning">
          <p className="pdpp-caption text-callout-warning-fg/80">Reason: {status.last_error.reason}</p>
        </Callout>
      ) : null}
    </RecordroomShellWithPalette>
  );
}
