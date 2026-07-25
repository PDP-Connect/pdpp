#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { runMcpServerCli } from "../src/index.ts";

runMcpServerCli(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    const err = error as { stack?: string } | null;
    process.stderr.write(`pdpp-mcp-server: ${err?.stack ?? error}\n`);
    process.exit(1);
  }
);
