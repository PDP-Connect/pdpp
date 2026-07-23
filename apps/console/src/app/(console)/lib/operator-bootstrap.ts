// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-only helpers for the dashboard owner-token bootstrap flow.
 *
 * These wrap the real public device/introspection endpoints and keep only
 * ephemeral dashboard state in memory so the UI can step through the flow
 * without inventing a second token minting surface.
 */
import { describeError } from "./describe-error.ts";
import { DEFAULT_DCR_INITIAL_ACCESS_TOKEN } from "./operator-grant-request.ts";
import {
  getAsInternalUrl,
  getReferencePublicOrigin,
  ReferenceServerUnreachableError,
  withOwnerSessionCookie,
} from "./owner-token.ts";

export const DASHBOARD_BOOTSTRAP_CLIENT_ID = "pdpp-web-dashboard";

export interface OwnerBootstrapFlow {
  approvalUpdatedAt: string | null;
  clientId: string;
  deviceCode: string;
  expiresAt: string | null;
  flowId: string;
  intervalSeconds: number;
  introspectedAt: string | null;
  introspection: Record<string, unknown> | null;
  lastError: string | null;
  // Operator-supplied label so the issued bearer is recognizable later.
  // Doesn't change the protocol — bearers are still RFC 8628 device-flow
  // tokens. The name is dashboard-only metadata.
  name: string | null;
  startedAt: string;
  status: "pending_approval" | "approved" | "denied" | "token_issued";
  subjectId: string | null;
  token: string | null;
  tokenIssuedAt: string | null;
  tokenResponse: Record<string, unknown> | null;
  userCode: string;
  verificationUri: string | null;
  verificationUriComplete: string | null;
}

type OwnerBootstrapStore = Map<string, OwnerBootstrapFlow>;

function getFlowStore(): OwnerBootstrapStore {
  const state = globalThis as typeof globalThis & {
    __pdppOwnerBootstrapFlows?: OwnerBootstrapStore;
  };
  if (!state.__pdppOwnerBootstrapFlows) {
    state.__pdppOwnerBootstrapFlows = new Map();
  }
  return state.__pdppOwnerBootstrapFlows;
}

function readBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

function requireFlow(flowId: string): OwnerBootstrapFlow {
  const flow = getFlowStore().get(flowId);
  if (!flow) {
    throw new Error(`Unknown dashboard owner-token flow: ${flowId}`);
  }
  return flow;
}

