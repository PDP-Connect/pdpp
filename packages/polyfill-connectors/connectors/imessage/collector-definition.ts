// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * iMessage connector's local-collector definition.
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
 * This connector can ship in the published npm bundle because it reads
 * chat.db via `node:sqlite`'s `DatabaseSync` (built into Node.js since
 * 22.13, no install step) instead of `better-sqlite3` — the native compiled
 * dependency `packages/local-collector`'s own package validation
 * hard-forbids from the packed output. See `index.ts`'s module doc for the
 * full rationale.
 *
 * Unlike claude_code/codex, this connector declares no `coverage_diagnostics`
 * stream: each stream already carries its own manifest `coverage_strategy`
 * (`snapshot_import_receipt` / `parent_detail_accounting`), which is the
 * connector-appropriate coverage mechanism for a chat.db snapshot read, not
 * the per-store diagnostic rollup claude_code/codex use.
 */

import type { LocalCollectorDefinition } from "@pdpp/collector-runtime/collector-definition";

export const IMESSAGE_DEFAULT_STREAMS = ["messages", "participants", "attachments"] as const;

/**
 * Only `messages` declares a `consent_time_field` (`date`). Participants are
 * standing entities and attachments carry no owner-moment of their own, so a
 * date bound is not measurable against either; both are collected whole.
 */
export const IMESSAGE_TIME_SCOPABLE_STREAMS = ["messages"] as const;

export const imessageCollectorDefinition: LocalCollectorDefinition = {
  connector_id: "imessage",
  entry: "imessage",
  bindings: { filesystem: { required: true } },
  streams: IMESSAGE_DEFAULT_STREAMS,
  time_scopable_streams: IMESSAGE_TIME_SCOPABLE_STREAMS,
};
