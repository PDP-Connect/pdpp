/**
 * Collector protocol compatibility surface.
 *
 * Reference/control-plane behavior, NOT PDPP Core. The reference server and
 * any external collector runner (today: the runner inside
 * `@pdpp/polyfill-connectors`; tomorrow: the published `@pdpp/local-collector`
 * package) declare compatibility via a small semver-major protocol version.
 *
 * The version is sent on every device-exporter request via
 * `X-PDPP-Collector-Protocol`, and on enrollment is also persisted on the
 * device row so the dashboard can render an `collector_protocol_outdated`
 * warning when an already-enrolled device drifts out of the accepted set.
 *
 * Old devices enrolled before this header existed have `null` on the device
 * row and are reported as `legacy_unknown` rather than silently assumed
 * compatible — diagnostics must not hide drift.
 *
 * Spec: openspec/changes/publish-pdpp-local-collector
 */

// Single semver-major identifier. Starts at "1" per Decision 3 in
// publish-pdpp-local-collector/design.md. Bump only on breaking ingest /
// enrollment contract changes.
export const COLLECTOR_PROTOCOL_VERSION = "1" as const;

export const COLLECTOR_PROTOCOL_HEADER = "x-pdpp-collector-protocol";

// The set the reference server accepts. Today: only the current version.
// A future server release that adds version "2" while still accepting "1"
// would list both here; mismatches are still rejected before any record
// persists.
export const SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS: readonly string[] = [
  COLLECTOR_PROTOCOL_VERSION,
];

export type CollectorProtocolVersion = string;

export interface CollectorProtocolMismatch {
  readonly accepted_versions: readonly string[];
  readonly received_version: string | null;
}

export function isAcceptedCollectorProtocolVersion(version: string | null | undefined): boolean {
  if (typeof version !== "string" || version.length === 0) {
    return false;
  }
  return SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS.includes(version);
}

export function readCollectorProtocolHeader(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers[COLLECTOR_PROTOCOL_HEADER];
  if (Array.isArray(raw)) {
    const first = raw[0];
    return typeof first === "string" && first.trim() ? first.trim() : null;
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  return null;
}

export function buildCollectorProtocolMismatchBody(receivedVersion: string | null): CollectorProtocolMismatch {
  return {
    accepted_versions: [...SUPPORTED_COLLECTOR_PROTOCOL_VERSIONS],
    received_version: receivedVersion,
  };
}
