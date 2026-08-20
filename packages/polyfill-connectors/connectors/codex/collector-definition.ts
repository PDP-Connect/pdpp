// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import type { LocalCollectorDefinition } from "@pdpp/connector-protocol/collector-definition";

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
  "shell_snapshots",
  "config_inventory",
  "cache_inventory",
  "coverage_diagnostics",
] as const;

/**
 * Streams an owner-declared `since` can be proven against — exactly those the
 * `codex` manifest gives a `consent_time_field` (`sessions.started_at`,
 * `messages.timestamp`, `function_calls.timestamp`).
 *
 * Streams without a consent time field remain whole-store under a time bound;
 * the runner keeps them in the requested inventory and marks them unscoped.
 */
export const CODEX_TIME_SCOPABLE_STREAMS = ["sessions", "messages", "function_calls"] as const;

export const CODEX_SOURCE_ROOT_SCOPABLE_STREAMS = CODEX_TIME_SCOPABLE_STREAMS;

export const codexCollectorDefinition: LocalCollectorDefinition = {
  connector_id: "codex",
  entry: "codex",
  bindings: { filesystem: { required: true } },
  streams: CODEX_DEFAULT_STREAMS,
  enforces_source_roots: true,
  source_root_scopable_streams: CODEX_SOURCE_ROOT_SCOPABLE_STREAMS,
  time_scopable_streams: CODEX_TIME_SCOPABLE_STREAMS,
};
