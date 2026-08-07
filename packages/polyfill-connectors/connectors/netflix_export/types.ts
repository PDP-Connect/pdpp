// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shapes for the Netflix export connector. Extracted so parsers.ts
// and tests can import them without pulling in runtime entry.

export type ViewingActivityCSVRow = Record<string, string | undefined>;

export interface ViewingActivityRecord {
  device_type: string | null;
  id: string;
  profile_name: string | null;
  title: string | null;
  watch_duration_percent: number | null;
  watched_at: string;
  [key: string]: string | null | number;
}

export interface StreamTimestampState {
  last_timestamp?: string;
}

export interface NetflixExportState {
  viewing_activity?: StreamTimestampState;
}
