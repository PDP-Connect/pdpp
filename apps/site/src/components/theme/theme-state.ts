// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Re-exported from shared package. Source of truth: packages/operator-ui/src/components/theme/theme-state.ts

export type { ResolvedTheme, ThemeChoice } from "@pdpp/operator-ui/components/theme/theme-state";
export {
  buildThemeCookie,
  normalizeThemeChoice,
  THEME_COOKIE_MAX_AGE_SECONDS,
  THEME_KEY,
} from "@pdpp/operator-ui/components/theme/theme-state";
