// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fixture: the whole-run framework mode, `runConnector({ browser: {...} })`
// with an inline object literal — the shape every real browser-backed
// connector (chatgpt, amazon, etc.) uses.
function runConnector(_config: { browser?: { profileName: string }; name: string }): void {
  // stand-in for the real runtime primitive
}

runConnector({
  name: "example",
  browser: { profileName: "example" },
});
