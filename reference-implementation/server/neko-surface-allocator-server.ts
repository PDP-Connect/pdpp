import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BROWSER_SURFACE_BACKEND_NEKO,
  type BrowserSurface,
  type BrowserSurfaceHealth,
  type EnsureBrowserSurfaceRequest,
  type StopBrowserSurfaceRequest,
} from "@pdpp/remote-surface/leases";

const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const DEFAULT_LABEL_NAMESPACE = "org.pdpp.reference.neko";
const DEFAULT_CONTAINER_HTTP_PORT = 8080;
const DEFAULT_CONTAINER_CDP_PORT = 9223;
const DEFAULT_NEKO_HEALTH_PATH = "/neko/health";
const DEFAULT_STREAM_HEALTH_PATH = "/api/room/screen/cast.jpg";
const DEFAULT_CDP_VERSION_PATH = "/json/version";
const DEFAULT_ALLOCATOR_HOST = "0.0.0.0";
const DEFAULT_ALLOCATOR_PORT = 7331;
const LEADING_SLASH_RE = /^\//;
const TRAILING_SLASHES_RE = /\/+$/;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface DockerContainerSummary {
  readonly Id: string;
  readonly Labels?: Record<string, string>;
  readonly Names?: readonly string[];
  readonly Ports?: readonly DockerPortSummary[];
  readonly State?: string;
}

interface DockerPortSummary {
  readonly PrivatePort?: number;
  readonly PublicPort?: number;
  readonly Type?: string;
}

interface DockerContainerInspect {
  readonly Config?: {
    readonly Labels?: Record<string, string>;
  };
  readonly Id: string;
  readonly Name?: string;
  readonly NetworkSettings?: {
    readonly Ports?: Record<string, readonly DockerPortBinding[] | null>;
    readonly Networks?: Record<string, unknown>;
  };
  readonly State?: {
    readonly Running?: boolean;
    readonly Status?: string;
  };
}

interface DockerPortBinding {
  readonly HostIp?: string;
  readonly HostPort?: string;
}

export interface DockerEngineTransport {
  requestJson(path: string, init?: DockerEngineRequestInit): Promise<unknown>;
}

export interface DockerEngineRequestInit {
  readonly body?: unknown;
  readonly method?: string;
  readonly okStatuses?: readonly number[];
  readonly query?: Readonly<Record<string, string>>;
}

export interface NekoSurfaceAllocatorServerOptions {
  readonly cdpBaseUrlTemplate: string;
  readonly cdpVersionPath?: string;
  readonly containerCdpPort?: number;
  readonly containerHttpPort?: number;
  readonly docker?: DockerEngineTransport;
  readonly dockerSocketPath?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly fetchImpl?: FetchLike;
  readonly image: string;
  readonly labelNamespace?: string;
  readonly listenHost?: string;
  readonly listenPort?: number;
  readonly nekoHealthPath?: string;
  readonly network: string;
  readonly now?: () => Date;
  readonly profileRoot: string;
  readonly streamBaseUrlTemplate: string;
  readonly streamHealthPath?: string;
  readonly webrtcHostPortEnd: number;
  readonly webrtcHostPortStart: number;
}

interface ResourceNames {
  readonly containerName: string;
  readonly profileHash: string;
  readonly profilePath: string;
  readonly profileSlug: string;
}

interface SurfaceRequest extends EnsureBrowserSurfaceRequest {
  readonly accountKey?: string;
}

export class DockerEngineHttpClient implements DockerEngineTransport {
  readonly #socketPath: string;

  constructor(options: { socketPath?: string } = {}) {
    this.#socketPath = options.socketPath ?? DEFAULT_DOCKER_SOCKET_PATH;
  }

