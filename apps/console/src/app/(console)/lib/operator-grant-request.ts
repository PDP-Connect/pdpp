// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-only helpers for a dashboard-managed client registration + PAR
 * staging workspace. Uses only the real public registration and PAR routes.
 */

import { DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN } from "pdpp-reference-implementation/reference-local-defaults";
import { describeError } from "./describe-error.ts";
import {
  buildConnectionPinOptions,
  type ConnectionPinOption,
  streamSelectionFromDraft,
} from "./grant-request-connection-pin.ts";
import { approveConsentRequest, denyConsentRequest } from "./operator-approvals.ts";
import {
  getAsInternalUrl,
  getReferencePublicOrigin,
  ReferenceServerUnreachableError,
  withOwnerSessionCookie,
} from "./owner-token.ts";
import { listConnectorSummaries } from "./ref-client.ts";

export type { ConnectionPinOption } from "./grant-request-connection-pin.ts";

export const DEFAULT_DCR_INITIAL_ACCESS_TOKEN =
  (process.env.PDPP_DCR_INITIAL_ACCESS_TOKENS || "")
    .split(",")
    .map((value) => value.trim())
    .find(Boolean) || DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN;

export interface GrantRequestDraft {
  accessMode: string;
  clientId: string;
  clientName: string;
  clientUri: string;
  /**
   * Optional per-connection pin for the addressed stream. Empty string ⇒
   * fan-in: the issued grant omits `streams[].connection_id` and reads union
   * across every connection the grant authorizes for the stream. A non-empty
   * value ⇒ the staged PAR pins `streams[0].connection_id` to exactly that
   * connection (an existing supported grant field — no new storage shape).
   * The form only ever offers a value the owner saw labelled, satisfying the
   * "consent surface SHALL have shown the per-connection constraint" scenario.
   */
  connectionId: string;
  fields: string;
  initialAccessToken: string;
  purposeCode: string;
  purposeDescription: string;
  redirectUri: string;
  retention: string;
  sourceId: string;
  sourceKind: "connector" | "provider_native";
  streamName: string;
  subjectId: string;
  view: string;
}

export interface GrantRequestWorkspace {
  createdAt: string;
  draft: GrantRequestDraft;
  lastError: string | null;
  registeredClient: Record<string, unknown> | null;
  stagedRequest: Record<string, unknown> | null;
  updatedAt: string;
  workspaceId: string;
}

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

function trim(value: string | undefined): string {
  return (value ?? "").trim();
}

function normalizeSourceKind(value: string | undefined): GrantRequestDraft["sourceKind"] {
  return trim(value) === "provider_native" ? "provider_native" : "connector";
}

function sourceFromDraft(draft: GrantRequestDraft) {
  return {
    id: draft.sourceId,
    kind: draft.sourceKind,
  };
}

/**
 * Load the pinnable connections for the draft's current source. Returns `[]`
 * for non-connector or empty sources, and degrades to `[]` (fan-in only) if
 * the connector listing is unreachable — the page must never block staging on
 * connection enumeration.
 */
export async function loadConnectionPinOptions(draft: GrantRequestDraft): Promise<ConnectionPinOption[]> {
  if (draft.sourceKind !== "connector" || !trim(draft.sourceId)) {
    return [];
  }
  try {
    const response = await listConnectorSummaries();
    return buildConnectionPinOptions(
      { id: draft.sourceId, kind: draft.sourceKind, streamName: draft.streamName },
      response.data
    );
  } catch {
    return [];
  }
}

export function createDefaultGrantRequestDraft(): GrantRequestDraft {
  return {
    accessMode: "single_use",
    clientId: "",
    clientName: "Longview",
    clientUri: "",
    connectionId: "",
    fields: "",
    initialAccessToken: DEFAULT_DCR_INITIAL_ACCESS_TOKEN,
    purposeCode: "https://pdpp.org/purpose/financial_planning",
    purposeDescription: "Compare personal data across providers.",
    redirectUri: "",
    retention: "P30D",
    sourceId: "",
    sourceKind: "connector",
    streamName: "",
    subjectId: "owner_local",
    view: "",
  };
}

