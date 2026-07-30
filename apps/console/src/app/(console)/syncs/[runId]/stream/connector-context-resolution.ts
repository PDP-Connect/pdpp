// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure resolution logic for the stream page's connector label, extracted so
 * it's directly unit-testable (`page.tsx` transitively imports `server-only`
 * via `owner-token.ts` and cannot be imported in a plain `node:test`
 * process).
 *
 * Intentional migration behavior (2026-07-29, root-cause gate finding #6):
 * the connection route id resolves through the reference's own exact-
 * instance-then-unambiguous-connector-id precedence
 * (`resolveUnambiguousConnectionForConnectorId`, server-side) instead of a
 * client-side "fetch the whole fleet, take the first connector_id match"
 * fallback. An ambiguous connector_id (multiple connections of the same
 * type, no instance id known) now resolves to NO match rather than
 * silently picking one sibling connection's identity — safer, but a real
 * observable change from the pre-migration behavior.
 */

import { formatConnectorNameForDisplay } from "@pdpp/operator-ui/lib/connector-display";

export interface ConnectorContext {
  connectorId: string;
  displayName: string;
}

interface ConnectorSummaryLike {
  connector_display_name?: string;
  display_name: string;
}

/**
 * The single route id to request from the reference: the exact connection
 * instance when known, else the bare connector id (which the reference
 * resolves unambiguously or not at all — never "pick the first match").
 */
export function resolveConnectorSummaryRouteId(connectorId: string, connectorInstanceId: string | null): string {
  return connectorInstanceId ?? connectorId;
}

/**
 * Build the display context from a possibly-absent resolved summary. `match`
 * is `undefined` both when the route id is genuinely unknown AND when it was
 * ambiguous (multiple connections shared the connector type) — both cases
 * degrade to the generic connector-type label, never a wrong sibling's name
 * and never a thrown error.
 */
export function buildConnectorContext(connectorId: string, match: ConnectorSummaryLike | undefined): ConnectorContext {
  return {
    connectorId,
    displayName: formatConnectorNameForDisplay({
      connectorId,
      displayName: match?.display_name,
      name: match?.connector_display_name,
    }),
  };
}
