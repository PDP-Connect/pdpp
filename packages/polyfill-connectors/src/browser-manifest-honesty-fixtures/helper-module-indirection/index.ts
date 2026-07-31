// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fixture: `runConnector` has no `browser:` key at all, and the literal
// `acquireBrowserForConnector` never appears here — it is reachable only
// through a one-hop relative import of `browser-helper.ts`, which is the
// realistic refactor-for-reuse bypass the gate found.
import { getSlackBrowserPage } from "./browser-helper.ts";

function runConnector(_config: { name: string }): void {
  // stand-in for the real runtime primitive
}

runConnector({ name: "example" });

export async function f(): Promise<void> {
  const page = await getSlackBrowserPage();
  await page.release();
}