function sanitizeDraft(input: Partial<GrantRequestDraft> = {}): GrantRequestDraft {
  const base = createDefaultGrantRequestDraft();
  return {
    accessMode: trim(input.accessMode) || base.accessMode,
    clientId: trim(input.clientId),
    clientName: trim(input.clientName) || base.clientName,
    clientUri: trim(input.clientUri),
    connectionId: trim(input.connectionId),
    fields: trim(input.fields),
    initialAccessToken: trim(input.initialAccessToken) || base.initialAccessToken,
    purposeCode: trim(input.purposeCode) || base.purposeCode,
    purposeDescription: trim(input.purposeDescription) || base.purposeDescription,
    redirectUri: trim(input.redirectUri),
    retention: trim(input.retention) || base.retention,
    sourceId: trim(input.sourceId),
    sourceKind: normalizeSourceKind(input.sourceKind),
    streamName: trim(input.streamName),
    subjectId: trim(input.subjectId) || base.subjectId,
    view: trim(input.view),
  };
}

function requireSingleSourceBinding(draft: GrantRequestDraft) {
  if (!draft.sourceId) {
    throw new Error("source.id is required");
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
    createdAt: existing?.createdAt || now,
    draft,
    lastError: null,
    registeredClient: existing?.registeredClient ?? null,
    stagedRequest: existing?.stagedRequest ?? null,
    updatedAt: now,
    workspaceId: existing?.workspaceId || crypto.randomUUID(),
  };
  return saveWorkspace(workspace);
}

function readBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
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
    lastError: message,
    updatedAt: nowIso(),
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
    body: JSON.stringify(metadata),
    headers: {
      Authorization: `Bearer ${workspace.draft.initialAccessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const body = await readBody(response);
  if (!(response.ok && body) || typeof body !== "object") {
    throw new Error(describeError(body, `client registration failed (${response.status})`));
  }

  const registeredClient = body as Record<string, unknown>;
  return saveWorkspace({
    ...workspace,
    draft: {
      ...workspace.draft,
      clientId: typeof registeredClient.client_id === "string" ? registeredClient.client_id : workspace.draft.clientId,
    },
    lastError: null,
    registeredClient,
    updatedAt: nowIso(),
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
    authorization_details: [
      {
        access_mode: workspace.draft.accessMode,
        purpose_code: workspace.draft.purposeCode,
        purpose_description: workspace.draft.purposeDescription,
        retention: workspace.draft.retention,
        source: sourceFromDraft(workspace.draft),
        streams: [streamSelectionFromDraft(workspace.draft, workspace.draft.streamName)],
        type: "https://pdpp.org/data-access",
      },
    ],
    client_display: workspace.draft.clientName ? { name: workspace.draft.clientName } : undefined,
    client_id: clientId,
  };

  const response = await fetchAs("/oauth/par", {
    body: JSON.stringify(request),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await readBody(response);
  if (!(response.ok && body) || typeof body !== "object") {
    throw new Error(describeError(body, `PAR staging failed (${response.status})`));
  }

  return saveWorkspace({
    ...workspace,
    draft: {
      ...workspace.draft,
      clientId,
    },
    lastError: null,
    stagedRequest: body as Record<string, unknown>,
    updatedAt: nowIso(),
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
    lastError: null,
    updatedAt: nowIso(),
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
    lastError: null,
    updatedAt: nowIso(),
  });
}

export async function buildGrantRequestExamples(workspace: GrantRequestWorkspace) {
  const asUrl = await getReferencePublicOrigin();
  const streamSelection = streamSelectionFromDraft(workspace.draft, workspace.draft.streamName || "<stream>");
  const request = {
    authorization_details: [
      {
        access_mode: workspace.draft.accessMode,
        purpose_code: workspace.draft.purposeCode,
        purpose_description: workspace.draft.purposeDescription,
        retention: workspace.draft.retention,
        source: sourceFromDraft(workspace.draft),
        streams: [streamSelection],
        type: "https://pdpp.org/data-access",
      },
    ],
    client_display: workspace.draft.clientName ? { name: workspace.draft.clientName } : undefined,
    client_id:
      workspace.draft.clientId ||
      (typeof workspace.registeredClient?.client_id === "string"
        ? workspace.registeredClient.client_id
        : "<client_id>"),
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
