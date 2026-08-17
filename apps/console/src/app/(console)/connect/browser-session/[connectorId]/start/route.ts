// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { NextResponse } from "next/server";
import { isBrowserBoundConnector, isSupportedBrowserCollectorConnector } from "../../../../lib/connection-modality.ts";
import { requireDashboardAccess } from "../../../../lib/dashboard-access.ts";
import {
  abandonBrowserEnrollmentShell,
  captureStaticSecretCredential,
  createBrowserEnrollmentShell,
  getStaticSecretSetup,
  StaticSecretValidationError,
} from "../../../../lib/ref-client.ts";
import { originMatchesHost, redirectToPublicPath } from "../../../../lib/same-origin-route.ts";
import {
  type OptionalBrowserCredentialSubmission,
  optionalBrowserCredentialSubmission,
} from "../browser-session-credential-form.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  connectorId: string;
}

function pagePath(connectorId: string): string {
  return `/connect/browser-session/${encodeURIComponent(connectorId)}`;
}

function errorPath(
  connectorId: string,
  message: string,
  options: { connectionId?: string | null; setupFields?: Record<string, string> } = {}
): string {
  const query = new URLSearchParams({ error: message });
  if (options.connectionId) {
    query.set("connectionId", options.connectionId);
  }
  for (const [name, value] of Object.entries(options.setupFields ?? {})) {
    query.set(`field_${name}`, value);
  }
  return `${pagePath(connectorId)}?${query.toString()}`;
}

function readConnectionIdField(formData: FormData): string | null {
  if (!formData.has("connection_id")) {
    return null;
  }
  const value = formData.get("connection_id");
  if (typeof value !== "string") {
    throw new Error("connection_id must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("connection_id must be a non-empty string");
  }
  return trimmed;
}

function readOptionalDisplayNameField(formData: FormData): string | null {
  if (!formData.has("display_name")) {
    return null;
  }
  const value = formData.get("display_name");
  if (typeof value !== "string") {
    throw new Error("display_name must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > 200) {
    throw new Error("display_name must be 200 characters or fewer");
  }
  return trimmed;
}

class BrowserCredentialFormError extends Error {
  readonly setupFields: Record<string, string>;

  constructor(message: string, setupFields: Record<string, string>) {
    super(message);
    this.name = "BrowserCredentialFormError";
    this.setupFields = setupFields;
  }
}

interface OptionalCredentialSubmission {
  readonly credentialKind: string;
  readonly setupFields: Record<string, string>;
  readonly submission: OptionalBrowserCredentialSubmission;
}

async function readOptionalCredentialSubmission(
  connectorId: string,
  formData: FormData
): Promise<OptionalCredentialSubmission | null> {
  const remember = formData.get("remember_sign_in_details");
  if (remember !== "1" && remember !== "true") {
    return null;
  }
  const setup = await getStaticSecretSetup(connectorId);
  const result = optionalBrowserCredentialSubmission(setup, formData);
  if (result === null) {
    return null;
  }
  if (setup.deployment_readiness.state !== "ready") {
    throw new BrowserCredentialFormError(
      setup.deployment_readiness.guidance ?? "Credential storage is not ready.",
      result.ok ? result.submission.setupFields : result.setupFields
    );
  }
  if (!result.ok) {
    throw new BrowserCredentialFormError(result.error, result.setupFields);
  }
  return {
    credentialKind: setup.credential_kind,
    setupFields: result.submission.setupFields,
    submission: result.submission,
  };
}

async function captureOptionalCredential(
  connectionId: string,
  submission: OptionalCredentialSubmission
): Promise<void> {
  await captureStaticSecretCredential({
    connectionId,
    credentialKind: submission.credentialKind,
    secret: submission.submission.secret,
  });
}

function launchPath(connectorId: string, connectionId: string, draft: boolean): string {
  const query = new URLSearchParams({ connection_id: connectionId, draft: draft ? "1" : "0" });
  return `${pagePath(connectorId)}/launch?${query.toString()}`;
}

async function captureOptionalCredentialOrRedirect(
  request: Request,
  connectorId: string,
  connectionId: string,
  optionalCredential: OptionalCredentialSubmission | null,
  abandonOnFailure: boolean
): Promise<NextResponse | null> {
  if (!optionalCredential) {
    return null;
  }
  try {
    await captureOptionalCredential(connectionId, optionalCredential);
    return null;
  } catch (err) {
    if (abandonOnFailure) {
      try {
        await abandonBrowserEnrollmentShell(connectionId);
      } catch {
        // Best effort; the shell TTL retires any orphaned draft.
      }
    }
    // A refusal (400 provider rejection / 409 replacement conflict) carries the
    // reference server's own owner-causal copy — surface it verbatim rather
    // than flattening every failure into one generic line the owner cannot act
    // on. The fallback stays for transport-level failures with no envelope.
    const message =
      err instanceof StaticSecretValidationError ? err.message : "Could not save the optional sign-in details.";
    return redirectToPublicPath(
      request,
      errorPath(connectorId, message, {
        connectionId: abandonOnFailure ? null : connectionId,
        setupFields: optionalCredential.setupFields,
      })
    );
  }
}

async function startNewBrowserEnrollment(
  request: Request,
  connectorId: string,
  formData: FormData,
  optionalCredential: OptionalCredentialSubmission | null
): Promise<NextResponse> {
  const displayName = readOptionalDisplayNameField(formData);
  const shell = await createBrowserEnrollmentShell(connectorId, { displayName });
  const captureError = await captureOptionalCredentialOrRedirect(
    request,
    connectorId,
    shell.connection_id,
    optionalCredential,
    true
  );
  if (captureError) {
    return captureError;
  }
  return redirectToPublicPath(request, launchPath(connectorId, shell.connection_id, true));
}

export async function POST(request: Request, { params }: { params: Promise<RouteParams> }): Promise<NextResponse> {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);

  await requireDashboardAccess(pagePath(connectorId));

  if (!originMatchesHost(request)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (!isBrowserBoundConnector(connectorId)) {
    return redirectToPublicPath(
      request,
      `/sources/add?error=${encodeURIComponent("This source does not use browser setup.")}`
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return redirectToPublicPath(request, errorPath(connectorId, "Invalid browser-session form."));
  }

  let existingConnectionId: string | null;
  try {
    existingConnectionId = readConnectionIdField(formData);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid browser-session form";
    return redirectToPublicPath(request, errorPath(connectorId, message));
  }

  try {
    if (!(isSupportedBrowserCollectorConnector(connectorId) || existingConnectionId)) {
      return redirectToPublicPath(
        request,
        `/sources/add?error=${encodeURIComponent("This browser-backed source is not available for self-service setup.")}`
      );
    }

    let optionalCredential: OptionalCredentialSubmission | null;
    try {
      optionalCredential = await readOptionalCredentialSubmission(connectorId, formData);
    } catch (err) {
      if (err instanceof BrowserCredentialFormError) {
        return redirectToPublicPath(request, errorPath(connectorId, err.message, { setupFields: err.setupFields }));
      }
      return redirectToPublicPath(request, errorPath(connectorId, "Could not load the optional sign-in details form."));
    }

    if (existingConnectionId) {
      const captureError = await captureOptionalCredentialOrRedirect(
        request,
        connectorId,
        existingConnectionId,
        optionalCredential,
        false
      );
      if (captureError) {
        return captureError;
      }
      return redirectToPublicPath(request, launchPath(connectorId, existingConnectionId, false));
    }

    return await startNewBrowserEnrollment(request, connectorId, formData, optionalCredential);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start browser session";
    return redirectToPublicPath(request, errorPath(connectorId, message));
  }
}
