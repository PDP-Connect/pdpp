#!/usr/bin/env node
import { runMcpServerCli } from '../src/index.js';

runMcpServerCli(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (error) => {
    process.stderr.write(`pdpp-mcp-server: ${error?.stack ?? error}\n`);
    process.exit(1);
  }
);
