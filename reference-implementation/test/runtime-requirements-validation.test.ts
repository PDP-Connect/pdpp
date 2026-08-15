// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the UNTESTED manifest-validation shaper
 * `validateRuntimeRequirements` (`server/connector-manifest-validation.ts`).
 *
 * It validates a connector manifest's `runtime_requirements` block (bindings +
 * external_tools), THROWING a typed `invalidConnectorManifest` (carrying the
 * supplied `code`) per violation, or returning when absent/valid.
 *
 * Pinned here:
 *   - ACCEPT: no runtime_requirements; bindings only; a valid external tool.
 *   - bindings REJECT: requirements not an object; bindings not an object; an
 *     unsupported binding key; a binding value that is not an object; a
 *     non-boolean `required`.
 *   - external_tools REJECT (only reachable once bindings is present — see the
 *     short-circuit test): not an array; an unsupported tool key; a missing
 *     required string field (name/license/purpose); a duplicate tool name; a
 *     `detect` without a command; a negative `detect.exit_code`; in strict
 *     (streams-bearing) mode, a non-string `detect.executable_env_override`.
 *   - local_paths ACCEPT/REJECT (only reachable once bindings is present): a
 *     valid declaration for a made-up connector id (proves the validator is
 *     connector-agnostic); non-object `local_paths`; unsupported top-level or
 *     per-path keys; missing required string fields.
 *   - SHORT-CIRCUIT: when `bindings` is absent, the function returns BEFORE
 *     external_tools is validated — so an invalid external_tools with no bindings
 *     is (by contract) not rejected here.
 *
 * Pure — the module imports only connector-key helpers (no DB). No fixtures.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { validateRuntimeRequirements } from "../server/connector-manifest-validation.ts";

const CODE = "invalid_connector_manifest";

// external_tools validation is only reached when `bindings` is present, so tests
// that probe external_tools include an (empty, valid) bindings object.
function withBindingsAndTools(external_tools: unknown): Record<string, unknown> {
  return { runtime_requirements: { bindings: {}, external_tools } };
}

// A manifest with `streams` takes the STRICT detect-validation path
// (allowLegacyCommand: false) — the path every real connector manifest uses.
function withBindingsAndToolsStrict(external_tools: unknown): Record<string, unknown> {
  return { runtime_requirements: { bindings: {}, external_tools }, streams: [] };
}

function assertRejects(manifest: Record<string, unknown>, messagePart: string): void {
  assert.throws(
    () => validateRuntimeRequirements(manifest, CODE),
    (err: unknown) => {
      const typed = err as Error & { code: string };
      assert.equal(typed.code, CODE, `code: ${typed.code}`);
      assert.ok(
        String(typed.message).includes(messagePart),
        `message ${JSON.stringify(typed.message)} lacks ${JSON.stringify(messagePart)}`
      );
      return true;
    }
  );
}

// --- accept paths -----------------------------------------------------------

test("validateRuntimeRequirements: returns when runtime_requirements is absent", () => {
  assert.equal(validateRuntimeRequirements({}, CODE), undefined);
  assert.equal(validateRuntimeRequirements({ runtime_requirements: null }, CODE), undefined);
});

test("validateRuntimeRequirements: accepts valid bindings", () => {
  assert.equal(
    validateRuntimeRequirements(
      { runtime_requirements: { bindings: { browser: { required: true }, network: {} } } },
      CODE
    ),
    undefined
  );
});

test("validateRuntimeRequirements: accepts a valid external tool (with bindings present)", () => {
  assert.equal(
    validateRuntimeRequirements(
      withBindingsAndTools([{ license: "GPL-2.0", name: "git", purpose: "clone repos" }]),
      CODE
    ),
    undefined
  );
});

// --- bindings reject paths --------------------------------------------------

test("validateRuntimeRequirements: rejects non-object requirements or bindings", () => {
  assertRejects({ runtime_requirements: "x" }, "runtime_requirements must be an object");
  assertRejects({ runtime_requirements: { bindings: "x" } }, "runtime_requirements.bindings must be an object");
});

test("validateRuntimeRequirements: rejects an unsupported binding key", () => {
  assertRejects({ runtime_requirements: { bindings: { gpu: {} } } }, "bindings has unsupported keys: gpu");
});

test("validateRuntimeRequirements: rejects a non-object binding value and a non-boolean required", () => {
  assertRejects({ runtime_requirements: { bindings: { browser: "x" } } }, "bindings.browser must be an object");
  assertRejects(
    { runtime_requirements: { bindings: { browser: { required: "yes" } } } },
    "bindings.browser.required must be a boolean"
  );
});

// --- external_tools reject paths (bindings present) -------------------------

test("validateRuntimeRequirements: rejects external_tools that is not an array", () => {
  assertRejects(withBindingsAndTools("x"), "external_tools must be an array");
});

test("validateRuntimeRequirements: rejects an unsupported external tool key", () => {
  assertRejects(
    withBindingsAndTools([{ bogus: 1, license: "x", name: "git", purpose: "y" }]),
    "external_tools[0] has unsupported keys: bogus"
  );
});

test("validateRuntimeRequirements: rejects a tool missing a required string field", () => {
  assertRejects(
    withBindingsAndTools([{ license: "x", purpose: "y" }]),
    "external_tools[0].name must be a non-empty string"
  );
  assertRejects(
    withBindingsAndTools([{ name: "git", purpose: "y" }]),
    "external_tools[0].license must be a non-empty string"
  );
});

