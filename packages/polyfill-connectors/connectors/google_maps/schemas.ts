import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

const RECORD_ID_RE = /^[0-9a-f]{24}$/;
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const recordIdSchema = z.string().regex(RECORD_ID_RE);
const isoTimestampSchema = z.string().regex(ISO_DT_RE);
const latitudeSchema = z.number().min(-90).max(90);
const longitudeSchema = z.number().min(-180).max(180);
const nullableLatitudeSchema = latitudeSchema.nullable();
const nullableLongitudeSchema = longitudeSchema.nullable();
const nullableSensorNumberSchema = z.number().nullable();

export const timelinePointSchema = z.object({
  id: recordIdSchema,
  timestamp: isoTimestampSchema,
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  accuracy_meters: nullableSensorNumberSchema,
  altitude_m: nullableSensorNumberSchema,
  velocity_mps: nullableSensorNumberSchema,
  activity_type: pdppSafeText.max(120).nullable(),
  segment_id: recordIdSchema.nullable(),
  source_format: z.enum(["legacy_records", "semantic_segments", "timeline_objects"]),
  source_kind: z.enum(["raw_location", "timeline_path", "visit_location", "activity_start", "activity_end"]),
});

export const timelineSegmentSchema = z.object({
  id: recordIdSchema,
  start_time: isoTimestampSchema,
  end_time: isoTimestampSchema.nullable(),
  segment_kind: z.enum(["path", "visit", "activity"]),
  source_format: z.enum(["legacy_records", "semantic_segments", "timeline_objects"]),
  latitude: nullableLatitudeSchema,
  longitude: nullableLongitudeSchema,
  place_id: pdppSafeText.max(256).nullable(),
  semantic_type: pdppSafeText.max(160).nullable(),
  activity_type: pdppSafeText.max(120).nullable(),
  probability: z.number().min(0).max(1).nullable(),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  timeline_points: timelinePointSchema,
  timeline_segments: timelineSegmentSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
