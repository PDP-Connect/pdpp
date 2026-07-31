// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { acquireBrowserForConnector } from "./browser-launch-stub.ts";

export function acquireInner(): ReturnType<typeof acquireBrowserForConnector> {
  return acquireBrowserForConnector({ headless: true, profileName: "example" });
}
