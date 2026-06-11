#!/usr/bin/env node

import {
  type CollectContext,
  emitDetailCoverage,
  nowIso,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import {
  type AccessTypeResult,
  GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS,
  GoogleDataPortabilityClient,
  type InitiateArchiveResult,
} from "./api.ts";
import { validateRecord } from "./schemas.ts";

interface ArchiveJobCursor {
  readonly access_type?: string | null;
  readonly archive_job_id: string;
  readonly export_time?: string | null;
  readonly start_time?: string | null;
  readonly state?: string | null;
  readonly updated_at?: string | null;
  readonly url_count?: number | null;
}

interface DataPortabilityState {
  readonly archive_jobs?: Record<string, ArchiveJobCursor>;
  readonly fetched_at?: string;
}

interface DataPortabilityClientLike {
  checkAccessType(): Promise<AccessTypeResult>;
  getArchiveState(archiveJobId: string): ReturnType<GoogleDataPortabilityClient["getArchiveState"]>;
  initiateArchive(input: Parameters<GoogleDataPortabilityClient["initiateArchive"]>[0]): Promise<InitiateArchiveResult>;
}

interface ArchiveJobRecord extends RecordData {
  readonly access_type: string | null;
  readonly archive_job_id: string | null;
  readonly download_url_count: number;
  readonly export_time: string | null;
  readonly id: string;
  readonly resource_group: string;
  readonly source: "google_data_portability_api";
  readonly start_time: string | null;
  readonly state: string | null;
}

interface GoogleDataPortabilityCollectOptions {
  readonly clientFactory?: (accessToken: string) => DataPortabilityClientLike;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

const TERMINAL_STATES = new Set(["COMPLETE", "FAILED", "CANCELLED"]);

function csvSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredAccessToken(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  const token = cleanString(env.GOOGLE_DATAPORTABILITY_ACCESS_TOKEN);
  if (!token) {
    throw new Error("google_dataportability_access_token_missing");
  }
  return token;
}

function selectedResourceGroups(ctx: CollectContext): readonly string[] {
  const requested = new Set<string>();
  for (const stream of ctx.scope.streams) {
    if (stream.name !== "archive_jobs") {
      continue;
    }
    for (const resource of stream.resources ?? []) {
      if (typeof resource === "string" && resource.trim()) {
        requested.add(resource.trim());
      }
    }
  }
  return requested.size > 0 ? [...requested] : GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS;
}

function archiveStreamTimeRange(ctx: CollectContext): { endTime?: string; startTime?: string } {
  const stream = ctx.scope.streams.find((entry) => entry.name === "archive_jobs");
  const startTime = cleanString(stream?.time_range?.since);
  const endTime = cleanString(stream?.time_range?.until);
  return {
    ...(endTime ? { endTime } : {}),
    ...(startTime ? { startTime } : {}),
  };
}

function stateFromContext(ctx: CollectContext): DataPortabilityState {
  const state = ctx.state.google_maps_data_portability;
  return state && typeof state === "object" && !Array.isArray(state) ? (state as DataPortabilityState) : {};
}

function mergeAccessType(
  accessType: AccessTypeResult,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): {
  readonly authorized: ReadonlySet<string>;
  readonly denied: ReadonlySet<string>;
  readonly oneTime: ReadonlySet<string>;
  readonly timeBased: ReadonlySet<string>;
} {
  const oneTime = new Set([
    ...accessType.oneTimeResources,
    ...csvSet(env.GOOGLE_DATAPORTABILITY_ONE_TIME_RESOURCE_GROUPS),
  ]);
  const timeBased = new Set([
    ...accessType.timeBasedResources,
    ...csvSet(env.GOOGLE_DATAPORTABILITY_TIME_BASED_RESOURCE_GROUPS),
  ]);
  const authorizedFromEnv = csvSet(env.GOOGLE_DATAPORTABILITY_AUTHORIZED_RESOURCE_GROUPS);
  const denied = csvSet(env.GOOGLE_DATAPORTABILITY_DENIED_RESOURCE_GROUPS);
  const authorized = new Set([...oneTime, ...timeBased, ...authorizedFromEnv]);
  return { authorized, denied, oneTime, timeBased };
}

function cursorForResource(state: DataPortabilityState, resourceGroup: string): ArchiveJobCursor | null {
  const cursor = state.archive_jobs?.[resourceGroup];
  return cursor && typeof cursor.archive_job_id === "string" ? cursor : null;
}

function shouldPollExisting(cursor: ArchiveJobCursor | null): cursor is ArchiveJobCursor {
  return Boolean(cursor?.archive_job_id && !TERMINAL_STATES.has(cursor.state ?? ""));
}

function recordId(resourceGroup: string, archiveJobId: string | null): string {
  return `${resourceGroup}:${archiveJobId ?? "not_started"}`;
}

function accessTypeForResource(
  resourceGroup: string,
  initiated: InitiateArchiveResult | null,
  oneTime: ReadonlySet<string>,
  timeBased: ReadonlySet<string>
): string | null {
  if (initiated?.accessType) {
    return initiated.accessType;
  }
  if (oneTime.has(resourceGroup)) {
    return "ACCESS_TYPE_ONE_TIME";
  }
  if (timeBased.has(resourceGroup)) {
    return "ACCESS_TYPE_TIME_BASED";
  }
  return null;
}

function archiveCursorFromRecord(record: ArchiveJobRecord): ArchiveJobCursor {
  return {
    access_type: record.access_type,
    archive_job_id: record.archive_job_id ?? "",
    export_time: record.export_time,
    start_time: record.start_time,
    state: record.state,
    updated_at: nowIso(),
    url_count: record.download_url_count,
  };
}

async function collectResourceGroup({
  accessType,
  client,
  ctx,
  resourceGroup,
  state,
  timeRange,
}: {
  readonly accessType: ReturnType<typeof mergeAccessType>;
  readonly client: DataPortabilityClientLike;
  readonly ctx: CollectContext;
  readonly resourceGroup: string;
  readonly state: DataPortabilityState;
  readonly timeRange: { readonly endTime?: string; readonly startTime?: string };
}): Promise<ArchiveJobRecord> {
  const prior = cursorForResource(state, resourceGroup);
  let initiated: InitiateArchiveResult | null = null;
  let archiveJobId = prior?.archive_job_id ?? null;
  let stateName = prior?.state ?? null;
  let startTime = prior?.start_time ?? null;
  let exportTime = prior?.export_time ?? null;
  let urls: readonly string[] = [];
  const pollExisting = shouldPollExisting(prior);

  if (!pollExisting) {
    await ctx.progress("Initiating Google Data Portability archive", { stream: "archive_jobs" });
    initiated = await client.initiateArchive({
      resources: [resourceGroup],
      ...timeRange,
    });
    archiveJobId = initiated.archiveJobId;
    stateName = "IN_PROGRESS";
  }

  if (archiveJobId && pollExisting) {
    const archiveState = await client.getArchiveState(archiveJobId);
    stateName = archiveState.state;
    startTime = archiveState.startTime;
    exportTime = archiveState.exportTime;
    urls = archiveState.urls;
  }

  return {
    access_type: accessTypeForResource(resourceGroup, initiated, accessType.oneTime, accessType.timeBased),
    archive_job_id: archiveJobId,
    download_url_count: urls.length,
    export_time: exportTime,
    id: recordId(resourceGroup, archiveJobId),
    resource_group: resourceGroup,
    source: "google_data_portability_api",
    start_time: startTime,
    state: stateName,
  };
}

export async function collectGoogleMapsDataPortability(
  ctx: CollectContext,
  options: GoogleDataPortabilityCollectOptions = {}
): Promise<void> {
  if (!ctx.requested.has("archive_jobs")) {
    await ctx.progress("No Google Data Portability archive streams requested", { stream: "archive_jobs" });
    return;
  }
  const env = options.env ?? process.env;
  const client = options.clientFactory
    ? options.clientFactory(requiredAccessToken(env))
    : new GoogleDataPortabilityClient({ accessToken: requiredAccessToken(env) });
  const state = stateFromContext(ctx);
  const checkedAccessType = mergeAccessType(await client.checkAccessType(), env);
  const selected = selectedResourceGroups(ctx);
  const resourceGroups = selected.filter((resourceGroup) => checkedAccessType.authorized.has(resourceGroup));
  const denied = selected.filter(
    (resourceGroup) => checkedAccessType.denied.has(resourceGroup) || !checkedAccessType.authorized.has(resourceGroup)
  );
  if (resourceGroups.length === 0) {
    await emitDetailCoverage(ctx, {
      stream: "archive_jobs",
      stateStream: "archive_jobs",
      requiredKeys: selected,
      hydratedKeys: [],
      optionalSkipKeys: denied,
      considered: selected.length,
      covered: denied.length,
    });
    throw new Error("google_dataportability_no_authorized_resource_groups");
  }

  const nextJobs: Record<string, ArchiveJobCursor> = { ...(state.archive_jobs ?? {}) };
  const emitted: string[] = [];
  const timeRange = archiveStreamTimeRange(ctx);

  for (const resourceGroup of resourceGroups) {
    const record = await collectResourceGroup({
      accessType: checkedAccessType,
      client,
      ctx,
      resourceGroup,
      state,
      timeRange,
    });
    await ctx.emitRecord("archive_jobs", record);
    nextJobs[resourceGroup] = archiveCursorFromRecord(record);
    emitted.push(resourceGroup);
  }

  await emitDetailCoverage(ctx, {
    stream: "archive_jobs",
    stateStream: "archive_jobs",
    requiredKeys: [...resourceGroups, ...denied],
    hydratedKeys: emitted,
    optionalSkipKeys: denied,
    considered: resourceGroups.length + denied.length,
    covered: emitted.length + denied.length,
  });

  await ctx.emit({
    type: "STATE",
    stream: "archive_jobs",
    cursor: {
      google_maps_data_portability: {
        archive_jobs: nextJobs,
        fetched_at: nowIso(),
      },
    },
  });
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "google_maps_data_portability",
    validateRecord,
    retryablePattern: /429|5\d\d|timeout|temporar|rate|unavailable|google_data_portability_api_error/i,
    timeRangeField: "export_time",
    collect: collectGoogleMapsDataPortability,
  });
}
