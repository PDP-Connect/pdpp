// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

/**
 * RecordroomShellWithPalette — drop-in replacement for `RecordroomShell` on
 * routes that live under the dashboard layout (and therefore inside
 * `DashboardPaletteProvider`).
 *
 * It wires the `onJump` prop to `CommandPaletteContext.toggle`, so the Jump
 * button in the shell header and the ⌘K / Ctrl+K shortcut both open (or
 * close) the command palette. Using `toggle` rather than `open` ensures the
 * shell's own ⌘K listener and the provider's listener don't fight — pressing
 * ⌘K once always toggles instead of opening-then-immediately-re-opening.
 *
 * Design invariants:
 *   - `@pdpp/brand-react` does NOT import console or operator-ui concerns —
 *     the dependency is one-way (console → brand-react). We bridge here in the
 *     console layer by reading the context and passing a plain callback down as
 *     `onJump`.
 */

import { RecordroomShell } from "@pdpp/brand-react";
import type { ReactNode } from "react";
import { useCommandPalette } from "./command-palette.tsx";

interface RecordroomShellWithPaletteProps {
  build?: string;
  children: ReactNode;
  host?: string;
}

export function RecordroomShellWithPalette({ build, children, host }: RecordroomShellWithPaletteProps) {
  const { toggle } = useCommandPalette();
  return (
    <RecordroomShell build={build} host={host} onJump={toggle}>
      {children}
    </RecordroomShell>
  );
}
