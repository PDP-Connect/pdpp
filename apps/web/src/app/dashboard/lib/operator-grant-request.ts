/**
 * Server-only helpers for a dashboard-managed client registration + PAR
 * staging workspace. Uses only the real public registration and PAR routes.
 */

import { DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN } from "pdpp-reference-implementation/reference-local-defaults";
import { approveConsentRequest, denyConsentRequest } from "./operator-approvals.ts";
import {
  getAsInternalUrl,
  getReferencePublicOrigin,
  ReferenceServerUnreachableError,
  withOwnerSessionCookie,
} from "./owner-token.ts";

export const DEFAULT_DCR_INITIAL_ACCESS_TOKEN =
  (process.env.PDPP_DCR_INITIAL_ACCESS_TOKENS || "")
    .split(",")
    .map((value) => value.trim())
    .find(Boolean) || DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN;

export type GrantRequestDraft = {
  initialAccessToken: string;
  clientId: string;
  clientName: string;
  clientUri: string;
  redirectUri: string;
  connectorId: string;
  providerId: string;
  purposeCode: string;
  purposeDescription: string;
  accessMode: string;
  retention: string;
  streamName: string;
  fields: string;
  view: string;
  subjectId: string;
};

export type GrantRequestWorkspace = {
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  draft: GrantRequestDraft;
  registeredClient: Record<string, unknown> | null;
  stagedRequest: Record<string, unknown> | null;
  lastError: string | null;
};

type GrantRequestStore = Map<string, GrantRequestWorkspace>;

