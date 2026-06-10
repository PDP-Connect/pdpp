"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../../lib/dashboard-access.ts";
import {
  captureStaticSecretCredential,
  createStaticSecretDraftConnection,
  getStaticSecretSetup,
  type StaticSecretSetup,
} from "../../../lib/ref-client.ts";
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

function firstSecretField(setup: StaticSecretSetup) {
  return setup.credential_capture.fields.find((field) => field.secret) ?? null;
}

function collectSetupFields(setup: StaticSecretSetup, formData: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const field of setup.credential_capture.fields) {
    if (field.secret) {
      continue;
    }
    const value = asString(formData.get(field.name));
    if (value) {
      fields[field.name] = value;
    }
  }
  return fields;
}

export async function createStaticSecretConnectionAction(formData: FormData) {
  const connectorId = asString(formData.get("connector_id"));
  await requireDashboardAccess(`/dashboard/connect/static-secret/${encodeURIComponent(connectorId)}`);
  const setup = await getStaticSecretSetup(connectorId).catch((err) => {
    redirect(pageHref(connectorId, { error: errorMessage(err) }));
  });
  if (setup.deployment_readiness.state !== "ready") {
    redirect(
      pageHref(connectorId, {
        error: setup.deployment_readiness.guidance ?? "Credential storage is not ready.",
      })
    );
  }
  const secretField = firstSecretField(setup);
  if (!secretField) {
    redirect(pageHref(connectorId, { error: "Connector setup is missing a secret field." }));
  }
  const secret = asString(formData.get(secretField.name));
  if (!secret) {
    redirect(pageHref(connectorId, { error: "Provider secret is required." }));
  }
  const setupFields = collectSetupFields(setup, formData);

  let draftConnectionId: string | null = null;
  let target: string;
  try {
    const draft = await createStaticSecretDraftConnection(connectorId, setupFields);
    draftConnectionId = draft.connection_id;
    await captureStaticSecretCredential({
      connectionId: draft.connection_id,
      credentialKind: setup.credential_kind,
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
