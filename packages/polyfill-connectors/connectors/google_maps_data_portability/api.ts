const DEFAULT_BASE_URL = "https://dataportability.googleapis.com/v1";
const TRAILING_SLASHES = /\/+$/;

export const GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS = Object.freeze([
  "maps.aliased_places",
  "maps.commute_routes",
  "maps.commute_settings",
  "maps.ev_profile",
  "maps.factual_contributions",
  "maps.offering_contributions",
  "maps.photos_videos",
  "maps.questions_answers",
  "maps.reviews",
  "maps.starred_places",
  "maps.vehicle_profile",
  "myactivity.maps",
  "mymaps.maps",
]);

export const GOOGLE_MAPS_DATA_PORTABILITY_OAUTH_SCOPES = Object.freeze(
  GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS.map(
    (resourceGroup) => `https://www.googleapis.com/auth/dataportability.${resourceGroup}`
  )
);

export type DataPortabilityFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DataPortabilityClientOptions {
  readonly accessToken: string;
  readonly baseUrl?: string;
  readonly fetch?: DataPortabilityFetch;
}

export interface InitiateArchiveInput {
  readonly endTime?: string;
  readonly resources: readonly string[];
  readonly startTime?: string;
}

export interface InitiateArchiveResult {
  readonly accessType: string | null;
  readonly archiveJobId: string;
}

export interface ArchiveStateResult {
  readonly exportTime: string | null;
  readonly name: string;
  readonly startTime: string | null;
  readonly state: string;
  readonly urls: readonly string[];
}

export interface AccessTypeResult {
  readonly oneTimeResources: readonly string[];
  readonly timeBasedResources: readonly string[];
}

export class DataPortabilityApiError extends Error {
  readonly bodySnippet: string;
  readonly status: number;

  constructor(status: number, bodySnippet: string) {
    super(`google_data_portability_api_error: ${status}`);
    this.name = "DataPortabilityApiError";
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

function cleanBaseUrl(value: string | undefined): string {
  return (value || DEFAULT_BASE_URL).replace(TRAILING_SLASHES, "");
}

function assertAccessToken(value: string): string {
  if (!value?.trim()) {
    throw new Error("google_data_portability_access_token_missing");
  }
  return value.trim();
}

function assertResources(resources: readonly string[]): string[] {
  const unique = [...new Set(resources.map((item) => item.trim()).filter(Boolean))];
  if (unique.length === 0) {
    throw new Error("google_data_portability_resources_missing");
  }
  return unique;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function snippet(value: string): string {
  return value.slice(0, 500);
}

export class GoogleDataPortabilityClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: DataPortabilityFetch;

  constructor(options: DataPortabilityClientOptions) {
    this.accessToken = assertAccessToken(options.accessToken);
    this.baseUrl = cleanBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async checkAccessType(): Promise<AccessTypeResult> {
    const body = asObject(await this.request("/accessType:check", { method: "POST" }));
    return {
      oneTimeResources: asStringArray(body.oneTimeResources),
      timeBasedResources: asStringArray(body.timeBasedResources),
    };
  }

  async initiateArchive(input: InitiateArchiveInput): Promise<InitiateArchiveResult> {
    const payload: Record<string, unknown> = { resources: assertResources(input.resources) };
    if (input.startTime) {
      payload.startTime = input.startTime;
    }
    if (input.endTime) {
      payload.endTime = input.endTime;
    }
    const body = asObject(
      await this.request("/portabilityArchive:initiate", {
        body: JSON.stringify(payload),
        method: "POST",
      })
    );
    const archiveJobId = asString(body.archiveJobId);
    if (!archiveJobId) {
      throw new Error("google_data_portability_archive_job_id_missing");
    }
    return {
      accessType: asString(body.accessType),
      archiveJobId,
    };
  }

  async getArchiveState(archiveJobId: string): Promise<ArchiveStateResult> {
    const jobId = asString(archiveJobId);
    if (!jobId) {
      throw new Error("google_data_portability_archive_job_id_missing");
    }
    const name = `archiveJobs/${encodeURIComponent(jobId)}/portabilityArchiveState`;
    const body = asObject(await this.request(`/${name}`, { method: "GET" }));
    const state = asString(body.state);
    if (!state) {
      throw new Error("google_data_portability_archive_state_missing");
    }
    return {
      exportTime: asString(body.exportTime),
      name: asString(body.name) ?? name,
      startTime: asString(body.startTime),
      state,
      urls: asStringArray(body.urls),
    };
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new DataPortabilityApiError(response.status, snippet(text));
    }
    return text ? JSON.parse(text) : {};
  }
}
