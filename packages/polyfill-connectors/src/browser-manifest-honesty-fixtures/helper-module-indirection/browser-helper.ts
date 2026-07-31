// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The literal string `acquireBrowserForConnector` never appears in
// index.ts for this fixture — only here, one hop away — reproducing the
// gate's real bypass: "a helper function defined in a *different* file that
// internally calls acquireBrowserForConnector, imported and invoked from
// index.ts under any name."
import { acquireBrowserForConnector } from "./browser-launch-stub.ts";

export function getSlackBrowserPage(): Promise<{ release: () => Promise<void> }> {
  return acquireBrowserForConnector({ headless: true, profileName: "example" });
}
