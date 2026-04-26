/**
 * Inline pre-hydration theme resolver.
 *
 * This runs synchronously in <head> before React hydration so the page paints
 * with the correct theme on the first frame. It is intentionally minimal —
 * any error short-circuits to the light default rather than throwing.
 *
 * Storage key and class hooks are kept in sync with `theme-provider.tsx`.
 */

import Script from "next/script";

const THEME_STORAGE_KEY = "pdpp-theme";

const SCRIPT = `
(function () {
  try {
    var stored = null;
    try { stored = window.localStorage.getItem("${THEME_STORAGE_KEY}"); } catch (_) {}
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var resolved = stored === "light" ? "light"
      : stored === "dark" ? "dark"
      : prefersDark ? "dark" : "light";
    var root = document.documentElement;
    if (resolved === "dark") root.classList.add("dark"); else root.classList.remove("dark");
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  } catch (_) { /* fall through to light default */ }
})();
`;

export function ThemeScript() {
  // next/script with beforeInteractive is the App Router-supported way
  // to ship a synchronous script that runs before hydration. Content is
  // a static literal — no user input.
  return (
    <Script id="pdpp-theme-script" strategy="beforeInteractive">
      {SCRIPT}
    </Script>
  );
}

export const THEME_KEY = THEME_STORAGE_KEY;
