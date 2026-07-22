// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";

/**
 * Route-level loading state for the event-subscriptions list.
 *
 * `/event-subscriptions` reads the client event-subscription list
 * (and optionally peeks one) from the reference deployment on every load. Keep
 * the shell stable and animate a list skeleton instead of a blank frame.
 */
export default function EventSubscriptionsLoading() {
  return (
    <RecordroomShellWithPalette>
      <ListLoadingSkeleton label="event subscriptions" rows={6} />
    </RecordroomShellWithPalette>
  );
}
