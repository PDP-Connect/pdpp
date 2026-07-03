/**
 * Pure, dependency-free helpers for the operator grant-request flow's
 * per-connection pin. Kept free of Next/server-only imports so the projection
 * and stream-selection logic can be executed directly under `node --test`
 * (mirroring `apps/site/src/lib/consent-connection-label.ts`).
 *
 * The only import is the shared, dependency-free connector-display labeler so
 * the operator flow names a connection exactly the way the consent card and
 * the records dashboard do — one definition of "owner-meaningful label".
 */

import { formatConnectorNameForDisplay, isFallbackConnectionLabel } from "@pdpp/operator-ui/lib/connector-display";

/** Source kinds a grant request can address. Only `connector` has connections. */
export type GrantRequestSourceKind = "connector" | "provider_native";

/** Minimal connector-summary shape this projection reads. */
export interface ConnectionSummaryLike {
  connection_id?: string | null;
  connector_id?: string | null;
  display_name?: string | null;
  streams?: readonly string[] | null;
}

/** A draft's connection-relevant fields. */
export interface ConnectionPinDraft {
  connectionId: string;
  fields: string;
  sourceId: string;
  sourceKind: GrantRequestSourceKind;
  streamName: string;
  view: string;
}

/**
 * One owner-meaningful, pinnable connection under the chosen source. `value`
 * is the stable `connection_id` the grant pins; `label` is what the owner
 * sees on the select. Never carries a placeholder/URL/bare-type string as the
 * primary label (the same rule the consent card enforces).
 */
export interface ConnectionPinOption {
  label: string;
  value: string;
}

function trim(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeFields(value: string): string[] | undefined {
  const fields = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return fields.length ? fields : undefined;
}

/**
 * The single stream selection the operator flow stages. When the owner pinned
 * a specific connection, `connection_id` lands on the stream entry — the
 * existing `StreamSelectionSchema.connection_id` grant field the read path
 * already enforces. When the pin is empty, the field is omitted so the grant
 * fans in across the connections it authorizes (the explicit default).
 */
export function streamSelectionFromDraft(draft: ConnectionPinDraft, streamName: string) {
  const fields = normalizeFields(draft.fields);
  const view = trim(draft.view);
  const connectionId = trim(draft.connectionId);
  return {
    name: streamName,
    ...(fields ? { fields } : {}),
    ...(view ? { view } : {}),
    ...(connectionId ? { connection_id: connectionId } : {}),
  };
}

/**
 * Project the active connections under a chosen connector source into labelled
 * pin options. Pure so it can be unit-tested without the AS.
 *
 * - Only connector sources have a connection dimension; provider-native and
 *   empty sources return `[]` so the page hides the pin control.
 * - Each option's label is derived through the shared
 *   `formatConnectorNameForDisplay` so owner-set names show verbatim and
 *   never-renamed connections fall back to the connector type. When two
 *   connections would collapse to the same label, a stable `· account N`
 *   disambiguator (1-based, in summary order) is appended so the owner can
 *   tell them apart — mirroring the consent card's per-connection rule.
 * - `connection_id` is the pinned value, never rendered as the label.
 */
export function buildConnectionPinOptions(
  source: { id: string; kind: GrantRequestSourceKind; streamName?: string },
  summaries: readonly ConnectionSummaryLike[]
): ConnectionPinOption[] {
  const sourceId = trim(source.id);
  const streamName = trim(source.streamName);
  if (source.kind !== "connector" || !sourceId) {
    return [];
  }
  const matching = summaries
    .filter((summary) => {
      if (trim(summary.connector_id) !== sourceId || !trim(summary.connection_id)) {
        return false;
      }
      return !streamName || (summary.streams ?? []).includes(streamName);
    })
    .map((summary) => {
      const connectorId = trim(summary.connector_id);
      const owned = !isFallbackConnectionLabel({
        connectorId,
        displayName: summary.display_name,
      });
      const base = formatConnectorNameForDisplay({
        connectorId,
        displayName: owned ? summary.display_name : null,
      });
      return { value: trim(summary.connection_id), base };
    });

  const labelCounts = new Map<string, number>();
  for (const entry of matching) {
    labelCounts.set(entry.base, (labelCounts.get(entry.base) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return matching.map((entry) => {
    if ((labelCounts.get(entry.base) ?? 0) <= 1) {
      return { value: entry.value, label: entry.base };
    }
    const ordinal = (seen.get(entry.base) ?? 0) + 1;
    seen.set(entry.base, ordinal);
    return { value: entry.value, label: `${entry.base} · account ${ordinal}` };
  });
}
