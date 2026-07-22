// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

/**
 * Facts captured before a device batch gains a processing reservation.  The
 * route owns validation; durable and derived writers only consume this frozen
 * snapshot.  Keeping it JSON-shaped makes the boundary easy to inspect and
 * avoids a second, ambient manifest lookup while a batch is in flight.
 */
export interface DeviceAttemptStreamFacts {
  readonly consentTimeField: string | null;
  readonly cursorField: string | null;
  readonly lexicalFields: readonly string[];
  readonly primaryKey: readonly string[];
  readonly semanticFields: readonly string[];
}

export interface DeviceAttemptContext {
  readonly manifestFingerprint: string;
  readonly semanticCapabilityIdentity: string;
  readonly streams: Readonly<Record<string, DeviceAttemptStreamFacts>>;
}

export function canonicalDeviceAttemptJson(value: unknown): string {
  return JSON.stringify(canonicalDeviceAttemptValue(value));
}

export function fingerprintDeviceAttemptManifest(manifest: unknown): string {
  return createHash("sha256").update(canonicalDeviceAttemptJson(manifest)).digest("hex");
}

function canonicalDeviceAttemptValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalDeviceAttemptValue);
  }
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) {
      canonical[key] = canonicalDeviceAttemptValue(child);
    }
  }
  return canonical;
}
