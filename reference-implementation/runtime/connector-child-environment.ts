// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Managed connector child environment policy. This is propagation control, not a sandbox.
 * Values compose in order: reviewed platform input, current-manifest fallback,
 * connection fragment, then explicit run controls. Reserved names cannot enter
 * through manifest fallback or the connection fragment.
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
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
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

/**
 * Shipped connector inputs that predate the manifest fields which now describe
 * ambient fallback. Keep this connector-keyed: putting these names in the
 * platform allowlist would disclose one connector's paths/preferences to every
 * connector child. Delete entries as the corresponding manifests gain honest
 * declarations.
 */
const LEGACY_CONNECTOR_KEYS: Readonly<Record<string, readonly string[]>> = {
  apple_contacts: ["APPLE_CARDDAV_ORIGIN"],
  "apple-health": ["APPLE_HEALTH_EXPORT_DIR"],
  "apple-photos": ["APPLE_PHOTOS_EXPORT_DIR"],
  chase: ["CHASE_2FA_METHOD"],
  "claude-code": ["CLAUDE_CODE_PROJECT_INCLUDE", "CLAUDE_CODE_PROJECT_EXCLUDE"],
  codex: ["CODEX_RULES_DIR", "CODEX_PROMPTS_DIR", "CODEX_SKILLS_DIR"],
  "google-takeout": ["GOOGLE_TAKEOUT_DIR"],
  ical: ["ICAL_IMPORT_DIR", "ICAL_SUBSCRIPTION_URL"],
  imessage: ["IMESSAGE_DB_PATH", "IMESSAGE_ATTACHMENTS_ROOT"],
  slack: [
    "SLACK_LOOKBACK_DAYS",
    "SLACK_CHANNEL_ALLOWLIST",
    "SLACK_CHANNEL_TYPES",
    "SLACK_MEMBER_ONLY",
    "SLACK_SKIP_FILES",
    "SLACK_RECLAIM_UPLOADS",
  ],
  "twitter-archive": ["TWITTER_ARCHIVE_DIR"],
};

export interface ConnectorChildEnvironmentInput {
  connectionEnv?: Record<string, string> | null;
  explicitRunEnv: Record<string, string>;
  manifest: unknown;
  platform?: NodeJS.Platform;
  sourceEnv?: NodeJS.ProcessEnv;
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

function deploymentName(value: unknown): string | null {
  if (typeof value === "string") {
    return name(value);
  }
  const entry = record(value);
  if ("logical_key" in entry) {
    const logicalKey = name(entry.logical_key);
    return logicalKey ? (name(entry.env_alias) ?? logicalKey) : null;
  }
  return name(entry.key);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function allowedName(value: unknown): string | null {
  const candidate = name(value);
  return candidate && !reserved(candidate) ? candidate : null;
}

function addName(names: Set<string>, value: unknown): void {
  const candidate = allowedName(value);
  if (candidate) {
    names.add(candidate);
  }
}

function addNames(names: Set<string>, values: unknown): void {
  for (const value of list(values)) {
    addName(names, value);
  }
}

function addDeploymentNames(names: Set<string>, values: unknown): void {
  for (const value of list(values)) {
    addName(names, deploymentName(value));
  }
}

function addCredentialCaptureNames(names: Set<string>, setup: Record<string, unknown>): void {
  const capture = record(setup.credential_capture);
  for (const field of list(capture.fields)) {
    addNames(names, record(field).env);
  }
}

function addSetupNames(names: Set<string>, setup: Record<string, unknown>): void {
  addDeploymentNames(names, setup.deployment_config);
  addName(names, record(setup.manual_or_upload).import_dir_env_var);
}

function addRuntimeRequirementNames(names: Set<string>, root: Record<string, unknown>): void {
  const requirements = record(root.runtime_requirements);
  const paths = record(requirements.local_paths);
  addName(names, paths.home_env_override);
  for (const path of list(paths.paths)) {
    addName(names, record(path).env_override);
  }
  for (const tool of list(requirements.external_tools)) {
    addName(names, record(record(tool).detect).executable_env_override);
  }
}

function declaredConnectionNames(auth: Record<string, unknown>): string[] {
  return list(auth.connection_config)
    .map((entry) => allowedName(record(entry).env_var))
    .filter((candidate): candidate is string => candidate !== null);
}

function addAuthNames(names: Set<string>, root: Record<string, unknown>): void {
  const auth = record(record(root.capabilities).auth);
  addDeploymentNames(names, auth.deployment_config);
  const connectionNames = declaredConnectionNames(auth);
  if (connectionNames.length > 0) {
    addNames(names, connectionNames);
    return;
  }
  addNames(names, auth.required);
}

function addLegacyConnectorNames(names: Set<string>, root: Record<string, unknown>): void {
  const connectorKey = name(root.connector_key);
  if (!connectorKey) {
    return;
  }
  for (const value of LEGACY_CONNECTOR_KEYS[connectorKey] ?? []) {
    addName(names, value);
  }
}

function declaredNames(manifest: unknown): string[] {
  const out = new Set<string>();
  const root = record(manifest);
  const setup = record(root.setup);
  addCredentialCaptureNames(out, setup);
  addSetupNames(out, setup);
  addRuntimeRequirementNames(out, root);
  addAuthNames(out, root);
  addLegacyConnectorNames(out, root);
  return [...out];
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
  return Object.keys(source).find((candidate) => candidate.toUpperCase() === key.toUpperCase());
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

function platformValues(source: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PLATFORM_KEYS) {
    addPlatformValue(out, source, key, platform);
  }
  return out;
}

function sourceValue(source: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  const resolvedKey = sourceKey(source, key, platform);
  return resolvedKey === undefined ? undefined : source[resolvedKey];
}

export function composeConnectorChildEnvironment(input: ConnectorChildEnvironmentInput): Record<string, string> {
  const source = input.sourceEnv ?? process.env;
  const platform = input.platform ?? process.platform;
  const env: Record<string, string> = {};
  apply(env, platformValues(source, platform), platform, false);
  const ambient = Object.fromEntries(
    declaredNames(input.manifest).flatMap((key) => {
      const value = sourceValue(source, key, platform);
      return value === undefined ? [] : [[key, value]];
    })
  );
  apply(env, ambient, platform, true);
  apply(env, input.connectionEnv ?? {}, platform, true);
  apply(env, input.explicitRunEnv, platform, false);
  return env;
}