  requestJson(path: string, init: DockerEngineRequestInit = {}): Promise<unknown> {
    const method = init.method ?? "GET";
    const query = new URLSearchParams(init.query ?? {});
    const requestPath = query.size > 0 ? `${path}?${query.toString()}` : path;
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const okStatuses = new Set(init.okStatuses ?? [200]);

    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.#socketPath,
          path: requestPath,
          method,
          headers:
            body === undefined
              ? undefined
              : { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const payload = Buffer.concat(chunks).toString("utf8");
            if (!okStatuses.has(res.statusCode ?? 0)) {
              reject(
                new NekoSurfaceAllocatorServiceError(
                  "docker_http_error",
                  `Docker ${method} ${path} returned HTTP ${String(res.statusCode)}`
                )
              );
              return;
            }
            if (payload.length === 0) {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(payload) as unknown);
            } catch (cause) {
              reject(
                new NekoSurfaceAllocatorServiceError(
                  "docker_malformed_response",
                  `Docker ${method} ${path} returned invalid JSON`,
                  { cause }
                )
              );
            }
          });
        }
      );
      req.on("error", (cause) =>
        reject(
          new NekoSurfaceAllocatorServiceError("docker_request_failed", `Docker ${method} ${path} failed`, { cause })
        )
      );
      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }
}

export class NekoSurfaceAllocatorServiceError extends Error {
  readonly code:
    | "bad_request"
    | "docker_http_error"
    | "docker_malformed_response"
    | "docker_request_failed"
    | "foreign_resource"
    | "not_found"
    | "port_capacity_exhausted"
    | "readiness_failed";

  constructor(code: NekoSurfaceAllocatorServiceError["code"], message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NekoSurfaceAllocatorServiceError";
    this.code = code;
  }
}

export class NekoSurfaceAllocatorService {
  readonly #options: Required<
    Pick<
      NekoSurfaceAllocatorServerOptions,
      | "containerCdpPort"
      | "containerHttpPort"
      | "fetchImpl"
      | "labelNamespace"
      | "nekoHealthPath"
      | "streamHealthPath"
      | "cdpVersionPath"
      | "now"
    >
  > &
    Omit<
      NekoSurfaceAllocatorServerOptions,
      | "containerCdpPort"
      | "containerHttpPort"
      | "fetchImpl"
      | "labelNamespace"
      | "nekoHealthPath"
      | "streamHealthPath"
      | "cdpVersionPath"
      | "now"
    >;
  readonly #docker: DockerEngineTransport;

