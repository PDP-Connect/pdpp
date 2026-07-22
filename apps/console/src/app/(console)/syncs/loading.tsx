// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";

/**
 * Route-level loading state for the runs list.
 *
 * `/syncs` lists connector runs (and optionally peeks a run timeline),
 * which can be slow on a busy instance. Show a stable Ink Carbon shell plus an
 * animated list skeleton while the data resolves — the same frame the live
 * Syncs view renders, so there is no shell flash on first paint.
 */
export default function RunsLoading() {
  return (
    <RecordroomShellWithPalette>
      <ListLoadingSkeleton label="runs" rows={8} />
    </RecordroomShellWithPalette>
  );
}
