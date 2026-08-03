// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The persisted Gmail attachment locator shapes that scheduled recovery can
 * actually measure. This is intentionally the single parser for both the
 * connector and bounded repair selection: a row that cannot reach a provider
 * lookup must never be returned to pending recovery.
 */
export interface GmailAttachmentRecoveryLocator {
  attachmentId: string | null;
  messageId: string;
  partIndex: string;
}

export function normalizeGmailAttachmentRecoveryLocator(locator: unknown): GmailAttachmentRecoveryLocator | null {
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
    return null;
  }
  const typedLocator = locator as Record<string, unknown>;
  if (typedLocator.kind !== "gmail.attachment_detail") {
    return null;
  }
  // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
  const attachmentId = typedLocator.attachment_id == null ? null : String(typedLocator.attachment_id).trim() || null;
  // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
  let messageId = typedLocator.message_id == null ? "" : String(typedLocator.message_id).trim();
  // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
  let partIndex = typedLocator.part_index == null ? "" : String(typedLocator.part_index).trim();
  if (attachmentId && !(messageId && partIndex)) {
    const separator = attachmentId.lastIndexOf(":");
    if (separator <= 0 || separator === attachmentId.length - 1) {
      return null;
    }
    const derivedMessageId = attachmentId.slice(0, separator);
    const derivedPartIndex = attachmentId.slice(separator + 1);
    messageId ||= derivedMessageId;
    partIndex ||= derivedPartIndex;
  }
  if (!(messageId && partIndex)) {
    return null;
  }
  return { attachmentId, messageId, partIndex };
}