  constructor(options: NekoSurfaceAllocatorServerOptions) {
    assertAllocatorOptions(options);
    this.#options = {
      ...options,
      containerCdpPort: options.containerCdpPort ?? DEFAULT_CONTAINER_CDP_PORT,
      containerHttpPort: options.containerHttpPort ?? DEFAULT_CONTAINER_HTTP_PORT,
      fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
      labelNamespace: options.labelNamespace ?? DEFAULT_LABEL_NAMESPACE,
      nekoHealthPath: options.nekoHealthPath ?? DEFAULT_NEKO_HEALTH_PATH,
      streamHealthPath: options.streamHealthPath ?? DEFAULT_STREAM_HEALTH_PATH,
      cdpVersionPath: options.cdpVersionPath ?? DEFAULT_CDP_VERSION_PATH,
      now: options.now ?? (() => new Date()),
    };
    this.#docker =
      options.docker ??
      new DockerEngineHttpClient(
        options.dockerSocketPath === undefined ? {} : { socketPath: options.dockerSocketPath }
      );
  }

  async ensureSurface(request: SurfaceRequest): Promise<BrowserSurface> {
    assertSurfaceRequest(request);
    const existing = await this.#findOwnedContainer(request.surfaceId);
    if (existing !== null) {
      this.#assertContainerMatchesRequest(existing, request);
      if (!isInspectRunning(existing)) {
        await this.#startContainer(existing.Id);
      }
      return this.#surfaceFromInspect(await this.#inspectContainer(existing.Id), request);
    }

    const port = await this.#allocateHostPort();
    const names = this.#resourceNames(request);
    const labels = this.#labelsForRequest(request, names, port);
    const created = await this.#docker.requestJson("/containers/create", {
      method: "POST",
      query: { name: names.containerName },
      body: {
        Image: this.#options.image,
        Labels: labels,
        Env: this.#containerEnv(request, port),
        ExposedPorts: {
          [`${String(this.#options.containerHttpPort)}/tcp`]: {},
          [`${String(this.#options.containerCdpPort)}/tcp`]: {},
          [`${String(port)}/tcp`]: {},
          [`${String(port)}/udp`]: {},
        },
        HostConfig: {
          Binds: [`${names.profilePath}:/home/user/.config/chromium`],
          NetworkMode: this.#options.network,
          PortBindings: {
            [`${String(port)}/tcp`]: [{ HostPort: String(port) }],
            [`${String(port)}/udp`]: [{ HostPort: String(port) }],
          },
        },
      },
      okStatuses: [201],
    });
    const containerId = readCreatedContainerId(created);
    await this.#startContainer(containerId);
    return this.#surfaceFromInspect(await this.#inspectContainer(containerId), request);
  }

  async getSurfaceStatus(surfaceId: string): Promise<BrowserSurface | null> {
    assertNonEmpty(surfaceId, "surface_id");
    const inspect = await this.#findOwnedContainer(surfaceId);
    return inspect === null ? null : this.#surfaceFromInspect(inspect);
  }

  async stopSurface(request: StopBrowserSurfaceRequest): Promise<BrowserSurface | null> {
    assertNonEmpty(request.surfaceId, "surface_id");
    const inspect = await this.#findOwnedContainer(request.surfaceId);
    if (inspect === null) {
      return null;
    }
    await this.#docker.requestJson(`/containers/${encodeURIComponent(inspect.Id)}/stop`, {
      method: "POST",
      okStatuses: [204, 304],
    });
    return this.#surfaceFromInspect(await this.#inspectContainer(inspect.Id));
  }

  async listSurfaces(): Promise<BrowserSurface[]> {
    const containers = await this.#listOwnedContainers();
    const surfaces = await Promise.all(containers.map((container) => this.#surfaceFromInspectId(container.Id)));
    return surfaces.sort((a, b) => a.surface_id.localeCompare(b.surface_id));
  }

  async #surfaceFromInspectId(containerId: string): Promise<BrowserSurface> {
    return this.#surfaceFromInspect(await this.#inspectContainer(containerId));
  }

  async #surfaceFromInspect(inspect: DockerContainerInspect, request?: SurfaceRequest): Promise<BrowserSurface> {
    const labels = this.#ownedLabels(inspect);
    const surfaceId = labels[`${this.#options.labelNamespace}.surface_id`];
    const profileKey = labels[`${this.#options.labelNamespace}.profile_key`];
    const connectorId = labels[`${this.#options.labelNamespace}.connector_id`];
    if (surfaceId === undefined || profileKey === undefined || connectorId === undefined) {
      throw new NekoSurfaceAllocatorServiceError(
        "foreign_resource",
        "managed container is missing required PDPP labels"
      );
    }
    const hostPort = readHostPort(inspect, Number(labels[`${this.#options.labelNamespace}.webrtc_host_port`]));
    const containerName = inspect.Name?.replace(LEADING_SLASH_RE, "") ?? "";
    const cdpUrl = this.#expandTemplate(this.#options.cdpBaseUrlTemplate, surfaceId, hostPort, containerName);
    const streamBaseUrl = this.#expandTemplate(this.#options.streamBaseUrlTemplate, surfaceId, hostPort, containerName);
    const readiness = await this.#readiness({ inspect, cdpUrl, streamBaseUrl });
    const now = this.#options.now().toISOString();
    const accountKey = request?.accountKey ?? labels[`${this.#options.labelNamespace}.account_key`];
    const surface: BrowserSurface = {
      surface_id: surfaceId,
      backend: BROWSER_SURFACE_BACKEND_NEKO,
      profile_key: profileKey,
      connector_id: connectorId,
      cdp_url: cdpUrl,
      stream_base_url: streamBaseUrl,
      health: readiness.health,
      created_at: labels[`${this.#options.labelNamespace}.created_at`] ?? now,
      last_used_at: now,
      container_id: inspect.Id,
      allocator_metadata: {
        container_name: containerName,
        host_port: String(hostPort),
        image: this.#options.image,
        network: this.#options.network,
        profile_path: labels[`${this.#options.labelNamespace}.profile_path`] ?? "",
        profile_slug: labels[`${this.#options.labelNamespace}.profile_slug`] ?? "",
        readiness: readiness.reason,
        resource_owner: "pdpp-reference",
      },
    };
    if (accountKey !== undefined) {
      return { ...surface, account_key: accountKey };
    }
    return surface;
  }

  async #readiness(input: {
    inspect: DockerContainerInspect;
    cdpUrl: string;
    streamBaseUrl: string;
  }): Promise<{ health: BrowserSurfaceHealth; reason: string }> {
    if (!isInspectRunning(input.inspect)) {
      return { health: "starting", reason: "container_not_running" };
    }
    if (!hasNetwork(input.inspect, this.#options.network)) {
      return { health: "unhealthy", reason: "missing_expected_network" };
    }
    const nekoReady = await probeUrl(
      this.#options.fetchImpl,
      new URL(this.#options.nekoHealthPath, input.streamBaseUrl)
    );
    if (!nekoReady) {
      return { health: "starting", reason: "neko_http_unready" };
    }
    const cdpVersion = await probeJson(
      this.#options.fetchImpl,
      joinUrlPath(input.cdpUrl, this.#options.cdpVersionPath)
    );
    if (!cdpVersion.ok) {
      return { health: "starting", reason: "cdp_unready" };
    }
    if (!looksLikeChromiumVersion(cdpVersion.value)) {
      return { health: "unhealthy", reason: "chromium_unhealthy" };
    }
    const streamReady = await probeUrl(
      this.#options.fetchImpl,
      joinUrlPath(input.streamBaseUrl, this.#options.streamHealthPath)
    );
    if (!streamReady) {
      return { health: "starting", reason: "stream_unready" };
    }
    return { health: "ready", reason: "ready" };
  }

  async #findOwnedContainer(surfaceId: string): Promise<DockerContainerInspect | null> {
    const containers = await this.#listOwnedContainers();
    const matches = containers.filter(
      (container) => container.Labels?.[`${this.#options.labelNamespace}.surface_id`] === surfaceId
    );
    if (matches.length === 0) {
      return null;
    }
    const first = matches[0];
    if (first === undefined) {
      return null;
    }
    return this.#inspectContainer(first.Id);
  }

  async #listOwnedContainers(): Promise<DockerContainerSummary[]> {
    const filters = JSON.stringify({ label: [`${this.#options.labelNamespace}.owner=pdpp-reference`] });
    const value = await this.#docker.requestJson("/containers/json", { query: { all: "true", filters } });
    if (!Array.isArray(value)) {
      throw new NekoSurfaceAllocatorServiceError("docker_malformed_response", "Docker container list was not an array");
    }
    return value.map(parseContainerSummary);
  }

  async #inspectContainer(containerId: string): Promise<DockerContainerInspect> {
    const value = await this.#docker.requestJson(`/containers/${encodeURIComponent(containerId)}/json`);
    return parseContainerInspect(value, this.#options.labelNamespace);
  }

  async #startContainer(containerId: string): Promise<void> {
    await this.#docker.requestJson(`/containers/${encodeURIComponent(containerId)}/start`, {
      method: "POST",
      okStatuses: [204, 304],
    });
  }

  async #allocateHostPort(): Promise<number> {
    const containers = await this.#listOwnedContainers();
    const used = new Set<number>();
    for (const container of containers) {
      for (const port of container.Ports ?? []) {
        if (port.PublicPort !== undefined) {
          used.add(port.PublicPort);
        }
      }
    }
    for (let port = this.#options.webrtcHostPortStart; port <= this.#options.webrtcHostPortEnd; port += 1) {
      if (!used.has(port)) {
        return port;
      }
    }
    throw new NekoSurfaceAllocatorServiceError(
      "port_capacity_exhausted",
      "no configured n.eko WebRTC host ports are available"
    );
  }

  #assertContainerMatchesRequest(inspect: DockerContainerInspect, request: SurfaceRequest): void {
    const labels = this.#ownedLabels(inspect);
    if (
      labels[`${this.#options.labelNamespace}.profile_key`] !== request.profileKey ||
      labels[`${this.#options.labelNamespace}.connector_id`] !== request.connectorId
    ) {
      throw new NekoSurfaceAllocatorServiceError(
        "foreign_resource",
        "surface id is already owned by a different profile or connector"
      );
    }
  }

  #ownedLabels(inspect: DockerContainerInspect): Record<string, string> {
    const labels = inspect.Config?.Labels ?? {};
    if (labels[`${this.#options.labelNamespace}.owner`] !== "pdpp-reference") {
      throw new NekoSurfaceAllocatorServiceError(
        "foreign_resource",
        "Docker resource is not owned by the PDPP reference allocator"
      );
    }
    return labels;
  }

  #resourceNames(request: SurfaceRequest): ResourceNames {
    const profileHash = createHash("sha256").update(request.profileKey).digest("hex").slice(0, 16);
    const surfaceHash = createHash("sha256").update(request.surfaceId).digest("hex").slice(0, 16);
    const profileSlug = `${sanitizeResourceSegment(request.connectorId)}-${profileHash}`;
    return {
      containerName: `pdpp-neko-${sanitizeResourceSegment(request.connectorId)}-${surfaceHash}`,
      profilePath: `${this.#options.profileRoot.replace(TRAILING_SLASHES_RE, "")}/${profileSlug}`,
      profileSlug,
      profileHash,
    };
  }

  #labelsForRequest(request: SurfaceRequest, names: ResourceNames, webrtcHostPort: number): Record<string, string> {
    const labels: Record<string, string> = {
      [`${this.#options.labelNamespace}.owner`]: "pdpp-reference",
      [`${this.#options.labelNamespace}.backend`]: BROWSER_SURFACE_BACKEND_NEKO,
      [`${this.#options.labelNamespace}.surface_id`]: request.surfaceId,
      [`${this.#options.labelNamespace}.connector_id`]: request.connectorId,
      [`${this.#options.labelNamespace}.profile_key`]: request.profileKey,
      [`${this.#options.labelNamespace}.profile_hash`]: names.profileHash,
      [`${this.#options.labelNamespace}.profile_slug`]: names.profileSlug,
      [`${this.#options.labelNamespace}.profile_path`]: names.profilePath,
      [`${this.#options.labelNamespace}.webrtc_host_port`]: String(webrtcHostPort),
      [`${this.#options.labelNamespace}.created_at`]: this.#options.now().toISOString(),
    };
    if (request.accountKey !== undefined) {
      labels[`${this.#options.labelNamespace}.account_key`] = request.accountKey;
    }
    return labels;
  }

  #containerEnv(request: SurfaceRequest, hostPort: number): string[] {
    const env = {
      NEKO_SERVER_BIND: `0.0.0.0:${String(this.#options.containerHttpPort)}`,
      NEKO_SERVER_PATH_PREFIX: "/neko",
      NEKO_SERVER_PROXY: "true",
      NEKO_MEMBER_PROVIDER: "noauth",
      NEKO_SESSION_IMPLICIT_HOSTING: "true",
      NEKO_WEBRTC_UDPMUX: String(hostPort),
      NEKO_WEBRTC_TCPMUX: String(hostPort),
      NEKO_WEBRTC_ICELITE: "1",
      PDPP_NEKO_CDP_PROXY_PORT: String(this.#options.containerCdpPort),
      PDPP_NEKO_SURFACE_ID: request.surfaceId,
      PDPP_NEKO_PROFILE_KEY_HASH: createHash("sha256").update(request.profileKey).digest("hex"),
      PDPP_NEKO_WEBRTC_HOST_PORT: String(hostPort),
      ...(this.#options.extraEnv ?? {}),
    };
    return Object.entries(env).map(([key, value]) => `${key}=${value}`);
  }

  #expandTemplate(template: string, surfaceId: string, hostPort: number, containerName: string): string {
    return template
      .replaceAll("{surface_id}", encodeURIComponent(surfaceId))
      .replaceAll("{host_port}", String(hostPort))
      .replaceAll("{container_name}", encodeURIComponent(containerName));
  }
}

