// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Managed connector child environment policy. This is propagation control, not a sandbox.
 * Values compose in order: reviewed platform input, operator-approved
 * installation bindings, connection fragment, then explicit run controls.
 * Manifest declarations are logical needs only; they never name a source
 * environment variable. Reserved names cannot enter through an installation
 * binding or the connection fragment.
 */
const PLATFORM_KEYS = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "PLAYWRIGHT_BROWSERS_PATH",
  "PATCHRIGHT_BROWSERS_PATH",
  "PDPP_RUNTIME_BROWSER",
  "PDPP_BROWSER_HEADLESS",
  "PDPP_BROWSER_CHANNEL",
  "PDPP_FORCE_CONTAINER",
  "PDPP_ALLOW_HEADED_CONTAINER_BROWSER",
  "PDPP_BROWSER_PROFILE_ROOT",
  "PDPP_BROWSER_EXTRA_ARGS",
  "PDPP_BROWSER_SURFACE_DIAGNOSTICS",
  "PDPP_TRACE",
  "PDPP_CAPTURE_FIXTURES",
  "PDPP_CAPTURE_ON_FAILURE",
  "PDPP_CAPTURE_ROOT_DIR",
  "PDPP_CAPTURE_ARIA_DEPTH",
  "PDPP_SESSION_ESTABLISH_WATCHDOG_MS",
  "PDPP_WEB_BASE_URL",
  "PDPP_REFERENCE_ORIGIN",
  "PDPP_CONNECTOR_ARTIFACT_ROOT",
  "PDPP_DB_PATH",
  "GMCLI_BIN",
  "GMCLI_TIMEOUT_MS",
  "GMCLI_MESSAGES_PER_CHAT_LIMIT",
  "GMCLI_MAX_CHATS",
  "SLACKDUMP_BIN",
  "SLACKDUMP_MAX_RUNTIME_MS",
  "SLACKDUMP_PROGRESS_INTERVAL_MS",
  "SLACKDUMP_TIMEOUT_MS",
  "PDPP_SLACK_SKIP_SLACKDUMP",
  "PDPP_AMAZON_YEARS",
  "PDPP_AMAZON_SKIP_DETAIL",
  "WHATSAPP_MAX_ARCHIVE_BYTES",
  "WHATSAPP_MAX_MESSAGE_COUNT",
  "PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES",
  "PDPP_GMAIL_ATTACHMENT_BACKFILL_WINDOW_UIDS",
  "PDPP_GMAIL_ATTACHMENT_PROGRESS_MIN_BYTES",
  "PDPP_GMAIL_ATTACHMENT_PROGRESS_MIN_INTERVAL_MS",
  "PDPP_GMAIL_ATTACHMENT_RECOVERY_PAGE_BYTES",
  "PDPP_GMAIL_ATTACHMENT_STALL_TIMEOUT_MS",
  "PDPP_GMAIL_MAX_ATTACHMENT_BYTES",
  "PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS",
  "PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER",
  "PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN",
  "PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS",
  "PDPP_CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN",
  "PDPP_CHATGPT_PACING_BURST_TOLERANCE_MS",
  "PDPP_CHATGPT_PACING_INITIAL_INTERVAL_MS",
  "PDPP_CHATGPT_PACING_MAX_INTERVAL_MS",
  "PDPP_CHATGPT_PACING_MIN_INTERVAL_MS",
  "PDPP_CHATGPT_PACING_RECOVERY_GAIN",
  "PDPP_CHATGPT_RETRY_BUDGET_CAPACITY",
  "PDPP_CHATGPT_RETRY_BUDGET_INITIAL_TOKENS",
  "PDPP_CHATGPT_CIRCUIT_BREAKER",
  "PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS",
  "PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS",
  "PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS",
  "PDPP_IMESSAGE_MAX_ATTACHMENT_BYTES",
  "PDPP_APPLE_PHOTOS_MAX_PHOTO_BYTES",
  "PDPP_GOOGLE_TAKEOUT_MAX_PHOTO_BYTES",
] as const;

const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"] as const;

