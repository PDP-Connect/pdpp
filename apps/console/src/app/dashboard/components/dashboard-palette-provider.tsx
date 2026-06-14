"use client";

/**
 * DashboardPaletteProvider — layout-level client wrapper that mounts the
 * command palette context + the palette UI itself over the entire dashboard.
 *
 * All routes rendered under the dashboard layout inherit this provider, so
 * `RecordroomShellWithPalette` (or any other consumer of `CommandPaletteContext`)
 * can call `useCommandPalette().open` without each page needing its own
 * provider setup.
 *
 * The palette is always wired to the live dashboard (`basePath="/dashboard"`,
 * `mode="live"`). Sandbox routes continue to use `DashboardShell` which has
 * its own `CommandPaletteProvider`.
 */

import type { ReactNode } from "react";
import { CommandPalette, CommandPaletteProvider } from "./command-palette.tsx";

export function DashboardPaletteProvider({ children }: { children: ReactNode }) {
  return (
    <CommandPaletteProvider>
      {children}
      <CommandPalette basePath="/dashboard" mode="live" />
    </CommandPaletteProvider>
  );
}
