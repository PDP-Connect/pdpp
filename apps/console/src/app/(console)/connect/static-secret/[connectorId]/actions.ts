"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { rethrowControlFlow } from "../../../lib/control-flow.ts";
import { requireDashboardAccess } from "../../../lib/dashboard-access.ts";
import { runConnectionNow } from "../../../lib/operator-runs.ts";
import {
  captureStaticSecretCredential,
  createStaticSecretDraftConnection,
  getStaticSecretSetup,
  StaticSecretValidationError,
} from "../../../lib/ref-client.ts";
import { buildStaticSecretPayload, collectStaticSecretSetupFields } from "./static-secret-payload.ts";
import { FirstSyncStartError, runIdAfterCapture } from "./static-secret-start.ts";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function pageHref(connectorId: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  return `/connect/static-secret/${encodeURIComponent(connectorId)}?${query.toString()}`;
}

// Back to the form, preserving the owner's non-secret context (e.g. the mailbox
// address) so a validation failure does not make them re-type everything. The
// secret is deliberately NOT round-tripped — the owner re-enters it, matching
// Plaid/Zapier credential-retry behavior. Non-secret values ride as `field_*`
// query params the page re-reads into the inputs.
function formRetryHref(
  connectorId: string,
  error: string,
  setupFields: Record<string, string>,
  displayName?: string | null
): string {
  const params: Record<string, string> = { error };
  for (const [name, value] of Object.entries(setupFields)) {
    params[`field_${name}`] = value;
  }
  if (displayName) {
    params.display_name = displayName;
  }
  return pageHref(connectorId, params);
}

function formErrorParams(error: string, displayName?: string | null): Record<string, string> {
  return displayName ? { display_name: displayName, error } : { error };
}

// Durable per-connection setup-status surface. After a successful submit the
// owner lands here — a bookmarkable URL backed by the connection's real
// draft/active/run state — instead of bouncing back to the form with a
// transient query-string notice that vanishes on the next navigation.
function statusHref(connectionId: string, runId: string | null, identity?: string | null): string {
  const base = `/connect/status/${encodeURIComponent(connectionId)}`;
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
  if (err instanceof FirstSyncStartError) {
    return "The credential was captured, but the first sync could not start. Check the credential and submit again.";
  }
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
  await requireDashboardAccess(`/connect/static-secret/${encodeURIComponent(connectorId)}`);
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
      setupFields,
    });
    const capturedConnectionId = captured.connection_id;
    const runId = await runIdAfterCapture(capturedConnectionId, captured, runConnectionNow);
    revalidatePath("/sources");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the receiver here is a genuinely optional/nullable type per its declared interface; tsc rejects removing this guard.
    target = statusHref(capturedConnectionId, runId, captured.identity?.account_identity ?? null);
  } catch (err) {
    // The capture path runs `verifyDashboardSession()`, which redirects to
    // /owner/login by THROWING. Let that control-flow signal out before
    // treating anything as a credential failure, or an expired session renders
    // as a bogus form error instead of a sign-in.
    rethrowControlFlow(err);
    // Every non-2xx lands here, refusal or not: the owner stays on this form
    // with the server's reason. No success state, no navigation away, and the
    // secret is never round-tripped.
    target = formRetryHrefWithConnectionId(connectorId, connectionId, errorMessage(err), setupFields);
  }
  redirect(target);
}

function pageHrefWithConnectionId(
  connectorId: string,
  connectionId: string,
  extraParams: Record<string, string> = {}
): string {
  const query = new URLSearchParams({ connection_id: connectionId, ...extraParams });
  return `/connect/static-secret/${encodeURIComponent(connectorId)}?${query.toString()}`;
}

function formRetryHrefWithConnectionId(
  connectorId: string,
  connectionId: string,
  error: string,
  setupFields: Record<string, string>,
  options: { displayName?: string | null; draftRetry?: boolean } = {}
): string {
  const params: Record<string, string> = {
    ...(options.draftRetry ? { draft_retry: "1" } : {}),
    error,
  };
  for (const [name, value] of Object.entries(setupFields)) {
    params[`field_${name}`] = value;
  }
  if (options.displayName) {
    params.display_name = options.displayName;
  }
  return pageHrefWithConnectionId(connectorId, connectionId, params);
}

export async function createStaticSecretConnectionAction(formData: FormData) {
  const connectorId = asString(formData.get("connector_id"));
  const displayName = asString(formData.get("display_name")) || null;
  await requireDashboardAccess(`/connect/static-secret/${encodeURIComponent(connectorId)}`);
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
    redirect(pageHref(connectorId, formErrorParams(payload.error, displayName)));
  }
  const setupFields = collectStaticSecretSetupFields(setup, formData);

  let draftConnectionId: string | null = null;
  let target: string;
  try {
    const draft = await createStaticSecretDraftConnection(connectorId, setupFields, { displayName });
    draftConnectionId = draft.connection_id;
    const captured = await captureStaticSecretCredential({
      connectionId: draft.connection_id,
      credentialKind: setup.credential_kind,
      secret: payload.secret,
      setupFields,
    });
    const capturedConnectionId = captured.connection_id;
    const runId = await runIdAfterCapture(capturedConnectionId, captured, runConnectionNow);
    revalidatePath("/sources");
    // Land on the durable setup-status surface, not a transient form notice. The
    // status page reads the connection's projected setup_state and, for a
    // synchronous-probe connector, surfaces the echoed account identity.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the receiver here is a genuinely optional/nullable type per its declared interface; tsc rejects removing this guard.
    target = statusHref(capturedConnectionId, runId, captured.identity?.account_identity ?? null);
  } catch (err) {
    // See the note in replaceStaticSecretCredentialAction: an owner-session
    // redirect is thrown, and must not be mistaken for a credential failure.
    rethrowControlFlow(err);
    if (err instanceof StaticSecretValidationError) {
      // The capture was refused — the provider rejected the secret (400), or a
      // replacement guard refused it (409). Nothing was stored, no run started.
      // Keep the owner on the same resumable draft with the server's reason and
      // non-secret context. The secret is never round-tripped.
      target = draftConnectionId
        ? formRetryHrefWithConnectionId(connectorId, draftConnectionId, err.message, setupFields, {
            displayName,
            draftRetry: true,
          })
        : formRetryHref(connectorId, err.message, setupFields, displayName);
    } else if (draftConnectionId) {
      // A draft with captured material but no confirmed run must not land on
      // first_sync_pending: that state has no run to observe or refresh. Keep
      // the owner on the repair form with non-secret context preserved.
      target = formRetryHrefWithConnectionId(connectorId, draftConnectionId, errorMessage(err), setupFields, {
        displayName,
        draftRetry: true,
      });
    } else {
      target = pageHref(connectorId, formErrorParams(errorMessage(err), displayName));
    }
  }
  redirect(target);
}
