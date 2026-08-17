// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Google Takeout connector's local-collector definition.
 *
 * The connector's own declaration of how it participates in local collection:
 * its stable id, the runtime bindings it needs, and the default stream set an
 * unscoped `run` should request. The generic `@pdpp/local-collector` runtime
 * consumes these definitions instead of hardcoding a per-connector table.
 *
 * Pure data only. This module MUST NOT import connector runtime code, Node
 * built-ins, or anything browser-bound (see the claude_code definition for
 * why).
 */

import type { LocalCollectorDefinition } from "@pdpp/collector-runtime/collector-definition";

/**
 * Default stream set for an unscoped `google_takeout` local-collector run.
 *
 * Mirrors the connector's full manifest-declared stream set. Google Takeout
 * reads an already-extracted GOOGLE_TAKEOUT_DIR from the local filesystem —
 * exactly the local-collector shape (runs on the machine that has the
 * extracted archive), not a browser-upload or provider-API connector.
 */
export const GOOGLE_TAKEOUT_DEFAULT_STREAMS = [
  "location_history",
  "youtube_watch_history",
  "search_history",
  "photos",
  "coverage_diagnostics",
] as const;

/**
 * Streams an owner-declared `since` can be proven against — those the manifest
 * gives a `consent_time_field`. `coverage_diagnostics` carries none (it is the
 * run's own accounting, not owner data), so it is always collected whole.
 */
export const GOOGLE_TAKEOUT_TIME_SCOPABLE_STREAMS = [
  "location_history",
  "youtube_watch_history",
  "search_history",
  "photos",
] as const;

export const googleTakeoutCollectorDefinition: LocalCollectorDefinition = {
  connector_id: "google_takeout",
  entry: "google_takeout",
  bindings: { filesystem: { required: true } },
  streams: GOOGLE_TAKEOUT_DEFAULT_STREAMS,
  time_scopable_streams: GOOGLE_TAKEOUT_TIME_SCOPABLE_STREAMS,
};
