"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { type ManualUploadFormState, manualUploadConnectionFormAction } from "./actions.ts";

interface ManualUploadSetupForForm {
  accepted_file_extensions: string[];
  accepted_file_names: string[];
  connector_id: string;
  display_name: string;
  help_text?: string | null;
  help_url?: string | null;
  validation_expectations: string[];
}

function countRows(preview: NonNullable<ManualUploadFormState["preview"]>) {
  return [
    ["Detected format", preview.detectedFormat],
    ["Status", preview.status],
    ["Coverage window", formatDateRange(preview.dateRange)],
    ["Estimated records", preview.estimatedRecords],
    ["Estimated points", preview.estimatedPoints],
    ["Estimated segments", preview.estimatedSegments],
    ["Estimated messages", preview.estimatedMessages],
    ["Estimated chats", preview.estimatedChats],
    ["Estimated participants", preview.estimatedParticipants],
    ["Estimated attachments", preview.estimatedAttachments],
    ["Media coverage", formatMediaCoverage(preview.mediaCoverage)],
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");
}

function formatDateRange(dateRange: { end: string | null; start: string | null } | null | undefined): string | null {
  if (!(dateRange?.start || dateRange?.end)) {
    return null;
  }
  return `${dateRange.start ?? "unknown"} to ${dateRange.end ?? "unknown"}`;
}

function formatMediaCoverage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" && status.length > 0 ? status.replaceAll("_", " ") : null;
}

function PreviewCard({ preview }: { preview: NonNullable<ManualUploadFormState["preview"]> }) {
  const rows = countRows(preview);
  const duplicate = preview.nextStep === "show_status";
  return (
    <div className="rounded-md border border-border/80 bg-background px-4 py-3" data-testid="manual-upload-preview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="pdpp-eyebrow text-muted-foreground">What PDPP found</p>
          <p className="pdpp-body mt-1 font-medium text-foreground">{preview.uploadedFileName}</p>
        </div>
        <span className="pdpp-caption rounded-sm bg-muted px-2 py-1 text-muted-foreground">
          {duplicate ? "Already imported" : "Ready to import"}
        </span>
      </div>
      {rows.length > 0 ? (
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div className="rounded-sm border border-border/70 bg-muted/20 px-3 py-2" key={label}>
              <dt className="pdpp-caption text-muted-foreground">{label}</dt>
              <dd className="pdpp-caption mt-0.5 break-words text-foreground">{String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {preview.warnings && preview.warnings.length > 0 ? (
        <div className="mt-3 rounded-sm border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <p className="pdpp-caption font-medium text-foreground">Warnings</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {preview.warnings.map((warning) => (
              <li className="pdpp-caption text-muted-foreground" key={warning}>
                {warning}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.remediation ? <p className="pdpp-caption mt-3 text-muted-foreground">{preview.remediation}</p> : null}
      {duplicate && preview.duplicateConnectionId ? (
        <a
          className="pdpp-caption mt-3 inline-flex underline decoration-dotted underline-offset-4"
          href={`/dashboard/connect/status/${encodeURIComponent(preview.duplicateConnectionId)}`}
        >
          Open existing receipt
        </a>
      ) : null}
    </div>
  );
}

function reviewButtonLabel(pending: boolean, hasValidator: boolean): string {
  if (pending) {
    return "Checking...";
  }
  return hasValidator ? "Review file" : "Check file";
}

export function ManualUploadForm({
  setup,
  targetConnectionId,
}: {
  setup: ManualUploadSetupForForm;
  targetConnectionId?: string | null;
}) {
  const [state, formAction, pending] = useActionState(manualUploadConnectionFormAction, {
    ok: null,
  });
  const accepted = [
    ...setup.accepted_file_names,
    ...setup.accepted_file_extensions.map((extension) => `*${extension}`),
  ];
  const acceptLabel = accepted.length > 0 ? accepted.join(", ") : "supported export file";
  const acceptAttribute = [...setup.accepted_file_names, ...setup.accepted_file_extensions].join(",");
  const hasValidator = setup.validation_expectations.length > 0;
  const canImport = state.ok === true && state.preview?.nextStep === "confirm_import";

  return (
    <form
      action={formAction}
      className="grid max-w-2xl gap-4 rounded-md border border-border/80 bg-muted/20 p-4"
      encType="multipart/form-data"
    >
      <input name="connector_id" type="hidden" value={setup.connector_id} />
      {targetConnectionId ? <input name="connection_id" type="hidden" value={targetConnectionId} /> : null}
      {targetConnectionId ? (
        <div className="pdpp-caption rounded-md border border-border/80 bg-background px-3 py-2 text-muted-foreground">
          This import will be added to the existing source you came from. Use the Add source page only when this export
          belongs to a different account, profile, device, or source identity.
        </div>
      ) : (
        <label className="grid gap-1" htmlFor="manual-upload-display-name">
          <span className="pdpp-eyebrow">Source name</span>
          <input
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            defaultValue={setup.display_name}
            id="manual-upload-display-name"
            maxLength={120}
            name="display_name"
            type="text"
          />
          <span className="pdpp-caption text-muted-foreground">
            Use one source per account, profile, device, or source identity. Import related exports into that same
            source.
          </span>
        </label>
      )}
      <label className="grid gap-1" htmlFor="manual-upload-file">
        <span className="pdpp-eyebrow">Export file</span>
        <input
          accept={acceptAttribute || undefined}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:font-medium file:text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          id="manual-upload-file"
          name="import_file"
          required
          type="file"
        />
        <span className="pdpp-caption text-muted-foreground">
          Accepted files: {acceptLabel}
          {setup.help_url ? (
            <>
              {". "}
              <a
                className="underline decoration-dotted underline-offset-4"
                href={setup.help_url}
                rel="noreferrer"
                target="_blank"
              >
                Export instructions
              </a>
            </>
          ) : null}
        </span>
        {setup.help_text ? <span className="pdpp-caption text-muted-foreground">{setup.help_text}</span> : null}
      </label>
      {hasValidator ? (
        <div className="pdpp-caption rounded-md border border-border/80 bg-background px-3 py-2 text-muted-foreground">
          PDPP validates before committing anything: {setup.validation_expectations.join(", ")}. If the file does not
          pass, nothing is imported.
        </div>
      ) : null}
      {state.ok === false && state.message ? (
        <div className="pdpp-caption rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
          {state.message}
        </div>
      ) : null}
      {state.preview ? <PreviewCard preview={state.preview} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} name="intent" type="submit" value="preview" variant="outline">
          {reviewButtonLabel(pending, hasValidator)}
        </Button>
        <Button disabled={pending || (hasValidator && !canImport)} name="intent" type="submit" value="import">
          {pending ? "Importing..." : "Import this file"}
        </Button>
      </div>
      {hasValidator && !canImport ? (
        <p className="pdpp-caption text-muted-foreground">
          Review the file first. Import stays disabled until PDPP can show what it found.
        </p>
      ) : null}
    </form>
  );
}
