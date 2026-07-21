/**
 * Registry of connectors that support PDPP local (device-side) collection.
 *
 * This is the single source of truth for *which* connectors participate in
 * local collection and *how* — assembled from each connector's own
 * {@link LocalCollectorDefinition}. It intentionally lives in
 * `@pdpp/polyfill-connectors` (which owns the connectors), not in the generic
 * `@pdpp/local-collector` runtime: the connector defines its collector; the
 * runtime discovers definitions.
 *
 * The publishable collector's composition root imports {@link
 * LOCAL_COLLECTOR_DEFINITIONS} and injects it into the generic runtime. Adding
 * a filesystem-class connector to the published bundle is a one-line addition
 * here (plus the connector's own `collector-definition.ts`) — the runtime does
 * not change.
 *
 * Browser-bound connectors are intentionally absent: each gets its own
 * publishability review before being added, and the published `@pdpp/local-collector`
 * bundle stays filesystem-class only so the publish stays browser-free.
 */

import { claudeCodeCollectorDefinition } from "../connectors/claude_code/collector-definition.ts";
import { codexCollectorDefinition } from "../connectors/codex/collector-definition.ts";
import type { LocalCollectorDefinition } from "./collector-definition.ts";

export type { LocalCollectorBinding, LocalCollectorDefinition } from "./collector-definition.ts";

/**
 * Every connector definition the published local collector bundles, in the
 * supported public order on a fresh host (Claude Code, then Codex transcripts).
 */
export const LOCAL_COLLECTOR_DEFINITIONS: readonly LocalCollectorDefinition[] = Object.freeze([
  claudeCodeCollectorDefinition,
  codexCollectorDefinition,
]);
