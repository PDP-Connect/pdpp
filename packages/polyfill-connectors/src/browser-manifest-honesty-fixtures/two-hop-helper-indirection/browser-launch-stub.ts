// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface IsolatedBrowser {
  release: () => Promise<void>;
}

export function acquireBrowserForConnector(_options: {
  headless?: boolean;
  profileName: string;
}): Promise<IsolatedBrowser> {
  return Promise.resolve({ release: () => Promise.resolve() });
}
