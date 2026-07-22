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
      description="The grants view ran into an error while reading from your reference deployment. Your grants and approvals are unaffected — this is a read failure, not a change. Try again, or check your reference deployment status."
      title="Couldn't load your grants"
    />
  );
}
