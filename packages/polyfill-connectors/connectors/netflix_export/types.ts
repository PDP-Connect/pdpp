// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shapes for the Netflix export connector. Extracted so parsers.ts
// and tests can import them without pulling in runtime entry.

export type ViewingActivityCSVRow = Record<string, string | undefined>;

/**
 * Netflix exposes viewing history in two genuinely different CSV shapes —
 * this connector must detect and parse both, and must never blend or fake
 * fields one shape doesn't have:
 *
 * "direct_history": the immediate "Download all" button on
 *   netflix.com/viewingactivity. Header: `Title,Date`. Date is a calendar day
 *   with no time-of-day component — reporting an exact instant from this
 *   source would be dishonest, so watched_at_precision is "day" and
 *   watched_at is midnight UTC of that day, not a real timestamp.
 * "full_export": CONTENT_INTERACTION/ViewingActivity.csv inside the official
 *   "Download a copy of your personal information" (getmyinfo) archive.
 *   Header: `Profile Name,Start Time (UTC),Duration (H:MM:SS),Attributes,
 *   Title,Supplemental Video Type,Device Type,Bookmark,Latest Bookmark,
 *   Country`. Start Time (UTC) is a real timestamp with time-of-day, so
 *   watched_at_precision is "instant".
 */
export type ViewingActivitySourceSchema = "direct_history" | "full_export";

export interface ViewingActivityRecord {
  country: string | null;
  device_type: string | null;
  duration_seconds: number | null;
  id: string;
  profile_name: string | null;
  source_schema: ViewingActivitySourceSchema;
  title: string | null;
  watched_at: string;
  /** "day": watched_at is midnight UTC of a calendar day only, no real time-of-day. "instant": watched_at is a real UTC timestamp. */
  watched_at_precision: "day" | "instant";
  [key: string]: string | null | number;
}

export interface StreamTimestampState {
  last_timestamp?: string;
}

export interface NetflixExportState {
  viewing_activity?: StreamTimestampState;
}
