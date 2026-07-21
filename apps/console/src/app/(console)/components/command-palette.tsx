"use client";

/**
 * Command palette — re-exported from the single unified implementation in
 * `@pdpp/operator-ui`. There is exactly ONE palette component and ONE
 * ⌘K/Ctrl+K listener across the console and the public sandbox; this file only
 * preserves the console's historical import path.
 *
 * See `packages/operator-ui/src/components/command-palette.tsx` for the
 * implementation: one provider owns the listener + open state and exposes
 * `toggle` (bridged to the shell Jump button); the modal is built on the
 * base-ui dialog skin for autofocus + first-outside-click dismissal; the list
 * filters live over the shared registry; free-text record search is an explicit
 * selectable row, not the default Enter redirect.
 */

// biome-ignore lint/performance/noBarrelFile: thin re-export of the ONE unified palette in @pdpp/operator-ui; preserves the console's historical import path (`./command-palette.tsx`) so the layout, bridge, legacy shell, and tests import the single implementation by name.
export {
  CommandPalette,
  CommandPaletteProvider,
  CommandPaletteTrigger,
  useCommandPalette,
} from "@pdpp/operator-ui/components/command-palette";