const RUN_KEYS = [
  "PDPP_CONNECTOR_ID",
  "PDPP_CONNECTOR_INSTANCE_ID",
  "PDPP_OWNER_TOKEN",
  "PDPP_RS_URL",
  "PDPP_REFERENCE_BASE_URL",
  "PDPP_RUN_ID",
  "PDPP_STREAMING_REGISTRATION_TOKEN",
  "PDPP_BROWSER_SURFACE_REQUIRED",
  "PDPP_BROWSER_SURFACE_LEASE_ID",
  "PDPP_BROWSER_SURFACE_PROFILE_KEY",
  "PDPP_BROWSER_SURFACE_ID",
  "PDPP_BROWSER_SURFACE_REMOTE_CDP_URL",
  "PDPP_BROWSER_SURFACE_STREAM_BASE_URL",
  "PDPP_RUN_TRIGGER_KIND",
  "PDPP_RUN_AUTOMATION_MODE",
] as const;
const RESERVED = new Set([...PLATFORM_KEYS, ...RUN_KEYS].map((key) => key.toUpperCase()));

export interface ConnectorChildEnvironmentInput {
  /**
   * Operator-owned bindings for logical manifest requirements. The manifest
   * can request a logical key, but only this authority may choose whether its
   * value comes from the ambient process, a connection fragment, or a literal
   * installation value.
   */
  approvedBindings?: readonly ConnectorEnvironmentBinding[];
  /** Operator-authorized connector IDs that may receive ambient proxy aliases. */
  approvedProxyConnectorIds?: readonly string[];
  connectionEnv?: ConnectorConnectionEnvironment | null;
  /** The connector identity used to evaluate approvedProxyConnectorIds. */
  connectorId?: string;
  explicitRunEnv: Record<string, string>;
  manifest: unknown;
  platform?: NodeJS.Platform;
  sourceEnv?: NodeJS.ProcessEnv;
}

export type ConnectorEnvironmentBindingSource =
  | { readonly kind: "connection_env"; readonly key: string }
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "process_env"; readonly key: string };

export interface ConnectorEnvironmentBinding {
  /** Canonical connector identity authorized to consume this binding. */
  readonly connectorId: string;
  /** Logical key declared by the connector manifest. */
  readonly logicalKey: string;
  /** Explicit operator-selected value source. */
  readonly source: ConnectorEnvironmentBindingSource;
  /** Environment key exposed to the connector child. */
  readonly targetKey: string;
}

/** Runtime-tagged fragment produced by a trusted connection credential resolver. */
export interface ConnectorConnectionEnvironment {
  /** Exact target keys approved by the trusted connection resolver. */
  readonly allowedKeys: readonly string[];
  /** Canonical connector identity that owns this resolver output. */
  readonly connectorId: string;
  readonly kind: "connection";
  readonly values: Readonly<Record<string, string>>;
}

