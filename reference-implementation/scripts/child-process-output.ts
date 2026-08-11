// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

interface ChildWithPipedOutput extends EventEmitter {
  stderr: Readable | null;
  stdout: Readable | null;
}

/** Collect both output streams until Node confirms the process and stdio are closed. */
export function collectChildProcessOutput(child: ChildWithPipedOutput, onChunk?: () => void): Promise<string> {
  return new Promise((resolve) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      onChunk?.();
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      onChunk?.();
      output += chunk.toString();
    });
    child.once("close", () => resolve(output));
  });
}
