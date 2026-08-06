// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Registers the `.css` stub loader hook for the test runner.
 *
 * Passed to `node --test` via `--import` so component `.tsx` sources (which
 * `import "./status-badge.css"`) can be loaded by the bare runner without a CSS
 * bundler. See css-stub-loader.ts for the hook itself.
 */
import { createRequire, register } from "node:module";

const nodeRequire = createRequire(import.meta.url);
nodeRequire.extensions[".css"] = () => undefined;

register("./css-stub-loader.ts", import.meta.url);
