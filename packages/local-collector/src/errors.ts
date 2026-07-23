// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed errors emitted by `@pdpp/local-collector`.
 *
 * These mirror the contracts already exported from the runner slice in
 * `@pdpp/polyfill-connectors`. They are re-exported here so npm consumers
 * can import them without depending on the private monorepo package.
 *
 * Spec: openspec/changes/publish-pdpp-local-collector/design.md §1.
 */

// biome-ignore lint/performance/noBarrelFile: public package facade re-exports its runner error contract from the source of truth.
export {
  CollectorStateReadError,
  RUNTIME_CAPABILITY_MISMATCH_CODE,
  RuntimeCapabilityMismatchError,
} from "../../polyfill-connectors/src/runner/index.ts";

/**
 * The published `pdpp-local-collector` bin rejects `--command <bin>` unless
 * the operator explicitly opts in via this env var. Custom commands hand a
 * device-scoped ingest token to an arbitrary binary; the public package
 * keeps the supply chain narrow to the bundled connector entrypoints
 * (Claude Code, Codex).
 *
 * Spec: openspec/changes/publish-pdpp-local-collector/design.md §3.
 */
export const ALLOW_CUSTOM_COMMAND_ENV = "PDPP_LOCAL_COLLECTOR_ALLOW_CUSTOM_COMMAND";

/** Thrown when an operator passes `--command` without the explicit opt-in env var. */
export class CollectorCustomCommandRefusedError extends Error {
  readonly code: "custom_command_refused";
  constructor() {
    super(
      "pdpp-local-collector refuses --command <bin> by default to keep the " +
        `device-token supply chain narrow. Set ${ALLOW_CUSTOM_COMMAND_ENV}=1 ` +
        "to opt in for monorepo development; see openspec/changes/publish-pdpp-local-collector/design.md §3."
    );
    this.name = "CollectorCustomCommandRefusedError";
    this.code = "custom_command_refused";
  }
}

/** Thrown when an operator invokes the bin with an unrecognized subcommand. */
export class CollectorUsageError extends Error {
  readonly exitCode: number;
  constructor(message: string, options: { exitCode?: number } = {}) {
    super(message);
    this.name = "CollectorUsageError";
    this.exitCode = options.exitCode ?? 64;
  }
}
