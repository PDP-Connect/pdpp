#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * deploy-canary
 *
 * Owner/operator-only tool that deploys one ref to the production container
 * and verifies it against PRE-REGISTERED metrics, emitting a durable receipt.
 *
 * Why this tool exists
 * --------------------
 * Six deploys happened by hand in one day, each verified by manually typing
 * greps, psql queries and `docker inspect` at a terminal. Three failure modes
 * recurred, and none of them is a mistake a careful operator stops making —
 * they are all invisible unless something checks mechanically:
 *
 *   1. A deploy that never happened. Production restarted onto the SAME image
 *      tag; the fix was believed live for hours while Gmail kept destroying
 *      data. A tag is a label and a commit sha describes source, not bytes.
 *      Only a grep INSIDE the image caught it. Phase 2 makes that grep a
 *      required gate that fails closed before anything is deployed.
 *
 *   2. Env filtering broke the container twice, in both directions. See
 *      `env-derivation.ts`; the short version is that dropping vars by NAME
 *      would have pointed production at the wrong database.
 *
 *   3. Success criteria chosen after seeing the results. D15: "post-hoc
 *      success criteria are how 'green' claims died in this program." The
 *      manifest is parsed and frozen before the build, and the evaluator is
 *      pure, so the rule cannot be edited to fit the number.
 *
 * Phases
 * ------
 *   1 build            image from a ref, base image digest-pinned
 *   2 artifact-verify  content greps inside the image; FAIL CLOSED
 *   3 capture          full inspect, env, rollback target, BEFORE metrics
 *   4 deploy           rename old container (never remove), run new one
 *   5 check            the pre-registered predicates
 *   6 receipt          durable JSON artifact
 *   7 rollback         automatic on any blocking failure, loudly recorded
 *
 * Safety
 * ------
 *   - DRY RUN BY DEFAULT. `--apply` is required to build or change anything.
 *     A dry run performs every read-only step (inspect, env derivation,
 *     BEFORE metrics) and prints the exact `docker run` argv it would use.
 *   - The outgoing container is RENAMED, not removed, so rollback never
 *     depends on this tool having reconstructed the spec correctly.
 *   - No volume is ever removed. A prior incident destroyed 562 volumes;
 *     this tool contains no `docker volume` call and no `down -v`.
 *   - Connector runs for OTP-gated connectors are refused at manifest-parse
 *     time and again at the trigger site.
 *
 * Usage:
 *   node reference-implementation/scripts/canary/deploy-canary.ts \
 *     --manifest=reference-implementation/scripts/canary/manifests/step-1-run-lifecycle.json \
 *     --ref=fix/sweep-fairness-and-transformer-bounds \
 *     [--apply] [--receipt-dir=./local/canary-receipts]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import {
  greppedCountInImage,
  httpStatus,
  imageDigest,
  imageEnv,
  inspectContainer,
  logPatternCount,
  run,
  sqlNumber,
  sqlScalar,
} from "./collectors.ts";
import { triggerConnectorRun } from "./connector-run.ts";
import { buildRunArgs, type InspectedContainer, parseInspect, rollbackContainerName } from "./container-spec.ts";
import { deriveEnv, type EnvDerivation, toDockerEnvArgs } from "./env-derivation.ts";
import {
  type CanaryManifest,
  type CheckOutcome,
  evaluateNumericPredicate,
  evaluateTimestampPredicate,
  parseManifest,
  shouldRollback,
} from "./manifest.ts";

interface ParsedArgs {
  readonly apply: boolean;
  readonly manifest: string | null;
  readonly receiptDir: string;
  readonly ref: string | null;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let apply = false;
  let manifest: string | null = null;
  let ref: string | null = null;
  let receiptDir = "local/canary-receipts";
  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
    } else if (arg.startsWith("--manifest=")) {
      manifest = arg.slice("--manifest=".length) || null;
    } else if (arg.startsWith("--ref=")) {
      ref = arg.slice("--ref=".length) || null;
    } else if (arg.startsWith("--receipt-dir=")) {
      receiptDir = arg.slice("--receipt-dir=".length) || receiptDir;
    }
  }
  return { apply, manifest, receiptDir, ref };
}

