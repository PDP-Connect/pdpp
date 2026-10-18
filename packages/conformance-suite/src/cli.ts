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
import { buildRequirementsReport, readSpecText } from "./report/requirements.ts";
import { exitCodeFor } from "./report/result.ts";
import { ALL_CASES, runSuite } from "./suite.ts";
import { type HttpTargetConfig, httpTargetFromConfig } from "./targets/http-target.ts";
import { ReferenceTargetAdapter } from "./targets/reference-adapter.ts";
import { ReferenceAsAdapter, type ReferenceAsConfig } from "./targets/reference-as-adapter.ts";

const USAGE = `pdpp-conformance --target <reference|config.json|module-path> [options]

Options:
  --target <t>       One of:
                       "reference"  the bundled in-process target (self-test)
                       a .json path  an HTTP target config (see README)
                       a module path whose default export returns a TargetAdapter
  --json <path>      Write the machine-readable report to this path.
  --markdown <path>  Write the human-readable report to this path.
  --requirements-json <path>
                     Write one machine-readable result per spec clause (MUST and SHOULD).
  --quiet            Do not print the markdown report to stdout.

Exit codes: 0 every applicable Section 9 requirement passes AND every applicable
MUST clause rolls up to pass (no partial, skip or not-tested clause; review-only
clauses are listed separately in the report); 1 failures present; 2 no failures
but coverage incomplete.
`;

/**
 * A whole-string `${ENV_VAR}` placeholder. Anchored so a config value that merely
 * contains the syntax is left alone rather than partially substituted.
 */
const ENV_PLACEHOLDER = /^\$\{([A-Z0-9_]+)\}$/;

/**
 * Resolves `${ENV_VAR}` placeholders in a target config against the environment.
 *
 * Target configs are committed; per-boot credentials must not be. A server that
 * mints a fresh owner token on every start cannot have that token checked in --
 * the committed value is stale the moment it is written, and a reader who trusts
 * it runs against a target that refuses every request. Worse, a real deployment's
 * credential committed by habit is a credential leak.
 *
 * So a config carries the NAME of the variable holding the secret, and the value
 * arrives at runtime. Missing variables fail loudly here rather than surfacing
 * later as an unexplained 401 from the target.
 */
function resolveEnvPlaceholders(value: unknown, path: string[] = []): unknown {
  if (typeof value === "string") {
    const name = ENV_PLACEHOLDER.exec(value)?.[1];
    if (!name) {
      return value;
    }
    const resolved = process.env[name];
    if (resolved === undefined || resolved === "") {
      throw new Error(
        `Target config field "${path.join(".")}" requires environment variable ${name}, which is unset. ` +
          "Credentials are not committed: export it from the value the target printed at boot."
      );
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => resolveEnvPlaceholders(item, [...path, String(i)]));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveEnvPlaceholders(item, [...path, key])])
    );
  }
  return value;
}

async function loadAdapter(target: string): Promise<TargetAdapter> {
  if (target === "reference") {
    return new ReferenceTargetAdapter();
  }
  // A JSON config describes a real server over HTTP, so pointing the suite at a
  // deployment is a config change rather than a code change.
  if (target.endsWith(".json")) {
    const parsed = resolveEnvPlaceholders(JSON.parse(readFileSync(target, "utf8"))) as { kind?: string };
    // A config naming an authorization server drives the real consent journey,
    // so the grant-shape cases can run instead of skipping.
    if (parsed.kind === "reference-as") {
      return new ReferenceAsAdapter(parsed as unknown as ReferenceAsConfig);
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
      "requirements-json": { type: "string" },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help || !values.target) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  const adapter = await loadAdapter(values.target);
  const report = await runSuite(adapter, ALL_CASES);

  if (values.json) {
    writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (values["requirements-json"]) {
    const requirements = buildRequirementsReport(report, readSpecText());
    writeFileSync(values["requirements-json"], `${JSON.stringify(requirements, null, 2)}\n`);
  }
  const markdown = renderMarkdown(report);
  if (values.markdown) {
    writeFileSync(values.markdown, markdown);
  }
  if (!values.quiet) {
    process.stdout.write(markdown);
  }

  return exitCodeFor(report);
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
