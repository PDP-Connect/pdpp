"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../../lib/dashboard-access.ts";
import { runConnectionNow } from "../../../lib/operator-runs.ts";
import { createManualUploadDraftConnection, getManualUploadSetup, RefNotFoundError } from "../../../lib/ref-client.ts";

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

export async function createManualUploadConnectionAction(formData: FormData) {
  const connectorId = asString(formData.get("connector_id"));
  await requireDashboardAccess(`/dashboard/connect/manual-upload/${encodeURIComponent(connectorId)}`);

  const setup = await getManualUploadSetup(connectorId).catch((err) => {
    if (err instanceof RefNotFoundError) {
      redirect(pageHref(connectorId, { error: `Connector '${connectorId}' not found.` }));
    }
    redirect(pageHref(connectorId, { error: errorMessage(err) }));
  });

  const rawFile = formData.get("import_file");
  if (!(rawFile instanceof File) || rawFile.size === 0) {
    redirect(pageHref(connectorId, { error: "An import file is required." }));
  }
  const fileEntry = rawFile as File;

  const accepted = setup.accepted_file_names;
  if (accepted.length > 0) {
    const acceptedLower = new Set(accepted.map((name: string) => name.toLowerCase()));
    if (!acceptedLower.has(fileEntry.name.toLowerCase())) {
      redirect(
        pageHref(connectorId, {
          error: `File name '${fileEntry.name}' is not accepted. Expected one of: ${accepted.join(", ")}.`,
        })
      );
    }
  }

  let draftConnectionId: string | null = null;
  let target: string;
  try {
    const draft = await createManualUploadDraftConnection(connectorId, fileEntry);
    draftConnectionId = draft.connection_id;
    const started = (await runConnectionNow(draft.connection_id)) as { run_id?: string };
    revalidatePath("/dashboard/records");
    target = statusHref(draft.connection_id, started.run_id ?? null);
  } catch (err) {
    target = draftConnectionId
      ? statusHref(draftConnectionId, null)
      : pageHref(connectorId, { error: errorMessage(err) });
  }
  redirect(target);
}