interface ArtifactResult {
  readonly actual: number;
  readonly expectedMin: number;
  readonly id: string;
  readonly passed: boolean;
  readonly path: string;
  readonly pattern: string;
}

interface Receipt {
  readonly artifactAssertions: readonly ArtifactResult[];
  readonly checks: readonly CheckOutcome[];
  readonly container: string;
  readonly dryRun: boolean;
  readonly env: {
    readonly carriedCount: number;
    readonly droppedAsImageIdentical: readonly string[];
    readonly carriedOverrides: readonly { name: string; liveValue: string; imageValue: string }[];
  };
  readonly finishedAt: string;
  readonly image: string;
  readonly imageDigest: string;
  readonly nodeBaseImage: string;
  readonly ref: string;
  readonly refCommit: string;
  readonly rollbackTarget: {
    readonly image: string;
    readonly containerName: string | null;
  };
  readonly rolledBack: boolean;
  readonly startedAt: string;
  readonly step: string;
  readonly tool: string;
  readonly verdict: "PASS" | "FAIL" | "DRY_RUN" | "ABORTED_ARTIFACT_MISMATCH";
}

/**
 * Redacts values that look like credentials before they reach a receipt or
 * the console.
 *
 * The live container carries 97 vars including `PDPP_OWNER_TOKEN`,
 * `SLACK_COOKIE`, `*_PASSWORD`, and `PDPP_CREDENTIAL_ENCRYPTION_KEY`. A
 * receipt is a durable artifact and the console output gets pasted into
 * issues, so both go through this. Matching is by NAME, because a secret's
 * value is by definition unrecognizable.
 */
const SECRET_NAME_PATTERN = /pass|secret|token|key|cookie|credential|auth/iu;

/**
 * Strips the `node:` prefix so the manifest's digest-pinned base image can be
 * passed as the Dockerfile's `NODE_VERSION` build ARG, which is declared
 * without it.
 */
const NODE_IMAGE_PREFIX_PATTERN = /^node:/u;

export function redact(name: string, value: string): string {
  return SECRET_NAME_PATTERN.test(name) ? "<redacted>" : value;
}

/**
 * Renders `docker run` argv for human display with every `-e NAME=value`
 * redacted by name.
 *
 * This walks the argv pairwise rather than regexing the joined string: a
 * regex over the flattened command has to guess where one value ends and the
 * next flag begins, and a value containing a space silently defeats it. The
 * earlier regex form leaked several secrets for exactly that reason.
 */
export function renderRunArgs(args: readonly string[]): string {
  const rendered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-e" && index + 1 < args.length) {
      const entry = args[index + 1] ?? "";
      const separator = entry.indexOf("=");
      const name = separator === -1 ? entry : entry.slice(0, separator);
      const value = separator === -1 ? "" : entry.slice(separator + 1);
      rendered.push("-e", quoteForDisplay(`${name}=${redact(name, value)}`));
      index += 1;
      continue;
    }
    rendered.push(quoteForDisplay(arg));
  }
  return rendered.join(" ");
}

