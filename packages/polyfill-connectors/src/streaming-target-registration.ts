/**
 * Reference-internal streaming-target registration client.
 *
 * PUTs/DELETEs an interaction-scoped CDP page-target wsUrl, or POSTs a
 * non-CDP target descriptor, against the reference server's
 * `/admin/runs/:runId/interactions/:interactionId/streaming-target`
 * endpoints. Used by the connector runtime / browser binding when it
 * decides which exact page the human should control for a given
 * `manual_action` interaction, so the reference server's streaming
 * companion factory can resolve the live wsUrl by `(runId, interactionId)`
 * when an operator opens a streaming session for that interaction.
 *
 * Boundary: this is reference-runtime orchestration plumbing, NOT a PDPP
 * wire surface (no manifest fields, no capability vocabulary). The
 * boundary that exists IS the registration HTTP call across the
 * connector-runtime / reference-server process boundary established by
 * `introduce-local-collector-runner`. See:
 *   - openspec/changes/add-run-interaction-streaming-companion/design-notes/
 *     advisor-response-streaming-process-boundary-2026-05-04.md
 *   - openspec/changes/add-run-interaction-streaming-companion/design-notes/
 *     implementation-decisions-2026-05-04.md
 *
 * Authority: device-exporter bearer auth, same boundary used by
 * `LocalDeviceClient`. We do NOT mint a new credential type — registration
 * piggybacks on the existing local-collector authority. The reference
 * server's per-run nonce path (Mode A, in-process runtime) is also
 * accepted transparently — the same nonce authenticates registrations
 * for any interactionId within its run.
 *
 * Failure mode: every method is best-effort. Network errors, 401/403/4xx
 * from the server, malformed wsUrl — all surface as `false` from
 * `register`/`unregister`. The browser launch and the connector run MUST
 * proceed regardless. The honest consequence of a failed registration is
 * that streaming will not work for that interaction; the records still flow.
 */

const REGISTRATION_PATH = (runId: string, interactionId: string): string =>
  `/admin/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(interactionId)}/streaming-target`;

