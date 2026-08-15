// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 * Browser-bound connectors are intentionally absent: each gets its own
 * publishability review before being added, and the published `@pdpp/local-collector`
 * bundle stays filesystem-class only so the publish stays browser-free.
 */

import { applePhotosCollectorDefinition } from "../connectors/apple_photos/collector-definition.ts";
import { claudeCodeCollectorDefinition } from "../connectors/claude_code/collector-definition.ts";
import { codexCollectorDefinition } from "../connectors/codex/collector-definition.ts";
import { googleMessagesCollectorDefinition } from "../connectors/google_messages/collector-definition.ts";
import { googleTakeoutCollectorDefinition } from "../connectors/google_takeout/collector-definition.ts";
import { imessageCollectorDefinition } from "../connectors/imessage/collector-definition.ts";
import type { LocalCollectorDefinition } from "./collector-definition.ts";

export type { LocalCollectorBinding, LocalCollectorDefinition } from "./collector-definition.ts";

/**
 * Every connector definition the published local collector bundles, in the
 * supported public order on a fresh host: Claude Code, then Codex
 * transcripts, then Google Takeout, then iMessage, then Apple Photos, then
 * Google Messages.
 *
 * iMessage reads chat.db via `node:sqlite` (built into Node.js, not a
 * native npm module), so it carries no native compiled dependency and can
 * ship in this bundle like any other filesystem-class connector. Apple
 * Photos carries no native compiled or external subprocess dependency.
 * Google Messages spawns the external `gmcli` binary
 * (github.com/johnlindquist/gmkit, AGPL-3.0) — not bundled/installed by
 * this package, a separate operator-installed prerequisite documented in
 * its manifest and surfaced by the guided setup flow, the same
 * arms-length-subprocess shape this repo's Slack connector already uses
 * for slackdump.
 */
export const LOCAL_COLLECTOR_DEFINITIONS: readonly LocalCollectorDefinition[] = Object.freeze([
  claudeCodeCollectorDefinition,
  codexCollectorDefinition,
  googleTakeoutCollectorDefinition,
  imessageCollectorDefinition,
  applePhotosCollectorDefinition,
  googleMessagesCollectorDefinition,
]);