export interface ConnectorEnvironmentPolicy {
  readonly approvedBindings: readonly ConnectorEnvironmentBinding[];
  readonly approvedProxyConnectorIds: readonly string[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function name(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function reserved(value: string): boolean {
  return RESERVED.has(value.toUpperCase());
}

function proxyKey(value: string): boolean {
  return PROXY_KEYS.some((key) => key.toUpperCase() === value.toUpperCase());
}

function environmentKey(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("=") || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty environment key without '=' or NUL`);
  }
  return value;
}

function policyObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unsupported keys: ${unknown.join(", ")}`);
  }
}

/**
 * Parse the operator-owned reference-server policy. The JSON form is kept
 * host-neutral so the same contract works in Docker, Windows, and local runs.
 * Invalid input is fatal rather than silently disabling a requested policy.
 */
function parseBinding(
  rawBinding: unknown,
  index: number,
  label: string,
  targetKeys: Set<string>
): ConnectorEnvironmentBinding {
  const bindingLabel = `${label}.bindings[${index}]`;
  const binding = policyObject(rawBinding, bindingLabel);
  exactKeys(binding, ["connector_id", "logical_key", "source", "target_key"], bindingLabel);
  const connectorId = environmentKey(binding.connector_id, `${bindingLabel}.connector_id`);
  const logical = environmentKey(binding.logical_key, `${bindingLabel}.logical_key`);
  const targetKey = environmentKey(binding.target_key, `${bindingLabel}.target_key`);
  if (reserved(targetKey)) {
    throw new Error(`${bindingLabel}.target_key is reserved`);
  }
  const normalizedTarget = targetKey.toUpperCase();
  const targetScope = `${connectorId}\0${normalizedTarget}`;
  if (targetKeys.has(targetScope)) {
    throw new Error(`${label} has duplicate target key ${targetKey}`);
  }
  targetKeys.add(targetScope);
  const source = policyObject(binding.source, `${bindingLabel}.source`);
  if (source.kind === "literal") {
    exactKeys(source, ["kind", "value"], `${bindingLabel}.source`);
    if (typeof source.value !== "string") {
      throw new Error(`${bindingLabel}.source.value must be a string`);
    }
    return { connectorId, logicalKey: logical, source: { kind: "literal", value: source.value }, targetKey };
  }
  if (source.kind !== "process_env" && source.kind !== "connection_env") {
    throw new Error(`${bindingLabel}.source.kind must be process_env, connection_env, or literal`);
  }
  exactKeys(source, ["kind", "key"], `${bindingLabel}.source`);
  const key = environmentKey(source.key, `${bindingLabel}.source.key`);
  return { connectorId, logicalKey: logical, source: { key, kind: source.kind }, targetKey };
}

function parseProxyConnectorIds(root: Record<string, unknown>, label: string): string[] {
  const rawProxyConnectorIds = root.proxy_connector_ids ?? [];
  if (!Array.isArray(rawProxyConnectorIds)) {
    throw new Error(`${label}.proxy_connector_ids must be an array`);
  }
  const connectorIds: string[] = [];
  const seen = new Set<string>();
  for (const [index, rawConnectorId] of rawProxyConnectorIds.entries()) {
    if (typeof rawConnectorId !== "string" || rawConnectorId.trim().length === 0) {
      throw new Error(`${label}.proxy_connector_ids[${index}] must be a non-empty string`);
    }
    const connectorId = rawConnectorId.trim();
    if (seen.has(connectorId)) {
      throw new Error(`${label} has duplicate proxy connector ID ${connectorId}`);
    }
    seen.add(connectorId);
    connectorIds.push(connectorId);
  }
  return connectorIds;
}

export function parseConnectorEnvironmentPolicy(
  raw: unknown,
  label = "connector environment policy"
): ConnectorEnvironmentPolicy {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${label} must contain valid JSON`, { cause: error });
    }
  }
  if (value === undefined || value === null) {
    return { approvedBindings: [], approvedProxyConnectorIds: [] };
  }
  const root = policyObject(value, label);
  exactKeys(root, ["bindings", "proxy_connector_ids"], label);
  const rawBindings = root.bindings ?? [];
  if (!Array.isArray(rawBindings)) {
    throw new Error(`${label}.bindings must be an array`);
  }
  const targetKeys = new Set<string>();
  return {
    approvedBindings: rawBindings.map((binding, index) => parseBinding(binding, index, label, targetKeys)),
    approvedProxyConnectorIds: parseProxyConnectorIds(root, label),
  };
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function logicalKey(value: unknown): string | null {
  if (typeof value === "string") {
    // Legacy declarations remain usable as logical identifiers. They are
    // never read from sourceEnv unless an operator binding names the source.
    return name(value);
  }
  const entry = record(value);
  return name(entry.logical_key);
}

function addLogicalValues(out: Set<string>, value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      addLogicalValues(out, entry);
    }
    return;
  }
  if (typeof value === "string") {
    const key = name(value);
    if (key) {
      out.add(key);
    }
    return;
  }
  const key = logicalKey(value);
  if (key) {
    out.add(key);
  }
}

function declaredLogicalKeys(manifest: unknown): string[] {
  const out = new Set<string>();
  const root = record(manifest);
  const requirements = record(root.runtime_requirements);
  for (const entry of list(requirements.environment_variables)) {
    const key = logicalKey(entry);
    if (key) {
      out.add(key);
    }
  }
  const paths = record(requirements.local_paths);
  const home = logicalKey(paths.home_env_override);
  if (home) {
    out.add(home);
  }
  for (const path of list(paths.paths)) {
    const key = logicalKey(record(path).env_override);
    if (key) {
      out.add(key);
    }
  }
  for (const tool of list(requirements.external_tools)) {
    const key = logicalKey(record(record(tool).detect).executable_env_override);
    if (key) {
      out.add(key);
    }
  }
  const setup = record(root.setup);
  addLogicalValues(out, setup.deployment_config);
  const credentialCapture = record(setup.credential_capture);
  for (const field of list(credentialCapture.fields)) {
    addLogicalValues(out, record(field).env);
  }
  const manualOrUpload = record(setup.manual_or_upload);
  addLogicalValues(out, manualOrUpload.import_dir_env_var);
  const auth = record(record(root.capabilities).auth);
  addLogicalValues(out, auth.required);
  for (const entry of list(auth.deployment_config)) {
    addLogicalValues(out, entry);
  }
  for (const entry of list(auth.connection_config)) {
    const config = record(entry);
    addLogicalValues(out, config.env_var);
  }
  return [...out];
}

function connectionValues(
  fragment: ConnectorConnectionEnvironment | null | undefined,
  connectorId: string | undefined,
  proxyAuthorized: boolean
): Record<string, string> {
  if (fragment === null || fragment === undefined) {
    return {};
  }
  if (
    fragment.kind !== "connection" ||
    typeof fragment.connectorId !== "string" ||
    !Array.isArray(fragment.allowedKeys) ||
    !fragment.values ||
    typeof fragment.values !== "object"
  ) {
    throw new Error("connectionEnv must be a tagged connection fragment");
  }
  if (connectorId === undefined || fragment.connectorId !== connectorId) {
    throw new Error("connectionEnv connector identity does not match the active connector");
  }
  const allowedKeys = new Set<string>();
  for (const [index, allowedKey] of fragment.allowedKeys.entries()) {
    const key = environmentKey(allowedKey, `connectionEnv.allowedKeys[${index}]`);
    const normalizedKey = key.toUpperCase();
    if (allowedKeys.has(normalizedKey)) {
      throw new Error(`connectionEnv.allowedKeys has duplicate key ${key}`);
    }
    allowedKeys.add(normalizedKey);
  }
  const valueKeys = new Set<string>();
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(fragment.values)) {
    validateConnectionValueKey(key, valueKeys, allowedKeys, proxyAuthorized);
    if (typeof value !== "string") {
      throw new Error(`connectionEnv.${key} must be a string`);
    }
    values[key] = value;
  }
  return values;
}

function validateConnectionValueKey(
  key: string,
  valueKeys: Set<string>,
  allowedKeys: Set<string>,
  proxyAuthorized: boolean
): void {
  environmentKey(key, "connectionEnv key");
  if (reserved(key)) {
    throw new Error(`connectionEnv key ${key} is reserved`);
  }
  const normalizedKey = key.toUpperCase();
  if (valueKeys.has(normalizedKey)) {
    throw new Error(`connectionEnv has duplicate key alias ${key}`);
  }
  valueKeys.add(normalizedKey);
  if (!allowedKeys.has(normalizedKey)) {
    throw new Error(`connectionEnv has unsupported key ${key}`);
  }
  if (proxyKey(key) && !proxyAuthorized) {
    throw new Error(`connectionEnv proxy key ${key} requires connector-scoped operator authority`);
  }
}

function apply(
  target: Record<string, string>,
  values: Record<string, string>,
  platform: NodeJS.Platform,
  rejectReserved: boolean
): void {
  for (const [key, value] of Object.entries(values)) {
    if (shouldReject(key, rejectReserved)) {
      continue;
    }
    deleteCaseInsensitiveKey(target, key, platform);
    target[key] = value;
  }
}

function shouldReject(key: string, rejectReserved: boolean): boolean {
  return rejectReserved ? reserved(key) : false;
}

function deleteCaseInsensitiveKey(target: Record<string, string>, key: string, platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    return;
  }
  for (const prior of Object.keys(target)) {
    if (prior.toUpperCase() === key.toUpperCase()) {
      delete target[prior];
    }
  }
}

function sourceKey(source: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") {
    return key;
  }
  const matches = Object.keys(source).filter((candidate) => candidate.toUpperCase() === key.toUpperCase());
  if (matches.length > 1) {
    throw new Error(`ambiguous Windows environment aliases for ${key}`);
  }
  return matches[0];
}

function hasCaseInsensitiveKey(values: Record<string, string>, key: string): boolean {
  return Object.keys(values).some((candidate) => candidate.toUpperCase() === key.toUpperCase());
}

function addPlatformValue(
  target: Record<string, string>,
  source: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform
): void {
  const match = sourceKey(source, key, platform);
  if (match === undefined) {
    return;
  }
  const value = source[match];
  if (value === undefined) {
    return;
  }
  if (platform === "win32") {
    if (hasCaseInsensitiveKey(target, match)) {
      return;
    }
    target[match] = value;
    return;
  }
  target[key] = value;
}

function platformValues(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  includeProxyEnvironment: boolean
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PLATFORM_KEYS) {
    addPlatformValue(out, source, key, platform);
  }
  if (includeProxyEnvironment) {
    for (const key of PROXY_KEYS) {
      addPlatformValue(out, source, key, platform);
    }
  }
  return out;
}

function declaredLocalPathValues(
  manifest: unknown,
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Record<string, string> {
  const runtime = record(record(manifest).runtime_requirements);
  const localPaths = record(runtime.local_paths);
  const keys: unknown[] = [localPaths.home_env_override];
  for (const path of Array.isArray(localPaths.paths) ? localPaths.paths : []) {
    keys.push(record(path).env_override);
  }
  const out: Record<string, string> = {};
  for (const rawKey of keys) {
    const key = name(rawKey);
    if (!key || reserved(key)) {
      continue;
    }
    const value = sourceValue(source, key, platform);
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function sourceValue(source: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  const resolvedKey = sourceKey(source, key, platform);
  return resolvedKey === undefined ? undefined : source[resolvedKey];
}

function approvedBindingValues(
  bindings: readonly ConnectorEnvironmentBinding[] | undefined,
  logicalKeys: readonly string[],
  connectorId: string | undefined,
  proxyAuthorized: boolean,
  sourceEnv: NodeJS.ProcessEnv,
  connectionEnv: Record<string, string>,
  platform: NodeJS.Platform
): Record<string, string> {
  const declared = new Set(logicalKeys);
  const out: Record<string, string> = {};
  for (const binding of bindings ?? []) {
    if (
      binding.connectorId !== connectorId ||
      !declared.has(binding.logicalKey) ||
      reserved(binding.targetKey) ||
      (proxyKey(binding.targetKey) && !proxyAuthorized)
    ) {
      continue;
    }
    let value: string | undefined;
    if (binding.source.kind === "literal") {
      const { value: literalValue } = binding.source;
      value = literalValue;
    } else if (binding.source.kind === "connection_env") {
      value = sourceValue(connectionEnv, binding.source.key, platform);
    } else {
      value = sourceValue(sourceEnv, binding.source.key, platform);
    }
    if (value !== undefined) {
      deleteCaseInsensitiveKey(out, binding.targetKey, platform);
      out[binding.targetKey] = value;
    }
  }
  return out;
}

export function composeConnectorChildEnvironment(input: ConnectorChildEnvironmentInput): Record<string, string> {
  const source = input.sourceEnv ?? process.env;
  const platform = input.platform ?? process.platform;
  const policy = parseConnectorEnvironmentPolicy(
    {
      bindings: (input.approvedBindings ?? []).map((binding) => ({
        connector_id: binding.connectorId,
        logical_key: binding.logicalKey,
        source: binding.source,
        target_key: binding.targetKey,
      })),
      proxy_connector_ids: input.approvedProxyConnectorIds ?? [],
    },
    "approved connector environment policy"
  );
  const env: Record<string, string> = {};
  const proxyAuthorized =
    input.connectorId !== undefined && policy.approvedProxyConnectorIds.includes(input.connectorId);
  const connectionEnv = connectionValues(input.connectionEnv, input.connectorId, proxyAuthorized);
  apply(env, platformValues(source, platform, proxyAuthorized), platform, false);
  apply(env, declaredLocalPathValues(input.manifest, source, platform), platform, false);
  apply(
    env,
    approvedBindingValues(
      policy.approvedBindings,
      declaredLogicalKeys(input.manifest),
      input.connectorId,
      proxyAuthorized,
      source,
      connectionEnv,
      platform
    ),
    platform,
    true
  );
  apply(env, connectionEnv, platform, true);
  apply(env, input.explicitRunEnv, platform, false);
  return env;
}
