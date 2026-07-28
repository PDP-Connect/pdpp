// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
const DEFAULT_SCOPE = "pdpp:read";
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const TRAILING_SLASH_RE = /\/$/;
const TRAILING_SLASHES_RE = /\/+$/;

export class ConnectError extends Error {
  code: string;
  exitCode: number;

  constructor(code: string, message: string, exitCode = 69) {
    super(message);
    this.name = "ConnectError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

type FetchFn = typeof fetch;

// Provider-supplied JSON payloads (OAuth protected-resource / authorization-server
// metadata, connect-start/poll responses, client registration). These come from
// external HTTP servers with no compile-time contract; fields below are the ones
// this module reads, all optional since a provider may omit any of them.
interface ProtectedResourceMetadata {
  agent_connect_endpoint?: string;
  authorization_server?: string;
  authorization_servers?: string[];
  pdpp_agent_discovery?: {
    cli?: { no_owner_token?: boolean; no_owner_token_policy?: string };
    agent_connect_endpoint?: string;
  };
  resource?: string;
}

interface AuthorizationServerMetadata {
  agent_connect_endpoint?: string;
  issuer?: string;
  pdpp_agent_connect_endpoint?: string;
  pdpp_agent_discovery?: { agent_connect_endpoint?: string };
  pdpp_registration_modes_supported?: string[];
  registration_endpoint?: string;
}

interface PublicClient {
  client_id?: string;
  client_name?: string;
  token_endpoint_auth_method?: string;
}

interface ConnectStartResponse {
  approval_url?: string;
  client_id?: string;
  completion_endpoint?: string;
  device_poll_endpoint?: string;
  interval?: number;
  interval_ms?: number;
  poll_url?: string;
  polling_code?: string;
  token_url?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
}

interface ConnectPollCredential {
  access_token?: string;
  expires_at?: string;
  grant_id?: string;
  scope?: string;
  token_type?: string;
}

interface ConnectPollResponse {
  access_token?: string;
  code?: string;
  credential?: ConnectPollCredential;
  error?: { code?: string } | string;
  expires_at?: string;
  grant_id?: string;
  scope?: string;
  status?: string;
  token_type?: string;
}

interface ConnectRequestErrorBody {
  code?: string;
  error?: { code?: string; message?: string } | string;
  error_description?: string;
  message?: string;
}

interface StoredCredentialFile {
  client?: PublicClient;
  credential?: ConnectPollCredential;
}

export interface ConnectIo {
  stderr: NodeJS.WritableStream;
  stdout: NodeJS.WritableStream;
}

export interface ConnectProviderOptions {
  cacheRoot?: string;
  fetch?: FetchFn;
  io?: ConnectIo;
  now?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  scope?: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface ConnectProviderResult {
  authorizationServerUrl: string;
  cacheFile: string;
  clientId: string | null;
  providerUrl: string;
  scope: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this function's branching mirrors the OAuth/device-flow protocol's distinct terminal states; splitting it would scatter closely-related error handling.
export async function connectProvider(
  providerUrl: string,
  options: ConnectProviderOptions = {}
): Promise<ConnectProviderResult> {
  const normalizedProviderUrl = normalizeProviderUrl(providerUrl);
  if (!normalizedProviderUrl) {
    throw new ConnectError("invalid_provider_url", `Invalid provider URL: ${providerUrl}`, 64);
  }

  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new ConnectError("fetch_unavailable", "This Node runtime does not provide fetch().");
  }

  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  const cacheRoot = options.cacheRoot ?? ".pdpp";
  const scope = options.scope ?? DEFAULT_SCOPE;
  const resourceMetadata = await discoverProtectedResourceMetadata(normalizedProviderUrl, fetchFn);
  const cliDiscovery = resourceMetadata.pdpp_agent_discovery?.cli;
  if (cliDiscovery?.no_owner_token === false) {
    const policy = cliDiscovery.no_owner_token_policy ? ` Policy: ${cliDiscovery.no_owner_token_policy}.` : "";
    throw new ConnectError(
      "connect_not_supported",
      `Provider metadata does not advertise a complete no-owner-token connect flow.${policy}`
    );
  }
  const authorizationServerUrl = selectAuthorizationServer(resourceMetadata, normalizedProviderUrl);
  if (!authorizationServerUrl) {
    throw new ConnectError(
      "metadata_failure",
      "Protected-resource metadata did not include a valid authorization server."
    );
  }
  const authorizationMetadata = await discoverAuthorizationServerMetadata(authorizationServerUrl, fetchFn);
  const connectEndpoint = findAgentConnectEndpoint(resourceMetadata, authorizationMetadata);

  if (!connectEndpoint) {
    throw new ConnectError(
      "connect_not_supported",
      "Provider metadata does not advertise a no-owner-token agent connect endpoint yet. Backend must expose pdpp_agent_discovery.agent_connect_endpoint or agent_connect_endpoint before this command can complete."
    );
  }

  const publicClient = await getOrRegisterPublicClient({
    fetchFn,
    authorizationMetadata,
    cacheRoot,
    providerUrl: normalizedProviderUrl,
    clientName: "PDPP CLI",
  });

  const startRequest: Record<string, string> = {
    resource: normalizedProviderUrl,
    scope,
    client_name: "PDPP CLI",
  };
  if (publicClient?.client_id) {
    startRequest.client_id = publicClient.client_id;
  }

  const start = await postJson<ConnectStartResponse>(fetchFn, connectEndpoint, startRequest);

  const approvalUrl = start.approval_url ?? start.verification_uri_complete ?? start.verification_uri;
  const pollUrl = start.poll_url ?? start.token_url ?? start.device_poll_endpoint ?? start.completion_endpoint;
  if (!(approvalUrl && pollUrl)) {
    throw new ConnectError(
      "connect_contract_invalid",
      "Agent connect start response must include approval_url and a polling token URL."
    );
  }

  io.stdout.write(`Open this URL to approve access:\n${approvalUrl}\n`);
  if (start.user_code) {
    io.stdout.write(`Enter code: ${start.user_code}\n`);
  }
  io.stdout.write("Waiting for approval...\n");

  const pollOptions: PollForCredentialOptions = {
    intervalMs: Number(start.interval_ms ?? start.interval ?? options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
    timeoutMs: options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
  };
  if (options.sleep) {
    pollOptions.sleep = options.sleep;
  }
  if (options.now) {
    pollOptions.now = options.now;
  }
  if (start.polling_code) {
    pollOptions.pollingCode = start.polling_code;
  }
  const credential = await pollForCredential(fetchFn, pollUrl, pollOptions);

  await verifySchema(fetchFn, normalizedProviderUrl, credential.access_token);
  const cacheFile = await storeCredential(cacheRoot, normalizedProviderUrl, {
    provider_url: normalizedProviderUrl,
    authorization_server: authorizationServerUrl,
    scope,
    client: publicClient,
    credential,
    created_at: new Date(options.now?.() ?? Date.now()).toISOString(),
  });

  io.stdout.write(
    `Connected to ${normalizedProviderUrl}\nStored scoped credentials in ${cacheFile}\nVerified /v1/schema\n`
  );

  return {
    providerUrl: normalizedProviderUrl,
    authorizationServerUrl,
    cacheFile,
    scope,
    clientId: publicClient?.client_id ?? null,
  };
}

export interface ReadStoredCredentialOptions {
  cacheRoot?: string | undefined;
  now?: () => number;
}

export interface ReadStoredCredentialResult {
  cacheFile: string;
  credential: ConnectPollCredential;
  payload: StoredCredentialFile;
  providerUrl: string;
}

export async function readStoredCredential(
  providerUrl: string,
  options: ReadStoredCredentialOptions = {}
): Promise<ReadStoredCredentialResult> {
  const normalizedProviderUrl = normalizeProviderUrl(providerUrl);
  if (!normalizedProviderUrl) {
    throw new ConnectError("invalid_provider_url", `Invalid provider URL: ${providerUrl}`, 64);
  }

  const cacheRoot = options.cacheRoot ?? ".pdpp";
  const cacheFile = getCredentialCacheFile(cacheRoot, normalizedProviderUrl);
  let payload: StoredCredentialFile;
  try {
    payload = JSON.parse(await readFile(cacheFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      // biome-ignore lint/style/useErrorCause: ConnectError's constructor (code, message, exitCode) has no cause param; the ENOENT branch is self-explanatory and the original error is preserved via `throw error` below for non-ENOENT cases.
      throw new ConnectError(
        "not_connected",
        `No PDPP credential found for ${normalizedProviderUrl}. Run pdpp connect ${normalizedProviderUrl} first.`
      );
    }
    throw error;
  }

  const credential = payload?.credential;
  if (!credential?.access_token) {
    throw new ConnectError("credential_invalid", `Credential cache entry is missing an access token: ${cacheFile}`);
  }

  if (credential.expires_at) {
    const expiresAtMs = Date.parse(credential.expires_at);
    const now = options.now?.() ?? Date.now();
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= now) {
      throw new ConnectError(
        "credential_expired",
        `Credential for ${normalizedProviderUrl} expired. Run pdpp connect ${normalizedProviderUrl} again.`
      );
    }
  }

  return { cacheFile, payload, credential, providerUrl: normalizedProviderUrl };
}

export function normalizeProviderUrl(value: string): string | null {
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = trimTrailingSlash(parsed.pathname);
    if (parsed.pathname === "/") {
      parsed.pathname = "";
    }
    return parsed.toString().replace(TRAILING_SLASH_RE, "");
  } catch {
    return null;
  }
}

export async function discoverProtectedResourceMetadata(
  providerUrl: string,
  fetchFn: FetchFn = globalThis.fetch
): Promise<ProtectedResourceMetadata> {
  const metadataUrl = new URL(PROTECTED_RESOURCE_METADATA_PATH, providerUrl).toString();
  const metadata = await getJson<ProtectedResourceMetadata>(fetchFn, metadataUrl, "metadata_failure");
  if (metadata.resource && normalizeProviderUrl(metadata.resource) !== providerUrl) {
    throw new ConnectError(
      "metadata_failure",
      `Protected-resource metadata resource mismatch: expected ${providerUrl}.`
    );
  }
  return metadata;
}

export async function discoverAuthorizationServerMetadata(
  issuerUrl: string,
  fetchFn: FetchFn = globalThis.fetch
): Promise<AuthorizationServerMetadata> {
  const metadataUrl = new URL(AUTHORIZATION_SERVER_METADATA_PATH, issuerUrl).toString();
  const metadata = await getJson<AuthorizationServerMetadata>(fetchFn, metadataUrl, "metadata_failure");
  if (metadata.issuer && normalizeProviderUrl(metadata.issuer) !== normalizeProviderUrl(issuerUrl)) {
    throw new ConnectError("metadata_failure", "Authorization-server metadata issuer mismatch.");
  }
  return metadata;
}

function selectAuthorizationServer(resourceMetadata: ProtectedResourceMetadata, providerUrl: string): string | null {
  const servers = resourceMetadata.authorization_servers;
  const selected = Array.isArray(servers) ? servers[0] : resourceMetadata.authorization_server;
  return normalizeProviderUrl(selected ?? providerUrl);
}

function findAgentConnectEndpoint(
  resourceMetadata: ProtectedResourceMetadata,
  authorizationMetadata: AuthorizationServerMetadata
): string | null {
  const endpoint =
    authorizationMetadata.agent_connect_endpoint ??
    authorizationMetadata.pdpp_agent_connect_endpoint ??
    authorizationMetadata.pdpp_agent_discovery?.agent_connect_endpoint ??
    resourceMetadata.agent_connect_endpoint ??
    resourceMetadata.pdpp_agent_discovery?.agent_connect_endpoint;
  if (!endpoint) {
    return null;
  }
  try {
    return new URL(endpoint, authorizationMetadata.issuer ?? resourceMetadata.resource).toString();
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: ConnectError's constructor (code, message, exitCode) has no cause param; the original error's message is interpolated into the thrown message instead.
    throw new ConnectError(
      "metadata_failure",
      `Agent connect endpoint in provider metadata is not a valid URL: ${(error as Error).message}.`
    );
  }
}

function findRegistrationEndpoint(authorizationMetadata: AuthorizationServerMetadata): string | null {
  const endpoint = authorizationMetadata.registration_endpoint;
  if (!endpoint) {
    return null;
  }
  const modes = authorizationMetadata.pdpp_registration_modes_supported;
  if (Array.isArray(modes) && !modes.includes("dynamic")) {
    return null;
  }
  try {
    return new URL(endpoint, authorizationMetadata.issuer).toString();
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: ConnectError's constructor (code, message, exitCode) has no cause param; the original error's message is interpolated into the thrown message instead.
    throw new ConnectError(
      "metadata_failure",
      `Registration endpoint in provider metadata is not a valid URL: ${(error as Error).message}.`
    );
  }
}

interface GetOrRegisterPublicClientArgs {
  authorizationMetadata: AuthorizationServerMetadata;
  cacheRoot: string;
  clientName: string;
  fetchFn: FetchFn;
  providerUrl: string;
}

async function getOrRegisterPublicClient({
  fetchFn,
  authorizationMetadata,
  cacheRoot,
  providerUrl,
  clientName,
}: GetOrRegisterPublicClientArgs): Promise<PublicClient | null> {
  const cached = await readCachedClientRegistration(cacheRoot, providerUrl);
  if (cached) {
    return cached;
  }
  const registrationEndpoint = findRegistrationEndpoint(authorizationMetadata);
  if (!registrationEndpoint) {
    return null;
  }
  const registered = await postJson<PublicClient>(fetchFn, registrationEndpoint, {
    client_name: clientName,
    token_endpoint_auth_method: "none",
  });
  if (!registered?.client_id) {
    throw new ConnectError(
      "connect_contract_invalid",
      "Dynamic client registration response did not include client_id."
    );
  }
  return {
    client_id: registered.client_id,
    client_name: registered.client_name ?? clientName,
    token_endpoint_auth_method: registered.token_endpoint_auth_method ?? "none",
  };
}

async function readCachedClientRegistration(cacheRoot: string, providerUrl: string): Promise<PublicClient | null> {
  try {
    const payload: StoredCredentialFile = JSON.parse(
      await readFile(getCredentialCacheFile(cacheRoot, providerUrl), "utf8")
    );
    const { client } = payload;
    return client?.client_id ? client : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

interface PollForCredentialOptions {
  intervalMs: number;
  now?: (() => number) | undefined;
  pollingCode?: string | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  timeoutMs: number;
}

interface PolledCredential {
  access_token: string;
  expires_at?: string | undefined;
  grant_id?: string | undefined;
  scope?: string | undefined;
  token_type: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this function's branching mirrors the OAuth/device-flow protocol's distinct terminal states; splitting it would scatter closely-related error handling.
async function pollForCredential(
  fetchFn: FetchFn,
  pollUrl: string,
  options: PollForCredentialOptions
): Promise<PolledCredential> {
  const startedAt = options.now?.() ?? Date.now();
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)));

  while ((options.now?.() ?? Date.now()) - startedAt <= options.timeoutMs) {
    // biome-ignore lint/performance/noAwaitInLoops: intentional sequential polling with backoff, not a parallelizable batch.
    const result = await postJson<ConnectPollResponse>(
      fetchFn,
      pollUrl,
      options.pollingCode ? { polling_code: options.pollingCode } : {}
    );
    const errorObj = typeof result.error === "object" ? result.error : undefined;
    const errorStatus = errorObj?.code ?? result.error ?? result.code;
    if (errorStatus === "access_denied") {
      throw new ConnectError("approval_denied", "Owner denied the delegated access request.");
    }
    if (errorStatus === "expired_token") {
      throw new ConnectError("approval_expired", "Delegated access approval expired. Run connect again.");
    }
    if (errorStatus === "insufficient_scope") {
      throw new ConnectError("insufficient_scope", "Approved grant did not include the required PDPP scope.");
    }
    const status = result.status ?? (result.access_token ? "approved" : "pending");

    if (status === "approved") {
      const credential = result.credential ?? result;
      if (!credential.access_token) {
        throw new ConnectError(
          "token_verification_failed",
          "Approved connect response did not include an access token."
        );
      }
      return {
        access_token: credential.access_token,
        token_type: credential.token_type ?? "Bearer",
        expires_at: credential.expires_at,
        grant_id: credential.grant_id ?? result.grant_id,
        scope: credential.scope,
      };
    }

    if (status === "pending" || status === "authorization_pending") {
      await sleep(options.intervalMs);
      continue;
    }

    if (status === "denied" || status === "access_denied") {
      throw new ConnectError("approval_denied", "Owner denied the delegated access request.");
    }

    if (status === "expired" || status === "expired_token") {
      throw new ConnectError("approval_expired", "Delegated access approval expired. Run connect again.");
    }

    if (status === "insufficient_scope") {
      throw new ConnectError("insufficient_scope", "Approved grant did not include the required PDPP scope.");
    }

    throw new ConnectError("connect_contract_invalid", `Unexpected connect polling status: ${status}`);
  }

  throw new ConnectError("approval_expired", "Timed out waiting for delegated access approval.");
}

async function verifySchema(fetchFn: FetchFn, providerUrl: string, accessToken: string | undefined): Promise<Response> {
  const response = await fetchFn(new URL("/v1/schema", providerUrl), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 403) {
    throw new ConnectError("insufficient_scope", "Grant cannot read /v1/schema; required scope is missing.");
  }
  if (response.status === 401) {
    throw new ConnectError("token_verification_failed", "Grant token was rejected by /v1/schema.");
  }
  if (!response.ok) {
    throw new ConnectError("token_verification_failed", `/v1/schema verification failed with HTTP ${response.status}.`);
  }
  return response;
}

interface StoredCredentialPayload {
  authorization_server: string;
  client: PublicClient | null;
  created_at: string;
  credential: PolledCredential;
  provider_url: string;
  scope: string;
}

async function storeCredential(
  cacheRoot: string,
  providerUrl: string,
  payload: StoredCredentialPayload
): Promise<string> {
  const cacheFile = getCredentialCacheFile(cacheRoot, providerUrl);
  await mkdir(dirname(cacheFile), { recursive: true, mode: 0o700 });
  await ensurePdppGitignore(cacheRoot);
  await writeFile(cacheFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return cacheFile;
}

function getCredentialCacheFile(cacheRoot: string, providerUrl: string): string {
  const host = new URL(providerUrl).host.replace(/[^a-zA-Z0-9.-]/g, "_");
  return join(cacheRoot, "clients", `${host}.json`);
}

async function ensurePdppGitignore(cacheRoot: string): Promise<void> {
  const gitignorePath = join(cacheRoot, ".gitignore");
  let current = "";
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch {
    // absent .gitignore is expected on first run
  }
  if (current.includes("*")) {
    return;
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const prefix = current && !current.endsWith("\n") ? `${current}\n` : current;
  await writeFile(gitignorePath, `${prefix}*\n!.gitignore\n`, { mode: 0o600 });
}

async function getJson<T>(fetchFn: FetchFn, url: string, errorCode: string): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { Accept: "application/json" } });
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: ConnectError's constructor (code, message, exitCode) has no cause param; the original error's message is interpolated into the thrown message instead.
    throw new ConnectError(errorCode, `Failed to fetch ${url}: ${(error as Error).message}.`);
  }
  if (!response.ok) {
    throw new ConnectError(errorCode, `Failed to fetch ${url}: HTTP ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(fetchFn: FetchFn, url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: ConnectError's constructor (code, message, exitCode) has no cause param; the original error's message is interpolated into the thrown message instead.
    throw new ConnectError("connect_request_failed", `Connect request failed at ${url}: ${(error as Error).message}.`);
  }
  if (!response.ok) {
    let errBody: ConnectRequestErrorBody | null = null;
    try {
      errBody = (await response.json()) as ConnectRequestErrorBody;
    } catch {
      // non-JSON error body is treated as absent detail below
    }
    const nestedError = typeof errBody?.error === "object" ? errBody.error : undefined;
    const errorCode = nestedError?.code ?? errBody?.error ?? errBody?.code;
    if (errorCode === "access_denied") {
      throw new ConnectError("approval_denied", "Owner denied the delegated access request.");
    }
    if (errorCode === "expired_token") {
      throw new ConnectError("approval_expired", "Delegated access approval expired. Run connect again.");
    }
    if (errorCode === "insufficient_scope") {
      throw new ConnectError("insufficient_scope", "Approved grant did not include the required PDPP scope.");
    }
    if (errorCode === "invalid_grant") {
      throw new ConnectError("token_verification_failed", "Provider rejected the agent-connect polling handle.");
    }
    const detail = nestedError?.message ?? errBody?.error_description ?? errBody?.message;
    const suffix = detail ? ` ${detail}` : "";
    throw new ConnectError(
      "connect_request_failed",
      `Connect request failed at ${url}: HTTP ${response.status}.${suffix}`
    );
  }
  return response.json() as Promise<T>;
}

function trimTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(TRAILING_SLASHES_RE, "") : value;
}
