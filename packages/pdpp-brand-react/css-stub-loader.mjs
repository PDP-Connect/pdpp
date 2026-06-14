/**
 * Node ESM loader hook that stubs `.css` side-effect imports during tests.
 *
 * Component sources (button.tsx, input.tsx, select.tsx, …) do
 * `import "./components.css"` so the Next bundler ships styling alongside the
 * component. The bare `node --test` runner has no CSS handling, so importing
 * any of those `.tsx` files from a test would throw ERR_UNKNOWN_FILE_EXTENSION.
 *
 * This hook resolves `*.css` specifiers to an empty ES module — the styling is
 * irrelevant to behavioral/render assertions, and the real CSS still ships via
 * the bundler in production.
 *
 * Registered through `css-stub-register.mjs` (a `module.register` shim) via the
 * test script's `--import` flag.
 */
export function load(url, context, nextLoad) {
  if (url.endsWith(".css")) {
    return { format: "module", shortCircuit: true, source: "export default {};" };
  }
  return nextLoad(url, context);
}
