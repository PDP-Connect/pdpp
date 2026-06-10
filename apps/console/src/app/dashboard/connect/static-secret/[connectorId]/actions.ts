"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isStaticSecretConnector } from "../../../lib/connection-modality.ts";
import { requireDashboardAccess } from "../../../lib/dashboard-access.ts";
import { captureStaticSecretCredential, createStaticSecretDraftConnection } from "../../../lib/ref-client.ts";
import { runConnectionNow } from "../../../lib/operator-runs.ts";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function pageHref(connectorId: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  return `/dashboard/connect/static-secret/${encodeURIComponent(connectorId)}?${query.toString()}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Static-secret setup failed.";
}

export async function createStaticSecretConnectionAction(formData: FormData) {
  const connectorId = asString(formData.get("connector_id"));
  await requireDashboardAccess(`/dashboard/connect/static-secret/${encodeURIComponent(connectorId)}`);
  if (!isStaticSecretConnector(connectorId)) {
    redirect("/dashboard/records?error=Unsupported+static-secret+connector");
  }
  const secret = asString(formData.get("secret"));
  if (!secret) {
    redirect(pageHref(connectorId, { error: "Provider secret is required." }));
  }

  let draftConnectionId: string | null = null;
  let target: string;
  try {
    const draft = await createStaticSecretDraftConnection(connectorId);
    draftConnectionId = draft.connection_id;
    await captureStaticSecretCredential({
      connectionId: draft.connection_id,
      credentialKind: draft.credential_kind,
      secret,
    });
    const started = (await runConnectionNow(draft.connection_id)) as {
      run_id?: string;
      trace_id?: string;
    };
    revalidatePath("/dashboard/records");
    target = pageHref(connectorId, {
      connection_id: draft.connection_id,
      notice: "first_sync_started",
      run_id: started.run_id ?? started.trace_id ?? "",
    });
  } catch (err) {
    const suffix = draftConnectionId ? ` Draft connection: ${draftConnectionId}.` : "";
    target = pageHref(connectorId, { error: `${errorMessage(err)}${suffix}` });
  }
  redirect(target);
}
