// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fixture: a scoped, ad-hoc acquisition via the lower-level
// `acquireBrowserForConnector` primitive directly (Slack's own real shape),
// bypassing `runConnector`'s `browser:` config entirely.
import { acquireBrowserForConnector } from "./browser-launch-stub.ts";

function runConnector(_config: { name: string }): void {
  // stand-in for the real runtime primitive
}

runConnector({ name: "example" });

export async function acquireScopedTransport(): Promise<void> {
  const browser = await acquireBrowserForConnector({ headless: true, profileName: "example" });
  await browser.release();
}