const ALLOWED_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export interface RegistrationLogger {
  /**
   * Best-effort warn channel; we keep the surface intentionally tiny so
   * `console` and pino-style loggers both satisfy the type.
   */
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface CreateRegistrationClientOptions {
  /**
   * Reference server base URL — the same value the surrounding collector
   * runner uses when calling `LocalDeviceClient`.
   */
  readonly baseUrl: string;
  /**
   * Device-exporter bearer token, sourced from collector-runner enrollment.
   * Without this, the reference server's `requireDeviceExporterCredential`
   * middleware rejects with 401, so the client should not be constructed
   * at all when the token is absent — let the call site decide.
   */
  readonly deviceToken: string;
  /**
   * Injectable for tests. Defaults to `globalThis.fetch`. Honours the
   * standard `fetch` typing.
   */
  readonly fetch?: typeof fetch;
  /**
   * Optional structured logger. Defaults to a logger that writes to
   * `process.stderr`, since this code runs inside the connector runtime
   * which uses stdio for protocol traffic.
   */
  readonly logger?: RegistrationLogger;
}

interface RegisterMetadataArgs {
  readonly pageTitle?: string;
  /**
   * Optional diagnostic metadata. Forward-compatible: the server accepts,
   * stores, and surfaces these on debug paths but does not consult them
   * for resolution. Useful for "why did the operator see THIS page?"
   * postmortems.
   */
  readonly pageUrl?: string;
  readonly reason?: string;
}

interface BaseRegisterArgs extends RegisterMetadataArgs {
  /**
   * Interaction id (e.g. `int_…`) of the manual_action this page handoff
   * belongs to. The composite `(runId, interactionId)` is the registry key;
   * a single run may host multiple manual_action interactions over its
   * lifetime, each bound to its own page identity.
   */
  readonly interactionId: string;
  /** Stable run id (e.g. `run_…`) shared between connector and server. */
  readonly runId: string;
}

export interface CdpRegisterArgs extends BaseRegisterArgs {
  /**
   * CDP remains the default to preserve existing callers that only pass
   * `wsUrl`.
   */
  readonly backend?: "cdp";
  /**
   * Page-target CDP WebSocket URL. MUST be loopback (`127.0.0.1` or
   * `localhost`) or the registration is short-circuited locally; the
   * server enforces the same constraint.
   */
  readonly wsUrl: string;
}

export type NekoTargetDescriptor = Readonly<Record<string, unknown>>;

export interface NekoRegisterArgs extends BaseRegisterArgs {
  readonly backend: "neko";
  /**
   * Opaque n.eko target descriptor owned by the reference server. It is not
   * a CDP bearer URL, so the client forwards it without loopback wsUrl
   * validation.
   */
  readonly descriptor: NekoTargetDescriptor;
}

/**
 * Legacy CDP registration args. Kept as the CDP-only alias so existing
 * contextual callback types can keep treating `wsUrl` as required.
 */
export type RegisterArgs = CdpRegisterArgs;

export type StreamingTargetRegisterArgs = RegisterArgs | NekoRegisterArgs;

export interface UnregisterArgs {
  readonly interactionId: string;
  readonly runId: string;
}

export interface RegistrationClient {
  /**
   * PUT /admin/runs/:runId/interactions/:interactionId/streaming-target
   *
   * Idempotent: same-value re-PUT for an existing key succeeds silently;
   * different-value PUT replaces the prior value (the server logs a
   * diagnostic warn). Returns true on 2xx, false on any failure
   * (network, HTTP, validation). Never throws.
   */
  register(args: StreamingTargetRegisterArgs): Promise<boolean>;
  /**
   * DELETE /admin/runs/:runId/interactions/:interactionId/streaming-target
   * Returns true on 2xx, false on any failure. Never throws. Cleanup is
   * best-effort; a stale record will be evicted by the server's TTL.
   */
  unregister(args: UnregisterArgs): Promise<boolean>;
}

const defaultLogger: RegistrationLogger = {
  warn(message, data) {
    const suffix = data ? ` ${JSON.stringify(data)}` : "";
    process.stderr.write(`[streaming-registration] ${message}${suffix}\n`);
  },
};

/**
 * Defensive check: refuse to ship a non-loopback wsUrl across the wire.
 * The reference server validates this too (and also strips path / scheme
 * leakage from logs), but doing it here avoids paying a network round-trip
 * to discover an obvious mistake AND avoids the path component (which
 * encodes the page-target id, treated as a bearer secret) ever leaving
 * this process for a non-loopback destination.
 */
function isLoopbackWsUrl(wsUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(wsUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return false;
  }
  return ALLOWED_LOOPBACK_HOSTS.has(parsed.hostname);
}

function isDescriptorObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addOptionalMetadata(
  body: Record<string, unknown>,
  { pageUrl, pageTitle, reason }: RegisterMetadataArgs
): void {
  if (typeof pageUrl === "string" && pageUrl.length > 0) {
    body.page_url = pageUrl;
  }
  if (typeof pageTitle === "string" && pageTitle.length > 0) {
    body.page_title = pageTitle;
  }
  if (typeof reason === "string" && reason.length > 0) {
    body.reason = reason;
  }
}

/**
 * Construct a registration client bound to a base URL and device token.
 * The client never throws; all errors are logged + returned as `false`.
 */
export function createRegistrationClient(options: CreateRegistrationClientOptions): RegistrationClient {
  if (!options.baseUrl) {
    throw new Error("createRegistrationClient: baseUrl required");
  }
  if (!options.deviceToken) {
    throw new Error("createRegistrationClient: deviceToken required");
  }
  const baseUrl = new URL(options.baseUrl);
  const fetchImpl: typeof fetch = options.fetch ?? globalThis.fetch;
  const logger: RegistrationLogger = options.logger ?? defaultLogger;
  const authHeader = `Bearer ${options.deviceToken}`;

  if (typeof fetchImpl !== "function") {
    throw new Error("createRegistrationClient: no fetch implementation available");
  }

  return {
    async register(args: StreamingTargetRegisterArgs): Promise<boolean> {
      const { runId, interactionId } = args;
      if (!runId) {
        logger.warn("register skipped: runId is empty");
        return false;
      }
      if (!interactionId) {
        logger.warn("register skipped: interactionId is empty", { runId });
        return false;
      }

      let method: "POST" | "PUT";
      let body: Record<string, unknown>;
      if (args.backend === "neko") {
        if (!isDescriptorObject(args.descriptor)) {
          logger.warn("register skipped: neko descriptor is not an object", { runId, interactionId });
          return false;
        }
        method = "POST";
        body = { backend: "neko", descriptor: args.descriptor };
      } else {
        const { wsUrl } = args;
        if (!isLoopbackWsUrl(wsUrl)) {
          // We deliberately do NOT log the rejected URL — the path component
          // is a bearer secret. Just say what failed.
          logger.warn("register skipped: wsUrl is not loopback ws:/wss:", { runId, interactionId });
          return false;
        }
        method = "PUT";
        body = { ws_url: wsUrl };
      }
      addOptionalMetadata(body, args);

      let response: Response;
      try {
        response = await fetchImpl(new URL(REGISTRATION_PATH(runId, interactionId), baseUrl), {
          method,
          headers: {
            accept: "application/json",
            authorization: authHeader,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("register failed (network error)", { runId, interactionId, error: message });
        return false;
      }
      if (!response.ok) {
        // Drain the response so the underlying socket can be reused. The
        // reference server's response shape is the standard `pdppError`
        // envelope; we don't surface its body — the most useful signal
        // for the operator is `status`, since 401/403 means token issue
        // and 4xx other means client bug.
        await response.text().catch((): undefined => undefined);
        logger.warn("register failed", { runId, interactionId, status: response.status });
        return false;
      }
      // Drain successful body too.
      await response.text().catch((): undefined => undefined);
      return true;
    },

    async unregister({ runId, interactionId }: UnregisterArgs): Promise<boolean> {
      if (!(runId && interactionId)) {
        return false;
      }
      let response: Response;
      try {
        response = await fetchImpl(new URL(REGISTRATION_PATH(runId, interactionId), baseUrl), {
          method: "DELETE",
          headers: {
            accept: "application/json",
            authorization: authHeader,
          },
        });
      } catch (err) {
        // Cleanup is best-effort; warn quietly. The server's TTL sweeps
        // stale records anyway.
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("unregister failed (network error)", { runId, interactionId, error: message });
        return false;
      }
      if (!response.ok) {
        await response.text().catch((): undefined => undefined);
        // 404 is the common case (server already swept the record, or
        // we never registered) — don't elevate noise.
        if (response.status !== 404) {
          logger.warn("unregister failed", { runId, interactionId, status: response.status });
        }
        return false;
      }
      await response.text().catch((): undefined => undefined);
      return true;
    },
  };
}

/** Exported for tests that want to validate URL shapes without a server. */
export { ALLOWED_LOOPBACK_HOSTS, REGISTRATION_PATH };

/**
 * Two env var names exist for the bearer credential the registration
 * client sends to the reference server, one per deployment mode:
 *
 *  - `PDPP_STREAMING_REGISTRATION_TOKEN` — Mode A (in-process runtime).
 *    The reference server's controller mints a per-run nonce at spawn
 *    time and passes it to the connector child. The server-side route
 *    accepts the nonce against a per-run nonce store. There is no
 *    "device" in Mode A — the parent process is the issuing authority.
 *    The same nonce authenticates registrations for any interactionId
 *    that arises during the run.
 *
 *  - `PDPP_LOCAL_DEVICE_TOKEN` — Mode B (collector-runner). A separate
 *    collector process (often on the operator's host) holds a real
 *    device-exporter bearer token and forwards it to the connector
 *    child. The server-side route accepts the token against the
 *    device-exporter authority. The collector boundary is the place
 *    where the device identity is real.
 *
 * The route handler accepts EITHER auth shape transparently; the env
 * var name disambiguates which mode the child is operating in for
 * diagnostics, and lets us evolve the two modes' semantics independently
 * without conflating them in one env namespace.
 */
const STREAMING_REGISTRATION_TOKEN_ENV = "PDPP_STREAMING_REGISTRATION_TOKEN";
const LOCAL_DEVICE_TOKEN_ENV = "PDPP_LOCAL_DEVICE_TOKEN";

export interface StreamingTargetRegistrationHooks {
  register(args: RegisterArgs): Promise<boolean>;
  readonly runId: string;
  unregister(args: UnregisterArgs): Promise<boolean>;
}

/**
 * Resolve optional streaming-target registration hooks from env vars.
 *
 * Returns `undefined` when ANY of the three required pieces (runId,
 * reference base URL, registration bearer token) is missing. This is the
 * "honest no-op" mode: connector runs that aren't spawned with the
 * registration env vars simply skip registration, and operator-side
 * streaming for that run will be unavailable.
 *
 * `interactionId` is intentionally NOT sourced from env: it is per-call
 * runtime context (a single run can have multiple manual_action
 * interactions, each with its own page identity). Callers pass it on
 * each `register()` call.
 *
 * Token precedence: `PDPP_STREAMING_REGISTRATION_TOKEN` wins over
 * `PDPP_LOCAL_DEVICE_TOKEN`. The two correspond to different deployment
 * modes (in-process runtime vs collector-runner) — see the env-var
 * comment block above. Either token is accepted by the server-side route.
 *
 * Why env vars: the runtime entry point is the connector subprocess
 * itself. Whatever spawned it (collector-runner OR in-process runtime)
 * is the right place to pass in `runId` + bearer context. Existing
 * patterns (PDPP_TRACE, PDPP_CAPTURE_FIXTURES, PDPP_*_HEADLESS) all use
 * the same env-var channel.
 */
export function resolveStreamingRegistrationFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<StreamingTargetRegistrationHooks | undefined> {
  const runId = env.PDPP_RUN_ID?.trim();
  const baseUrl = env.PDPP_REFERENCE_BASE_URL?.trim();
  const registrationToken = env[STREAMING_REGISTRATION_TOKEN_ENV]?.trim();
  const deviceToken = env[LOCAL_DEVICE_TOKEN_ENV]?.trim();
  // Per-run nonce wins over device token. The two carry different
  // authorities; the route accepts either.
  const bearerToken = registrationToken || deviceToken;
  if (!(runId && baseUrl && bearerToken)) {
    if (runId && !(baseUrl && bearerToken)) {
      // Operator likely intended to enable streaming but hasn't wired up
      // the bearer context yet. Surface this honestly so it's easy to
      // diagnose. Don't include the token value or the URL itself
      // (URL may carry an embedded token in some setups).
      process.stderr.write(
        "[streaming-registration] PDPP_RUN_ID set but PDPP_REFERENCE_BASE_URL or " +
          `${STREAMING_REGISTRATION_TOKEN_ENV}/${LOCAL_DEVICE_TOKEN_ENV} missing; ` +
          "streaming-companion target not registered for this run.\n"
      );
    }
    return Promise.resolve(undefined);
  }
  const client = createRegistrationClient({ baseUrl, deviceToken: bearerToken });
  return Promise.resolve({
    runId,
    register: (args): Promise<boolean> => client.register(args),
    unregister: (args): Promise<boolean> => client.unregister(args),
  });
}

/** Exported for tests that want to assert env-var precedence. */
export { LOCAL_DEVICE_TOKEN_ENV, STREAMING_REGISTRATION_TOKEN_ENV };
