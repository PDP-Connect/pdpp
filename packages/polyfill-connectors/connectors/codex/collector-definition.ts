/**
 * Codex connector's local-collector definition.
 *
 * This is the connector's own declaration of how it participates in local
 * collection: its stable id, the runtime bindings it needs, and the default
 * stream set an unscoped `run` should request. The generic
 * `@pdpp/local-collector` runtime consumes these definitions instead of
 * hardcoding a per-connector table — the connector owns this knowledge, the
 * runtime stays connector-agnostic.
 *
 * Pure data only. This module MUST NOT import connector runtime code, Node
 * built-ins, or anything browser-bound: it is imported by the runner-side
 * registry that the publishable collector build re-exports, so it has to stay
 * dependency-free and trivially tree-shakeable.
 *
 * Spec: openspec/changes/publish-pdpp-local-collector/design.md §3.
 */

import type { LocalCollectorDefinition } from "../../src/collector-definition.ts";

/**
 * Default stream set for an unscoped `codex` local-collector run.
 *
 * Mirrors the full manifest-declared safe surface: `coverage_diagnostics` is
 * what promotes a drained local collector off `coverage_unknown` (the local
 * run path writes no spine run, so the connection-health rollup derives the
 * coverage axis from durable `coverage_diagnostics` records alone), and the
 * inventory streams emit metadata only (path hash, size, mtime).
 */
export const CODEX_DEFAULT_STREAMS = [
  "sessions",
  "messages",
  "function_calls",
  "rules",
  "prompts",
  "skills",
  "history",
  "session_index",
  "logs",
  "shell_snapshots",
  "config_inventory",
  "cache_inventory",
  "coverage_diagnostics",
] as const;

export const codexCollectorDefinition: LocalCollectorDefinition = {
  connector_id: "codex",
  entry: "codex",
  bindings: { filesystem: { required: true } },
  streams: CODEX_DEFAULT_STREAMS,
};
