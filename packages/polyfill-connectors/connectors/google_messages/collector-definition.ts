// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Google Messages connector's local-collector definition.
 *
 * The connector's own declaration of how it participates in local
 * collection: its stable id, the runtime bindings it needs, and the default
 * stream set an unscoped `run` should request. See
 * `packages/polyfill-connectors/src/collector-definition.ts` for the
 * contract this satisfies.
 *
 * Pure data only — no Node built-ins, no connector runtime imports — so it
 * stays safe for the publishable `@pdpp/local-collector` build to re-export.
 *
 * This connector carries no native COMPILED dependency in the published
 * npm package itself — it spawns the external `gmcli` binary
 * (github.com/johnlindquist/gmkit, AGPL-3.0) as an arms-length subprocess,
 * the same shape this repo's Slack connector already uses for slackdump.
 * `gmcli` is not bundled/installed by `@pdpp/local-collector`; it is a
 * separate operator-installed prerequisite, documented in the manifest's
 * `runtime_requirements.external_tools` entry and surfaced by the guided
 * setup flow. Default streams include `coverage_diagnostics` (mirroring
 * claude_code/codex/apple_photos's mechanism) so a drained local-collector
 * run always leaves durable coverage evidence even when gmcli/pairing is
 * unavailable.
 */

import type { LocalCollectorDefinition } from "@pdpp/connector-protocol/collector-definition";

export const GOOGLE_MESSAGES_DEFAULT_STREAMS = ["messages", "coverage_diagnostics"] as const;

/**
 * `messages` declares `sent_at`; `coverage_diagnostics` is the run's own
 * accounting and carries no owner-moment, so it is always collected whole.
 */
export const GOOGLE_MESSAGES_TIME_SCOPABLE_STREAMS = ["messages"] as const;

export const googleMessagesCollectorDefinition: LocalCollectorDefinition = {
  connector_id: "google_messages",
  entry: "google_messages",
  bindings: { filesystem: { required: true } },
  streams: GOOGLE_MESSAGES_DEFAULT_STREAMS,
  time_scopable_streams: GOOGLE_MESSAGES_TIME_SCOPABLE_STREAMS,
};