function saveFlow(flow: OwnerBootstrapFlow): OwnerBootstrapFlow {
  getFlowStore().set(flow.flowId, flow);
  return flow;
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

export function getOwnerBootstrapFlow(flowId: string): OwnerBootstrapFlow | null {
  return getFlowStore().get(flowId) ?? null;
}

export function setOwnerBootstrapFlowError(flowId: string, message: string): OwnerBootstrapFlow | null {
  const flow = getOwnerBootstrapFlow(flowId);
  if (!flow) {
    return null;
  }
  return saveFlow({
    ...flow,
    lastError: message,
  });
}

/**
 * Issue an owner self-export bearer by:
 *   1. Registering a fresh OAuth client (RFC 7591 DCR) with the operator-
 *      supplied name. The AS stamps `metadata.issuer_subject_id` from the
 *      forwarded owner-session cookie so the client is scoped to this
 *      operator and shows up in `/_ref/clients?owner=true`.
 *   2. Running the canonical RFC 8628 device flow against the freshly-
 *      registered client_id (not the shared bootstrap client).
 *
 * Per-token DCR is the standards-grounded alternative to PAT-style per-token
 * database labels: the credential's identity (and its name) lives where the
 * IETF spec puts it. Revocation is `DELETE /oauth/register/{client_id}` (RFC
 * 7592), which cascade-revokes the bearer.
 *
 * Spec: openspec/changes/dcr-per-owner-token-with-revoke/
 */
export async function startOwnerBootstrapFlow(
  _legacyClientId: string = DASHBOARD_BOOTSTRAP_CLIENT_ID,
  name: string | null = null
): Promise<OwnerBootstrapFlow> {
  const label = name?.trim();
  if (!label) {
    throw new Error("Token name is required");
  }
  const registerResp = await fetchAs("/oauth/register", {
    body: JSON.stringify({
      client_name: label,
      token_endpoint_auth_method: "none",
    }),
    headers: {
      Authorization: `Bearer ${DEFAULT_DCR_INITIAL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const registerBody = await readBody(registerResp);
  if (!(registerResp.ok && registerBody) || typeof registerBody !== "object") {
    throw new Error(describeError(registerBody, `oauth/register failed (${registerResp.status})`));
  }
  const registered = registerBody as { client_id?: string; client_name?: string };
  if (typeof registered.client_id !== "string" || !registered.client_id) {
    throw new Error("oauth/register succeeded without a client_id");
  }
  const clientId = registered.client_id;

  // JSON content-type uses the documented CSRF exemption, like every other
  // server-to-server BFF call from the dashboard.
  const response = await fetchAs("/oauth/device_authorization", {
    body: JSON.stringify({ client_id: clientId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await readBody(response);
  if (!(response.ok && body) || typeof body !== "object") {
    throw new Error(describeError(body, `device_authorization failed (${response.status})`));
  }

  const payload = body as {
    device_code: string;
    user_code: string;
    expires_in?: number;
    interval?: number;
    verification_uri?: string;
    verification_uri_complete?: string;
  };
  if (
    typeof payload.device_code !== "string" ||
    !payload.device_code ||
    typeof payload.user_code !== "string" ||
    !payload.user_code
  ) {
    throw new Error("device_authorization succeeded without device_code/user_code");
  }

  const flow: OwnerBootstrapFlow = {
    approvalUpdatedAt: null,
    clientId,
    deviceCode: payload.device_code,
    expiresAt:
      typeof payload.expires_in === "number" ? new Date(Date.now() + payload.expires_in * 1000).toISOString() : null,
    flowId: crypto.randomUUID(),
    intervalSeconds: typeof payload.interval === "number" ? payload.interval : 5,
    introspectedAt: null,
    introspection: null,
    lastError: null,
    name: label,
    startedAt: new Date().toISOString(),
    status: "pending_approval",
    subjectId: null,
    token: null,
    tokenIssuedAt: null,
    tokenResponse: null,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri ?? null,
    verificationUriComplete: payload.verification_uri_complete ?? null,
  };

  return saveFlow(flow);
}

export async function approveOwnerBootstrapFlow(flowId: string, subjectId: string): Promise<OwnerBootstrapFlow> {
  const flow = requireFlow(flowId);
  // JSON content-type uses the documented CSRF exemption (server/owner-auth.ts
  // isJsonRequest). Form-encoded bodies require a hosted-form CSRF token that
  // the dashboard never has — and never should fetch, since this is a
  // server-to-server call from the BFF, not a hosted browser form. The AS
  // derives the approved subject from the owner session when owner-auth is on;
  // `subjectId` here is retained only for the local UI transcript state.
  const response = await fetchAs("/device/approve", {
    body: JSON.stringify({ user_code: flow.userCode }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `device approval failed (${response.status})`));
  }
  return saveFlow({
    ...flow,
    approvalUpdatedAt: new Date().toISOString(),
    lastError: null,
    status: "approved",
    subjectId,
  });
}

export async function denyOwnerBootstrapFlow(flowId: string, subjectId: string): Promise<OwnerBootstrapFlow> {
  const flow = requireFlow(flowId);
  // See approveOwnerBootstrapFlow: JSON content-type uses the documented CSRF
  // exemption for server-to-server BFF callers.
  const response = await fetchAs("/device/deny", {
    body: JSON.stringify({ user_code: flow.userCode }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `device denial failed (${response.status})`));
  }
  return saveFlow({
    ...flow,
    approvalUpdatedAt: new Date().toISOString(),
    introspectedAt: null,
    introspection: null,
    lastError: null,
    status: "denied",
    subjectId,
    token: null,
    tokenResponse: null,
  });
}

export async function exchangeOwnerBootstrapToken(flowId: string): Promise<OwnerBootstrapFlow> {
  const flow = requireFlow(flowId);
  const response = await fetchAs("/oauth/token", {
    body: JSON.stringify({
      client_id: flow.clientId,
      device_code: flow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await readBody(response);
  if (!(response.ok && body) || typeof body !== "object") {
    throw new Error(describeError(body, `token exchange failed (${response.status})`));
  }
  const payload = body as {
    access_token?: string;
  } & Record<string, unknown>;
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("token exchange succeeded without an access_token");
  }
  return saveFlow({
    ...flow,
    lastError: null,
    status: "token_issued",
    token: payload.access_token,
    tokenIssuedAt: new Date().toISOString(),
    tokenResponse: payload,
  });
}

export async function introspectOwnerBootstrapToken(flowId: string): Promise<OwnerBootstrapFlow> {
  const flow = requireFlow(flowId);
  if (!flow.token) {
    throw new Error("No token available yet for introspection");
  }
  const response = await fetchAs("/introspect", {
    body: JSON.stringify({ token: flow.token }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await readBody(response);
  if (!(response.ok && body) || typeof body !== "object") {
    throw new Error(describeError(body, `introspection failed (${response.status})`));
  }
  return saveFlow({
    ...flow,
    introspectedAt: new Date().toISOString(),
    introspection: body as Record<string, unknown>,
    lastError: null,
  });
}

export async function buildOwnerBootstrapExamples(flow: OwnerBootstrapFlow) {
  const referenceOrigin = await getReferencePublicOrigin();
  const asUrl = referenceOrigin;
  const rsUrl = referenceOrigin;
  return {
    approveCurl: `curl -sS -X POST ${shellQuote(`${asUrl}/device/approve`)} \\\n  -H 'Content-Type: application/json' \\\n  -H 'Cookie: pdpp_owner_session=<your-session>' \\\n  --data ${shellQuote(JSON.stringify({ user_code: flow.userCode }))}`,
    cliIntrospect: flow.token
      ? `pdpp auth introspect --as-url ${shellQuote(asUrl)} --token ${shellQuote(flow.token)} --format json`
      : "pdpp auth introspect --as-url <as-url> --token <token> --format json",
    cliLogin: `pdpp auth login --client-id ${shellQuote(flow.clientId)} --as-url ${shellQuote(asUrl)} --format json`,
    exchangeCurl: `curl -sS -X POST ${shellQuote(`${asUrl}/oauth/token`)} \\\n  -H 'Content-Type: application/json' \\\n  --data ${shellQuote(
      JSON.stringify({
        client_id: flow.clientId,
        device_code: flow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      })
    )}`,
    introspectCurl: flow.token
      ? `curl -sS -X POST ${shellQuote(`${asUrl}/introspect`)} \\\n  -H 'Content-Type: application/json' \\\n  --data ${shellQuote(JSON.stringify({ token: flow.token }))}`
      : `curl -sS -X POST ${shellQuote(`${asUrl}/introspect`)} \\\n  -H 'Content-Type: application/json' \\\n  --data '{"token":"<token>"}'`,
    ownerReadExample: flow.token
      ? `curl -sS ${shellQuote(`${rsUrl}/v1/streams`)} -H 'Authorization: Bearer ${flow.token}'`
      : `curl -sS ${shellQuote(`${rsUrl}/v1/streams`)} -H 'Authorization: Bearer <token>'`,
    // Curl examples mirror what the BFF actually sends on the wire:
    // application/json bodies with the owner-session cookie, using the
    // documented isJsonRequest CSRF exemption. /device/approve does not
    // accept subject_id from the body — the AS derives it from the session.
    startCurl: `curl -sS -X POST ${shellQuote(`${asUrl}/oauth/device_authorization`)} \\\n  -H 'Content-Type: application/json' \\\n  --data ${shellQuote(JSON.stringify({ client_id: flow.clientId }))}`,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
