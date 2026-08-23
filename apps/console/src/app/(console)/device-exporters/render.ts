// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { DeviceExporter, DeviceSourceInstance } from "../lib/ref-client.ts";

export type FreshnessState = "fresh" | "stale" | "never";

const MINUTE_MS = 60 * 1000;

export function classifyHeartbeatFreshness(lastHeartbeatAt: string | null | undefined, stale: boolean): FreshnessState {
  if (!lastHeartbeatAt) {
    return "never";
  }
  return stale ? "stale" : "fresh";
}

export function formatRelativeTime(value: string | null | undefined, now = new Date()): string {
  if (!value) {
    return "never";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  const deltaMs = now.getTime() - date.getTime();
  const absMinutes = Math.max(0, Math.round(Math.abs(deltaMs) / MINUTE_MS));
  const suffix = deltaMs >= 0 ? "ago" : "from now";
  if (absMinutes < 1) {
    return deltaMs >= 0 ? "just now" : "in under a minute";
  }
  if (absMinutes < 60) {
    return `${absMinutes}m ${suffix}`;
  }
  const hours = Math.round(absMinutes / 60);
  if (hours < 48) {
    return `${hours}h ${suffix}`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ${suffix}`;
}

/**
 * A summed count that remembers whether it is complete.
 *
 * `accepted_record_count` and `rejected_record_count` are optional in the
 * published contract (`DeviceSourceInstanceSchema` does not list them as
 * required), so a source instance may carry no count at all. Coalescing an
 * absent count to `0` and summing it produces a number that LOOKS measured but
 * is not — and the device row derives its rejected TONE from that number, so a
 * fabricated zero rendered as a neutral "no rejects" reassurance. `total` is
 * therefore the sum of the counts that genuinely exist, and `complete` says
 * whether any were missing, so callers can decline to state a total they
 * cannot prove.
 */
export interface IngestCount {
  complete: boolean;
  total: number;
}

export interface IngestCounts {
  accepted: IngestCount;
  rejected: IngestCount;
}

/** Formats a count for display, refusing to print a total it cannot prove. */
export function formatIngestCount(count: IngestCount): string {
  return count.complete ? count.total.toLocaleString() : "unknown";
}

export function summarizeIngestCounts(device: Pick<DeviceExporter, "source_instances">): IngestCounts {
  return device.source_instances.reduce<IngestCounts>(
    (counts, source) => ({
      accepted: {
        complete: counts.accepted.complete && typeof source.accepted_record_count === "number",
        total: counts.accepted.total + (source.accepted_record_count ?? 0),
      },
      rejected: {
        complete: counts.rejected.complete && typeof source.rejected_record_count === "number",
        total: counts.rejected.total + (source.rejected_record_count ?? 0),
      },
    }),
    { accepted: { complete: true, total: 0 }, rejected: { complete: true, total: 0 } }
  );
}

export function formatLastError(error: Record<string, unknown> | null | undefined): string {
  if (!error) {
    return "none";
  }
  const { message } = error;
  const { code } = error;
  if (typeof message === "string" && message.trim()) {
    return message;
  }
  if (typeof code === "string" && code.trim()) {
    return code;
  }
  return "error reported";
}

export function sourceLabel(source: DeviceSourceInstance): string {
  return source.display_name || source.local_binding_name || source.source_instance_id;
}
