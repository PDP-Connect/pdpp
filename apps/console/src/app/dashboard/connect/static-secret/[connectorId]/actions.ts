"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../../lib/dashboard-access.ts";
import { runConnectionNow } from "../../../lib/operator-runs.ts";
import {
  captureStaticSecretCredential,
  createStaticSecretDraftConnection,
  getStaticSecretSetup,
  StaticSecretValidationError,
} from "../../../lib/ref-client.ts";
import { buildStaticSecretPayload, collectStaticSecretSetupFields } from "./static-secret-payload.ts";

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
function statusHref(connectionId: string, runId: string | null, identity?: string | null): string {
  const base = `/dashboard/connect/status/${encodeURIComponent(connectionId)}`;
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

interface AutoResumeResult {
  confirming_run: { run_id?: string } | null;
  status?: string | null;
}

interface StaticSecretCaptureResult {
  auto_resume?: AutoResumeResult | null;
}

function autoResumeRunId(capture: StaticSecretCaptureResult): string | null {
  const runId = capture.auto_resume?.confirming_run?.run_id;
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

function shouldStartRunAfterCapture(capture: StaticSecretCaptureResult): boolean {
  const autoResume = capture.auto_resume;
  return autoResume == null || autoResume.status === "no_satisfied_action";
}

async function runIdAfterCapture(connectionId: string, capture: StaticSecretCaptureResult): Promise<string | null> {
  const autoRunId = autoResumeRunId(capture);
  if (autoRunId) {
    return autoRunId;
  }
  if (!shouldStartRunAfterCapture(capture)) {
    return null;
  }
  const started = (await runConnectionNow(connectionId)) as {
    run_id?: string;
    trace_id?: string;
  };
  return started.run_id ?? null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Static-secret setup failed.";
}

// Credential replacement on an EXISTING connection — preserves connection_id,
// history, schedule, and records. Architecturally identical to the capture step
// in createStaticSecretConnectionAction, but skips draft-connection creation and
// fires a sync run on the existing connection instead. This is the server side
// of the "Update credential" / "Repair" flow (Plaid re-link pattern).
export async function replaceStaticSecretCredentialAction(formData: FormData) {
  const connectorId = asString(formData.get("connector_id"));
  const connectionId = asString(formData.get("connection_id"));
  await requireDashboardAccess(`/dashboard/connect/static-secret/${encodeURIComponent(connectorId)}`);
  if (!connectionId) {
    redirect(pageHref(connectorId, { error: "Connection ID is required for credential replacement." }));
  }
  const setup = await getStaticSecretSetup(connectorId).catch((err) => {
    redirect(pageHrefWithConnectionId(connectorId, connectionId, { error: errorMessage(err) }));
  });
  if (setup.deployment_readiness.state !== "ready") {
    redirect(
      pageHrefWithConnectionId(connectorId, connectionId, {
        error: setup.deployment_readiness.guidance ?? "Credential storage is not ready.",
      })
    );
  }
  const payload = buildStaticSecretPayload(setup, formData);
  if (!payload.ok) {
    redirect(pageHrefWithConnectionId(connectorId, connectionId, { error: payload.error }));
  }
  const setupFields = collectStaticSecretSetupFields(setup, formData);

  let target: string;
  try {
    const captured = await captureStaticSecretCredential({
      connectionId,
      credentialKind: setup.credential_kind,
      secret: payload.secret,
    });
    const runId = await runIdAfterCapture(connectionId, captured);
    revalidatePath("/dashboard/records");
    target = statusHref(connectionId, runId, captured.identity?.account_identity ?? null);
  } catch (err) {
    if (err instanceof StaticSecretValidationError) {
      target = formRetryHrefWithConnectionId(connectorId, connectionId, err.message, setupFields);
    } else {
      target = pageHrefWithConnectionId(connectorId, connectionId, { error: errorMessage(err) });
    }
  }
  redirect(target);
}

function pageHrefWithConnectionId(
  connectorId: string,
  connectionId: string,
  extraParams: Record<string, string> = {}
): string {
  const query = new URLSearchParams({ connection_id: connectionId, ...extraParams });
  return `/dashboard/connect/static-secret/${encodeURIComponent(connectorId)}?${query.toString()}`;
}

function formRetryHrefWithConnectionId(
  connectorId: string,
  connectionId: string,
  error: string,
  setupFields: Record<string, string>
): string {
  const params: Record<string, string> = { error };
  for (const [name, value] of Object.entries(setupFields)) {
    params[`field_${name}`] = value;
  }
  return pageHrefWithConnectionId(connectorId, connectionId, params);
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
  const payload = buildStaticSecretPayload(setup, formData);
  if (!payload.ok) {
    redirect(pageHref(connectorId, { error: payload.error }));
  }
  const setupFields = collectStaticSecretSetupFields(setup, formData);

  let draftConnectionId: string | null = null;
  let target: string;
  try {
    const draft = await createStaticSecretDraftConnection(connectorId, setupFields);
    draftConnectionId = draft.connection_id;
    const captured = await captureStaticSecretCredential({
      connectionId: draft.connection_id,
      credentialKind: setup.credential_kind,
      secret: payload.secret,
    });
    const runId = await runIdAfterCapture(draft.connection_id, captured);
    revalidatePath("/dashboard/records");
    // Land on the durable setup-status surface, not a transient form notice. The
    // status page reads the connection's projected setup_state and, for a
    // synchronous-probe connector, surfaces the echoed account identity.
    target = statusHref(draft.connection_id, runId, captured.identity?.account_identity ?? null);
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
      target = statusHref(draftConnectionId, null);
    } else {
      target = pageHref(connectorId, { error: errorMessage(err) });
    }
  }
  redirect(target);
}
