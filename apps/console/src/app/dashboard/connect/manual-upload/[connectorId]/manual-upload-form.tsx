"use client";

import { IcButton } from "@pdpp/brand-react";
import { type FormEvent, useState } from "react";

interface ManualUploadSetupForForm {
  accepted_file_extensions: string[];
  accepted_file_names: string[];
  connector_id: string;
  display_name: string;
  help_text?: string | null;
  help_url?: string | null;
  large_file_fallback?: string | null;
  max_file_bytes?: number | null;
  validation_expectations: string[];
}

interface ExistingManualUploadSource {
  connection_id: string;
  display_name: string;
  detail: string;
}

interface ManualUploadPreview {
  dateRange?: { end: string | null; start: string | null } | null;
  detectedFormat?: string | null;
  duplicateConnectionId?: string | null;
  estimatedAttachments?: number | null;
  estimatedChats?: number | null;
  estimatedMessages?: number | null;
  estimatedParticipants?: number | null;
  estimatedPoints?: number | null;
  estimatedRecords?: number | null;
  estimatedSegments?: number | null;
  mediaCoverage?: unknown;
  nextStep: "confirm_import" | "show_status";
  remediation?: string | null;
  sourceDisplayName?: string | null;
  status?: string | null;
  uploadedFileName: string;
  warnings?: string[];
}

type UploadState = {
  message?: string;
  ok: boolean | null;
  preview?: ManualUploadPreview;
  progress?: {
    currentFile: number;
    fileName: string;
    percent: number | null;
    phase: "importing" | "running" | "uploading" | "validating" | "waiting";
    totalFiles: number;
  };
};

interface ValidationWire {
  date_range?: { end: string | null; start: string | null } | null;
  detected_format?: string | null;
  estimated_attachments?: number | null;
  estimated_chats?: number | null;
  estimated_messages?: number | null;
  estimated_participants?: number | null;
  estimated_points?: number | null;
  estimated_records?: number | null;
  estimated_segments?: number | null;
  media_coverage?: unknown;
  remediation?: string | null;
  status?: string | null;
  warnings?: string[];
}

interface ManualUploadValidationPreviewWire {
  connector_id: string;
  display_name: string;
  duplicate: { connection_id: string } | null;
  next_step: { kind: "confirm_import" | "show_status" };
  object: "manual_upload_validation_preview";
  uploaded_file_name: string;
  validation?: ValidationWire | null;
}

interface ManualUploadArtifactWire {
  artifact_id: string;
  batch_id?: string | null;
  connection_id?: string | null;
  connector_id: string;
  error?: { code?: string; message?: string } | null;
  file_name: string;
  next_step: { kind: "choose_another_file" | "poll_artifact" | "run_connection" | "show_status"; url: string };
  object: "manual_upload_artifact";
  status: "duplicate" | "failed" | "staged" | "uploaded" | "validating";
  validation?: ValidationWire | null;
}