export function createNekoSurfaceAllocatorHttpHandler(service: NekoSurfaceAllocatorService) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await routeAllocatorRequest(service, req, res);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      sendJson(res, statusForError(error), { error: error.message });
    }
  };
}

async function routeAllocatorRequest(
  service: NekoSurfaceAllocatorService,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://allocator.local");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "surfaces") {
    await routeSurfaceCollection(service, req, res);
    return;
  }
  if (parts.length === 2 && parts[0] === "surfaces" && parts[1] !== undefined) {
    await routeSurfaceMember(service, req, res, decodeURIComponent(parts[1]));
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

async function routeSurfaceCollection(
  service: NekoSurfaceAllocatorService,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method === "POST") {
    const body = parseEnsureBody(await readJsonBody(req));
    sendJson(res, 200, { surface: await service.ensureSurface(body) });
    return;
  }
  if (req.method === "GET") {
    sendJson(res, 200, { surfaces: await service.listSurfaces() });
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

async function routeSurfaceMember(
  service: NekoSurfaceAllocatorService,
  req: IncomingMessage,
  res: ServerResponse,
  surfaceId: string
): Promise<void> {
  if (req.method === "GET") {
    await sendSurfaceOrNotFound(res, await service.getSurfaceStatus(surfaceId));
    return;
  }
  if (req.method === "DELETE") {
    const body = await readJsonBody(req);
    await sendSurfaceOrNotFound(res, await service.stopSurface({ surfaceId, reason: parseStopReason(body) }));
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

function sendSurfaceOrNotFound(res: ServerResponse, surface: BrowserSurface | null): void {
  if (surface === null) {
    sendJson(res, 404, { error: "surface_not_found" });
    return;
  }
  sendJson(res, 200, { surface });
}

export function startNekoSurfaceAllocatorServer(
  options: NekoSurfaceAllocatorServerOptions
): Promise<{ close: () => Promise<void>; url: string }> {
  const service = new NekoSurfaceAllocatorService(options);
  const server = createServer(createNekoSurfaceAllocatorHttpHandler(service));
  const listenHost = options.listenHost ?? "127.0.0.1";
  const listenPort = options.listenPort ?? 0;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      const urlHost = listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost;
      resolve({
        url: `http://${urlHost}:${String(address.port)}/`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error === undefined ? closeResolve() : closeReject(error)));
          }),
      });
    });
  });
}

