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

import type { LocalCollectorDefinition } from "../../src/collector-definition.ts";

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

export const googleTakeoutCollectorDefinition: LocalCollectorDefinition = {
  connector_id: "google_takeout",
  entry: "google_takeout",
  bindings: { filesystem: { required: true } },
  streams: GOOGLE_TAKEOUT_DEFAULT_STREAMS,
};
