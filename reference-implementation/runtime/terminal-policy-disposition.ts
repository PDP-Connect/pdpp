// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** The sole terminal policy disposition currently allowed to affect coverage. */
export const GMAIL_ATTACHMENT_TOO_LARGE_POLICY_DISPOSITION = "gmail_attachment_too_large";

export interface GmailAttachmentTooLargePolicyDisposition {
  readonly configured_limit_bytes: number;
  readonly kind: typeof GMAIL_ATTACHMENT_TOO_LARGE_POLICY_DISPOSITION;
  readonly observed_size_bytes: number;
}

export interface TerminalPolicyDispositionContext {
  readonly connectorId: string;
  readonly detailLocator: unknown;
  readonly lastError: unknown;
  readonly reason: string | null;
  readonly stream: string;
}

const GMAIL_CONNECTOR_IDS = new Set(["gmail", "https://registry.pdpp.org/connectors/gmail"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Parses the closed, persisted discriminator. Extra fields are rejected so a
 * future policy cannot inherit coverage semantics without an explicit review.
 */
export function parseGmailAttachmentTooLargePolicyDisposition(
  value: unknown
): GmailAttachmentTooLargePolicyDisposition | null {
  const disposition = record(value);
  if (!disposition || Object.keys(disposition).length !== 3) {
    return null;
  }
  const configuredLimit = disposition.configured_limit_bytes;
  const observedSize = disposition.observed_size_bytes;
  if (
    disposition.kind !== GMAIL_ATTACHMENT_TOO_LARGE_POLICY_DISPOSITION ||
    !positiveSafeInteger(configuredLimit) ||
    !positiveSafeInteger(observedSize) ||
    observedSize <= configuredLimit
  ) {
    return null;
  }
  return {
    configured_limit_bytes: configuredLimit,
    kind: GMAIL_ATTACHMENT_TOO_LARGE_POLICY_DISPOSITION,
    observed_size_bytes: observedSize,
  };
}

/**
 * Validates the policy proof at every authority boundary. The discriminator is
 * valid only for Gmail attachment terminal settlement, never by a mutable
 * reason/error class alone.
 */
export function validatedTerminalPolicyDisposition(
  disposition: unknown,
  context: TerminalPolicyDispositionContext
): GmailAttachmentTooLargePolicyDisposition | null {
  const locator = record(context.detailLocator);
  const error = record(context.lastError);
  if (
    !GMAIL_CONNECTOR_IDS.has(context.connectorId) ||
    context.stream !== "attachments" ||
    context.reason !== "too_large" ||
    locator?.kind !== "gmail.attachment_detail" ||
    error?.class !== "too_large"
  ) {
    return null;
  }
  return parseGmailAttachmentTooLargePolicyDisposition(disposition);
}

export function requireValidatedTerminalPolicyDisposition(
  disposition: unknown,
  context: TerminalPolicyDispositionContext
): GmailAttachmentTooLargePolicyDisposition {
  const validated = validatedTerminalPolicyDisposition(disposition, context);
  if (!validated) {
    throw new Error("invalid terminal policy disposition");
  }
  return validated;
}
