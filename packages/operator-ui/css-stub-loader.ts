// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Node ESM loader hook that stubs `.css` side-effect imports during tests.
 *
 * Component sources may `import "./status-badge.css"` so the Next bundler ships
 * styling alongside the component. The bare `node --test` runner has no CSS
 * handling, so importing those `.tsx` files from a test would throw
 * ERR_UNKNOWN_FILE_EXTENSION.
 *
 * This hook resolves `*.css` specifiers to an empty ES module — the styling is
 * irrelevant to behavioral/source-regex assertions, and the real CSS still
 * ships via the bundler in production.
 *
 * Registered through `css-stub-register.ts` via the test script's `--import`.
 * Mirrors @pdpp/brand-react's stub.
 */
import type { LoadHook } from "node:module";

export const load: LoadHook = (url, context, nextLoad) => {
  if (url.endsWith(".css")) {
    return { format: "module", shortCircuit: true, source: "export default {};" };
  }
  return nextLoad(url, context);
};
