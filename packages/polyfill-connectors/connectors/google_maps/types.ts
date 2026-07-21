export type GoogleMapsSourceFormat = "legacy_records" | "semantic_segments" | "timeline_objects";
export type GoogleMapsPointKind =
  | "raw_location"
  | "timeline_path"
  | "visit_location"
  | "activity_start"
  | "activity_end";
export type GoogleMapsSegmentKind = "path" | "visit" | "activity";

export interface StreamTimestampState {
  last_start_time?: string;
  last_timestamp?: string;
}

export interface GoogleMapsState {
  timeline_points?: StreamTimestampState;
  timeline_segments?: StreamTimestampState;
}

export interface TimelinePointRecord {
  accuracy_meters: number | null;
  activity_type: string | null;
  altitude_m: number | null;
  id: string;
  latitude: number;
  longitude: number;
  segment_id: string | null;
  source_format: GoogleMapsSourceFormat;
  source_kind: GoogleMapsPointKind;
  timestamp: string;
  velocity_mps: number | null;
}

export interface TimelineSegmentRecord {
  activity_type: string | null;
  end_time: string | null;
  id: string;
  latitude: number | null;
  longitude: number | null;
  place_id: string | null;
  probability: number | null;
  segment_kind: GoogleMapsSegmentKind;
  semantic_type: string | null;
  source_format: GoogleMapsSourceFormat;
  start_time: string;
}

export interface ParseResult {
  points: TimelinePointRecord[];
  segments: TimelineSegmentRecord[];
}
