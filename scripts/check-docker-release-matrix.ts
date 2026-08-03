#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fails closed if the Docker image matrices drift apart or point at a
// Dockerfile stage that no longer exists.
//
// docker-images.yml (its `publish` job) and semantic-release.yml (its
// `validate-release-images` and `publish-images` jobs) each hand-declare the
// same image/target list in YAML. They have drifted before without any CI
// signal: railway-core/core-browser/neko were added to the release matrices
// while docker-images.yml's earlier `publish` job list only carried the
// pre-existing three, and nothing compared the two. A row present in one
// matrix but not another silently narrows what a release actually publishes,
// with no build failure to notice it by.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface MatrixRow {
  dockerfile: string;
  image: string;
  target: string;
}

interface MatrixSource {
  jobHeading: string;
  path: string;
}

// The `publish` job in docker-images.yml (:main / tag-triggered releases) and
// the two release-gated jobs in semantic-release.yml. docker-images.yml's
// `validate` job and semantic-release.yml's `quality`/`resolve-version` jobs
// are deliberately excluded — they aren't publish paths.
const MATRIX_SOURCES: MatrixSource[] = [
  { path: ".github/workflows/docker-images.yml", jobHeading: "publish:" },
  { path: ".github/workflows/semantic-release.yml", jobHeading: "validate-release-images:" },
  { path: ".github/workflows/semantic-release.yml", jobHeading: "publish-images:" },
];

const JOB_HEADING_PATTERN = /^  \S.*:$/;
const ROW_START_PATTERN = /^\s*- image:\s*(\S+)\s*$/;
const TARGET_PATTERN = /^\s*target:\s*(\S+)\s*$/;
const DOCKERFILE_PATTERN = /^\s*dockerfile:\s*(\S+)\s*$/;
const STEPS_PATTERN = /^\s*steps:\s*$/;
const DEFAULT_DOCKERFILE = "./Dockerfile";
const DOCKERFILE_STAGE_PATTERN = /^FROM\s+\S+\s+AS\s+(\S+)/im;

function extractJobBody(source: string, heading: string): string {
  const lines = source.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === heading.trim());
  if (headingIndex === -1) {
    throw new Error(`job heading not found: ${heading}`);
  }
  const bodyLines: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (JOB_HEADING_PATTERN.test(line)) {
      break;
    }
    bodyLines.push(line);
  }
  return bodyLines.join("\n");
}

// Only the `strategy.matrix.include` list feeding a job's build/push step —
// stop reading once the job reaches `steps:`, so an unrelated `- image:`
// mention later in the job (there is none today, but nothing enforces that)
// can never be silently folded in as a matrix row.
function matrixRows(jobBody: string): MatrixRow[] {
  const stepsIndex = jobBody.search(STEPS_PATTERN);
  const strategyBody = stepsIndex === -1 ? jobBody : jobBody.slice(0, stepsIndex);
  const lines = strategyBody.split("\n");
  const rows: MatrixRow[] = [];
  let current: { dockerfile?: string; image: string; target?: string } | null = null;
  for (const line of lines) {
    const rowStart = ROW_START_PATTERN.exec(line);
    if (rowStart?.[1]) {
      if (current) {
        rows.push({
          dockerfile: current.dockerfile ?? DEFAULT_DOCKERFILE,
          image: current.image,
          target: current.target ?? "",
        });
      }
      current = { image: rowStart[1] };
      continue;
    }
    if (!current) {
      continue;
    }
    const target = TARGET_PATTERN.exec(line);
    if (target?.[1]) {
      current.target = target[1];
      continue;
    }
    const dockerfile = DOCKERFILE_PATTERN.exec(line);
    if (dockerfile?.[1]) {
      current.dockerfile = dockerfile[1];
    }
  }
  if (current) {
    rows.push({
      dockerfile: current.dockerfile ?? DEFAULT_DOCKERFILE,
      image: current.image,
      target: current.target ?? "",
    });
  }
  return rows;
}

export function loadMatrix(source: MatrixSource, repoRoot: string = REPO_ROOT): MatrixRow[] {
  const workflow = readFileSync(join(repoRoot, source.path), "utf8");
  const body = extractJobBody(workflow, source.jobHeading);
  return matrixRows(body);
}

function rowKey(row: MatrixRow): string {
  return `${row.image}|${row.target}|${row.dockerfile}`;
}

export interface DriftFinding {
  detail: string;
}

export function findMatrixDrift(matrices: { rows: MatrixRow[]; source: MatrixSource }[]): DriftFinding[] {
  const findings: DriftFinding[] = [];
  if (matrices.length === 0) {
    return findings;
  }
  const [reference, ...rest] = matrices;
  if (!reference) {
    return findings;
  }
  const referenceKeys = new Set(reference.rows.map(rowKey));
  const referenceLabel = `${reference.source.path} (${reference.source.jobHeading})`;
  for (const matrix of rest) {
    const label = `${matrix.source.path} (${matrix.source.jobHeading})`;
    const keys = new Set(matrix.rows.map(rowKey));
    for (const row of reference.rows) {
      if (!keys.has(rowKey(row))) {
        findings.push({ detail: `${label} is missing image "${row.image}" present in ${referenceLabel}` });
      }
    }
    for (const row of matrix.rows) {
      if (!referenceKeys.has(rowKey(row))) {
        findings.push({ detail: `${label} declares image "${row.image}" absent from ${referenceLabel}` });
      }
    }
  }
  return findings;
}

export function findMissingDockerfileStages(
  rows: MatrixRow[],
  repoRoot: string = REPO_ROOT
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const byDockerfile = new Map<string, MatrixRow[]>();
  for (const row of rows) {
    const existing = byDockerfile.get(row.dockerfile) ?? [];
    existing.push(row);
    byDockerfile.set(row.dockerfile, existing);
  }
  for (const [dockerfile, dockerfileRows] of byDockerfile) {
    const relativePath = dockerfile.replace(/^\.\//, "");
    const fullPath = join(repoRoot, relativePath);
    if (!existsSync(fullPath)) {
      for (const row of dockerfileRows) {
        findings.push({ detail: `image "${row.image}" references missing Dockerfile ${relativePath}` });
      }
      continue;
    }
    const contents = readFileSync(fullPath, "utf8");
    const stages = new Set(
      [...contents.matchAll(new RegExp(DOCKERFILE_STAGE_PATTERN, "gim"))].map((match) => match[1])
    );
    for (const row of dockerfileRows) {
      if (!row.target || !stages.has(row.target)) {
        findings.push({
          detail: `image "${row.image}" targets stage "${row.target}" not found in ${relativePath}`,
        });
      }
    }
  }
  return findings;
}

function main(): void {
  const matrices = MATRIX_SOURCES.map((source) => ({ source, rows: loadMatrix(source) }));
  const drift = findMatrixDrift(matrices);
  const primaryRows = matrices[0]?.rows ?? [];
  const missingStages = findMissingDockerfileStages(primaryRows);
  const findings = [...drift, ...missingStages];
  if (findings.length > 0) {
    console.error(`check-docker-release-matrix: ${findings.length} finding(s)`);
    for (const finding of findings) {
      console.error(`  ${finding.detail}`);
    }
    process.exit(1);
  }
  console.log(
    `check-docker-release-matrix: ${MATRIX_SOURCES.length} matrices agree on ${primaryRows.length} image(s), all Dockerfile stages resolved.`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
