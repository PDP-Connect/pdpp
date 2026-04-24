/**
 * Server-only helpers for the dashboard owner-token bootstrap flow.
 *
 * These wrap the real public device/introspection endpoints and keep only
 * ephemeral dashboard state in memory so the UI can step through the flow
 * without inventing a second token minting surface.
 */
import {
  getAsInternalUrl,
  getReferencePublicOrigin,
  ReferenceServerUnreachableError,
  withOwnerSessionCookie,
} from "./owner-token.ts";

export const DASHBOARD_BOOTSTRAP_CLIENT_ID = "pdpp-web-dashboard";

export type OwnerBootstrapFlow = {
  flowId: string;
  clientId: string;
  subjectId: string | null;
  status: "pending_approval" | "approved" | "denied" | "token_issued";
  startedAt: string;
  expiresAt: string | null;
  intervalSeconds: number;
  deviceCode: string;
  userCode: string;
  verificationUri: string | null;
  verificationUriComplete: string | null;
  approvalUpdatedAt: string | null;
  tokenIssuedAt: string | null;
  token: string | null;
  tokenResponse: Record<string, unknown> | null;
  introspection: Record<string, unknown> | null;
  introspectedAt: string | null;
  lastError: string | null;
};

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

function asForm(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
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

export async function startOwnerBootstrapFlow(clientId = DASHBOARD_BOOTSTRAP_CLIENT_ID): Promise<OwnerBootstrapFlow> {
  const response = await fetchAs("/oauth/device_authorization", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: asForm({ client_id: clientId }),
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
    flowId: crypto.randomUUID(),
    clientId,
    subjectId: null,
    status: "pending_approval",
    startedAt: new Date().toISOString(),
    expiresAt:
      typeof payload.expires_in === "number" ? new Date(Date.now() + payload.expires_in * 1000).toISOString() : null,
    intervalSeconds: typeof payload.interval === "number" ? payload.interval : 5,
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri ?? null,
    verificationUriComplete: payload.verification_uri_complete ?? null,
    approvalUpdatedAt: null,
    tokenIssuedAt: null,
    token: null,
    tokenResponse: null,
    introspection: null,
    introspectedAt: null,
    lastError: null,
  };

  return saveFlow(flow);
}

export async function approveOwnerBootstrapFlow(flowId: string, subjectId: string): Promise<OwnerBootstrapFlow> {
  const flow = requireFlow(flowId);
  const response = await fetchAs("/device/approve", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: asForm({ user_code: flow.userCode, subject_id: subjectId }),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `device approval failed (${response.status})`));
  }
  return saveFlow({
    ...flow,
    subjectId,
    status: "approved",
    approvalUpdatedAt: new Date().toISOString(),
    lastError: null,
  });
}

export async function denyOwnerBootstrapFlow(flowId: string, subjectId: string): Promise<OwnerBootstrapFlow> {
  const flow = requireFlow(flowId);
  const response = await fetchAs("/device/deny", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: asForm({ user_code: flow.userCode, subject_id: subjectId }),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `device denial failed (${response.status})`));
  }
  return saveFlow({
    ...flow,
    subjectId,
    status: "denied",
    approvalUpdatedAt: new Date().toISOString(),
    token: null,
    tokenResponse: null,
    introspection: null,
    introspectedAt: null,
    lastError: null,
  });
}

export async function exchangeOwnerBootstrapToken(flowId: string): Promise<OwnerBootstrapFlow> {
  const flow = requireFlow(flowId);
  const response = await fetchAs("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: asForm({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: flow.deviceCode,
      client_id: flow.clientId,
    }),
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
    status: "token_issued",
    token: payload.access_token,
    tokenResponse: payload,
    tokenIssuedAt: new Date().toISOString(),
    lastError: null,
  });
}

export async function introspectOwnerBootstrapToken(flowId: string): Promise<OwnerBootstrapFlow> {
  const flow = requireFlow(flowId);
  if (!flow.token) {
    throw new Error("No token available yet for introspection");
  }
  const response = await fetchAs("/introspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: flow.token }),
  });
  const body = await readBody(response);
  if (!(response.ok && body) || typeof body !== "object") {
    throw new Error(describeError(body, `introspection failed (${response.status})`));
  }
  return saveFlow({
    ...flow,
    introspection: body as Record<string, unknown>,
    introspectedAt: new Date().toISOString(),
    lastError: null,
  });
}

export async function buildOwnerBootstrapExamples(flow: OwnerBootstrapFlow) {
  const referenceOrigin = await getReferencePublicOrigin();
  const asUrl = referenceOrigin;
  const rsUrl = referenceOrigin;
  return {
    cliLogin: `pdpp auth login --client-id ${shellQuote(flow.clientId)} --as-url ${shellQuote(asUrl)} --format json`,
    cliIntrospect: flow.token
      ? `pdpp auth introspect --as-url ${shellQuote(asUrl)} --token ${shellQuote(flow.token)} --format json`
      : "pdpp auth introspect --as-url <as-url> --token <token> --format json",
    startCurl: `curl -sS -X POST ${shellQuote(`${asUrl}/oauth/device_authorization`)} \\\n  -H 'Content-Type: application/x-www-form-urlencoded' \\\n  --data ${shellQuote(asForm({ client_id: flow.clientId }))}`,
    approveCurl: `curl -sS -X POST ${shellQuote(`${asUrl}/device/approve`)} \\\n  -H 'Content-Type: application/x-www-form-urlencoded' \\\n  --data ${shellQuote(asForm({ user_code: flow.userCode, subject_id: flow.subjectId ?? "owner_local" }))}`,
    exchangeCurl: `curl -sS -X POST ${shellQuote(`${asUrl}/oauth/token`)} \\\n  -H 'Content-Type: application/x-www-form-urlencoded' \\\n  --data ${shellQuote(
      asForm({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: flow.deviceCode,
        client_id: flow.clientId,
      })
    )}`,
    introspectCurl: flow.token
      ? `curl -sS -X POST ${shellQuote(`${asUrl}/introspect`)} \\\n  -H 'Content-Type: application/json' \\\n  --data ${shellQuote(JSON.stringify({ token: flow.token }))}`
      : `curl -sS -X POST ${shellQuote(`${asUrl}/introspect`)} \\\n  -H 'Content-Type: application/json' \\\n  --data '{"token":"<token>"}'`,
    ownerReadExample: flow.token
      ? `curl -sS ${shellQuote(`${rsUrl}/v1/streams`)} -H 'Authorization: Bearer ${flow.token}'`
      : `curl -sS ${shellQuote(`${rsUrl}/v1/streams`)} -H 'Authorization: Bearer <token>'`,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
