#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { runCli } from '../src/index.js';

const exitCode = await runCli(process.argv.slice(2), {
  stderr: process.stderr,
  stdout: process.stdout,
});

process.exitCode = exitCode;
