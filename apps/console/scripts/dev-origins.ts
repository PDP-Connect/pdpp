// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { hostname, networkInterfaces } from "node:os";

interface MinimalNetworkInterfaceInfo {
  address: string;
  family: "IPv4" | "IPv6";
}

function normalizeOriginHost(origin: string): string | null {
  const trimmed = origin.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("*.")) {
    return trimmed.toLowerCase();
  }
  try {
    return new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`).hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

export function parseAllowedDevOrigins(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map(normalizeOriginHost)
    .filter((host): host is string => Boolean(host));
}

function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts as [number, number, number, number];
}

export function isLocalDevIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (!parts) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function localInterfaceHosts(
  interfaces: Record<string, MinimalNetworkInterfaceInfo[] | undefined> = networkInterfaces()
) {
  const hosts: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && isLocalDevIpv4(entry.address)) {
        hosts.push(entry.address);
      }
    }
  }
  return hosts;
}

export function collectAllowedDevOrigins({
  envValue = process.env.PDPP_WEB_ALLOWED_DEV_ORIGINS,
  interfaces = networkInterfaces(),
  hostName = hostname(),
}: {
  envValue?: string;
  hostName?: string;
  interfaces?: Record<string, MinimalNetworkInterfaceInfo[] | undefined>;
} = {}) {
  const origins = new Set(parseAllowedDevOrigins(envValue));
  for (const address of localInterfaceHosts(interfaces)) {
    origins.add(address);
  }
  const normalizedHost = normalizeOriginHost(hostName);
  if (normalizedHost && normalizedHost !== "localhost") {
    origins.add(normalizedHost);
    origins.add(`${normalizedHost}.local`);
  }
  return [...origins].sort();
}
