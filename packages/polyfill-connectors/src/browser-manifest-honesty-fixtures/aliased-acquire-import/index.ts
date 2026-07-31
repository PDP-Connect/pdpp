// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fixture: the import is aliased to a completely different local name —
// detection must key on the IMPORTED name (stable), not the local binding
// every call site actually uses.
import { acquireBrowserForConnector as getBrowser } from "./browser-launch-stub.ts";

function runConnector(_config: { name: string }): void {
  // stand-in for the real runtime primitive
}

runConnector({ name: "example" });

export async function f(): Promise<void> {
  const browser = await getBrowser({ headless: true, profileName: "example" });
  await browser.release();
}
