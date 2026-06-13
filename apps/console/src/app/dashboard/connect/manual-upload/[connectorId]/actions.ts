"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../../lib/dashboard-access.ts";
import { runConnectionNow } from "../../../lib/operator-runs.ts";
import {
  createManualUploadDraftConnection,
  getManualUploadSetup,
  type ManualUploadValidationPreview,
  RefNotFoundError,
  validateManualUploadArtifact,
} from "../../../lib/ref-client.ts";

export interface ManualUploadFormState {
  message?: string;
  ok: boolean | null;
  preview?: {
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
    status?: string | null;
    uploadedFileName: string;
    warnings?: string[];
  };
}

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function pageHref(connectorId: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  return `/dashboard/connect/manual-upload/${encodeURIComponent(connectorId)}?${query.toString()}`;
}

function statusHref(connectionId: string, runId: string | null): string {
  const base = `/dashboard/connect/status/${encodeURIComponent(connectionId)}`;
  const query = new URLSearchParams();
  if (runId) {
    query.set("run_id", runId);
  }
  const suffix = query.toString();
  return suffix ? `${base}?${suffix}` : base;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Manual upload setup failed.";
}

function fileErrorState(message: string): ManualUploadFormState {
  return { message, ok: false };
}

function previewState(preview: ManualUploadValidationPreview): ManualUploadFormState {
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
      remediation: validation?.remediation ?? preview.next_step.reason ?? null,
      status: validation?.status ?? null,
      uploadedFileName: preview.uploaded_file_name,
      warnings: validation?.warnings ?? [],
    },
  };
}

export async function manualUploadConnectionFormAction(
  _previousState: ManualUploadFormState,
  formData: FormData
): Promise<ManualUploadFormState> {
  const connectorId = asString(formData.get("connector_id"));
  await requireDashboardAccess(`/dashboard/connect/manual-upload/${encodeURIComponent(connectorId)}`);

  const setup = await getManualUploadSetup(connectorId).catch((err) => {
    if (err instanceof RefNotFoundError) {
      return null;
    }
    throw err;
  });
  if (!setup) {
    return fileErrorState(`Connector '${connectorId}' not found.`);
  }

  const rawFile = formData.get("import_file");
  if (!(rawFile instanceof File) || rawFile.size === 0) {
    return fileErrorState("An import file is required.");
  }
  const fileEntry = rawFile as File;

  const accepted = setup.accepted_file_names;
  const acceptedExtensions = setup.accepted_file_extensions;
  if (accepted.length > 0 || acceptedExtensions.length > 0) {
    const lowerName = fileEntry.name.toLowerCase();
    const acceptedLower = new Set(accepted.map((name: string) => name.toLowerCase()));
    const extensionAccepted = acceptedExtensions.some((extension) => lowerName.endsWith(extension.toLowerCase()));
    if (!(acceptedLower.has(lowerName) || extensionAccepted)) {
      const acceptedLabels = [...accepted, ...acceptedExtensions.map((extension) => `*${extension}`)];
      return fileErrorState(`File name '${fileEntry.name}' is not accepted. Expected: ${acceptedLabels.join(", ")}.`);
    }
  }

  const intent = asString(formData.get("intent")) || "preview";
  if (intent === "preview") {
    try {
      return previewState(await validateManualUploadArtifact(connectorId, fileEntry));
    } catch (err) {
      return fileErrorState(errorMessage(err));
    }
  }

  let draftConnectionId: string | null = null;
  let target: string;
  try {
    const draft = await createManualUploadDraftConnection(connectorId, fileEntry);
    draftConnectionId = draft.connection_id;
    if (draft.next_step.kind === "show_status") {
      revalidatePath("/dashboard/records");
      target = statusHref(draft.connection_id, null);
    } else {
      const started = (await runConnectionNow(draft.connection_id)) as { run_id?: string };
      revalidatePath("/dashboard/records");
      target = statusHref(draft.connection_id, started.run_id ?? null);
    }
  } catch (err) {
    target = draftConnectionId
      ? statusHref(draftConnectionId, null)
      : pageHref(connectorId, { error: errorMessage(err) });
  }
  redirect(target);
}

export async function createManualUploadConnectionAction(formData: FormData) {
  const result = await manualUploadConnectionFormAction({ ok: null }, formData);
  if (result.ok === false) {
    const connectorId = asString(formData.get("connector_id"));
    redirect(pageHref(connectorId, { error: result.message ?? "Manual upload setup failed." }));
  }
}
