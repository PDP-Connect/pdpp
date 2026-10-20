// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const suiteBase = "541ebc38f0794d5c7c2d09198a978471dd61733e";
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(packageDir, "../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const SOURCE_PATH = /\/(src|scripts|targets|test)\//;
const CONFIG_PATH = /\/(package|tsconfig)\.json$/;
const files = git(repoDir, "ls-files", "--cached", "--others", "--exclude-standard", "packages/conformance-suite")
  .split("\n")
  .filter((path) => (SOURCE_PATH.test(path) || CONFIG_PATH.test(path)) && !path.endsWith(".expected.json"));
const sourceHashes = Object.fromEntries(
  [...new Set(files)].sort().map((path) => [path, sha256(readFileSync(join(repoDir, path)))])
);
const sourceDigest = sha256(JSON.stringify(sourceHashes));

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    "target-checkout": { type: "string" },
    "target-sha": { type: "string" },
    "target-repo": { type: "string" },
    "suite-exit": { type: "string" },
    snapshot: { type: "string" },
  },
});
if (values.snapshot) {
  writeFileSync(resolve(values.snapshot), `${JSON.stringify({ sourceDigest, sourceHashes }, null, 2)}\n`);
  process.exit(0);
}
if (values.out) {
  for (const file of ["baseline.json", "baseline.md"]) {
    rmSync(join(resolve(values.out), file), { force: true });
  }
}
for (const key of ["out", "target-checkout", "target-sha", "target-repo", "suite-exit"]) {
  if (!values[key]) {
    throw new Error(`Missing --${key}`);
  }
}
if (!/^[a-f0-9]{40}$/.test(values["target-sha"])) {
  throw new Error("Use a full target SHA");
}
const checkout = resolve(values["target-checkout"]);
if (git(checkout, "rev-parse", "HEAD") !== values["target-sha"]) {
  throw new Error("Target HEAD differs from pin");
}
if (git(checkout, "status", "--porcelain")) {
  throw new Error("Refusing to bind a dirty target");
}
const spec = readFileSync(join(repoDir, "spec-core.md"));
const pinnedSpec = execFileSync("git", ["-C", repoDir, "show", `${suiteBase}:spec-core.md`]);
if (sha256(spec) !== sha256(pinnedSpec)) {
  throw new Error("Core text differs from the pinned spec");
}
const out = resolve(values.out);
const before = JSON.parse(readFileSync(join(out, "suite-source.json"), "utf8"));
if (before.sourceDigest !== sourceDigest) {
  throw new Error("Suite sources changed during the run; rerun before binding");
}
const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
const requirements = JSON.parse(readFileSync(join(out, "requirements.json"), "utf8"));
const credentialKeys = new Set(["access_token", "refresh_token", "id_token", "token", "client_secret"]);
function redactCredentials(value) {
  if (Array.isArray(value)) {
    return value.map(redactCredentials);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        credentialKeys.has(key) ? "[REDACTED]" : redactCredentials(item),
      ])
    );
  }
  return value;
}
// Token-response assertions keep their original outcome and HTTP evidence;
// disposable bearer values are not part of a published baseline.
for (const requirement of report.requirements) {
  for (const result of requirement.cases) {
    for (const evidence of result.evidence ?? []) {
      try {
        evidence.response.body = JSON.stringify(redactCredentials(JSON.parse(evidence.response.body)));
      } catch {
        // Text and truncated responses have no structured credential fields.
      }
    }
  }
}
if (report.specVersion !== "0.1" || requirements.header.specSha256 !== sha256(spec)) {
  throw new Error("Report spec identity differs from the pinned v0.1 text");
}
let expectedExit = 2;
if (report.summary.allApplicableMustsTestedAndPassed) {
  expectedExit = 0;
}
if (report.summary.failedRequirements.length) {
  expectedExit = 1;
}
if (Number(values["suite-exit"]) !== expectedExit) {
  throw new Error("Suite exit and report disagree");
}
if (!report.target.version.includes(values["target-sha"].slice(0, 10))) {
  throw new Error("Report target version does not name the target revision");
}
writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
const cases = report.requirements.flatMap((r) => r.cases);
const counts = (rows, field) =>
  Object.fromEntries(
    ["pass", "fail", "skip", "unsupported", "advisory", "not-tested"].map((outcome) => [
      outcome,
      rows.filter((row) => row[field] === outcome).length,
    ])
  );
const artifacts = ["report.json", "report.md", "requirements.json", "target.json", "suite-source.json"];
const optionalArtifacts = [
  "fixture-truth.json",
  "instance-choice-probes.json",
  "instance-choice-probes.md",
  "fixture-probes.json",
  "experimental-v0.2.json",
  "experimental-v0.2.md",
];
const artifactHashes = {};
for (const file of [...artifacts, ...optionalArtifacts]) {
  try {
    artifactHashes[file] = sha256(readFileSync(join(out, file)));
  } catch (error) {
    if (!optionalArtifacts.includes(file) || error.code !== "ENOENT") {
      throw error;
    }
  }
}
const manifest = {
  schemaVersion: 1,
  scope: "Core v0.1 baseline; no conformance status conferred",
  suite: {
    baseSha: suiteBase,
    headSha: git(repoDir, "rev-parse", "HEAD"),
    sourceHashes,
    sourceDigest,
    dirty: Boolean(git(repoDir, "status", "--porcelain")),
  },
  spec: { repository: "PDP-Connect/pdpp", sha: suiteBase, path: "spec-core.md", sha256: sha256(spec), version: "0.1" },
  target: { repository: values["target-repo"], sha: values["target-sha"], dirty: false },
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  suiteExit: expectedExit,
  caseCounts: counts(cases, "outcome"),
  requirementCounts: counts(report.requirements, "outcome"),
  failures: cases
    .filter((c) => c.outcome === "fail")
    .map(({ caseId, detail }) => ({ caseId, detail, owner: values["target-repo"] })),
  hookGaps: cases
    .filter((c) => c.outcome === "skip")
    .map(({ caseId, detail }) => ({
      caseId,
      detail,
      owner: "PDP-Connect/pdpp",
      targetOwner: values["target-repo"],
    })),
  artifactHashes,
};
writeFileSync(join(out, "baseline.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const lines = [
  "# Core v0.1 baseline",
  "",
  `Target: ${manifest.target.repository}@${manifest.target.sha}.`,
  "",
  `Suite base: ${suiteBase}. Suite source digest: ${manifest.suite.sourceDigest}.`,
  "",
  `Spec SHA-256: ${manifest.spec.sha256}. Suite exit: ${expectedExit}.`,
  "",
  "Counts below are cases; requirement and clause counts remain in the raw reports.",
  "",
  "| pass | fail | skip | unsupported | advisory | not-tested |",
  "| --- | --- | --- | --- | --- | --- |",
  `| ${Object.values(manifest.caseCounts).join(" | ")} |`,
  "",
  "This run does not label the target conformant. Client-role coverage is outside this AS/RS run.",
  "",
  "## Observed target failures",
  "",
  ...manifest.failures.map((c) => `- **${c.caseId}** (${c.owner}): ${c.detail}`),
  "",
  "## Skipped cases and hook gaps",
  "",
  ...manifest.hookGaps.map((c) => `- **${c.caseId}**: ${c.detail}`),
  "",
  "Experimental v0.2 is not evaluated by this v0.1 suite. See the separate experimental report.",
  "",
];
writeFileSync(join(out, "baseline.md"), lines.join("\n"));
