// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stream display label resolution — unified boundary for preferring
 * manifest-declared human labels over protocol stream identifiers.
 *
 * All protocol streams use stable, machine-readable identifiers.
 * The manifest's display.label is the owner-facing presentation.
 * Surfaces always prefer display.label when available, fall back
 * honestly to stream name when absent.
 */

export interface StreamManifestEntry {
  display?: {
    detail?: string;
    label?: string;
  };
  name: string;
  [k: string]: unknown;
}

export function streamDisplayLabel(streamName: string, streamDecl: StreamManifestEntry | undefined): string {
  return streamDecl?.display?.label ?? streamName;
}

export function streamDisplayDetail(streamDecl: StreamManifestEntry | undefined): string | undefined {
  return streamDecl?.display?.detail;
}
