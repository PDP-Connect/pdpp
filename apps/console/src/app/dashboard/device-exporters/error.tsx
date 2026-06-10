"use client";

import { SegmentError } from "../components/segment-error.tsx";

export default function DeviceExportersError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <SegmentError
      {...props}
      backHref="/dashboard/device-exporters"
      backLabel="Back to device exporters"
      description="The device exporters view ran into an error while reading collector diagnostics from your reference deployment. Your exporters and enrollments are unaffected — this is a read failure, not a change. Try again, or check your reference deployment status."
      title="Couldn't load your device exporters"
    />
  );
}