function assertAllocatorOptions(options: NekoSurfaceAllocatorServerOptions): void {
  assertNonEmpty(options.image, "image");
  assertNonEmpty(options.network, "network");
  assertNonEmpty(options.profileRoot, "profileRoot");
  assertNonEmpty(options.streamBaseUrlTemplate, "streamBaseUrlTemplate");
  assertNonEmpty(options.cdpBaseUrlTemplate, "cdpBaseUrlTemplate");
  if (
    !(Number.isInteger(options.webrtcHostPortStart) && Number.isInteger(options.webrtcHostPortEnd)) ||
    options.webrtcHostPortStart > options.webrtcHostPortEnd
  ) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", "invalid WebRTC host port range");
  }
  if (!isAbsolute(options.profileRoot)) {
    throw new NekoSurfaceAllocatorServiceError(
      "bad_request",
      "profileRoot must be a host absolute path because Docker bind mounts are resolved by the Docker daemon"
    );
  }
}

function assertSurfaceRequest(request: SurfaceRequest): void {
  assertNonEmpty(request.surfaceId, "surface_id");
  assertNonEmpty(request.connectorId, "connector_id");
  assertNonEmpty(request.profileKey, "profile_key");
}

function assertNonEmpty(value: string | undefined, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", `${label} must be a non-empty string`);
  }
}

