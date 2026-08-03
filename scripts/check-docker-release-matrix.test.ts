#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards for the Docker release-matrix consistency check.
//
// Covers findMatrixDrift/findMissingDockerfileStages against synthetic
// fixtures (so a real drift/missing-stage case is provable without editing
// the live workflows), and asserts the live repository's three publish
// matrices currently agree with each other and with the Dockerfiles they
// reference — so a future edit that silently drops or mistargets an image
// from one matrix fails this test instead of shipping unnoticed.

import assert from "node:assert/strict";
import test from "node:test";

import { findMatrixDrift, findMissingDockerfileStages, loadMatrix, type MatrixRow } from "./check-docker-release-matrix.ts";

const MATRIX_SOURCES = [
  { path: ".github/workflows/docker-images.yml", jobHeading: "publish:" },
  { path: ".github/workflows/semantic-release.yml", jobHeading: "validate-release-images:" },
  { path: ".github/workflows/semantic-release.yml", jobHeading: "publish-images:" },
];

test("findMatrixDrift is silent when every matrix declares the same rows", () => {
  const rows: MatrixRow[] = [
    { dockerfile: "./Dockerfile", image: "reference", target: "reference" },
    { dockerfile: "./Dockerfile", image: "web", target: "console" },
  ];
  const matrices = [
    { source: { path: "a.yml", jobHeading: "one:" }, rows },
    { source: { path: "b.yml", jobHeading: "two:" }, rows: [...rows] },
  ];
  assert.deepEqual(findMatrixDrift(matrices), []);
});

test("findMatrixDrift reports an image missing from a later matrix", () => {
  const findings = findMatrixDrift([
    {
      source: { path: "a.yml", jobHeading: "one:" },
      rows: [
        { dockerfile: "./Dockerfile", image: "reference", target: "reference" },
        { dockerfile: "./Dockerfile", image: "core-browser", target: "core-browser" },
      ],
    },
    {
      source: { path: "b.yml", jobHeading: "two:" },
      rows: [{ dockerfile: "./Dockerfile", image: "reference", target: "reference" }],
    },
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", /b\.yml \(two:\) is missing image "core-browser"/);
});

test("findMatrixDrift reports an image only present in a later matrix", () => {
  const findings = findMatrixDrift([
    {
      source: { path: "a.yml", jobHeading: "one:" },
      rows: [{ dockerfile: "./Dockerfile", image: "reference", target: "reference" }],
    },
    {
      source: { path: "b.yml", jobHeading: "two:" },
      rows: [
        { dockerfile: "./Dockerfile", image: "reference", target: "reference" },
        { dockerfile: "./Dockerfile", image: "neko", target: "neko-runtime" },
      ],
    },
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", /b\.yml \(two:\) declares image "neko" absent from a\.yml/);
});

test("findMatrixDrift reports a target/dockerfile mismatch as drift even when image names match", () => {
  const findings = findMatrixDrift([
    {
      source: { path: "a.yml", jobHeading: "one:" },
      rows: [{ dockerfile: "./Dockerfile", image: "neko", target: "neko-runtime" }],
    },
    {
      source: { path: "b.yml", jobHeading: "two:" },
      rows: [{ dockerfile: "./docker/neko/Dockerfile", image: "neko", target: "neko-runtime" }],
    },
  ]);
  assert.equal(findings.length, 2);
});

test("findMissingDockerfileStages passes when every target stage exists", () => {
  const findings = findMissingDockerfileStages(
    [{ dockerfile: "./Dockerfile", image: "reference", target: "reference" }],
    "."
  );
  // Run from the repo root by the test runner; "reference" is a real stage.
  assert.deepEqual(findings, []);
});

test("findMissingDockerfileStages reports a target stage that does not exist", () => {
  const findings = findMissingDockerfileStages(
    [{ dockerfile: "./Dockerfile", image: "reference", target: "does-not-exist-stage" }],
    "."
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", /targets stage "does-not-exist-stage" not found/);
});

test("findMissingDockerfileStages reports a Dockerfile that does not exist", () => {
  const findings = findMissingDockerfileStages(
    [{ dockerfile: "./docker/does-not-exist/Dockerfile", image: "ghost", target: "ghost" }],
    "."
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.detail ?? "", /references missing Dockerfile/);
});

test("the live repository's three publish matrices agree with each other", () => {
  const matrices = MATRIX_SOURCES.map((source) => ({ source, rows: loadMatrix(source) }));
  assert.deepEqual(findMatrixDrift(matrices), []);
  const [primary] = matrices;
  assert.ok(primary, "docker-images.yml publish matrix must be loadable");
  assert.ok(primary.rows.length > 0, "docker-images.yml publish matrix must declare at least one image");
});

test("the live repository's publish matrix targets only Dockerfile stages that exist", () => {
  const [primary] = MATRIX_SOURCES.map((source) => loadMatrix(source));
  assert.ok(primary, "docker-images.yml publish matrix must be loadable");
  assert.deepEqual(findMissingDockerfileStages(primary), []);
});

test("the live repository's publish matrix includes every browser-capable self-host image", () => {
  const [primary] = MATRIX_SOURCES.map((source) => loadMatrix(source));
  assert.ok(primary, "docker-images.yml publish matrix must be loadable");
  const images = primary.map((row) => row.image).sort();
  assert.deepEqual(images, ["core-browser", "neko", "railway-core", "reference", "reference-browser", "web"]);
});
