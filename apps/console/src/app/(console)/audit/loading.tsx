// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";

/**
 * Route-level loading state for the traces list.
 *
 * `/audit` lists protocol traces (and optionally peeks a timeline)
 * from the reference deployment, which can be slow on a busy instance. Keep the
 * shell stable and animate a list skeleton while the data resolves.
 */
export default function TracesLoading() {
  return (
    <RecordroomShellWithPalette>
      <ListLoadingSkeleton label="traces" rows={8} />
    </RecordroomShellWithPalette>
  );
}
