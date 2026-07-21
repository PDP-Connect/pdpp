// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { SegmentError } from "../components/segment-error.tsx";

export default function SchedulesError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <SegmentError
      {...props}
      backHref="/schedules"
      backLabel="Back to schedules"
      description="The schedules view ran into an error while reading from your reference deployment. Your schedules are unaffected — this is a read failure, not a change. Try again, or check your reference deployment status."
      title="Couldn't load your schedules"
    />
  );
}
