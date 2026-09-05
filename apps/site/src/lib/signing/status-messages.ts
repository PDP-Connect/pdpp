// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const SIGNED_MESSAGES: Record<string, string> = {
  closed: "Signing is closed. Nothing was saved.",
  confirmed: "Your signature is confirmed. The public register updates when it is next published.",
  error: "We could not confirm your signature right now. Try again in a few minutes.",
  incomplete: "We could not accept that submission. Check the required fields and try again.",
  invalid: "This confirmation link is invalid or has expired. Nothing was changed.",
  pending: "Check your email to confirm your signature. Nothing is published until you use that link.",
  ratelimited: "Too many submissions came from this connection. Try again in a few minutes.",
  unavailable: "We could not send the confirmation email. Try again in a few minutes.",
};

const UNKNOWN_SIGNED_MESSAGE = "That link is not valid. Nothing was changed.";

export function signedStatusMessage(signed: string | undefined): string | undefined {
  return signed ? (SIGNED_MESSAGES[signed] ?? UNKNOWN_SIGNED_MESSAGE) : undefined;
}
