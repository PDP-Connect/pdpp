// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { DetailLoadingSkeleton } from "../../../../components/route-loading.tsx";

/**
 * Route-level loading state for a single record's detail page.
 *
 * `/sources/[connector]/[stream]/[recordKey]` is `force-dynamic` and
 * resolves the connection, the connector manifest, and the individual record
 * (and its change history) before it can paint. Keep the shell stable and
 * animate a detail skeleton while it resolves instead of a blank frame.
 */
export default function RecordDetailLoading() {
  return (
    <RecordroomShellWithPalette>
      <DetailLoadingSkeleton label="this record" />
    </RecordroomShellWithPalette>
  );
}
