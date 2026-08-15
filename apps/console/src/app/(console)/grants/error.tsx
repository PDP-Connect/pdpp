"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { SegmentError } from "../components/segment-error.tsx";

export default function GrantsError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <SegmentError
      {...props}
      backHref="/grants"
      backLabel="Back to grants"
      description="Reading from your reference deployment failed. Your grants and approvals are unchanged. Try again, or check your deployment status."
      title="Couldn't load your grants"
    />
  );
}
