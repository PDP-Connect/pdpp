// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stable major version of the local-collector ↔ reference-server
 * device-exporter ingest contract.
 *
 * This is reference/control-plane behavior, not PDPP Core. The runner sends
 * the version on enrollment and every device-exporter request so the reference
 * server can reject incompatible collectors before persisting records or state.
 */
export const COLLECTOR_PROTOCOL_VERSION = "1";

/** Canonical HTTP header for the local collector protocol version. */
export const COLLECTOR_PROTOCOL_HEADER = "X-PDPP-Collector-Protocol";
