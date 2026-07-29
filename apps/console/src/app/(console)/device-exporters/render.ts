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

export function summarizeIngestCounts(device: Pick<DeviceExporter, "source_instances">): {
  accepted: number;
  rejected: number;
} {
  return device.source_instances.reduce(
    (counts, source) => ({
      accepted: counts.accepted + (source.accepted_record_count ?? 0),
      rejected: counts.rejected + (source.rejected_record_count ?? 0),
    }),
    { accepted: 0, rejected: 0 }
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
