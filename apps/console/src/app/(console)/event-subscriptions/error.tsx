"use client";

import { SegmentError } from "../components/segment-error.tsx";

export default function EventSubscriptionsError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <SegmentError
      {...props}
      backHref="/event-subscriptions"
      backLabel="Back to event subscriptions"
      description="The event subscriptions view ran into an error while reading from your reference deployment. Your subscriptions are unaffected — this is a read failure, not a change. Try again, or check your reference deployment status."
      title="Couldn't load your event subscriptions"
    />
  );
}
