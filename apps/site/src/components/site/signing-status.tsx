// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Text } from "@/components/typography/text.tsx";
import { signedStatusMessage } from "@/lib/signing/status-messages.ts";

const WITHDRAW_MESSAGES: Record<string, string> = {
  closed: "Signing is closed. Nothing was changed.",
  done: "Your signature has been withdrawn. The public register updates when it is next published.",
  error: "We could not withdraw your signature right now. Try again in a few minutes.",
  invalid: "This withdrawal link is invalid. Nothing was changed.",
};

export function PdppSigningStatus({ signed, withdraw }: { signed?: string; withdraw?: string }) {
  const message = signedStatusMessage(signed) ?? (withdraw ? WITHDRAW_MESSAGES[withdraw] : undefined);
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
