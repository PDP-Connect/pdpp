import { ListLoadingSkeleton } from "../components/route-loading.tsx";
import { DashboardShell } from "../components/shell.tsx";

/**
 * Route-level loading state for the event-subscriptions list.
 *
 * `/dashboard/event-subscriptions` reads the client event-subscription list
 * (and optionally peeks one) from the reference deployment on every load. Keep
 * the shell stable and animate a list skeleton instead of a blank frame.
 */
export default function EventSubscriptionsLoading() {
  return (
    <DashboardShell active="event-subscriptions">
      <ListLoadingSkeleton label="event subscriptions" rows={6} />
    </DashboardShell>
  );
}
