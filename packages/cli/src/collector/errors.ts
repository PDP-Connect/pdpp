// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export class CollectorUsageError extends Error {
  exitCode: number;

  constructor(message: string, { exitCode = 64 }: { exitCode?: number } = {}) {
    super(message);
    this.name = "CollectorUsageError";
    this.exitCode = exitCode;
  }
}
