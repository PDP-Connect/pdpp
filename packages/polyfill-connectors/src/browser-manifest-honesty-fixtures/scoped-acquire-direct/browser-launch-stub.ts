// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Stub standing in for `../../browser-launch.ts`'s real primitive, so this
// fixture's import graph is self-contained and does not depend on parsing
// the real (large) browser-launch.ts module.
export interface IsolatedBrowser {
  release: () => Promise<void>;
}

export function acquireBrowserForConnector(_options: {
  headless?: boolean;
  profileName: string;
}): Promise<IsolatedBrowser> {
  return Promise.resolve({ release: () => Promise.resolve() });
}