function countRows(preview: ManualUploadPreview) {
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
    ["Source PDPP will use", preview.sourceDisplayName],
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

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = units[0] ?? "B";
  for (const nextUnit of units) {
    unit = nextUnit;
    if (value < 1024 || nextUnit === units[units.length - 1]) {
      break;
    }
    value /= 1024;
  }
  return `${value >= 10 || unit === "B" ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

function PreviewCard({ preview }: { preview: ManualUploadPreview }) {
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

function ProgressCard({ progress }: { progress: NonNullable<UploadState["progress"]> }) {
  const phase =
    progress.phase === "running"
      ? "Starting import"
      : progress.phase === "waiting"
        ? "Preparing file"
      : progress.phase === "validating"
        ? "Checking file"
        : progress.phase === "importing"
          ? "Importing file"
          : "Uploading file";
  return (
    <div className="rounded-md border border-border/80 bg-background px-3 py-2" data-testid="manual-upload-progress">
      <p className="pdpp-caption font-medium text-foreground">
        {phase} {progress.currentFile} of {progress.totalFiles}
      </p>
      <p className="pdpp-caption mt-1 break-words text-muted-foreground">{progress.fileName}</p>
      {progress.percent !== null ? (
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-foreground" style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function validationToPreview(preview: ManualUploadValidationPreviewWire): UploadState {
  const validation = preview.validation;
  return {
    ok: true,
    preview: {
      dateRange: validation?.date_range ?? null,
      detectedFormat: validation?.detected_format ?? null,
      duplicateConnectionId: preview.duplicate?.connection_id ?? null,
      estimatedAttachments: validation?.estimated_attachments ?? null,
      estimatedChats: validation?.estimated_chats ?? null,
      estimatedMessages: validation?.estimated_messages ?? null,
      estimatedParticipants: validation?.estimated_participants ?? null,
      estimatedPoints: validation?.estimated_points ?? null,
      estimatedRecords: validation?.estimated_records ?? null,
      estimatedSegments: validation?.estimated_segments ?? null,
      mediaCoverage: validation?.media_coverage ?? null,
      nextStep: preview.next_step.kind,
      remediation: validation?.remediation ?? null,
      sourceDisplayName: preview.display_name ?? null,
      status: validation?.status ?? null,
      uploadedFileName: preview.uploaded_file_name,
      warnings: validation?.warnings ?? [],
    },
  };
}

function acceptedFile(file: File, setup: ManualUploadSetupForForm): boolean {
  if (setup.accepted_file_names.length === 0 && setup.accepted_file_extensions.length === 0) {
    return true;
  }
  const lowerName = file.name.toLowerCase();
  const names = new Set(setup.accepted_file_names.map((name) => name.toLowerCase()));
  return names.has(lowerName) || setup.accepted_file_extensions.some((extension) => lowerName.endsWith(extension));
}

function fileRejectedMessage(file: File, setup: ManualUploadSetupForForm): string | null {
  if (!acceptedFile(file, setup)) {
    const accepted = [
      ...setup.accepted_file_names,
      ...setup.accepted_file_extensions.map((extension) => `*${extension}`),
    ];
    return `File '${file.name}' is not accepted. Expected: ${accepted.join(", ")}.`;
  }
  const maxFileBytes = setup.max_file_bytes;
  if (maxFileBytes && file.size > maxFileBytes) {
    const fallback = setup.large_file_fallback ? ` ${setup.large_file_fallback}` : "";
    return `File '${file.name}' is ${formatBytes(file.size)}. This connector accepts browser uploads up to ${formatBytes(maxFileBytes)}.${fallback}`;
  }
  return null;
}

function selectedFiles(form: HTMLFormElement): File[] {
  const input = form.elements.namedItem("import_file");
  if (!(input instanceof HTMLInputElement)) {
    return [];
  }
  return Array.from(input.files ?? []);
}

function targetFromForm(form: HTMLFormElement): { connectionId: string | null; displayName: string | null } | { error: string } {
  const fixed = form.elements.namedItem("connection_id");
  if (fixed instanceof HTMLInputElement && fixed.value.trim()) {
    return { connectionId: fixed.value.trim(), displayName: null };
  }
  const sourceTarget = new FormData(form).get("source_target");
  if (sourceTarget === "existing") {
    const existing = form.elements.namedItem("existing_connection_id");
    if (!(existing instanceof HTMLSelectElement) || !existing.value.trim()) {
      return { error: "Choose an existing source, or switch back to creating a new source." };
    }
    return { connectionId: existing.value.trim(), displayName: null };
  }
  const label = form.elements.namedItem("display_name");
  return { connectionId: null, displayName: label instanceof HTMLInputElement ? label.value.trim() || null : null };
}

function statusHref(connectionId: string, runId: string | null): string {
  const query = new URLSearchParams();
  if (runId) {
    query.set("run_id", runId);
  }
  const suffix = query.toString();
  return `/dashboard/connect/status/${encodeURIComponent(connectionId)}${suffix ? `?${suffix}` : ""}`;
}

function ownerLoginHref(): string {
  return `/owner/login?return_to=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`;
}

function errorFromResponse(status: number, text: string, fallback: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  } catch {
    // Fall through to the generic message.
  }
  return `${fallback} (${status})`;
}

function sendRawFile<T>(
  path: string,
  file: File,
  options: {
    connectionId?: string | null;
    contentType?: string;
    displayName?: string | null;
    onProgress(percent: number | null): void;
  }
): Promise<T> {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("file_name", file.name);
  if (options.connectionId) {
    url.searchParams.set("connection_id", options.connectionId);
  }
  if (options.displayName) {
    url.searchParams.set("display_name", options.displayName);
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url.toString());
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", options.contentType ?? "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      options.onProgress(event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null);
    };
    xhr.onload = () => {
      if (xhr.status === 401) {
        window.location.href = ownerLoginHref();
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(errorFromResponse(xhr.status, xhr.responseText, "Manual upload failed")));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText) as T);
      } catch (err) {
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error("Manual upload failed before the reference server responded."));
    xhr.send(file);
  });
}

function artifactFailureMessage(artifact: ManualUploadArtifactWire): string {
  return artifact.error?.message || artifact.validation?.remediation || "The import file failed validation.";
}

async function pollArtifactStatus(
  artifactId: string,
  options: {
    currentFile: number;
    fileName: string;
    totalFiles: number;
    update(progress: NonNullable<UploadState["progress"]>): void;
  }
): Promise<ManualUploadArtifactWire> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const res = await fetch(`/_ref/manual-upload/artifacts/${encodeURIComponent(artifactId)}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const text = await res.text();
    if (res.status === 401) {
      window.location.href = ownerLoginHref();
      return {
        artifact_id: artifactId,
        connector_id: "",
        file_name: options.fileName,
        next_step: { kind: "poll_artifact", url: "" },
        object: "manual_upload_artifact",
        status: "failed",
      };
    }
    if (!res.ok) {
      throw new Error(errorFromResponse(res.status, text, "Manual upload status failed"));
    }
    const artifact = JSON.parse(text) as ManualUploadArtifactWire;
    if (artifact.status === "staged" || artifact.status === "duplicate" || artifact.status === "failed") {
      return artifact;
    }
    options.update({
      currentFile: options.currentFile,
      fileName: options.fileName,
      percent: null,
      phase: "waiting",
      totalFiles: options.totalFiles,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Manual upload validation is still running. Open the source status page to check again.");
}

async function startImportRun(connectionId: string): Promise<{ run_id?: string | null }> {
  const res = await fetch(`/_ref/connections/${encodeURIComponent(connectionId)}/run`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "POST",
  });
  const text = await res.text();
  if (res.status === 401) {
    window.location.href = ownerLoginHref();
    return {};
  }
  if (!res.ok) {
    throw new Error(errorFromResponse(res.status, text, "Import run did not start"));
  }
  return text ? (JSON.parse(text) as { run_id?: string | null }) : {};
}

export function ManualUploadForm({
  existingSources,
  setup,
  targetConnectionId,
}: {
  existingSources: ExistingManualUploadSource[];
  setup: ManualUploadSetupForForm;
  targetConnectionId?: string | null;
}) {
  const [state, setState] = useState<UploadState>({ ok: null });
  const [pending, setPending] = useState(false);
  const accepted = [
    ...setup.accepted_file_names,
    ...setup.accepted_file_extensions.map((extension) => `*${extension}`),
  ];
  const acceptLabel = accepted.length > 0 ? accepted.join(", ") : "supported export file";
  const acceptAttribute = [...setup.accepted_file_names, ...setup.accepted_file_extensions].join(",");
  const hasValidator = setup.validation_expectations.length > 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    const form = event.currentTarget;
    const files = selectedFiles(form);
    if (files.length === 0) {
      setState({ ok: false, message: "Choose at least one import file." });
      return;
    }
    for (const file of files) {
      const rejection = fileRejectedMessage(file, setup);
      if (rejection) {
        setState({ ok: false, message: rejection });
        return;
      }
    }
    const target = targetFromForm(form);
    if ("error" in target) {
      setState({ ok: false, message: target.error });
      return;
    }
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const intent = submitter instanceof HTMLButtonElement && submitter.value === "preview" ? "preview" : "import";
    if (intent === "preview" && files.length !== 1) {
      setState({ ok: false, message: "Preview one file at a time. Import can accept multiple files into one source." });
      return;
    }

    setPending(true);
    try {
      if (intent === "preview") {
        const file = files[0] as File;
        setState({
          ok: null,
          progress: { currentFile: 1, fileName: file.name, percent: null, phase: "validating", totalFiles: 1 },
        });
        const preview = await sendRawFile<ManualUploadValidationPreviewWire>(
          `/_ref/connectors/${encodeURIComponent(setup.connector_id)}/manual-upload-validation-preview`,
          file,
          {
            connectionId: target.connectionId,
            displayName: target.displayName,
            onProgress: (percent) =>
              setState({
                ok: null,
                progress: { currentFile: 1, fileName: file.name, percent, phase: "uploading", totalFiles: 1 },
              }),
          }
        );
        setState(validationToPreview(preview));
        return;
      }

      let connectionId = target.connectionId;
      let lastConnectionId: string | null = target.connectionId;
      let shouldRun = false;
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index] as File;
        setState({
          ok: null,
          progress: {
            currentFile: index + 1,
            fileName: file.name,
            percent: null,
            phase: "importing",
            totalFiles: files.length,
          },
        });
        const staged = await sendRawFile<ManualUploadArtifactWire>(
          `/_ref/connectors/${encodeURIComponent(setup.connector_id)}/manual-upload-staged-artifact`,
          file,
          {
            contentType: "application/vnd.pdpp.manual-upload",
            connectionId,
            displayName: connectionId ? null : target.displayName,
            onProgress: (percent) =>
              setState({
                ok: null,
                progress: {
                  currentFile: index + 1,
                  fileName: file.name,
                  percent,
                  phase: "uploading",
                  totalFiles: files.length,
                },
              }),
          }
        );
        const artifact = await pollArtifactStatus(staged.artifact_id, {
          currentFile: index + 1,
          fileName: file.name,
          totalFiles: files.length,
          update: (progress) => setState({ ok: null, progress }),
        });
        if (artifact.status === "failed") {
          throw new Error(artifactFailureMessage(artifact));
        }
        if (artifact.status === "staged") {
          if (!artifact.connection_id) {
            throw new Error("Manual upload staged the file but did not return a connection id.");
          }
          connectionId = connectionId ?? artifact.connection_id;
          lastConnectionId = artifact.connection_id;
          shouldRun = true;
        } else if (artifact.status === "duplicate" && artifact.connection_id) {
          lastConnectionId = lastConnectionId ?? artifact.connection_id;
        }
      }
      if (!lastConnectionId) {
        throw new Error("Manual upload did not return a connection id.");
      }
      if (!shouldRun) {
        window.location.href = statusHref(lastConnectionId, null);
        return;
      }
      setState({
        ok: null,
        progress: {
          currentFile: files.length,
          fileName: files[files.length - 1]?.name ?? setup.display_name,
          percent: null,
          phase: "running",
          totalFiles: files.length,
        },
      });
      const started = await startImportRun(lastConnectionId);
      window.location.href = statusHref(lastConnectionId, started.run_id ?? null);
    } catch (err) {
      setState({ ok: false, message: err instanceof Error ? err.message : "Manual upload setup failed." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="grid max-w-2xl gap-4 rounded-md border border-border/80 bg-muted/20 p-4" onSubmit={handleSubmit}>
      <input name="connector_id" type="hidden" value={setup.connector_id} />
      {targetConnectionId ? <input name="connection_id" type="hidden" value={targetConnectionId} /> : null}
      {targetConnectionId ? (
        <div className="pdpp-caption rounded-md border border-border/80 bg-background px-3 py-2 text-muted-foreground">
          This import will be added to the existing source you came from. To keep it separate, return to Add source and
          create a new source instead.
        </div>
      ) : (
        <div className="pdpp-caption rounded-md border border-border/80 bg-background px-3 py-2 text-muted-foreground">
          Choose whether this file starts a new source or belongs with one you already created. PDPP can suggest a label
          from the file, but the choice stays yours.
        </div>
      )}
      {!targetConnectionId ? (
        <fieldset className="grid gap-2 rounded-md border border-border/80 bg-background px-3 py-2">
          <legend className="px-1 pdpp-eyebrow">Import target</legend>
          <label className="flex gap-2 text-sm">
            <input defaultChecked name="source_target" type="radio" value="new" />
            <span>Create a new source for these files</span>
          </label>
          {existingSources.length > 0 ? (
            <>
              <label className="flex gap-2 text-sm">
                <input name="source_target" type="radio" value="existing" />
                <span>Add these files to an existing source</span>
              </label>
              <label className="grid gap-1" htmlFor="manual-upload-existing-source">
                <span className="pdpp-caption text-muted-foreground">Existing source</span>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  id="manual-upload-existing-source"
                  name="existing_connection_id"
                >
                  {existingSources.map((source) => (
                    <option key={source.connection_id} value={source.connection_id}>
                      {source.display_name} · {source.detail}
                    </option>
                  ))}
                </select>
                <span className="pdpp-caption text-muted-foreground">
                  Select this only when the export belongs with that existing source.
                </span>
              </label>
            </>
          ) : null}
        </fieldset>
      ) : null}
      {!targetConnectionId ? (
        <label className="grid gap-1" htmlFor="manual-upload-display-name">
          <span className="pdpp-eyebrow">New source label</span>
          <input
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            id="manual-upload-display-name"
            name="display_name"
            placeholder={`Leave blank to use the ${setup.display_name} label PDPP detects`}
            type="text"
          />
          <span className="pdpp-caption text-muted-foreground">
            Used only when creating a new source. You can rename the source later.
          </span>
        </label>
      ) : null}
      <label className="grid gap-1" htmlFor="manual-upload-file">
        <span className="pdpp-eyebrow">Export files</span>
        <input
          accept={acceptAttribute || undefined}
          className="flex min-h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:font-medium file:text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          id="manual-upload-file"
          multiple
          name="import_file"
          required
          type="file"
        />
        <span className="pdpp-caption text-muted-foreground">
          Accepted files: {acceptLabel}
          {setup.max_file_bytes ? `, up to ${formatBytes(setup.max_file_bytes)} each` : ""}
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
          PDPP validates before committing anything: {setup.validation_expectations.join(", ")}. If a file does not pass,
          nothing from that file is imported.
        </div>
      ) : null}
      {state.ok === false && state.message ? (
        <div className="pdpp-caption rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
          {state.message}
        </div>
      ) : null}
      {state.progress ? <ProgressCard progress={state.progress} /> : null}
      {state.preview ? <PreviewCard preview={state.preview} /> : null}
      <div className="flex flex-wrap gap-2">
        <IcButton disabled={pending} name="intent" type="submit" value="import">
          {pending ? "Importing..." : "Import file"}
        </IcButton>
        <IcButton disabled={pending} name="intent" type="submit" value="preview" variant="ghost">
          {pending ? "Checking..." : "Preview only"}
        </IcButton>
      </div>
      <p className="pdpp-caption text-muted-foreground">
        Import can accept multiple files into one source. Preview checks one file without committing it.
      </p>
    </form>
  );
}
