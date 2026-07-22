"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DashboardPaletteProvider — layout-level client wrapper that mounts the
 * command palette context + the palette UI itself over the entire dashboard.
 *
 * All routes rendered under the dashboard layout inherit this provider, so
 * `RecordroomShellWithPalette` (or any other consumer of `CommandPaletteContext`)
 * can call `useCommandPalette().open` without each page needing its own
 * provider setup.
 *
 * The palette is wired to the live console clean routes (`basePath=""`,
 * `mode="live"`, Sources/Syncs/Audit segments) so ⌘K/Jump navigates to the
 * canonical top-level routes rather than the legacy dashboard prefix.
 * Sandbox routes continue to use `DashboardShell` which has its own
 * `CommandPaletteProvider` bound to `/sandbox`.
 */

import { CONSOLE_BASE_PATH, CONSOLE_SEGMENTS } from "@pdpp/operator-ui/components/views/routes";
import type { ReactNode } from "react";
import { CommandPalette, CommandPaletteProvider } from "./command-palette.tsx";

export function DashboardPaletteProvider({ children }: { children: ReactNode }) {
  return (
    <CommandPaletteProvider>
      {children}
      <CommandPalette basePath={CONSOLE_BASE_PATH} mode="live" segments={CONSOLE_SEGMENTS} />
    </CommandPaletteProvider>
  );
}
