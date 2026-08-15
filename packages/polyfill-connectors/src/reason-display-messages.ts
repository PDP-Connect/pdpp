// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reads every shipped connector manifest's `reason_display_messages` field:
 * connector-owned end-user copy for the `SKIP_RESULT`/`connector_error`/
 * `DETAIL_GAP` reason codes that connector emits.
 *
 * This package owns connector/provider knowledge — a connector's reason
 * vocabulary and the end-user copy for it are that connector's own facts,
 * same status as everything else in its manifest. The reference
 * implementation carries NO connector-specific display copy (see
 * `reference-implementation/runtime/display-messages.ts`, which owns only
 * the small closed set of RI-normalized generic recovery-class codes);
 * anything reaching an owner-facing surface for a connector-specific reason
 * code is looked up here, not hardcoded in RI. RI-side test code (not
 * production code — see the zero-connector-knowledge conformance guard's
 * test-file exemption) imports this module directly, by relative path, the
 * same way several other RI tests already reach into this package's `src/`.
 *
 * Reason vocabulary is CONNECTOR-OWNED, not a shared global namespace: this
 * module is keyed by (connector_key, reason_code), not by reason_code alone.
 * Two different connectors may both emit a reason code with the same literal
 * spelling (e.g. two DOM-scraping connectors both using `selector_drift`)
 * and give it entirely different, independently-vetted copy — that is
 * legitimate and expected, not a collision to resolve. `reason_display_messages`
 * is an optional top-level manifest field (`Record<reason_code,
 * display_message>`); validation (non-empty string, not a bare-key parrot)
 * happens within one manifest only. JSON object keys are already unique per
 * file, so no duplicate-key collision is possible within one manifest.
 *
 * The one cross-manifest check this module DOES make: a manifest must not
 * declare a code from `runtime/display-messages.ts`'s reserved
 * `RUNTIME_GENERIC_REASON_CODES` set (checked by
 * `reason-display-messages.test.ts`, which imports both this module and that
 * one — this module itself has no dependency on `reference-implementation`
 * and does not duplicate that list, keeping the dependency direction
 * one-way).
 */

import { readPolyfillManifests } from "./manifest-registry.ts";

interface ManifestLike {
  connector_id?: unknown;
  connector_key?: unknown;
  reason_display_messages?: unknown;
}

const REGISTRY_URL_PREFIX = "https://registry.pdpp.dev/connectors/";

function manifestKey(manifest: ManifestLike, fallbackFile: string): string {
  if (typeof manifest.connector_key === "string" && manifest.connector_key.trim()) {
    return manifest.connector_key.trim();
  }
  if (typeof manifest.connector_id === "string" && manifest.connector_id.trim()) {
    return manifest.connector_id.startsWith(REGISTRY_URL_PREFIX)
      ? manifest.connector_id.slice(REGISTRY_URL_PREFIX.length)
      : manifest.connector_id;
  }
  return fallbackFile;
}

export class ReasonDisplayMessageError extends Error {}

/**
 * Every shipped polyfill-connector manifest's own `reason_display_messages`,
 * keyed by connector_key. Re-derived on every call (manifests are small,
 * this is not a hot path) rather than cached, so tests can point
 * `PDPP_POLYFILL_MANIFESTS_DIR` at a scratch directory and see it reflected
 * immediately (matches `readPolyfillManifests`'s own behavior).
 */
export function connectorReasonDisplayMessages(): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const byConnector: Record<string, Record<string, string>> = {};

  for (const { file, manifest } of readPolyfillManifests()) {
    const raw = (manifest as ManifestLike).reason_display_messages;
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ReasonDisplayMessageError(
        `${file}: reason_display_messages must be an object of reason_code -> display_message strings`
      );
    }
    const key = manifestKey(manifest as ManifestLike, file);
    const messages: Record<string, string> = {};
    for (const [reasonCode, displayMessage] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof displayMessage !== "string" || displayMessage.trim().length === 0) {
        throw new ReasonDisplayMessageError(
          `${file}: reason_display_messages["${reasonCode}"] must be a non-empty string`
        );
      }
      if (displayMessage === reasonCode) {
        throw new ReasonDisplayMessageError(
          `${file}: reason_display_messages["${reasonCode}"] repeats its own key — write vetted end-user copy, not the raw code`
        );
      }
      messages[reasonCode] = displayMessage;
    }
    byConnector[key] = messages;
  }

  return Object.freeze(byConnector);
}

/** Looks up one connector's declared copy for one reason code, or `null` if none is declared. */
export function connectorReasonDisplayMessage(connectorKey: string | null, reasonCode: string | null): string | null {
  if (!(connectorKey && reasonCode)) {
    return null;
  }
  return connectorReasonDisplayMessages()[connectorKey]?.[reasonCode] ?? null;
}