function parseEnsureBody(value: unknown): SurfaceRequest {
  if (!isRecord(value)) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", "request body must be an object");
  }
  const request: SurfaceRequest = {
    surfaceId: requiredBodyString(value, "surface_id"),
    connectorId: requiredBodyString(value, "connector_id"),
    profileKey: requiredBodyString(value, "profile_key"),
  };
  const accountKey = optionalBodyString(value, "account_key");
  return accountKey === undefined ? request : { ...request, accountKey };
}

function parseStopReason(value: unknown): StopBrowserSurfaceRequest["reason"] {
  if (!isRecord(value)) {
    return "operator";
  }
  const reason = optionalBodyString(value, "reason");
  if (reason === "idle_ttl" || reason === "operator" || reason === "reconcile" || reason === "surface_failed") {
    return reason;
  }
  return "operator";
}

function requiredBodyString(value: Record<string, unknown>, key: string): string {
  const parsed = optionalBodyString(value, key);
  if (parsed === undefined) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", `${key} is required`);
  }
  return parsed;
}

function optionalBodyString(value: Record<string, unknown>, key: string): string | undefined {
  const parsed = value[key];
  if (parsed === undefined) {
    return;
  }
  if (typeof parsed !== "string" || parsed.length === 0) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", `${key} must be a non-empty string`);
  }
  return parsed;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (body.length === 0) {
    return {};
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (cause) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", "request body must be JSON", { cause });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function statusForError(error: Error): number {
  if (!(error instanceof NekoSurfaceAllocatorServiceError)) {
    return 500;
  }
  if (error.code === "bad_request") {
    return 400;
  }
  if (error.code === "not_found") {
    return 404;
  }
  if (error.code === "foreign_resource") {
    return 409;
  }
  if (error.code === "port_capacity_exhausted") {
    return 503;
  }
  return 502;
}

