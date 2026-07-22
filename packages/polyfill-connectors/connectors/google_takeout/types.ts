// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shapes for the Google Takeout connector. Extracted from index.ts so
// parsers.ts and tests can import them without pulling in runtime entry.

export interface GoogleActivityEntry {
  activity?: Array<{ activity?: Array<{ type?: string }> }>;
}

export interface LocationPoint {
  accuracy?: number | null;
  activity?: GoogleActivityEntry["activity"];
  altitude?: number | null;
  latitudeE7?: number;
  longitudeE7?: number;
  timestamp?: string;
  timestampMs?: string;
  velocity?: number | null;
}

export interface LocationFile {
  locations?: LocationPoint[];
}

export interface WatchHistoryEntry {
  subtitles?: Array<{ name?: string; url?: string }>;
  time?: string;
  title?: string;
  titleUrl?: string;
}

export interface SearchHistoryEntry {
  header?: string;
  time?: string;
  title?: string;
}

export interface StreamTimestampState {
  last_timestamp?: string;
}

export interface GoogleTakeoutState {
  location_history?: StreamTimestampState;
  search_history?: StreamTimestampState;
  youtube_watch_history?: StreamTimestampState;
}

export interface LocationRecord {
  accuracy_meters: number | null;
  activity_type: string | null;
  altitude_m: number | null;
  id: string;
  latitude: number | null;
  longitude: number | null;
  timestamp: string;
  velocity_mps: number | null;
}

export interface WatchHistoryRecord {
  channel_name: string | null;
  channel_url: string | null;
  id: string;
  video_title: string | null;
  video_url: string | null;
  watched_at: string;
}

export interface SearchRecord {
  id: string;
  product: string | null;
  query: string;
  timestamp: string;
}
