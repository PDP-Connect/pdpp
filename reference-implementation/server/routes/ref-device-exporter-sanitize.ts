// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Diagnostic sanitization helpers for device-exporter routes.
//
// Extracted from `server/index.js` per the OpenSpec change
// `split-reference-server-by-route-family`. These are pure transformation
// functions: no route registration, no auth, no state writes, no closure
// captures from `buildAsApp`.
//
// Covered by the device-exporter route integration suite:
//   test/device-exporter-routes.test.js
//   test/device-exporter-state-routes.test.js
//   test/connector-failure-diagnostics.test.js

import { redactStderrTail } from "../../runtime/stderr-redact.ts";

const SENSITIVE_DIAGNOSTIC_KEY_RE = /\b(authorization|bearer|token|password|passwd|cookie|secret|otp|api[_-]?key)\b/i;
const LOCAL_SECRET_PATH_FRAGMENT_RE =
  /(^|[\s"'=(:])(?:[^\s"'=(:),]+\/)*\.(?:codex|claude|ssh|aws|gcloud|config)(?:\/[^\s"',)]+)*/gi;

function redactLocalSecretPathFragments(value: string): string {
  return value.replace(LOCAL_SECRET_PATH_FRAGMENT_RE, "$1[REDACTED_PATH]");
}

export function sanitizeLocalCollectorGapDetails(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const redacted = redactLocalSecretPathFragments(redactStderrTail(value).text).replace(/\s+/g, " ").trim();
  if (!redacted) {
    return null;
  }
  return redacted.length <= 300 ? redacted : `${redacted.slice(0, 299)}…`;
}

export function sanitizeDeviceExporterDiagnostic(value: unknown, depth = 0): unknown {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return sanitizeDeviceExporterDiagnosticText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 4) {
      return "[REDACTED_DEPTH]";
    }
    return value.slice(0, 20).map((item) => sanitizeDeviceExporterDiagnostic(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 4) {
      return "[REDACTED_DEPTH]";
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_DIAGNOSTIC_KEY_RE.test(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = sanitizeDeviceExporterDiagnostic(child, depth + 1);
    }
    return out;
  }
  return null;
}

function sanitizeDeviceExporterDiagnosticText(value: string): string {
  let redacted = redactStderrTail(value).text;
  redacted = redacted.replace(/(?:^|[\s"'=(:])(?:\/home|\/Users|\/root)\/[^\s"',)]+/g, (match: string) => {
    const prefix = match.startsWith("/") ? "" : match[0];
    return `${prefix}[REDACTED_PATH]`;
  });
  redacted = redacted.replace(/\b[A-Za-z]:\\Users\\[^\s"',)]+/g, "[REDACTED_PATH]");
  redacted = redactLocalSecretPathFragments(redacted);
  return redacted.replace(/\s+/g, " ").trim();
}