function getWorkspaceStore(): GrantRequestStore {
  const state = globalThis as typeof globalThis & {
    __pdppGrantRequestWorkspaces?: GrantRequestStore;
  };
  if (!state.__pdppGrantRequestWorkspaces) {
    state.__pdppGrantRequestWorkspaces = new Map();
  }
  return state.__pdppGrantRequestWorkspaces;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeFields(value: string): string[] | undefined {
  const fields = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return fields.length ? fields : undefined;
}

function trim(value: string | undefined): string {
  return (value ?? "").trim();
}

export function createDefaultGrantRequestDraft(): GrantRequestDraft {
  return {
    initialAccessToken: DEFAULT_DCR_INITIAL_ACCESS_TOKEN,
    clientId: "",
    clientName: "Longview",
    clientUri: "",
    redirectUri: "",
    connectorId: "",
    providerId: "",
    purposeCode: "https://pdpp.org/purpose/financial_planning",
    purposeDescription: "Compare personal data across providers.",
    accessMode: "single_use",
    retention: "P30D",
    streamName: "",
    fields: "",
    view: "",
    subjectId: "owner_local",
  };
}

function sanitizeDraft(input: Partial<GrantRequestDraft> = {}): GrantRequestDraft {
  const base = createDefaultGrantRequestDraft();
  return {
    initialAccessToken: trim(input.initialAccessToken) || base.initialAccessToken,
    clientId: trim(input.clientId),
    clientName: trim(input.clientName) || base.clientName,
    clientUri: trim(input.clientUri),
    redirectUri: trim(input.redirectUri),
    connectorId: trim(input.connectorId),
    providerId: trim(input.providerId),
    purposeCode: trim(input.purposeCode) || base.purposeCode,
    purposeDescription: trim(input.purposeDescription) || base.purposeDescription,
    accessMode: trim(input.accessMode) || base.accessMode,
    retention: trim(input.retention) || base.retention,
    streamName: trim(input.streamName),
    fields: trim(input.fields),
    view: trim(input.view),
    subjectId: trim(input.subjectId) || base.subjectId,
  };
}

function requireSingleSourceBinding(draft: GrantRequestDraft) {
  if (!(draft.connectorId || draft.providerId)) {
    throw new Error("connector_id or provider_id is required");
  }
  if (draft.connectorId && draft.providerId) {
    throw new Error("Specify connector_id or provider_id, not both");
  }
}

function requireStreamSelection(draft: GrantRequestDraft) {
  if (!draft.streamName) {
    throw new Error("stream name is required");
  }
}

function workspaceOrNull(workspaceId: string): GrantRequestWorkspace | null {
  return getWorkspaceStore().get(workspaceId) ?? null;
}

function requireWorkspace(workspaceId: string): GrantRequestWorkspace {
  const workspace = workspaceOrNull(workspaceId);
  if (!workspace) {
    throw new Error(`Unknown grant request workspace: ${workspaceId}`);
  }
  return workspace;
}

function saveWorkspace(workspace: GrantRequestWorkspace): GrantRequestWorkspace {
  getWorkspaceStore().set(workspace.workspaceId, workspace);
  return workspace;
}

function upsertWorkspace(workspaceId: string | undefined, input: Partial<GrantRequestDraft>): GrantRequestWorkspace {
  const existing = workspaceId ? workspaceOrNull(workspaceId) : null;
  const draft = sanitizeDraft({
    ...(existing?.draft ?? {}),
    ...input,
  });
  const now = nowIso();
  const workspace: GrantRequestWorkspace = {
    workspaceId: existing?.workspaceId || crypto.randomUUID(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    draft,
    registeredClient: existing?.registeredClient ?? null,
    stagedRequest: existing?.stagedRequest ?? null,
    lastError: null,
  };
  return saveWorkspace(workspace);
}

async function readBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

function describeError(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const oauth = body as {
      error?: string | { message?: string };
      error_description?: string;
    };
    if (typeof oauth.error_description === "string" && oauth.error_description) {
      return oauth.error_description;
    }
    if (typeof oauth.error === "string" && oauth.error) {
      return oauth.error;
    }
    if (
      oauth.error &&
      typeof oauth.error === "object" &&
      typeof oauth.error.message === "string" &&
      oauth.error.message
    ) {
      return oauth.error.message;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim();
  }
  return fallback;
}

async function fetchAs(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(
      `${getAsInternalUrl()}${path}`,
      await withOwnerSessionCookie({
        cache: "no-store",
        ...init,
      })
    );
  } catch (err) {
    throw new ReferenceServerUnreachableError(`Cannot reach authorization server at ${getAsInternalUrl()}`, err);
  }
}

export function getGrantRequestWorkspace(workspaceId: string): GrantRequestWorkspace | null {
  return workspaceOrNull(workspaceId);
}

export function setGrantRequestWorkspaceError(workspaceId: string, message: string): GrantRequestWorkspace | null {
  const workspace = workspaceOrNull(workspaceId);
  if (!workspace) {
    return null;
  }
  return saveWorkspace({
    ...workspace,
    updatedAt: nowIso(),
    lastError: message,
  });
}

export function updateGrantRequestWorkspaceDraft(
  workspaceId: string | undefined,
  input: Partial<GrantRequestDraft>
): GrantRequestWorkspace {
  return upsertWorkspace(workspaceId, input);
}

export async function registerGrantRequestClient(
  workspaceId: string | undefined,
  input: Partial<GrantRequestDraft>
): Promise<GrantRequestWorkspace> {
  const workspace = upsertWorkspace(workspaceId, input);
  const metadata = {
    client_name: workspace.draft.clientName,
    ...(workspace.draft.clientUri ? { client_uri: workspace.draft.clientUri } : {}),
    ...(workspace.draft.redirectUri ? { redirect_uris: [workspace.draft.redirectUri] } : {}),
    token_endpoint_auth_method: "none",
  };

  const response = await fetchAs("/oauth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${workspace.draft.initialAccessToken}`,
    },
    body: JSON.stringify(metadata),
  });
  const body = await readBody(response);
  if (!(response.ok && body) || typeof body !== "object") {
    throw new Error(describeError(body, `client registration failed (${response.status})`));
  }

  const registeredClient = body as Record<string, unknown>;
  return saveWorkspace({
    ...workspace,
    updatedAt: nowIso(),
    draft: {
      ...workspace.draft,
      clientId: typeof registeredClient.client_id === "string" ? registeredClient.client_id : workspace.draft.clientId,
    },
    registeredClient,
    lastError: null,
  });
}