test("validateRuntimeRequirements: rejects a duplicate tool name", () => {
  assertRejects(
    withBindingsAndTools([
      { license: "a", name: "git", purpose: "b" },
      { license: "c", name: "git", purpose: "d" },
    ]),
    "external_tools duplicates tool 'git'"
  );
});

test("validateRuntimeRequirements: rejects a detect without a command and a negative exit_code", () => {
  assertRejects(
    withBindingsAndTools([{ detect: {}, license: "a", name: "git", purpose: "b" }]),
    "external_tools[0].detect.command must be a non-empty string"
  );
  assertRejects(
    withBindingsAndTools([
      { detect: { command: "git --version", exit_code: -1 }, license: "a", name: "git", purpose: "b" },
    ]),
    "external_tools[0].detect.exit_code must be a non-negative integer"
  );
});

// --- strict-mode detect.executable_env_override (real, streams-bearing manifests) ---

test("validateRuntimeRequirements: strict mode accepts a valid detect.executable_env_override", () => {
  assert.equal(
    validateRuntimeRequirements(
      withBindingsAndToolsStrict([
        {
          detect: { executable: "slackdump", executable_env_override: "SLACKDUMP_BIN", exit_code: 0 },
          license: "a",
          name: "slackdump",
          purpose: "b",
        },
      ]),
      CODE
    ),
    undefined
  );
});

test("validateRuntimeRequirements: strict mode rejects a non-string detect.executable_env_override", () => {
  assertRejects(
    withBindingsAndToolsStrict([
      { detect: { executable: "git", executable_env_override: 1 }, license: "a", name: "git", purpose: "b" },
    ]),
    "external_tools[0].detect.executable_env_override must be a non-empty string"
  );
  assertRejects(
    withBindingsAndToolsStrict([
      { detect: { executable: "git", executable_env_override: "" }, license: "a", name: "git", purpose: "b" },
    ]),
    "external_tools[0].detect.executable_env_override must be a non-empty string"
  );
});

// --- local_paths (synthetic connector, proves genericity) -------------------

function withBindingsAndLocalPaths(local_paths: unknown): Record<string, unknown> {
  return { runtime_requirements: { bindings: {}, local_paths } };
}

test("validateRuntimeRequirements: accepts a valid local_paths declaration for a made-up connector", () => {
  assert.equal(
    validateRuntimeRequirements(
      withBindingsAndLocalPaths({
        home_default_relative_to_user_home: ".acme-widget",
        home_env_override: "ACME_WIDGET_HOME",
        paths: [
          {
            default_relative_to_home: "data",
            env_override: "ACME_WIDGET_DATA_DIR",
            label: "data directory",
            required_for_readiness: true,
          },
        ],
      }),
      CODE
    ),
    undefined
  );
});

test("validateRuntimeRequirements: rejects a non-object local_paths", () => {
  assertRejects(withBindingsAndLocalPaths("x"), "local_paths must be an object when declared");
});

test("validateRuntimeRequirements: rejects an unsupported local_paths key", () => {
  assertRejects(
    withBindingsAndLocalPaths({ bogus: 1, home_default_relative_to_user_home: ".x", paths: [] }),
    "local_paths has unsupported keys: bogus"
  );
});

test("validateRuntimeRequirements: rejects a missing home_default_relative_to_user_home", () => {
  assertRejects(
    withBindingsAndLocalPaths({ paths: [] }),
    "local_paths.home_default_relative_to_user_home must be a non-empty string"
  );
});

test("validateRuntimeRequirements: rejects a non-array paths", () => {
  assertRejects(
    withBindingsAndLocalPaths({ home_default_relative_to_user_home: ".x", paths: "not-an-array" }),
    "local_paths.paths must be an array"
  );
});

test("validateRuntimeRequirements: rejects a local_paths.paths entry missing required fields", () => {
  assertRejects(
    withBindingsAndLocalPaths({ home_default_relative_to_user_home: ".x", paths: [{ label: "data directory" }] }),
    "local_paths.paths[0].default_relative_to_home must be a non-empty string"
  );
  assertRejects(
    withBindingsAndLocalPaths({
      home_default_relative_to_user_home: ".x",
      paths: [{ default_relative_to_home: "data" }],
    }),
    "local_paths.paths[0].label must be a non-empty string"
  );
});

test("validateRuntimeRequirements: rejects an unsupported local_paths.paths entry key", () => {
  assertRejects(
    withBindingsAndLocalPaths({
      home_default_relative_to_user_home: ".x",
      paths: [{ bogus: 1, default_relative_to_home: "data", label: "data directory" }],
    }),
    "local_paths.paths[0] has unsupported keys: bogus"
  );
});

// --- short-circuit contract -------------------------------------------------

test("validateRuntimeRequirements: external_tools is NOT validated when bindings is absent (early return)", () => {
  // No bindings => the function returns before ever reaching external_tools, so
  // an otherwise-invalid external_tools value is not rejected here.
  assert.equal(
    validateRuntimeRequirements({ runtime_requirements: { external_tools: "not-an-array" } }, CODE),
    undefined,
    "absent bindings short-circuits external_tools validation"
  );
});