function parseContainerSummary(value: unknown): DockerContainerSummary {
  if (!isRecord(value) || typeof value.Id !== "string") {
    throw new NekoSurfaceAllocatorServiceError("docker_malformed_response", "Docker container summary is malformed");
  }
  return value as unknown as DockerContainerSummary;
}

function parseContainerInspect(value: unknown, labelNamespace: string): DockerContainerInspect {
  if (!isRecord(value) || typeof value.Id !== "string") {
    throw new NekoSurfaceAllocatorServiceError("docker_malformed_response", "Docker inspect response is malformed");
  }
  const inspect = value as unknown as DockerContainerInspect;
  if (inspect.Config?.Labels?.[`${labelNamespace}.owner`] !== "pdpp-reference") {
    throw new NekoSurfaceAllocatorServiceError("foreign_resource", "Docker inspect response is not PDPP-owned");
  }
  return inspect;
}

function readCreatedContainerId(value: unknown): string {
  if (!isRecord(value) || typeof value.Id !== "string" || value.Id.length === 0) {
    throw new NekoSurfaceAllocatorServiceError(
      "docker_malformed_response",
      "Docker create response is missing container id"
    );
  }
  return value.Id;
}

function readHostPort(inspect: DockerContainerInspect, containerPort: number): number {
  const bindings = inspect.NetworkSettings?.Ports?.[`${String(containerPort)}/tcp`];
  const hostPort = bindings?.[0]?.HostPort;
  const parsed = hostPort === undefined ? Number.NaN : Number.parseInt(hostPort, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new NekoSurfaceAllocatorServiceError(
      "docker_malformed_response",
      "managed container is missing host port binding"
    );
  }
  return parsed;
}

