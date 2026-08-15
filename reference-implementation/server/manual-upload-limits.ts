// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Manual-upload transport body-size ceiling — a deployment resource/quota
 * policy, not a protocol constant. This is the OUTER bound enforced at the
 * HTTP transport layer (both the browser-facing Next.js proxy/server-action
 * body limit in apps/console/next.config.mjs, and the RI route's own
 * `bodyLimit` in ref-manual-upload-draft-connection.ts). Individual
 * connectors declare their own, typically tighter, `max_file_bytes` in their
 * manifest (e.g. Netflix 50 MiB, Google Maps 100 MiB, WhatsApp much larger to
 * accommodate "export chat with media") — this constant only needs to be
 * large enough to admit the LARGEST of those, never smaller.
 *
 * Both call sites import this SAME module so the limit cannot silently
 * diverge into two different literals that drift out of sync (which is what
 * happened before: MANUAL_UPLOAD_ROUTE_BODY_LIMIT_BYTES and
 * next.config.mjs's manualUploadBodyLimit were two independently-maintained
 * numbers that happened to agree by coincidence, not by construction).
 *
 * Configurable via PDPP_MANUAL_UPLOAD_MAX_BYTES so an operator can raise (or
 * lower) it for their deployment without a code change. Defaults to 24 GiB —
 * comfortably above the WhatsApp connector's own default archive ceiling
 * (WHATSAPP_MAX_ARCHIVE_BYTES, see connectors/whatsapp/parsers.ts, default 20
 * GiB) so a legitimate large WhatsApp "export chat with media" is never
 * rejected at the transport layer before it can even reach connector-level
 * validation.
 */

const DEFAULT_MANUAL_UPLOAD_MAX_BYTES = 24 * 1024 * 1024 * 1024;

export function manualUploadMaxBytes(): number {
  const raw = process.env.PDPP_MANUAL_UPLOAD_MAX_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MANUAL_UPLOAD_MAX_BYTES;
}

/** Next.js body-size config wants a "<number>mb"/"<number>gb" string, not a byte count. */
export function manualUploadMaxBytesAsNextBodySizeString(): string {
  const bytes = manualUploadMaxBytes();
  const mb = Math.ceil(bytes / (1024 * 1024));
  return `${mb}mb`;
}
