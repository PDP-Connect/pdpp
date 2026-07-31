// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fixture: index.ts -> outer-browser-helper.ts -> inner-browser-helper.ts ->
// browser-launch-stub.ts (the actual acquireBrowserForConnector import).
// Proves the walker doesn't stop at one hop.
import { getBrowserPage } from "./outer-browser-helper.ts";

function runConnector(_config: { name: string }): void {
  // stand-in for the real runtime primitive
}

runConnector({ name: "example" });

export async function f(): Promise<void> {
  const page = await getBrowserPage();
  await page.release();
}
