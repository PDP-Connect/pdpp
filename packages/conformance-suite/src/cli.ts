#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The suite runner CLI.
//
// A target is supplied as a module path exporting a default TargetAdapter
// factory, which is what keeps the suite black-box: the CLI never knows what it
// is testing beyond the contract. `--target reference` runs the bundled
// in-process reference target, which is how the suite demonstrates itself.
//
// Exit codes are deliberately three-valued rather than pass/fail, because a run
// with no failures and partial coverage is not the same result as a complete
// pass and must not be scriptable as one:
//   0  every applicable MUST was tested and passed
//   1  at least one requirement failed
//   2  no failures, but coverage is incomplete (untested applicable requirements)

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import type { TargetAdapter } from "./harness/adapter.ts";
import { renderMarkdown } from "./report/markdown.ts";
import { runSuite } from "./suite.ts";
import { type HttpTargetConfig, httpTargetFromConfig } from "./targets/http-target.ts";
import { ReferenceTargetAdapter } from "./targets/reference-adapter.ts";
import { ReferenceAsAdapter, type ReferenceAsConfig } from "./targets/reference-as-adapter.ts";
import { VanaPsAdapter, type VanaPsConfig } from "./targets/vana-ps-adapter.ts";

const USAGE = `pdpp-conformance --target <reference|config.json|module-path> [options]

Options:
  --target <t>       One of:
                       "reference"  the bundled in-process target (self-test)
                       a .json path  an HTTP target config (see README)
                       a module path whose default export returns a TargetAdapter
  --json <path>      Write the machine-readable report to this path.
  --markdown <path>  Write the human-readable report to this path.
  --quiet            Do not print the markdown report to stdout.

Exit codes: 0 all applicable MUSTs tested and passed; 1 failures present;
2 no failures but coverage incomplete.
`;

async function loadAdapter(target: string): Promise<TargetAdapter> {
  if (target === "reference") {
    return new ReferenceTargetAdapter();
  }
  // A JSON config describes a real server over HTTP, so pointing the suite at a
  // deployment is a config change rather than a code change.
  if (target.endsWith(".json")) {
    const parsed = JSON.parse(readFileSync(target, "utf8")) as { kind?: string };
    // A config naming an authorization server drives the real consent journey,
    // so the grant-shape cases can run instead of skipping.
    if (parsed.kind === "reference-as") {
      return new ReferenceAsAdapter(parsed as unknown as ReferenceAsConfig);
    }
    // A session-based authorization journey (authorize -> review -> approve ->
    // PKCE code exchange) rather than the reference's PAR + consent shape.
    if (parsed.kind === "vana-ps") {
      return new VanaPsAdapter(parsed as unknown as VanaPsConfig);
    }
    return httpTargetFromConfig(parsed as unknown as HttpTargetConfig);
  }
  const module = (await import(target)) as {
    default?: () => TargetAdapter | Promise<TargetAdapter>;
  };
  if (typeof module.default !== "function") {
    throw new Error(`Target module "${target}" must default-export a function returning a TargetAdapter.`);
  }
  return await module.default();
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      json: { type: "string" },
      markdown: { type: "string" },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help || !values.target) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  const adapter = await loadAdapter(values.target);
  const report = await runSuite(adapter);

  if (values.json) {
    writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
  }
  const markdown = renderMarkdown(report);
  if (values.markdown) {
    writeFileSync(values.markdown, markdown);
  }
  if (!values.quiet) {
    process.stdout.write(markdown);
  }

  if (report.summary.failedRequirements.length > 0) {
    return 1;
  }
  return report.summary.allApplicableMustsTestedAndPassed ? 0 : 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
);