function isInspectRunning(inspect: DockerContainerInspect): boolean {
  return inspect.State?.Running === true || inspect.State?.Status === "running";
}

function hasNetwork(inspect: DockerContainerInspect, network: string): boolean {
  return inspect.NetworkSettings?.Networks?.[network] !== undefined;
}

async function probeUrl(fetchImpl: FetchLike, url: URL): Promise<boolean> {
  try {
    const response = await fetchImpl(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function probeJson(fetchImpl: FetchLike, url: URL): Promise<{ ok: boolean; value?: unknown }> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      return { ok: false };
    }
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false };
  }
}

function looksLikeChromiumVersion(value: unknown): boolean {
  return isRecord(value) && (typeof value.Browser === "string" || typeof value.webSocketDebuggerUrl === "string");
}

function joinUrlPath(base: string, path: string): URL {
  const url = new URL(base);
  const basePath = url.pathname.replace(TRAILING_SLASHES_RE, "");
  const suffix = path.replace(LEADING_SLASH_RE, "");
  url.pathname = suffix.length === 0 ? `${basePath}/` : `${basePath}/${suffix}`;
  return url;
}

function sanitizeResourceSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 48);
  return sanitized.length === 0 ? "surface" : sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readNekoSurfaceAllocatorOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): NekoSurfaceAllocatorServerOptions {
  const profileRoot = readRequiredEnv(env, "PDPP_NEKO_PROFILE_STORAGE_ROOT");
  const hostPortStart = readIntegerEnv(env, "PDPP_NEKO_WEBRTC_HOST_PORT_START", 59_000);
  const hostPortEnd = readIntegerEnv(env, "PDPP_NEKO_WEBRTC_HOST_PORT_END", 59_010);
  return {
    image: readRequiredEnv(env, "NEKO_IMAGE"),
    network: readRequiredEnv(env, "PDPP_NEKO_DOCKER_NETWORK"),
    profileRoot,
    webrtcHostPortStart: hostPortStart,
    webrtcHostPortEnd: hostPortEnd,
    streamBaseUrlTemplate: env.PDPP_NEKO_STREAM_BASE_URL_TEMPLATE ?? "http://{container_name}:8080/neko/{surface_id}/",
    cdpBaseUrlTemplate: env.PDPP_NEKO_CDP_BASE_URL_TEMPLATE ?? "http://{container_name}:9223/",
    listenHost: env.PDPP_NEKO_ALLOCATOR_HOST ?? DEFAULT_ALLOCATOR_HOST,
    listenPort: readIntegerEnv(env, "PDPP_NEKO_ALLOCATOR_PORT", DEFAULT_ALLOCATOR_PORT),
    extraEnv: compactEnv({
      NEKO_DESKTOP_SCREEN: env.NEKO_DESKTOP_SCREEN,
      NEKO_WEBRTC_NAT1TO1: env.NEKO_WEBRTC_NAT1TO1,
      NEKO_WEBRTC_ICESERVERS: env.NEKO_WEBRTC_ICESERVERS,
      NEKO_PASSWORD: env.NEKO_PASSWORD,
      NEKO_USERNAME: env.NEKO_USERNAME,
    }),
  };
}

function compactEnv(values: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", `${name} is required`);
  }
  return value;
}

function readIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", `${name} must be an integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const options = readNekoSurfaceAllocatorOptionsFromEnv();
  const server = await startNekoSurfaceAllocatorServer(options);
  process.stdout.write(`n.eko surface allocator listening at ${server.url}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`n.eko surface allocator failed to start: ${message}\n`);
    process.exitCode = 1;
  });
}
