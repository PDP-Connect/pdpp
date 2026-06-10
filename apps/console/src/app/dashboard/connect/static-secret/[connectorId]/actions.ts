"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../../lib/dashboard-access.ts";
import { runConnectionNow } from "../../../lib/operator-runs.ts";
import {
  captureStaticSecretCredential,
  createStaticSecretDraftConnection,
  getStaticSecretSetup,
  type StaticSecretSetup,
  StaticSecretValidationError,
} from "../../../lib/ref-client.ts";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function pageHref(connectorId: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  return `/dashboard/connect/static-secret/${encodeURIComponent(connectorId)}?${query.toString()}`;
}

// Back to the form, preserving the owner's non-secret context (e.g. the mailbox
// address) so a validation failure does not make them re-type everything. The
// secret is deliberately NOT round-tripped — the owner re-enters it, matching
// Plaid/Zapier credential-retry behavior. Non-secret values ride as `field_*`
// query params the page re-reads into the inputs.
function formRetryHref(connectorId: string, error: string, setupFields: Record<string, string>): string {
  const params: Record<string, string> = { error };
  for (const [name, value] of Object.entries(setupFields)) {
    params[`field_${name}`] = value;
  }
  return pageHref(connectorId, params);
}

// Durable per-connection setup-status surface. After a successful submit the
// owner lands here — a bookmarkable URL backed by the connection's real
// draft/active/run state — instead of bouncing back to the form with a
// transient query-string notice that vanishes on the next navigation.
function statusHref(connectorId: string, connectionId: string, runId: string | null, identity?: string | null): string {
  const base = `/dashboard/connect/static-secret/${encodeURIComponent(connectorId)}/status/${encodeURIComponent(connectionId)}`;
  const query = new URLSearchParams();
  if (runId) {
    query.set("run_id", runId);
  }
  // The synchronous-probe account identity ("Connected as {identity}") is echoed
  // for the immediate post-submit view of connectors with no durable identity
  // setup field (e.g. an account login). Non-secret; the durable status read
  // surfaces any stored identity field on its own.
  if (identity) {
    query.set("identity", identity);
  }
  const suffix = query.toString();
  return suffix ? `${base}?${suffix}` : base;
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
    const captured = await captureStaticSecretCredential({
      connectionId: draft.connection_id,
      credentialKind: setup.credential_kind,
      secret,
    });
    const started = (await runConnectionNow(draft.connection_id)) as {
      run_id?: string;
      trace_id?: string;
    };
    revalidatePath("/dashboard/records");
    // Land on the durable setup-status surface, not a transient form notice. The
    // status page reads the connection's projected setup_state and, for a
    // synchronous-probe connector, surfaces the echoed account identity.
    target = statusHref(
      connectorId,
      draft.connection_id,
      started.run_id ?? null,
      captured.identity?.account_identity ?? null
    );
  } catch (err) {
    if (err instanceof StaticSecretValidationError) {
      // Synchronous validation rejected the credential — nothing was stored, no
      // run started. Keep the owner on the form with the provider-named reason
      // and their non-secret context preserved, so they can fix and resubmit.
      target = formRetryHref(connectorId, err.message, setupFields);
    } else if (draftConnectionId) {
      // The draft exists but a later step (capture/run) failed for a non-
      // validation reason; the owner can see and repair it on its durable status
      // surface, so the submitted account is never invisible.
      target = statusHref(connectorId, draftConnectionId, null);
    } else {
      target = pageHref(connectorId, { error: errorMessage(err) });
    }
  }
  redirect(target);
}
