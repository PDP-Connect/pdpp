// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-collector-definitions-snapshot.ts from
// @pdpp/polyfill-connectors's LOCAL_COLLECTOR_DEFINITIONS
// (packages/polyfill-connectors/src/collector-registry.ts), the one place a
// connector declares its local-collector participation. Runtime injection
// here stays a frozen snapshot, not a live cross-package source import, so
// @pdpp/local-collector (the publishable runner) never depends on
// @pdpp/polyfill-connectors (the content package) at build or publish time.
// test/collector-definitions-snapshot-drift.test.ts fails CI if this file
// drifts from what the generator would produce for polyfill-connectors'
// current definitions.
//
// Update path: after changing a connector's LocalCollectorDefinition (or
// adding/removing a bundled connector) in polyfill-connectors, regenerate
// with `node --experimental-strip-types
// scripts/generate-collector-definitions-snapshot.ts` from
// packages/local-collector, then commit this file alongside that change.

import type { LocalCollectorDefinition } from "@pdpp/connector-protocol/collector-definition";

/**
 * Frozen snapshot of every connector's local-collector participation, in the
 * order polyfill-connectors declares them. See this file's header for the
 * update path.
 */
export const LOCAL_COLLECTOR_DEFINITIONS: readonly LocalCollectorDefinition[] = Object.freeze([
  {
    connector_id: "claude_code",
    entry: "claude_code",
    bindings: {
      "filesystem": { required: true },
    },
    streams: ["sessions", "messages", "attachments", "memory_notes", "skills", "slash_commands", "file_history", "cache_inventory", "coverage_diagnostics", "backup_inventory", "config_inventory"],
    time_scopable_streams: ["sessions", "messages", "attachments"],
    source_root_scopable_streams: ["sessions", "messages", "attachments"],
    enforces_source_roots: true,
  },
  {
    connector_id: "codex",
    entry: "codex",
    bindings: {
      "filesystem": { required: true },
    },
    streams: ["sessions", "messages", "function_calls", "rules", "prompts", "skills", "history", "session_index", "shell_snapshots", "config_inventory", "cache_inventory", "coverage_diagnostics"],
    time_scopable_streams: ["sessions", "messages", "function_calls"],
    source_root_scopable_streams: ["sessions", "messages", "function_calls"],
    enforces_source_roots: true,
  },
  {
    connector_id: "google_takeout",
    entry: "google_takeout",
    bindings: {
      "filesystem": { required: true },
    },
    streams: ["location_history", "youtube_watch_history", "search_history", "photos", "coverage_diagnostics"],
    time_scopable_streams: ["location_history", "youtube_watch_history", "search_history", "photos"],
  },
  {
    connector_id: "imessage",
    entry: "imessage",
    bindings: {
      "filesystem": { required: true },
    },
    streams: ["messages", "participants", "attachments"],
    time_scopable_streams: ["messages"],
  },
  {
    connector_id: "apple_photos",
    entry: "apple_photos",
    bindings: {
      "filesystem": { required: true },
    },
    streams: ["photos", "coverage_diagnostics"],
    time_scopable_streams: ["photos"],
  },
  {
    connector_id: "google_messages",
    entry: "google_messages",
    bindings: {
      "filesystem": { required: true },
    },
    streams: ["messages", "coverage_diagnostics"],
    time_scopable_streams: ["messages"],
  },
]);
