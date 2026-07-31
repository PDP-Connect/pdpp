// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fixture: a local variable named `browser` with a TS type annotation must
// NOT be mistaken for either detection axis (no `runConnector({ browser })`
// call, no `acquireBrowserForConnector` import).
interface SomeIsolatedBrowserType {
  release: () => Promise<void>;
}

function runConnector(_config: { name: string }): void {
  // stand-in for the real runtime primitive
}

runConnector({ name: "example" });

export async function f(acquire: () => Promise<SomeIsolatedBrowserType>, retry: boolean): Promise<void> {
  let browser: SomeIsolatedBrowserType;
  browser = await acquire();
  if (retry) {
    browser = await acquire();
  }
  await browser.release();
}
