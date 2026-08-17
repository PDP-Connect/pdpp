// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Signal connector's local-collector definition.
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
 * npm package itself — it spawns the external `sigtop` binary
 * (github.com/tbvdm/sigtop, ISC license) as an arms-length subprocess, the
 * same shape this repo's Slack connector already uses for slackdump and
 * Google Messages already uses for gmcli. `sigtop` is not bundled/installed
 * by `@pdpp/local-collector`; it is a separate operator-installed
 * prerequisite (`go install github.com/tbvdm/sigtop@latest`), resolved via
 * the `SIGTOP_BIN` env var (default `"sigtop"` on PATH — see index.ts's
 * `resolveSigtopBin`), documented in the manifest's
 * `runtime_requirements.external_tools` entry.
 *
 * Unlike claude_code/codex/google_messages, this connector declares no
 * `coverage_diagnostics` stream: each stream carries its own manifest
 * `coverage_strategy` (`snapshot_import_receipt` / `parent_detail_accounting`),
 * the same per-stream coverage mechanism imessage uses for an identical
 * reason (see imessage/collector-definition.ts's module doc).
 */

import type { LocalCollectorDefinition } from "../../src/collector-definition.ts";

export const SIGNAL_DEFAULT_STREAMS = ["messages", "conversations", "reactions", "attachments"] as const;

/**
 * Only `messages` declares a `consent_time_field` (`sent_at`). Conversations
 * are standing entities (full resnapshot every run), and reactions/
 * attachments carry no owner-moment of their own — all three are collected
 * whole, same as imessage's `participants`/`attachments`.
 */
export const SIGNAL_TIME_SCOPABLE_STREAMS = ["messages"] as const;

export const signalCollectorDefinition: LocalCollectorDefinition = {
  connector_id: "signal",
  entry: "signal",
  bindings: { filesystem: { required: true } },
  streams: SIGNAL_DEFAULT_STREAMS,
  time_scopable_streams: SIGNAL_TIME_SCOPABLE_STREAMS,
};
