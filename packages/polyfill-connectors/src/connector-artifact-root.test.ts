// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract tests for the deployment-owned durable artifact root.
 *
 * The load-bearing claim under test is the one the Slack archive-loss bug
 * violated: with the DOCUMENTED single-volume deployment (Core's baked
 * `PDPP_DB_PATH=/var/lib/pdpp/pdpp.sqlite`, `-v pdpp_data:/var/lib/pdpp`),
 * the resolved root must land INSIDE `/var/lib/pdpp` — no second mount, and
 * never under `$HOME`.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { test } from "node:test";

import {
  describeConnectorArtifactRoot,
  resolveConnectorArtifactDir,
  resolveConnectorArtifactRoot,
} from "./connector-artifact-root.ts";

// The exact env Core bakes into the shipped image (see Dockerfile's
// core-browser stage). This is the deployment a fresh user gets.
const DOCUMENTED_CORE_ENV = { PDPP_DB_PATH: "/var/lib/pdpp/pdpp.sqlite" };

test("documented single-volume deployment resolves inside /var/lib/pdpp", () => {
  const resolved = resolveConnectorArtifactRoot(DOCUMENTED_CORE_ENV);
  assert.equal(resolved.root, "/var/lib/pdpp/connector-artifacts");
  assert.equal(resolved.source, "database-directory");
  assert.equal(resolved.deploymentOwned, true);
});

test("documented deployment never resolves under the container home directory", () => {
  // The regression that destroyed nine Slack runs: a path under $HOME is on
  // the container's writable layer, which `docker rm` discards.
  const resolved = resolveConnectorArtifactRoot(DOCUMENTED_CORE_ENV);
  assert.ok(!resolved.root.startsWith(homedir()), `expected a non-home path, got ${resolved.root}`);
});

test("explicit override wins over the database directory", () => {
  const resolved = resolveConnectorArtifactRoot({
    PDPP_CONNECTOR_ARTIFACT_ROOT: "/mnt/durable/artifacts",
    PDPP_DB_PATH: "/var/lib/pdpp/pdpp.sqlite",
  });
  assert.equal(resolved.root, "/mnt/durable/artifacts");
  assert.equal(resolved.source, "explicit-override");
  assert.equal(resolved.deploymentOwned, true);
});

test("blank env values are ignored rather than producing a relative root", () => {
  const resolved = resolveConnectorArtifactRoot({
    PDPP_CONNECTOR_ARTIFACT_ROOT: "   ",
    PDPP_DB_PATH: "/srv/data/pdpp.sqlite",
  });
  assert.equal(resolved.root, "/srv/data/connector-artifacts");
  assert.equal(resolved.source, "database-directory");
});

test("in-memory database falls back instead of naming a bogus directory", () => {
  const resolved = resolveConnectorArtifactRoot({ PDPP_DB_PATH: ":memory:" });
  assert.equal(resolved.source, "local-development-fallback");
  assert.equal(resolved.root, `${homedir()}/.pdpp/connector-artifacts`);
});

test("no configuration falls back to the developer home directory, marked not deployment-owned", () => {
  const resolved = resolveConnectorArtifactRoot({});
  assert.equal(resolved.root, `${homedir()}/.pdpp/connector-artifacts`);
  assert.equal(resolved.source, "local-development-fallback");
  assert.equal(resolved.deploymentOwned, false);
});

test("the local-development fallback is disclosed, not silent", () => {
  // A container that reaches the fallback is a misconfiguration; the run log
  // must say so rather than let the archive quietly vanish later.
  const disclosure = describeConnectorArtifactRoot(resolveConnectorArtifactRoot({}));
  assert.match(disclosure, /LOCAL-DEVELOPMENT FALLBACK/);
  assert.match(disclosure, /lost when the container is replaced/);
});

test("deployment-owned roots are described without a loss warning", () => {
  const disclosure = describeConnectorArtifactRoot(resolveConnectorArtifactRoot(DOCUMENTED_CORE_ENV));
  assert.match(disclosure, /\/var\/lib\/pdpp\/connector-artifacts/);
  assert.doesNotMatch(disclosure, /FALLBACK/);
});

test("per-connector directories are namespaced under the shared root", () => {
  const resolved = resolveConnectorArtifactDir("slack", ["myteam"], DOCUMENTED_CORE_ENV);
  assert.equal(resolved.root, "/var/lib/pdpp/connector-artifacts/slack/myteam");
  assert.equal(resolved.source, "database-directory");
});

test("two connectors never collide inside the shared root", () => {
  const slack = resolveConnectorArtifactDir("slack", [], DOCUMENTED_CORE_ENV);
  const usaa = resolveConnectorArtifactDir("usaa", [], DOCUMENTED_CORE_ENV);
  assert.notEqual(slack.root, usaa.root);
});

test("resolution performs no filesystem writes", () => {
  // Resolution must stay pure so diagnostics can ask "where would this go?"
  // without provisioning anything. Point at a path that does not exist and
  // assert we still get an answer and still no directory.
  const root = "/nonexistent-pdpp-artifact-root-probe/data";
  const resolved = resolveConnectorArtifactDir("slack", ["ws"], { PDPP_CONNECTOR_ARTIFACT_ROOT: root });
  assert.equal(resolved.root, `${root}/slack/ws`);
  assert.equal(existsSync(root), false);
});