export async function stageGrantRequest(
  workspaceId: string | undefined,
  input: Partial<GrantRequestDraft>
): Promise<GrantRequestWorkspace> {
  const workspace = upsertWorkspace(workspaceId, input);
  requireSingleSourceBinding(workspace.draft);
  requireStreamSelection(workspace.draft);

  const clientId =
    workspace.draft.clientId ||
    (typeof workspace.registeredClient?.client_id === "string" ? workspace.registeredClient.client_id : "");
  if (!clientId) {
    throw new Error("client_id is required; register a client first or enter one manually");
  }

  const request = {
    client_id: clientId,
    client_display: workspace.draft.clientName ? { name: workspace.draft.clientName } : undefined,
    authorization_details: [
      {
        type: "https://pdpp.org/data-access",
        ...(workspace.draft.connectorId ? { connector_id: workspace.draft.connectorId } : {}),
        ...(workspace.draft.providerId ? { provider_id: workspace.draft.providerId } : {}),
        purpose_code: workspace.draft.purposeCode,
        purpose_description: workspace.draft.purposeDescription,
        access_mode: workspace.draft.accessMode,
        retention: workspace.draft.retention,
        streams: [
          {
            name: workspace.draft.streamName,
            ...(normalizeFields(workspace.draft.fields) ? { fields: normalizeFields(workspace.draft.fields) } : {}),
            ...(workspace.draft.view ? { view: workspace.draft.view } : {}),
          },
        ],
      },
    ],
  };

  const response = await fetchAs("/oauth/par", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await readBody(response);
  if (!(response.ok && body) || typeof body !== "object") {
    throw new Error(describeError(body, `PAR staging failed (${response.status})`));
  }

  return saveWorkspace({
    ...workspace,
    updatedAt: nowIso(),
    draft: {
      ...workspace.draft,
      clientId,
    },
    stagedRequest: body as Record<string, unknown>,
    lastError: null,
  });
}

export async function approveGrantRequestWorkspace(workspaceId: string): Promise<GrantRequestWorkspace> {
  const workspace = requireWorkspace(workspaceId);
  const requestUri =
    typeof workspace.stagedRequest?.request_uri === "string" ? workspace.stagedRequest.request_uri : "";
  if (!requestUri) {
    throw new Error("No staged request is available yet");
  }
  await approveConsentRequest(requestUri, workspace.draft.subjectId);
  return saveWorkspace({
    ...workspace,
    updatedAt: nowIso(),
    lastError: null,
  });
}

export async function denyGrantRequestWorkspace(workspaceId: string): Promise<GrantRequestWorkspace> {
  const workspace = requireWorkspace(workspaceId);
  const requestUri =
    typeof workspace.stagedRequest?.request_uri === "string" ? workspace.stagedRequest.request_uri : "";
  if (!requestUri) {
    throw new Error("No staged request is available yet");
  }
  await denyConsentRequest(requestUri);
  return saveWorkspace({
    ...workspace,
    updatedAt: nowIso(),
    lastError: null,
  });
}

export async function buildGrantRequestExamples(workspace: GrantRequestWorkspace) {
  const asUrl = await getReferencePublicOrigin();
  const streamSelection = {
    name: workspace.draft.streamName || "<stream>",
    ...(normalizeFields(workspace.draft.fields) ? { fields: normalizeFields(workspace.draft.fields) } : {}),
    ...(workspace.draft.view ? { view: workspace.draft.view } : {}),
  };
  const request = {
    client_id:
      workspace.draft.clientId ||
      (typeof workspace.registeredClient?.client_id === "string"
        ? workspace.registeredClient.client_id
        : "<client_id>"),
    client_display: workspace.draft.clientName ? { name: workspace.draft.clientName } : undefined,
    authorization_details: [
      {
        type: "https://pdpp.org/data-access",
        ...(workspace.draft.connectorId ? { connector_id: workspace.draft.connectorId } : {}),
        ...(workspace.draft.providerId ? { provider_id: workspace.draft.providerId } : {}),
        purpose_code: workspace.draft.purposeCode,
        purpose_description: workspace.draft.purposeDescription,
        access_mode: workspace.draft.accessMode,
        retention: workspace.draft.retention,
        streams: [streamSelection],
      },
    ],
  };

  return {
    registerCurl: `curl -sS -X POST '${asUrl}/oauth/register' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Authorization: Bearer ${workspace.draft.initialAccessToken || "<initial-access-token>"}' \\\n  --data '${JSON.stringify(
      {
        client_name: workspace.draft.clientName || "Longview",
        ...(workspace.draft.clientUri ? { client_uri: workspace.draft.clientUri } : {}),
        ...(workspace.draft.redirectUri ? { redirect_uris: [workspace.draft.redirectUri] } : {}),
        token_endpoint_auth_method: "none",
      }
    )}'`,
    stageCurl: `curl -sS -X POST '${asUrl}/oauth/par' \\\n  -H 'Content-Type: application/json' \\\n  --data '${JSON.stringify(request)}'`,
  };
}