const NEEDS_QUOTING_PATTERN = /[\s'"$`\\]/u;
const SINGLE_QUOTE_PATTERN = /'/gu;

function quoteForDisplay(value: string): string {
  return NEEDS_QUOTING_PATTERN.test(value)
    ? `'${value.replace(SINGLE_QUOTE_PATTERN, "'\\''")}'`
    : value;
}

async function collectMetric(
  manifest: CanaryManifest,
  check: CanaryManifest["checks"][number],
  spec: InspectedContainer | null
): Promise<string | number | null> {
  switch (check.kind) {
    case "sql_scalar":
      return sqlNumber(manifest.postgresContainer, check.sql);
    case "sql_timestamp":
      return sqlScalar(manifest.postgresContainer, check.sql);
    case "container_fact":
      if (!spec) {
        return null;
      }
      return check.fact === "restart_count" ? spec.restartCount : spec.configImage;
    case "log_pattern":
      return logPatternCount(manifest.container, check.pattern, check.sinceSeconds);
    case "http_health":
      return await httpStatus(check.url);
    case "connector_run":
      // Meaningless before the deploy; only evaluated after.
      return null;
    default:
      return null;
  }
}

type OutcomeBase = Omit<CheckOutcome, "after" | "detail" | "passed">;

/**
 * Triggers the run and turns its terminal state into a verdict.
 *
 * A thrown error becomes a FAILED outcome rather than propagating: the
 * denylist re-check in `triggerConnectorRun` throws, and a refusal must be
 * recorded in the receipt rather than crashing the harness mid-deploy.
 */
async function evaluateConnectorRun(
  check: Extract<CanaryManifest["checks"][number], { kind: "connector_run" }>,
  base: OutcomeBase
): Promise<CheckOutcome> {
  const origin = process.env.PDPP_CANARY_ORIGIN ?? "https://pdpp.vivid.fish";
  const password = process.env.PDPP_OWNER_PASSWORD ?? "";
  if (!password) {
    return { ...base, after: null, detail: "PDPP_OWNER_PASSWORD is not set", passed: false };
  }
  try {
    const outcome = await triggerConnectorRun({
      connectionId: check.connectionId,
      connectorSlug: check.connectorSlug,
      origin,
      password,
      timeoutSeconds: check.timeoutSeconds,
    });
    return {
      ...base,
      after: outcome.status,
      detail: outcome.detail,
      passed: outcome.status === check.expectStatus,
    };
  } catch (error) {
    return { ...base, after: null, detail: String(error), passed: false };
  }
}

/**
 * Applies the non-SQL-numeric predicates, each of which compares a value the
 * numeric evaluator cannot express. Returns null when `check` is an ordinary
 * numeric comparison, which the caller then evaluates.
 */
function evaluateNonNumericCheck(
  check: CanaryManifest["checks"][number],
  base: OutcomeBase,
  before: string | number | null,
  after: string | number | null
): CheckOutcome | null {
  if (check.kind === "sql_timestamp") {
    const verdict = evaluateTimestampPredicate(
      typeof before === "string" ? before : null,
      typeof after === "string" ? after : null
    );
    return { ...base, after, detail: verdict.detail, passed: verdict.passed };
  }

  if (check.kind === "http_health") {
    const passed = after === check.expectStatus;
    return {
      ...base,
      after,
      detail: passed ? `status ${after}` : `expected ${check.expectStatus}, got ${String(after)}`,
      passed,
    };
  }

  if (check.kind === "log_pattern") {
    const count = typeof after === "number" ? after : 0;
    const passed = count <= check.maxOccurrences;
    return {
      ...base,
      after: count,
      detail: passed
        ? `${count} <= ${check.maxOccurrences} occurrence(s)`
        : `'${check.pattern}' appeared ${count}x, max ${check.maxOccurrences}`,
      passed,
    };
  }

  if (check.kind === "container_fact" && check.fact === "running_image") {
    const passed = check.predicate === "must_change" ? after !== before : after === before;
    return { ...base, after, detail: `${String(before)} -> ${String(after)}`, passed };
  }

  return null;
}

async function evaluateAfter(
  manifest: CanaryManifest,
  check: CanaryManifest["checks"][number],
  before: string | number | null,
  spec: InspectedContainer | null
): Promise<CheckOutcome> {
  const base: OutcomeBase = {
    before,
    blocking: check.blocking,
    description: check.description,
    id: check.id,
    kind: check.kind,
  };

  if (check.kind === "connector_run") {
    return await evaluateConnectorRun(check, base);
  }

  const after = await collectMetric(manifest, check, spec);

  const nonNumeric = evaluateNonNumericCheck(check, base, before, after);
  if (nonNumeric) {
    return nonNumeric;
  }

  if (typeof after !== "number") {
    return { ...base, after, detail: "no numeric value collected", passed: false };
  }
  // Only `sql_scalar` and the numeric `container_fact` reach here; every other
  // kind was answered by `evaluateNonNumericCheck` above. Narrowing on the
  // field rather than casting keeps that reachability argument checkable: if a
  // future check kind is added without a predicate, this fails closed instead
  // of evaluating an undefined rule.
  if (
    !("predicate" in check) ||
    check.predicate === "must_change" ||
    check.predicate === "must_not_advance"
  ) {
    return { ...base, after, detail: "check kind has no numeric predicate", passed: false };
  }
  const verdict = evaluateNumericPredicate(
    check.predicate,
    typeof before === "number" ? before : null,
    after,
    "bound" in check ? check.bound : undefined
  );
  return { ...base, after, detail: verdict.detail, passed: verdict.passed };
}

function writeReceipt(receiptDir: string, receipt: Receipt): string {
  mkdirSync(receiptDir, { recursive: true });
  const stamp = receipt.startedAt.replace(/[:.]/gu, "-");
  const path = resolve(receiptDir, `canary-${receipt.step}-${stamp}.json`);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return path;
}

/**
 * Phase 1. Builds `image` from `ref`, forcing the manifest's digest-pinned
 * base through the Dockerfile's `NODE_VERSION` ARG so the base cannot float.
 * Returns false when the build failed. A dry run only reports.
 */
function buildImage(
  manifest: CanaryManifest,
  image: string,
  ref: string,
  refCommit: string,
  apply: boolean
): boolean {
  if (!apply) {
    console.log(`\n[1] would build ${image} from ${ref} (${refCommit})`);
    console.log(`    base (digest-pinned): ${manifest.nodeBaseImage}`);
    return true;
  }
  console.log(`\n[1] building ${image} from ${ref} (${refCommit})`);
  const build = run(
    "docker",
    [
      "build",
      "--build-arg",
      `NODE_VERSION=${manifest.nodeBaseImage.replace(NODE_IMAGE_PREFIX_PATTERN, "")}`,
      "--target",
      manifest.dockerfileTarget,
      "-t",
      image,
      ".",
    ],
    3_600_000
  );
  if (!build.ok) {
    console.error(`build failed:\n${build.stderr}`);
    return false;
  }
  return true;
}

/**
 * Phase 2. Greps each pre-registered pattern INSIDE the image.
 *
 * This is the check that distinguishes a real deploy from a restart onto the
 * same bytes, so it runs before anything is changed and its result gates the
 * deploy in `main`.
 */
function verifyArtifacts(
  manifest: CanaryManifest,
  verifyTarget: string,
  apply: boolean
): ArtifactResult[] {
  console.log(
    `\n[2] artifact-verify against ${verifyTarget}${apply ? "" : " (currently running image, dry run)"}`
  );
  const results: ArtifactResult[] = [];
  for (const assertion of manifest.artifactAssertions) {
    const actual = greppedCountInImage(verifyTarget, assertion.path, assertion.pattern);
    const passed = actual >= assertion.minCount;
    results.push({
      actual,
      expectedMin: assertion.minCount,
      id: assertion.id,
      passed,
      path: assertion.path,
      pattern: assertion.pattern,
    });
    console.log(
      `    ${passed ? "PASS" : "FAIL"} ${assertion.id}: '${assertion.pattern}' x${actual} (min ${assertion.minCount}) in ${assertion.path}`
    );
  }
  return results;
}

/**
 * Prints what env derivation decided, and on what basis.
 *
 * The carried-overrides block is the operator's chance to catch a wrong call
 * BEFORE it reaches production: these are the vars a name-based filter would
 * have dropped, and one of them is the database path. Values are redacted by
 * name because this output gets pasted into issues.
 */
function reportEnvDerivation(
  derivation: EnvDerivation,
  basis: { basis: string; exact: boolean }
): void {
  console.log(
    `\n[4] env derivation: ${derivation.carried.length} carried, ${derivation.droppedAsImageIdentical.length} dropped as image-identical`
  );
  console.log(
    `    compared against: ${basis.basis}${basis.exact ? "" : "  (TARGET IMAGE NOT BUILT YET — preview only, compared against the running image)"}`
  );
  console.log("    dropped (image supplies an identical value):");
  for (const entry of derivation.droppedAsImageIdentical) {
    console.log(`      - ${entry.name}`);
  }
  if (derivation.carriedOverrides.length === 0) {
    return;
  }
  console.log("    CARRIED OVERRIDES — same name as the image, different value.");
  console.log("    Review these: a name-based filter would have DROPPED them.");
  for (const entry of derivation.carriedOverrides) {
    console.log(`      ! ${entry.name}`);
    console.log(`          image=${redact(entry.name, entry.imageValue)}`);
    console.log(`          live =${redact(entry.name, entry.liveValue)}`);
  }
}

/**
 * The receipt's env section, with every value redacted by name. Shared by the
 * dry-run, abort and final receipts so the three cannot drift apart.
 */
function summarizeEnvForReceipt(derivation: EnvDerivation): Receipt["env"] {
  return {
    carriedCount: derivation.carried.length,
    carriedOverrides: derivation.carriedOverrides.map((entry) => ({
      imageValue: redact(entry.name, entry.imageValue),
      liveValue: redact(entry.name, entry.liveValue),
      name: entry.name,
    })),
    droppedAsImageIdentical: derivation.droppedAsImageIdentical.map((entry) => entry.name),
  };
}

/**
 * Phase 4. Stops the running container, RENAMES it aside as the rollback
 * target, and starts the replacement under the original name.
 *
 * Each failure is undone at the level it reached: a failed rename restarts
 * the original in place; a failed start rolls back fully. The old container
 * is never removed, so the rollback target survives every branch here.
 */
function swapContainer(
  spec: InspectedContainer,
  rollbackName: string,
  runArgs: readonly string[]
): boolean {
  console.log(`\n[4] renaming ${spec.name} -> ${rollbackName}`);
  const stop = run("docker", ["stop", spec.name], 120_000);
  if (!stop.ok) {
    console.error(`could not stop ${spec.name}: ${stop.stderr}`);
    return false;
  }
  const rename = run("docker", ["rename", spec.name, rollbackName]);
  if (!rename.ok) {
    console.error(`could not rename ${spec.name}: ${rename.stderr}`);
    run("docker", ["start", spec.name]);
    return false;
  }
  const started = run("docker", [...runArgs], 300_000);
  if (!started.ok) {
    console.error(`could not start replacement: ${started.stderr}`);
    rollback(spec.name, rollbackName);
    return false;
  }
  return true;
}

/**
 * Phase 3b. Reads every pre-registered metric while the OLD image still runs.
 *
 * A collector that throws yields a null BEFORE value rather than aborting:
 * one unreadable metric must not block the deploy, and the `must_not_*`
 * predicates already fail closed on a missing before value, so the failure
 * surfaces as a failed check instead of a crash.
 *
 * Collection is sequential on purpose. These are `docker exec psql` calls
 * against one Postgres container and `docker inspect` against one daemon;
 * issuing them concurrently would add contention to the very system being
 * measured, and the metrics are a snapshot whose ordering should be stable.
 */
async function collectBeforeMetrics(
  manifest: CanaryManifest,
  spec: InspectedContainer
): Promise<Map<string, string | number | null>> {
  console.log("\n[3] BEFORE metrics");
  const before = new Map<string, string | number | null>();
  for (const check of manifest.checks) {
    let value: string | number | null = null;
    try {
      value = await collectMetric(manifest, check, spec);
    } catch (error) {
      console.error(`    ! ${check.id}: ${String(error)}`);
    }
    before.set(check.id, value);
    console.log(`    ${check.id} = ${String(value)}`);
  }
  return before;
}

/**
 * Phase 5. Evaluates each pre-registered check against the deployed image.
 *
 * Sequential for the same reason as the BEFORE pass, and additionally because
 * a `connector_run` check triggers a real run: overlapping runs would perturb
 * the very metrics the other checks are reading.
 */
async function runRegisteredChecks(
  manifest: CanaryManifest,
  before: ReadonlyMap<string, string | number | null>
): Promise<CheckOutcome[]> {
  console.log("\n[5] AFTER metrics");
  const newSpecRaw = inspectContainer(manifest.container);
  const newSpec = newSpecRaw ? parseInspect(newSpecRaw) : null;
  const outcomes: CheckOutcome[] = [];
  for (const check of manifest.checks) {
    const outcome = await evaluateAfter(manifest, check, before.get(check.id) ?? null, newSpec);
    outcomes.push(outcome);
    console.log(`    ${outcome.passed ? "PASS" : "FAIL"} ${outcome.id}: ${outcome.detail}`);
  }
  return outcomes;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) {
    console.error("--manifest=<path> is required");
    return 2;
  }
  const startedAt = new Date();
  const manifest = parseManifest(JSON.parse(readFileSync(resolve(args.manifest), "utf8")) as unknown);
  const ref = args.ref ?? "HEAD";
  const image = `${manifest.imageRepo}:${manifest.imageTag}`;

  console.log(`# deploy-canary — step ${manifest.step}`);
  console.log(`# ${manifest.description}`);
  console.log(args.apply ? "# MODE: APPLY (will build and deploy)" : "# MODE: DRY RUN (no changes)");

  // Phase 3a — capture the pre-image FIRST, so the rollback target and the
  // BEFORE metrics exist even if a later phase aborts.
  const rawInspect = inspectContainer(manifest.container);
  if (!rawInspect) {
    console.error(`container ${manifest.container} not found; nothing to deploy onto`);
    return 2;
  }
  const spec = parseInspect(rawInspect);
  console.log("\n[3] pre-image captured");
  console.log(`    running image : ${spec.configImage}`);
  console.log(`    RestartCount  : ${spec.restartCount}`);
  console.log(`    started at    : ${spec.startedAt}`);
  console.log(`    ROLLBACK TARGET: ${spec.configImage}`);

  const refCommit = run("git", ["rev-parse", ref]).stdout;

  // Phase 1 — build.
  if (!buildImage(manifest, image, ref, refCommit, args.apply)) {
    return 1;
  }

  // Phase 2 — artifact verification. FAIL CLOSED before any deploy.
  const verifyTarget = args.apply ? image : spec.configImage;
  const artifactResults = verifyArtifacts(manifest, verifyTarget, args.apply);
  const artifactOk = artifactResults.every((entry) => entry.passed);
  if (args.apply && !artifactOk) {
    console.error(
      "\nABORT: artifact assertions failed. The built image does not contain the expected change; deploying it would repeat the 'deploy that never happened' failure."
    );
    const receiptPath = writeReceipt(args.receiptDir, {
      artifactAssertions: artifactResults,
      checks: [],
      container: manifest.container,
      dryRun: false,
      env: { carriedCount: 0, carriedOverrides: [], droppedAsImageIdentical: [] },
      finishedAt: new Date().toISOString(),
      image,
      imageDigest: imageDigest(image),
      nodeBaseImage: manifest.nodeBaseImage,
      ref,
      refCommit,
      rollbackTarget: { containerName: null, image: spec.configImage },
      rolledBack: false,
      startedAt: startedAt.toISOString(),
      step: manifest.step,
      tool: "deploy-canary",
      verdict: "ABORTED_ARTIFACT_MISMATCH",
    });
    console.error(`receipt: ${receiptPath}`);
    return 1;
  }

  // Phase 3b — BEFORE metrics, captured while the old image still runs.
  const before = await collectBeforeMetrics(manifest, spec);

  // Env derivation, reported so a wrong call is visible before it lands.
  //
  // In a dry run the target image usually does not exist yet, so the
  // comparison falls back to the CURRENTLY RUNNING image. That preview is
  // honest but approximate: a var the new image changes would show here as a
  // carried override. The fallback is reported so the operator knows which
  // basis produced the numbers.
  const usedImageEnvBasis = safeImageEnvBasis(image, spec.configImage);
  const derivation: EnvDerivation = deriveEnv(spec.env, usedImageEnvBasis.env);
  reportEnvDerivation(derivation, usedImageEnvBasis);

  const runArgs = buildRunArgs(spec, image, toDockerEnvArgs(derivation));
  const rollbackName = rollbackContainerName(spec.name, startedAt);

  if (!args.apply) {
    console.log(`\n[4] would rename ${spec.name} -> ${rollbackName} (kept for rollback, never removed)`);
    console.log(`[4] would run: docker ${renderRunArgs(runArgs)}`);
    console.log("\n[6] DRY RUN — no deploy, no checks run, no rollback.");
    const receiptPath = writeReceipt(args.receiptDir, {
      artifactAssertions: artifactResults,
      checks: manifest.checks.map((check) => ({
        after: null,
        before: before.get(check.id) ?? null,
        blocking: check.blocking,
        description: check.description,
        detail: "dry run: not evaluated",
        id: check.id,
        kind: check.kind,
        passed: false,
      })),
      container: manifest.container,
      dryRun: true,
      env: summarizeEnvForReceipt(derivation),
      finishedAt: new Date().toISOString(),
      image,
      imageDigest: "",
      nodeBaseImage: manifest.nodeBaseImage,
      ref,
      refCommit,
      rollbackTarget: { containerName: rollbackName, image: spec.configImage },
      rolledBack: false,
      startedAt: startedAt.toISOString(),
      step: manifest.step,
      tool: "deploy-canary",
      verdict: "DRY_RUN",
    });
    console.log(`receipt: ${receiptPath}`);
    return 0;
  }

  // Phase 4 — deploy. Rename, never remove.
  if (!swapContainer(spec, rollbackName, runArgs)) {
    return 1;
  }

  // Phase 5 — pre-registered checks.
  const outcomes = await runRegisteredChecks(manifest, before);

  // Phase 7 — rollback on any blocking failure.
  const rolledBack = shouldRollback(outcomes);
  if (rolledBack) {
    console.error(`\n[7] ROLLBACK: a blocking check failed. Restoring ${spec.configImage}.`);
    for (const outcome of outcomes.filter((entry) => entry.blocking && !entry.passed)) {
      console.error(`    BLOCKING FAILURE ${outcome.id}: ${outcome.detail}`);
    }
    rollback(spec.name, rollbackName);
  } else {
    console.log(`\n[7] no blocking failure; ${rollbackName} retained for manual rollback.`);
  }

  const receipt: Receipt = {
    artifactAssertions: artifactResults,
    checks: outcomes,
    container: manifest.container,
    dryRun: false,
    env: summarizeEnvForReceipt(derivation),
    finishedAt: new Date().toISOString(),
    image,
    imageDigest: imageDigest(image),
    nodeBaseImage: manifest.nodeBaseImage,
    ref,
    refCommit,
    rollbackTarget: { containerName: rollbackName, image: spec.configImage },
    rolledBack,
    startedAt: startedAt.toISOString(),
    step: manifest.step,
    tool: "deploy-canary",
    verdict: rolledBack ? "FAIL" : "PASS",
  };
  const receiptPath = writeReceipt(args.receiptDir, receipt);
  console.log(`\n[6] receipt: ${receiptPath}`);
  console.log(`VERDICT: ${receipt.verdict}`);
  return rolledBack ? 1 : 0;
}

