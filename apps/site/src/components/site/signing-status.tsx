// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Text } from "@/components/typography/text.tsx";

const SIGNED_MESSAGES: Record<string, string> = {
  closed: "Signing is closed. Nothing was saved.",
  confirmed: "Your signature is confirmed. The public register updates when it is next published.",
  error: "We could not confirm your signature right now. Try again in a few minutes.",
  incomplete: "We could not accept that submission. Check the required fields and try again.",
  invalid: "This confirmation link is invalid or has expired. Nothing was changed.",
  pending: "Check your email to confirm your signature. Nothing is published until you use that link.",
  ratelimited: "Too many submissions came from this connection. Try again in a few minutes.",
  unavailable:
    "We could not send the confirmation email right now. Your details will be discarded. Try again in a few minutes.",
};

const WITHDRAW_MESSAGES: Record<string, string> = {
  closed: "Signing is closed. Nothing was changed.",
  done: "Your signature has been withdrawn. The public register updates when it is next published.",
  error: "We could not withdraw your signature right now. Try again in a few minutes.",
  invalid: "This withdrawal link is invalid. Nothing was changed.",
};

export function PdppSigningStatus({ signed, withdraw }: { signed?: string; withdraw?: string }) {
  let message: string | undefined;
  if (signed) {
    message = SIGNED_MESSAGES[signed];
  } else if (withdraw) {
    message = WITHDRAW_MESSAGES[withdraw];
  }
  if (!message) {
    return null;
  }
  return (
    <div aria-live="polite" className="border border-border p-4" data-slot="pdpp-signing-status" role="status">
      <Text as="p" size="body">
        {message}
      </Text>
    </div>
  );
}
