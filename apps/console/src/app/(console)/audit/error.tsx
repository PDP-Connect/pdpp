"use client";

import { SegmentError } from "../components/segment-error.tsx";

export default function TracesError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <SegmentError
      {...props}
      backHref="/audit"
      backLabel="Back to traces"
      description="The traces view ran into an error while reading from your reference deployment. This is a read failure, not a change. Try again, or check your reference deployment status."
      title="Couldn't load traces"
    />
  );
}
