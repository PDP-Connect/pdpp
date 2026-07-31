// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { computeSomething } from "./helper.ts";

function runConnector(_config: { name: string }): void {
  // stand-in for the real runtime primitive
}

runConnector({ name: "example" });

console.log(computeSomething(21));
