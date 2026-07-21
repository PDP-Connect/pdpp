// Pure parsers for owner-provided Google Maps Timeline export files. Runtime
// file discovery and emit orchestration live in index.ts.

import { createHash } from "node:crypto";
import type {
  GoogleMapsPointKind,
  GoogleMapsSegmentKind,
  GoogleMapsSourceFormat,
  ParseResult,
  TimelinePointRecord,
  TimelineSegmentRecord,
} from "./types.ts";

const GOOGLE_E7_DIVISOR = 1e7;
const RECORD_ID_HASH_LENGTH = 24;
const GEO_PREFIX_RE = /^geo:/i;
const GEO_PAIR_RE = /(-?\d+(?:\.\d+)?)[^\d-]+(-?\d+(?:\.\d+)?)/;

interface LegacyLocationPoint {
  accuracy?: number | null;
  activity?: Array<{ activity?: Array<{ type?: string }> }>;
  altitude?: number | null;
  latitudeE7?: number;
  longitudeE7?: number;
  timestamp?: string;
  timestampMs?: string;
  velocity?: number | null;
}

interface LatLon {
  latitude: number;
  longitude: number;
}

export function hashId(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, RECORD_ID_HASH_LENGTH);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isValidLatLon(latitude: number, longitude: number): boolean {
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function scaleE7(value: unknown): number | null {
  const n = asNumber(value);
  return n == null ? null : n / GOOGLE_E7_DIVISOR;
}

function parseIso(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function parseTimestampMs(value: unknown): string | null {
  const raw = typeof value === "number" ? String(value) : asString(value);
  if (!raw) {
    return null;
  }
  const ms = Number.parseInt(raw, 10);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseTimestamp(value: unknown): string | null {
  return parseIso(value) ?? parseTimestampMs(value);
}

function parseLatLonString(value: string): LatLon | null {
  const match = GEO_PAIR_RE.exec(value.replace(GEO_PREFIX_RE, ""));
  if (!match) {
    return null;
  }
  const latitude = Number.parseFloat(match[1] ?? "");
  const longitude = Number.parseFloat(match[2] ?? "");
  if (!(Number.isFinite(latitude) && Number.isFinite(longitude) && isValidLatLon(latitude, longitude))) {
    return null;
  }
  return { latitude, longitude };
}

function parseLatLon(value: unknown): LatLon | null {
  if (typeof value === "string") {
    return parseLatLonString(value);
  }
  const obj = asObject(value);
  if (!obj) {
    return null;
  }
  const latLng = asString(obj.latLng) ?? asString(obj.point);
  if (latLng) {
    return parseLatLonString(latLng);
  }
  const latitude =
    asNumber(obj.latitude) ??
    asNumber(obj.lat) ??
    scaleE7(obj.latitudeE7) ??
    scaleE7(obj.latE7) ??
    scaleE7(obj.sourceE7Lat);
  const longitude =
    asNumber(obj.longitude) ??
    asNumber(obj.lng) ??
    asNumber(obj.lon) ??
    scaleE7(obj.longitudeE7) ??
    scaleE7(obj.lngE7) ??
    scaleE7(obj.sourceE7Lng);
  if (latitude == null || longitude == null || !isValidLatLon(latitude, longitude)) {
    return null;
  }
  return { latitude, longitude };
}

function safeProbability(value: unknown): number | null {
  const n = asNumber(value);
  return n == null || n < 0 || n > 1 ? null : n;
}

function firstActivityType(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const top = asObject(value[0]);
  const nested = Array.isArray(top?.activity) ? asObject(top.activity[0]) : null;
  return asString(nested?.type);
}

function buildPoint(input: {
  accuracyMeters?: number | null;
  activityType?: string | null;
  altitudeM?: number | null;
  latitude: number;
  longitude: number;
  segmentId?: string | null;
  sourceFormat: GoogleMapsSourceFormat;
  sourceKind: GoogleMapsPointKind;
  timestamp: string;
  velocityMps?: number | null;
}): TimelinePointRecord {
  return {
    id: hashId(
      [
        "google_maps_point",
        input.sourceFormat,
        input.sourceKind,
        input.segmentId ?? "",
        input.timestamp,
        input.latitude.toFixed(7),
        input.longitude.toFixed(7),
      ].join("|")
    ),
    timestamp: input.timestamp,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracy_meters: input.accuracyMeters ?? null,
    altitude_m: input.altitudeM ?? null,
    velocity_mps: input.velocityMps ?? null,
    activity_type: input.activityType ?? null,
    segment_id: input.segmentId ?? null,
    source_format: input.sourceFormat,
    source_kind: input.sourceKind,
  };
}

function buildSegment(input: {
  activityType?: string | null;
  endTime?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  placeId?: string | null;
  probability?: number | null;
  segmentKind: GoogleMapsSegmentKind;
  semanticType?: string | null;
  sourceFormat: GoogleMapsSourceFormat;
  startTime: string;
}): TimelineSegmentRecord {
  return {
    id: hashId(
      [
        "google_maps_segment",
        input.sourceFormat,
        input.segmentKind,
        input.startTime,
        input.endTime ?? "",
        input.placeId ?? "",
        input.activityType ?? "",
        input.latitude?.toFixed(7) ?? "",
        input.longitude?.toFixed(7) ?? "",
      ].join("|")
    ),
    start_time: input.startTime,
    end_time: input.endTime ?? null,
    segment_kind: input.segmentKind,
    source_format: input.sourceFormat,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    place_id: input.placeId ?? null,
    semantic_type: input.semanticType ?? null,
    activity_type: input.activityType ?? null,
    probability: input.probability ?? null,
  };
}

function parseLegacyRecords(json: Record<string, unknown>): ParseResult {
  const locations = Array.isArray(json.locations) ? (json.locations as LegacyLocationPoint[]) : [];
  const points: TimelinePointRecord[] = [];
  for (const loc of locations) {
    const timestamp = parseTimestamp(loc.timestamp) ?? parseTimestampMs(loc.timestampMs);
    const latitude = scaleE7(loc.latitudeE7);
    const longitude = scaleE7(loc.longitudeE7);
    if (!timestamp || latitude == null || longitude == null || !isValidLatLon(latitude, longitude)) {
      continue;
    }
    points.push(
      buildPoint({
        timestamp,
        latitude,
        longitude,
        accuracyMeters: loc.accuracy ?? null,
        altitudeM: loc.altitude ?? null,
        velocityMps: loc.velocity ?? null,
        activityType: firstActivityType(loc.activity),
        sourceFormat: "legacy_records",
        sourceKind: "raw_location",
      })
    );
  }
  return { points, segments: [] };
}

function segmentTimes(segment: Record<string, unknown>): { endTime: string | null; startTime: string | null } {
  const duration = asObject(segment.duration);
  return {
    startTime:
      parseTimestamp(segment.startTime) ??
      parseTimestamp(segment.startTimestamp) ??
      parseTimestamp(duration?.startTimestamp) ??
      parseTimestamp(duration?.startTime),
    endTime:
      parseTimestamp(segment.endTime) ??
      parseTimestamp(segment.endTimestamp) ??
      parseTimestamp(duration?.endTimestamp) ??
      parseTimestamp(duration?.endTime),
  };
}

function parseTimelinePathPoint(
  value: unknown,
  segmentId: string | null,
  fallbackTime: string | null,
  sourceFormat: GoogleMapsSourceFormat
): TimelinePointRecord | null {
  const obj = asObject(value);
  const timestamp = parseTimestamp(obj?.time) ?? parseTimestamp(obj?.timestamp) ?? fallbackTime;
  const latLon = parseLatLon(obj?.point ?? obj?.location ?? value);
  if (!(timestamp && latLon)) {
    return null;
  }
  return buildPoint({
    timestamp,
    latitude: latLon.latitude,
    longitude: latLon.longitude,
    segmentId,
    sourceFormat,
    sourceKind: "timeline_path",
  });
}

function semanticSegmentKind(
  visit: Record<string, unknown> | null,
  activity: Record<string, unknown> | null
): GoogleMapsSegmentKind {
  if (visit) {
    return "visit";
  }
  if (activity) {
    return "activity";
  }
  return "path";
}

function parseSemanticSegment(segment: Record<string, unknown>): ParseResult {
  const { startTime, endTime } = segmentTimes(segment);
  const visit = asObject(segment.visit);
  const activity = asObject(segment.activity);
  const timelinePath = Array.isArray(segment.timelinePath) ? segment.timelinePath : [];
  const topVisit = asObject(visit?.topCandidate) ?? asObject(visit?.topPlace);
  const topActivity = asObject(activity?.topCandidate) ?? asObject(activity?.topActivity);
  const visitLocation = parseLatLon(
    topVisit?.placeLocation ?? topVisit?.location ?? visit?.placeLocation ?? visit?.location
  );
  const segmentKind = semanticSegmentKind(visit, activity);
  const activityType = asString(topActivity?.type) ?? asString(activity?.activityType);
  const placeId = asString(topVisit?.placeID) ?? asString(topVisit?.placeId) ?? asString(visit?.placeId);
  const semanticType = asString(topVisit?.semanticType) ?? asString(visit?.semanticType);
  const probability = safeProbability(
    topVisit?.probability ?? topActivity?.probability ?? visit?.probability ?? activity?.probability
  );
  const segments: TimelineSegmentRecord[] = [];
  const points: TimelinePointRecord[] = [];

  let segmentId: string | null = null;
  if (startTime) {
    const seg = buildSegment({
      startTime,
      endTime,
      segmentKind,
      sourceFormat: "semantic_segments",
      latitude: visitLocation?.latitude ?? null,
      longitude: visitLocation?.longitude ?? null,
      placeId,
      semanticType,
      activityType,
      probability,
    });
    segmentId = seg.id;
    segments.push(seg);
  }

  if (visitLocation && startTime) {
    points.push(
      buildPoint({
        timestamp: startTime,
        latitude: visitLocation.latitude,
        longitude: visitLocation.longitude,
        segmentId,
        sourceFormat: "semantic_segments",
        sourceKind: "visit_location",
      })
    );
  }

  for (const point of timelinePath) {
    const parsed = parseTimelinePathPoint(point, segmentId ?? "", startTime, "semantic_segments");
    if (parsed) {
      points.push(parsed);
    }
  }

  return { points, segments };
}

function parsePlaceVisitObject(placeVisit: Record<string, unknown>): ParseResult {
  const { startTime, endTime } = segmentTimes(placeVisit);
  const location = asObject(placeVisit.location);
  const latLon = parseLatLon(location);
  if (!startTime) {
    return { points: [], segments: [] };
  }
  const seg = buildSegment({
    startTime,
    endTime,
    segmentKind: "visit",
    sourceFormat: "timeline_objects",
    latitude: latLon?.latitude ?? null,
    longitude: latLon?.longitude ?? null,
    placeId: asString(location?.placeId) ?? asString(location?.placeID),
    semanticType: asString(location?.semanticType),
  });
  const points: TimelinePointRecord[] = [];
  if (latLon) {
    points.push(
      buildPoint({
        timestamp: startTime,
        latitude: latLon.latitude,
        longitude: latLon.longitude,
        segmentId: seg.id,
        sourceFormat: "timeline_objects",
        sourceKind: "visit_location",
      })
    );
  }
  return { points, segments: [seg] };
}

function parseActivitySegmentObject(activitySegment: Record<string, unknown>): ParseResult {
  const { startTime, endTime } = segmentTimes(activitySegment);
  const startLocation = parseLatLon(activitySegment.startLocation);
  const endLocation = parseLatLon(activitySegment.endLocation);
  if (!startTime) {
    return { points: [], segments: [] };
  }
  const seg = buildSegment({
    startTime,
    endTime,
    segmentKind: "activity",
    sourceFormat: "timeline_objects",
    latitude: startLocation?.latitude ?? null,
    longitude: startLocation?.longitude ?? null,
    activityType: asString(activitySegment.activityType),
  });
  const points: TimelinePointRecord[] = [];
  if (startLocation) {
    points.push(
      buildPoint({
        timestamp: startTime,
        latitude: startLocation.latitude,
        longitude: startLocation.longitude,
        segmentId: seg.id,
        sourceFormat: "timeline_objects",
        sourceKind: "activity_start",
        activityType: seg.activity_type,
      })
    );
  }
  if (endLocation && endTime) {
    points.push(
      buildPoint({
        timestamp: endTime,
        latitude: endLocation.latitude,
        longitude: endLocation.longitude,
        segmentId: seg.id,
        sourceFormat: "timeline_objects",
        sourceKind: "activity_end",
        activityType: seg.activity_type,
      })
    );
  }
  return { points, segments: [seg] };
}

function parseTimelineObject(value: unknown): ParseResult {
  const obj = asObject(value);
  if (!obj) {
    return { points: [], segments: [] };
  }
  const results: ParseResult[] = [];
  const placeVisit = asObject(obj.placeVisit);
  const activitySegment = asObject(obj.activitySegment);
  if (placeVisit) {
    results.push(parsePlaceVisitObject(placeVisit));
  }
  if (activitySegment) {
    results.push(parseActivitySegmentObject(activitySegment));
  }
  return mergeResults(results);
}

function mergeResults(results: ParseResult[]): ParseResult {
  const pointMap = new Map<string, TimelinePointRecord>();
  const segmentMap = new Map<string, TimelineSegmentRecord>();
  for (const result of results) {
    for (const point of result.points) {
      pointMap.set(point.id, point);
    }
    for (const segment of result.segments) {
      segmentMap.set(segment.id, segment);
    }
  }
  return {
    points: [...pointMap.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    segments: [...segmentMap.values()].sort((a, b) => a.start_time.localeCompare(b.start_time)),
  };
}

export function parseGoogleMapsExport(json: unknown): ParseResult {
  const obj = asObject(json);
  const results: ParseResult[] = [];
  if (obj?.locations) {
    results.push(parseLegacyRecords(obj));
  }
  const semanticSegments = Array.isArray(obj?.semanticSegments) ? obj.semanticSegments : [];
  for (const segment of semanticSegments) {
    const parsed = asObject(segment);
    if (parsed) {
      results.push(parseSemanticSegment(parsed));
    }
  }
  const timelineObjects: unknown[] = [];
  if (Array.isArray(obj?.timelineObjects)) {
    timelineObjects.push(...obj.timelineObjects);
  } else if (Array.isArray(json)) {
    timelineObjects.push(...json);
  }
  for (const item of timelineObjects) {
    results.push(parseTimelineObject(item));
  }
  return mergeResults(results);
}
