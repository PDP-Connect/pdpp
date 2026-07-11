/**
 * Claude Code connector's local-collector definition.
 *
 * The connector's own declaration of how it participates in local collection:
 * its stable id, the runtime bindings it needs, and the default stream set an
 * unscoped `run` should request. The generic `@pdpp/local-collector` runtime
 * consumes these definitions instead of hardcoding a per-connector table.
 *
 * Pure data only. This module MUST NOT import connector runtime code, Node
 * built-ins, or anything browser-bound (see the codex definition for why).
 *
 * Spec: openspec/changes/publish-pdpp-local-collector/design.md §3.
 */

import type { LocalCollectorDefinition } from "../../src/collector-definition.ts";

/**
 * Default stream set for an unscoped `claude_code` local-collector run.
 *
 * Mirrors the full manifest-declared safe surface so an unscoped `run`
 * exercises everything the connector can account for — including
 * `coverage_diagnostics`, which is what promotes a drained local collector off
 * `coverage_unknown`. The inventory streams emit metadata only (path hash,
 * size, mtime); deferred/excluded stores never read payload.
 */
export const CLAUDE_CODE_DEFAULT_STREAMS = [
  "sessions",
  "messages",
  "attachments",
  "memory_notes",
  "skills",
  "slash_commands",
  "file_history",
  "cache_inventory",
  "coverage_diagnostics",
  "debug_artifacts",
  "downloads",
  "backup_inventory",
  "config_inventory",
] as const;

export const claudeCodeCollectorDefinition: LocalCollectorDefinition = {
  connector_id: "claude_code",
  entry: "claude_code",
  bindings: { filesystem: { required: true } },
  streams: CLAUDE_CODE_DEFAULT_STREAMS,
};
