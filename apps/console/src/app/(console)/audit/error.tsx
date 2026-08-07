"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { SegmentError } from "../components/segment-error.tsx";

export default function AuditError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <SegmentError
      {...props}
      backHref="/audit"
      backLabel="Back to audit"
      description="The audit view ran into an error while reading from your reference deployment. Reading failed; nothing changed. Try again, or check your reference deployment status."
      title="Couldn't load your audit log"
    />
  );
}
