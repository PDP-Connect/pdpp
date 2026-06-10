export const THEME_KEY = "pdpp-theme";

/**
 * One year in seconds. The theme cookie is a low-stakes UI preference, so
 * we set a long Max-Age to avoid losing the preference between visits.
 */
export const THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export function normalizeThemeChoice(value: unknown): ThemeChoice {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

/**
 * Builds the `document.cookie` value for persisting a theme choice.
 *
 * - No `HttpOnly` — the client reads it for cross-tab/in-page state.
 * - `SameSite=Lax` is the right default for a same-origin UI preference.
 * - `Secure` is enabled in production so the preference doesn't leak over
 *   plain HTTP; in dev (HTTP localhost) we omit it because browsers reject
 *   `Secure` cookies on insecure origins.
 * - `Max-Age=0` and an explicit empty value clears the cookie when the
 *   user reverts to `system` (the default — encoded as "no cookie").
 */
export function buildThemeCookie(choice: ThemeChoice, isProduction: boolean): string {
  const secure = isProduction ? "; Secure" : "";
  if (choice === "system") {
    return `${THEME_KEY}=; Path=/; SameSite=Lax; Max-Age=0${secure}`;
  }
  return `${THEME_KEY}=${choice}; Path=/; SameSite=Lax; Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}${secure}`;
}
