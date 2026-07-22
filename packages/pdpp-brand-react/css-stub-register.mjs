// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Registers the `.css` stub loader hook for the test runner.
 *
 * Passed to `node --test` via `--import` so component `.tsx` sources (which
 * `import "./components.css"`) can be loaded by the bare runner without a CSS
 * bundler. See css-stub-loader.mjs for the hook itself.
 */
import { register } from "node:module";

register("./css-stub-loader.mjs", import.meta.url);
