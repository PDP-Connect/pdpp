// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { TableLoadingSkeleton } from "../../../components/route-loading.tsx";

/**
 * Route-level loading state for a stream's records table.
 *
 * `/sources/[connector]/[stream]` is `force-dynamic` and awaits the
 * connection resolution, a paged `queryRecords` read, and the connector
 * manifests before it can paint — the surface the owner specifically reported
 * as slow. Without its own `loading.tsx` it inherited the connection-detail
 * skeleton (two stacked prose blocks), which is the wrong shape for a dense
 * record table and shifts the layout when the table arrives. A table-shaped
 * skeleton inside the stable shell gives immediate, correctly-shaped feedback.
 */
export default function StreamRecordsLoading() {
  return (
    <RecordroomShellWithPalette>
      <TableLoadingSkeleton label="records" rows={8} />
    </RecordroomShellWithPalette>
  );
}
