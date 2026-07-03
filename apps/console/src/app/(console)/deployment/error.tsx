"use client";

import { SegmentError } from "../components/segment-error.tsx";

export default function DeploymentError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <SegmentError
      {...props}
      backHref="/deployment"
      backLabel="Back to deployment"
      description="The deployment view ran into an error while probing your reference deployment. This is a read failure, not a change to your instance. Try again, or check your reference deployment status."
      title="Couldn't load deployment status"
    />
  );
}
