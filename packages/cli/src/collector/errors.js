// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export class CollectorUsageError extends Error {
  constructor(message, { exitCode = 64 } = {}) {
    super(message);
    this.name = "CollectorUsageError";
    this.exitCode = exitCode;
  }
}
