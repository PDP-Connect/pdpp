/**
 * Inline pre-paint theme resolver.
 *
 * This is rendered as a raw blocking <script> inside <head> of the root
 * layout (a Server Component) so the browser executes it before painting
 * the body. That is the only reliable way in App Router to apply the
 * resolved theme on the first frame: `next/script` with
 * `strategy="beforeInteractive"` only guarantees ordering relative to
 * Next's own scripts, not first paint, which is what produces the
 * dark/light/dark flicker users were seeing.
 *
 * Because the script lives in a Server Component, React does not warn
 * about a raw `<script>` child. The script body is a static literal —
 * the storage key is interpolated from a module constant, never user
 * input — so there is no XSS surface.
 *
 * Storage key and class hooks are kept in sync with `theme-provider.tsx`.
 */

const THEME_STORAGE_KEY = "pdpp-theme";

const SCRIPT = `(function () {
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
})();`;

export function ThemeScript() {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: static literal, no user input; required for sync pre-paint execution in App Router <head>.
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}

/** Exposed so tests can assert the resolver string is present in built HTML. */
export const THEME_RESOLVER_SOURCE = SCRIPT;

export const THEME_KEY = THEME_STORAGE_KEY;