/**
 * Restores the previous container by name. Never removes a volume; never
 * removes the replacement's data. The failed container is renamed aside so
 * its logs remain available for diagnosis.
 */
function rollback(originalName: string, rollbackName: string): void {
  run("docker", ["stop", originalName], 120_000);
  run("docker", ["rename", originalName, `${rollbackName}-failed`]);
  const restored = run("docker", ["rename", rollbackName, originalName]);
  if (!restored.ok) {
    console.error(`ROLLBACK RENAME FAILED: ${restored.stderr}`);
    console.error(`Recover by hand: docker rename ${rollbackName} ${originalName} && docker start ${originalName}`);
    return;
  }
  const started = run("docker", ["start", originalName], 120_000);
  console.error(
    started.ok ? "rollback complete; previous container running." : `ROLLBACK START FAILED: ${started.stderr}`
  );
}

/**
 * Image env plus which image actually supplied it.
 *
 * During a dry run the target image typically has not been built, so the
 * comparison basis falls back to the running image. Returning the basis (and
 * not just the values) keeps the report honest: "20 dropped" means something
 * different depending on which image was compared against, and silently
 * substituting one for the other is how a preview stops predicting the
 * deploy it claims to preview.
 */
function safeImageEnvBasis(image: string, fallback: string): { env: string[]; basis: string; exact: boolean } {
  try {
    return { basis: image, env: imageEnv(image), exact: true };
  } catch {
    try {
      return { basis: fallback, env: imageEnv(fallback), exact: false };
    } catch {
      return { basis: "<none>", env: [], exact: false };
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(String(error));
      process.exitCode = 1;
    });
}
