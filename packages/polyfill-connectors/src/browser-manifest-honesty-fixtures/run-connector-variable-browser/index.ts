// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fixture: `runConnector({ browser: someConfigVariable })` where the config
// is built as a variable rather than an inline object literal — the
// gate's other real bypass ("browser config built as a variable for
// reuse/testability").
function runConnector(_config: { browser?: { profileName: string }; name: string }): void {
  // stand-in for the real runtime primitive
}

const browserCfg = { profileName: "example" };

runConnector({ name: "example", browser: browserCfg });
